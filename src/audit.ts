/**
 * Evidence execution: the parts that do not need a terminal, a model, or a gate.
 *
 * Three functions matter here, and each exists to close a hole in "the reviewer
 * says a command proves the claim":
 *
 *   classifyCommand  — may this argv run at all, and does it need a human?
 *   runCommand       — spawn it with no shell, a timeout, a cap, and a scrubbed
 *                      environment, and keep a record of what happened.
 *   toAuditRecord    — turn that into the artifact `audit.json`, including an
 *                      outcome compared mechanically against what the reviewer
 *                      said it expected.
 *
 * Nothing here decides anything. A refusal, a human rejection and a timeout all
 * produce a record, because an absent record is indistinguishable from a check
 * nobody proposed. That is the same lesson as a run stuck at `created`.
 */
import { createHash } from "node:crypto";
import { AuditRecord as AuditRecordSchema } from "./contracts.ts";
import type { AuditRecord, CheckProposal, Review } from "./contracts.ts";

/* ------------------------------------------------------------------ *
 * Allowlist
 *
 * Exact argv arrays, never patterns. The decision was settled in the M3 trial
 * (docs/M2-PLAN.md §3, D2/J3): pattern matching is where an allowlist stops
 * being one.
 *
 * Tier 1 runs without asking; Tier 2 would ask. The Tier 2 list is deliberately
 * empty: it is meant to come from the trial's `unverifiable` bucket rather than
 * from imagination, and the trial produced none.
 * ------------------------------------------------------------------ */

export type Tier = "auto" | "ask" | "refuse";

export interface AllowRule {
  argv: string[];
  tier: "auto" | "ask";
  why: string;
  /** Project checks need longer than introspection. Conservative by default. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const PROJECT_CHECK_TIMEOUT_MS = 120_000;
export const DEFAULT_CAP_BYTES = 64 * 1024;

export const DEFAULT_ALLOWLIST: AllowRule[] = [
  { argv: ["bun", "--version"], tier: "auto", why: "tool version; runs no project code" },
  { argv: ["node", "--version"], tier: "auto", why: "tool version; runs no project code" },
  { argv: ["git", "rev-parse", "HEAD"], tier: "auto", why: "read-only introspection" },
  { argv: ["git", "status", "--porcelain"], tier: "auto", why: "read-only introspection" },
  // Project checks execute repository code and take minutes, so they ask. The
  // human chose this split: quick checks run by themselves, slow ones need a yes.
  {
    argv: ["bun", "test"],
    tier: "ask",
    why: "project check; runs repository code and takes time",
    timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
  },
  {
    argv: ["bun", "run", "typecheck"],
    tier: "ask",
    why: "project check; runs repository code and takes time",
    timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
  },
];

const argvKey = (argv: string[]): string => argv.join("\u0000");

export interface Classification {
  tier: Tier;
  rule?: AllowRule;
}

/**
 * Exact match on the argv array. `["bun","test","--filter","x"]` is not
 * `["bun","test"]`, and `"bun test; rm -rf /"` — one string — matches nothing.
 * The shell never sees any of this.
 */
export function classifyCommand(
  argv: string[],
  allowlist: AllowRule[] = DEFAULT_ALLOWLIST,
): Classification {
  if (argv.length === 0 || argv.some((part) => part.trim() === "")) return { tier: "refuse" };
  const key = argvKey(argv);
  const rule = allowlist.find((r) => argvKey(r.argv) === key);
  return rule ? { tier: rule.tier, rule } : { tier: "refuse" };
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface CommandRun {
  status: "ran" | "timed-out" | "spawn-error";
  exitCode?: number;
  signal?: string;
  startedAt: string;
  durationMs: number;
  /** First `capBytes` of each stream. */
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Total bytes produced, before the cap. */
  totalBytes: number;
  /** sha256 of the *full* stdout and stderr, so a capped record still identifies it. */
  sha256: string;
  /** Names only: the environment holds credentials. */
  envNames: string[];
}

/**
 * Keep the variables a command cannot work without, and drop everything else —
 * the runner otherwise forwards `...process.env`, API keys included, to every
 * child.
 */
const ENV_KEEP = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): { env: Record<string, string>; names: string[] } {
  const env: Record<string, string> = {};
  for (const name of ENV_KEEP) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  return { env, names: Object.keys(env).sort() };
}

interface Drain {
  text: string;
  truncated: boolean;
  totalBytes: number;
  hash: string;
}

async function drain(stream: ReadableStream<Uint8Array>, cap: number): Promise<Drain> {
  const hash = createHash("sha256");
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let totalBytes = 0;

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    hash.update(value);
    if (keptBytes < cap) {
      const room = cap - keptBytes;
      const slice = value.byteLength <= room ? value : value.subarray(0, room);
      kept.push(Buffer.from(slice));
      keptBytes += slice.byteLength;
    }
  }

  return {
    text: Buffer.concat(kept).toString("utf8"),
    truncated: totalBytes > keptBytes,
    totalBytes,
    hash: hash.digest("hex"),
  };
}

/**
 * Run one argv array. No shell, no interpolation, no cwd guessing.
 *
 * On timeout the process is killed and the partial output kept — "it timed out"
 * is a result, and hiding what it printed first would make the record useless.
 */
export async function runCommand(
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
    capBytes?: number;
    env?: Record<string, string>;
  },
): Promise<CommandRun> {
  if (argv.length === 0) throw new Error("runCommand needs a command");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const capBytes = opts.capBytes ?? DEFAULT_CAP_BYTES;
  const { env, names } = scrubbedEnv(process.env, opts.env);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      status: "spawn-error",
      startedAt,
      durationMs: Date.now() - t0,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      truncated: false,
      totalBytes: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      envNames: names,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [out, err] = await Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, capBytes),
    drain(proc.stderr as ReadableStream<Uint8Array>, capBytes),
  ]);
  await proc.exited;
  clearTimeout(timer);

  return {
    status: timedOut ? "timed-out" : "ran",
    ...(proc.exitCode !== null ? { exitCode: proc.exitCode } : {}),
    ...(proc.signalCode !== null ? { signal: String(proc.signalCode) } : {}),
    startedAt,
    durationMs: Date.now() - t0,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    totalBytes: out.totalBytes + err.totalBytes,
    sha256: createHash("sha256").update(out.hash).update(":").update(err.hash).digest("hex"),
    envNames: names,
  };
}

/* ------------------------------------------------------------------ *
 * Outcome and record
 * ------------------------------------------------------------------ */

/**
 * Mechanical comparison against the expectation the reviewer stated. A timeout
 * or spawn failure is its own outcome, not a mismatch: the check never ran.
 *
 * If the output was capped, a substring near the end may be missing; proposals
 * should look for something a sane command prints early.
 */
export function outcomeOf(
  expect: CheckProposal["expect"],
  run: CommandRun,
): "matched" | "mismatched" | "not-run" {
  if (run.status !== "ran") return "not-run";
  if (expect.exitCode !== undefined && run.exitCode !== expect.exitCode) return "mismatched";
  if (expect.stdoutIncludes !== undefined && !run.stdout.includes(expect.stdoutIncludes)) {
    return "mismatched";
  }
  return "matched";
}

export interface AuditInput {
  id: string;
  proposal: CheckProposal;
  claim: string;
  proposedBy: string;
  cwd: string;
  tier: "auto" | "ask" | "none";
  decision: AuditRecord["decision"];
  decidedAt: string;
  /** Null when nothing ran: refused, rejected, or never reached. */
  run: CommandRun | null;
  tree: { head: string | null; dirty: boolean };
  planVersion: number;
  planSha256: string;
}

export function toAuditRecord(input: AuditInput): AuditRecord {
  const { run } = input;
  const empty = createHash("sha256").update("").digest("hex");
  const record: AuditRecord = {
    id: input.id,
    claim: input.claim,
    proposedBy: input.proposedBy,
    argv: input.proposal.argv,
    cwd: input.cwd,
    tier: input.tier,
    decision: input.decision,
    decidedAt: input.decidedAt,
    status: run ? run.status : "not-run",
    ...(run?.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run?.signal !== undefined ? { signal: run.signal } : {}),
    ...(run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run?.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    stdout: run?.stdout ?? "",
    stderr: run?.stderr ?? "",
    truncated: run?.truncated ?? false,
    totalBytes: run?.totalBytes ?? 0,
    sha256: run?.sha256 ?? empty,
    tree: input.tree,
    env: run?.envNames ?? [],
    planVersion: input.planVersion,
    planSha256: input.planSha256,
    outcome: run ? outcomeOf(input.proposal.expect, run) : "not-run",
  };
  // The record is a contract, not a bag: validate it here so a malformed id or a
  // missing field fails at the write, not when something later tries to read it.
  return AuditRecordSchema.parse(record);
}

/* ------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------ */

export const isAuditRef = (evidence: string): boolean => /^audit:A\d+$/.test(evidence);

/**
 * Resolve `audit:A1` against the records. Null means the reference is forged or
 * stale, and the caller must treat it as an evidence defect — not as a verdict
 * with missing proof.
 */
export function resolveAuditRef(
  evidence: string,
  records: AuditRecord[],
): AuditRecord | null {
  if (!isAuditRef(evidence)) return null;
  const id = evidence.slice("audit:".length);
  return records.find((record) => record.id === id) ?? null;
}

/** Ids are assigned here, never by a model: `A1`, `A2`, … */
export function nextAuditId(records: { id: string }[]): string {
  let highest = 0;
  for (const record of records) {
    const n = Number(record.id.slice(1));
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `A${highest + 1}`;
}

/* ------------------------------------------------------------------ *
 * Running what the reviewer proposed
 * ------------------------------------------------------------------ */

/** What a check approval prompt needs to show a human, in plain words. */
export interface ApprovalRequest {
  claim: string;
  argv: string[];
  why?: string;
}

export interface AuditOptions {
  repo: string;
  /** The plan text the checks are about, for planVersion/planSha256. */
  planText: string;
  proposedBy: string;
  /** Called for slow checks. Without it, slow checks are recorded as not approved. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  onNote?: (text: string) => void;
  allowlist?: AllowRule[];
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** HEAD and whether the tree is dirty. Read-only git, fixed argv. */
export async function treeIdentity(repo: string): Promise<{ head: string | null; dirty: boolean }> {
  try {
    const head = await runCommand(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 5000 });
    const status = await runCommand(["git", "status", "--porcelain"], { cwd: repo, timeoutMs: 5000 });
    return {
      head: head.status === "ran" && head.stdout.trim() ? head.stdout.trim() : null,
      dirty: status.status === "ran" && status.stdout.trim().length > 0,
    };
  } catch {
    return { head: null, dirty: false };
  }
}

/**
 * Run every check the reviewer proposed, or record why it did not run.
 *
 * A refusal, a declined approval, a timeout and a crash all produce a record.
 * Nothing here throws: one bad command must not end the run, and the review's
 * other verdicts are still valid.
 */
export async function runProposedChecks(
  review: Review,
  opts: AuditOptions,
): Promise<AuditRecord[]> {
  const note = opts.onNote ?? (() => {});
  const records: AuditRecord[] = [];
  const tree = await treeIdentity(opts.repo);
  const planSha = sha256(opts.planText);

  for (const verdict of review.verdicts) {
    if (verdict.verdict !== "unverifiable" || !verdict.proposes) continue;

    const proposal = verdict.proposes;
    const id = nextAuditId(records);
    const decidedAt = new Date().toISOString();
    const { tier, rule } = classifyCommand(proposal.argv, opts.allowlist);

    let decision: AuditRecord["decision"];
    let run: CommandRun | null = null;

    if (tier === "refuse") {
      decision = "refused";
      note(`! declined to run a check for ${verdict.id}: ${proposal.argv.join(" ")} (not on the allowlist)`);
    } else if (tier === "ask" && !(opts.approve && (await opts.approve({
      claim: verdict.id,
      argv: proposal.argv,
      ...(proposal.why ? { why: proposal.why } : {}),
    })))) {
      decision = "human-rejected";
      note(`skipped a check for ${verdict.id}: ${proposal.argv.join(" ")}`);
    } else {
      decision = tier === "auto" ? "auto-allowed" : "human-approved";
      note(`checking ${verdict.id}: ${proposal.argv.join(" ")}`);
      run = await runCommand(proposal.argv, {
        cwd: opts.repo,
        ...(rule?.timeoutMs ? { timeoutMs: rule.timeoutMs } : {}),
      });
      const outcome = outcomeOf(proposal.expect, run);
      if (outcome === "matched") note(`  ${proposal.argv.join(" ")} agrees with the plan`);
      else if (outcome === "mismatched") note(`  ! ${proposal.argv.join(" ")} disagrees with the plan`);
      else note(`  ${proposal.argv.join(" ")} did not complete (${run.status})`);
    }

    records.push(
      toAuditRecord({
        id,
        proposal,
        claim: verdict.id,
        proposedBy: opts.proposedBy,
        cwd: opts.repo,
        tier: tier === "refuse" ? "none" : tier,
        decision,
        decidedAt,
        run,
        tree,
        planVersion: 1,
        planSha256: planSha,
      }),
    );
  }

  return records;
}

/**
 * Apply what the commands found. This is the human's chosen behaviour: a check
 * that disagrees with the plan corrects it, without another question, because a
 * failing test is a fact rather than a taste call. The changelog and the diff
 * still show what changed.
 *
 * `review.json` is untouched; this is the merged view used for the gate and the
 * rebuttal, and it can be rebuilt from `review.json` + `audit.json` at any time.
 */
export function mergeAuditIntoReview(review: Review, records: AuditRecord[]): Review {
  const byClaim = new Map(records.map((record) => [record.claim, record]));
  const verdicts: Review["verdicts"] = review.verdicts.map((verdict) => {
    if (verdict.verdict !== "unverifiable") return verdict;
    const record = byClaim.get(verdict.id);
    if (!record) return verdict;

    const command = record.argv.join(" ");
    if (record.outcome === "matched") {
      return {
        id: verdict.id,
        verdict: "confirmed",
        evidence: `audit:${record.id}`,
        note: `checked by running: ${command}`,
      };
    }
    if (record.outcome === "mismatched") {
      return {
        id: verdict.id,
        verdict: "refuted",
        evidence: `audit:${record.id}`,
        note: `${command} disagreed with the plan`,
      };
    }
    return {
      ...verdict,
      note: `${verdict.note} (check did not complete: ${record.status})`,
    };
  });
  return { ...review, verdicts };
}

/** One plain line per check, for the gate and the result. */
export function auditLines(records: AuditRecord[]): string[] {
  return records.map((record) => {
    const command = record.argv.join(" ");
    if (record.decision === "refused") return `refused: ${command} — not on the allowlist`;
    if (record.decision === "human-rejected") return `not run: ${command} — you declined`;
    if (record.outcome === "matched") {
      return `ran: ${command} — agrees with the plan${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}`;
    }
    if (record.outcome === "mismatched") {
      return `ran: ${command} — DISAGREES with the plan${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}`;
    }
    return `did not complete: ${command} (${record.status})`;
  });
}
