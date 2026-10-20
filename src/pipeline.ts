import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Changelog, Claims, Gate, Review } from "./contracts.ts";
import { assessDiff, unifiedDiff, type DiffAssessment } from "./diff.ts";
import { verdictCounts } from "./gate-model.ts";
import {
  createRun,
  loadState,
  markFailed,
  readJson,
  saveState,
  writeJson,
  type Paths,
} from "./orchestrator.ts";
import { OpencodeRunRunner, type CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";
import { invisibleCount, repairUrls } from "./urls.ts";
import {

  mergeAuditIntoReview,
  resolveAuditRef,
  runProposedChecks,
  type ApprovalRequest,
} from "./audit.ts";
import type { Audit, AuditRecord } from "./contracts.ts";

export interface Models {
  drafter: ModelRef;
  reviewer: ModelRef;
}

/**
 * How the pipeline describes itself while it runs.
 *
 * `onCall` is machine-shaped (kind, step, ms, cost). `onNote` is a sentence a
 * human can read: what is happening now, and what came back. Both front ends
 * pass the same reporting object, so the CLI and the TUI cannot tell two
 * different stories about one run.
 */
export interface Reporting {
  onCall?: CallHook;
  onNote?: (text: string) => void;
  /**
   * Called when the reviewer proposes a slow check (a test suite, a typecheck).
   * The human said yes to "quick checks run by themselves, slow ones ask".
   * Without an approver, slow checks are recorded as declined rather than run.
   */
  onApprove?: (request: ApprovalRequest) => Promise<boolean>;
}

/**
 * The pipeline, shared by the CLI and the TUI. Everything a caller needs to
 * know is in the return values; progress is reported through `Reporting`.
 */

export interface Head {
  paths: Paths;
  plan: string;
  claims: Claims;
  review: Review;
  /** Verifiable claims the reviewer returned no verdict for. */
  missing: string[];
  /** Evidence that is broken before anyone argues about whether it is true. */
  evidenceIssues: { id: string; evidence: string; reason: "missing" | "invisible" | "unresolved" }[];
  /** URLs repaired deterministically before the reviewer saw them. */
  urlRepairs: { before: string; after: string }[];
  /** Checks the orchestrator ran, refused, or was told to skip. */
  checks: AuditRecord[];
}

/**
 * A reviewer can invent a plausible-looking path, can copy an invisible
 * character into a URL, and can cite a check that was never recorded. The first
 * is the cheapest forgery to catch, the second is a defect no reader can see,
 * and the third is a citation with no evidence behind it. All are checked here
 * rather than trusted.
 */
export function collectEvidenceIssues(
  repo: string,
  review: Review,
  records: AuditRecord[],
): { id: string; evidence: string; reason: "missing" | "invisible" | "unresolved" }[] {
  const issues: { id: string; evidence: string; reason: "missing" | "invisible" | "unresolved" }[] =
    [];
  const check = (id: string, evidence: string) => {
    if (invisibleCount(evidence) > 0) {
      issues.push({ id, evidence, reason: "invisible" });
      return;
    }
    if (/^audit:/.test(evidence)) {
      if (!resolveAuditRef(evidence, records)) {
        issues.push({ id, evidence, reason: "unresolved" });
      }
      return;
    }
    if (/^https?:\/\//.test(evidence)) return; // a URL cannot be existence-checked here

    // One verdict may cite more than one place — "README.md:8-9;
    // src/rateLimit.ts:3-4" is a legitimate answer, and checking the combined
    // string as a path reports both files as missing. Check each part.
    for (const part of evidence.split(/\s*;\s*/).filter(Boolean)) {
      // Line locators come in several shapes: ":88", ":88-92", ":3-4,6-16".
      const file = part.replace(/:\d+(?:[-,]\d+)*$/, "");
      if (!existsSync(path.join(repo, file))) issues.push({ id, evidence: part, reason: "missing" });
    }
  };
  for (const v of review.verdicts) {
    if (v.verdict === "unverifiable") continue;
    check(v.id, v.evidence);
  }
  for (const f of review.extra_findings) {
    if (f.evidence) check(f.id, f.evidence);
  }
  return issues;
}

/** Draft, review, validate. Leaves the run in state `validated`. */
export async function runHead(
  repo: string,
  task: string,
  criteria: string,
  decisions: string,
  models: Models,
  mode: Mode,
  reporting: Reporting = {},
  opts?: { parent?: { name: string; dir: string } },
): Promise<Head> {
  const note = reporting.onNote ?? (() => {});
  const runner = new OpencodeRunRunner({ repo, ...models, onCall: reporting.onCall });
  const paths = await createRun(repo, task, models, mode, opts?.parent ? { parent: opts.parent } : undefined);

  try {
    note(`drafting — ${models.drafter.ref}`);
    const draft = await runner.draft({ mode, task, criteria, decisions });

    // Repair before the reviewer sees it, so the artifacts stay consistent and
    // the diff has nothing unattributed to explain. The repair is reported:
    // silently fixing a model's citation would hide the defect it just made.
    const { text: planText, repairs: urlRepairs } = repairUrls(draft.plan);
    await writeFile(paths.planV1, `${planText}\n`);
    await writeJson(paths.claims, draft.claims);
    await saveState(paths, {
      ...(await loadState(paths)),
      state: "drafted",
      ...(urlRepairs.length ? { urlRepairs } : {}),
    });
    note(
      `drafted — ${draft.claims.verifiable.length} verifiable claim(s), ` +
        `${draft.claims.judgment.length} judgment call(s)`,
    );
    for (const r of urlRepairs) note(`! repaired a URL before review: ${r.before} -> ${r.after}`);

    note(
      `reviewing — ${draft.claims.verifiable.length} claim(s) and ` +
        `${draft.claims.judgment.length} judgment call(s) sent to ${models.reviewer.ref}`,
    );
    const review = await runner.review({ mode, task, criteria, plan: planText, claims: draft.claims });
    await writeJson(paths.review, review);
    await saveState(paths, { ...(await loadState(paths)), state: "reviewed" });

    // The reviewer may propose a check it could not run itself. Quick ones run
    // now; slow ones ask first; anything unlisted is refused. A contradiction
    // changes the plan — the human chose that — so the gate and the rebuttal see
    // the merged view. review.json stays exactly as the reviewer wrote it, and
    // audit.json is what records why the view differs.
    note("review read — matching verdicts to claims and proposed checks");
    const checks = await runProposedChecks(review, {
      repo,
      planText,
      proposedBy: models.reviewer.ref,
      ...(reporting.onApprove ? { approve: reporting.onApprove } : {}),
      onNote: note,
    });
    if (checks.length) await writeJson(paths.audit, { records: checks });
    const effective = mergeAuditIntoReview(review, checks);

    const missing = draft.claims.verifiable
      .map((c) => c.id)
      .filter((id) => !effective.verdicts.some((v) => v.id === id));

    const evidenceIssues = collectEvidenceIssues(repo, effective, checks);
    const counts = verdictCounts(draft.claims, effective);

    note(
      `reviewed — ${counts.confirmed} confirmed · ${counts.refuted} refuted · ` +
        `${counts.unverifiable} unverifiable` +
        (counts.noVerdict ? ` · ${counts.noVerdict} without a verdict` : "") +
        (counts.findings ? ` · ${counts.findings} extra finding(s)` : ""),
    );
    if (missing.length) note(`! no verdict returned for ${missing.join(", ")}`);
    const absent = evidenceIssues.filter((i) => i.reason === "missing");
    const invisible = evidenceIssues.filter((i) => i.reason === "invisible");
    if (absent.length) {
      note(
        `! ${absent.length} evidence citation(s) name a file that does not exist: ` +
          absent.map((i) => i.id).join(", "),
      );
    }
    if (invisible.length) {
      note(
        `! ${invisible.length} evidence citation(s) contain an invisible character: ` +
          invisible.map((i) => i.id).join(", "),
      );
    }

    await saveState(paths, { ...(await loadState(paths)), state: "validated" });
    return {
      paths,
      plan: planText,
      claims: draft.claims,
      review: effective,
      missing,
      evidenceIssues,
      urlRepairs,
      checks,
    };
  } catch (err) {
    await markFailed(paths, err);
    throw err;
  }
}

export interface Tail {
  plan: string;
  changelog: Changelog;
  patch: string;
  assessment: DiffAssessment;
}

/** What the rebuttal is allowed to touch, in the order it will be told. */
function scopeIds(i: {
  refuted: { id: string }[];
  accepted: { id: string }[];
  decisions: { id: string; choice: string }[];
}): string[] {
  const shown = [
    ...i.refuted.map((r) => `${r.id} fix`),
    ...i.accepted.map((a) => `${a.id} apply`),
    ...i.decisions.map((d) => `${d.id} → ${d.choice}`),
  ];
  return shown.length > 6 ? [...shown.slice(0, 6), `… +${shown.length - 6}`] : shown;
}

/** Apply the human's gate answers. Produces plan.v2, the changelog and the diff. */
export async function runTail(
  repo: string,
  paths: Paths,
  state: { task: string },
  claims: Claims,
  review: Review,
  gate: Gate,
  models: Models,
  mode: Mode,
  reporting: Reporting = {},
): Promise<Tail> {
  const note = reporting.onNote ?? (() => {});

  try {
    const planV1 = await readFile(paths.planV1, "utf8");

    const refuted: { id: string; text: string; evidence: string }[] = [];
    for (const v of review.verdicts) {
      if (v.verdict !== "refuted") continue;
      refuted.push({
        id: v.id,
        text: claims.verifiable.find((c) => c.id === v.id)?.text ?? "",
        evidence: v.note ? `${v.evidence} — ${v.note}` : v.evidence,
      });
    }

    const acceptedIds = gate.findings
      .filter((f) => f.disposition === "accepted")
      .map((f) => f.id);
    const accepted = review.extra_findings
      .filter((f) => acceptedIds.includes(f.id))
      .map((f) => ({ id: f.id, text: f.text, evidence: f.evidence ?? f.note ?? "" }));

    const decisions = gate.decisions
      .filter((d) => d.choice !== "open")
      .map((d) => ({
        id: d.id,
        text: claims.judgment.find((j) => j.id === d.id)?.text ?? "",
        choice: d.choice,
      }));

    // With nothing authorised there is nothing to rebut, and asking a model to
    // "rewrite, changing nothing" just invites an out-of-scope edit.
    let plan = planV1;
    let changelog: Changelog = { changes: [] };
    if (refuted.length || accepted.length || decisions.length) {
      // Say the scope out loud before the model sees it: the tool's whole claim
      // is that the rebuttal touches nothing else, and that is only credible if
      // you can watch it being given the list.
      note(
        `rebutting — ${[
          refuted.length ? `${refuted.length} refuted claim(s)` : "",
          accepted.length ? `${accepted.length} accepted finding(s)` : "",
          decisions.length ? `${decisions.length} decision(s)` : "",
        ]
          .filter(Boolean)
          .join(" · ")}`,
      );
      note(`in scope: ${scopeIds({ refuted, accepted, decisions }).join(", ")}`);

      const runner = new OpencodeRunRunner({ repo, ...models, onCall: reporting.onCall });
      const rebut = await runner.rebut({
        mode,
        task: state.task,
        plan: planV1,
        claims,
        refuted,
        accepted,
        decisions,
      });
      plan = `${rebut.plan}\n`;
      changelog = rebut.changelog;
      const applied = rebut.changelog.changes.filter((c) => c.disposition !== "no-op");
      const noops = rebut.changelog.changes.length - applied.length;
      note(
        `changelog — ${applied.length} change(s)` +
          (noops ? `, ${noops} no-op(s)` : "") +
          (applied.length ? `: ${applied.map((c) => `${c.item} ${c.disposition}`).join(", ")}` : ""),
      );
    } else {
      note(
        `nothing authorised at the gate — ${
          mode === "answer" ? "the answer" : "plan.v2"
        } is unchanged`,
      );
    }
    await writeFile(paths.planV2, plan);
    await writeJson(paths.changelog, changelog);

    const patch = await unifiedDiff(paths.planV1, paths.planV2);
    await writeFile(paths.diff, patch ? `${patch}\n` : "");
    const assessment = assessDiff(patch, changelog);

    const current = await loadState(paths);
    await saveState(paths, { ...current, state: "done", error: undefined });
    return { plan, changelog, patch, assessment };
  } catch (err) {
    await markFailed(paths, err);
    throw err;
  }
}

/** Record the gate answers and mark the run as paused/parked at the gate. */
export async function saveGate(paths: Paths, gate: Gate): Promise<void> {
  await writeJson(paths.gate, gate);
  await saveState(paths, { ...(await loadState(paths)), state: "gated" });
}

/**
 * The in-memory view of a run, rebuilt from its on-disk artifacts. The TUI
 * opens past runs through this: the same `Head` a fresh run produces, so the
 * gate and the result render identically whether the run just happened or
 * happened yesterday.
 */
export function headFromArtifacts(
  repo: string,
  paths: Paths,
  a: Awaited<ReturnType<typeof loadArtifacts>>,
): Head {
  const missing = a.claims.verifiable
    .map((c) => c.id)
    .filter((id) => !a.review.verdicts.some((v) => v.id === id));
  return {
    paths,
    plan: a.plan,
    claims: a.claims,
    review: a.review,
    missing,
    evidenceIssues: collectEvidenceIssues(repo, a.review, a.checks),
    urlRepairs: a.state.urlRepairs ?? [],
    checks: a.checks,
  };
}

/** The tail's artifacts, for a run that already finished: the revised text, its changelog, the diff. */
export async function loadTail(paths: Paths): Promise<Tail> {
  const plan = await readFile(paths.planV2, "utf8");
  const changelog = await readJson<Changelog>(paths.changelog);
  const patch = await readFile(paths.diff, "utf8");
  return { plan, changelog, patch, assessment: assessDiff(patch, changelog) };
}

export async function loadArtifacts(paths: Paths): Promise<{
  state: Awaited<ReturnType<typeof loadState>>;
  plan: string;
  claims: Claims;
  review: Review;
  gate: Gate | null;
  checks: AuditRecord[];
}> {
  const state = await loadState(paths);
  // A failed run has whatever artifacts it managed to write, and may have no
  // plan at all. Say why, instead of failing later on an ENOENT that reads like
  // a bug in adv.
  if (state.state === "failed") {
    throw new Error(
      `run failed before it could be decided:\n  ${state.error ?? "(no error recorded)"}`,
    );
  }
  const plan = await readFile(paths.planV1, "utf8");
  const { readJson } = await import("./orchestrator.ts");
  const claims = await readJson<Claims>(paths.claims);
  const rawReview = await readJson<Review>(paths.review);
  // Command results are applied on load, not baked into review.json: the merged
  // view is rebuildable, and the reviewer's original statements stay intact.
  const audit = await readJson<Audit>(paths.audit).catch(() => null);
  const review = mergeAuditIntoReview(rawReview, audit?.records ?? []);
  const gate = await readJson<Gate>(paths.gate).catch(() => null);
  return { state, plan, claims, review, gate, checks: audit?.records ?? [] };
}
