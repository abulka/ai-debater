/**
 * The gate as data, not as a React component.
 *
 * The TUI renders these structures and nothing else. Keeping the mapping here
 * means the thing that records a human's decision — the single most
 * consequential bit of this tool — can be tested without a terminal, and that
 * the CLI and the TUI cannot drift into asking subtly different questions.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditRecord, Claims, Gate, Review } from "./contracts.ts";
import { auditLines } from "./audit.ts";

export interface GateItem {
  id: string;
  kind: "judgment" | "finding";
  title: string;
  /** Trade-offs for a judgment call, evidence or note for a finding. */
  detail: string[];
  options: string[];
  /** What each option records in `gate.json`. */
  values: string[];
  /** `file:line` or URL, when the item cites one. */
  evidence?: string;
}

export interface GateAnswer {
  id: string;
  kind: GateItem["kind"];
  value: string;
}

/**
 * One screen per judgment call and per finding. A judgment call always offers
 * "leave it open": that is a real disposition, and the plan then presents the
 * options instead of picking one.
 */
export function buildItems(claims: Claims, review: Review): GateItem[] {
  const items: GateItem[] = [];

  for (const j of claims.judgment) {
    const tradeoffs = review.tradeoffs.find((t) => t.id === j.id);
    items.push({
      id: j.id,
      kind: "judgment",
      title: j.text,
      detail: j.options.map((option) => {
        const against = tradeoffs?.per_option.find((p) => p.option === option)?.against ?? [];
        return `${option}${against.length ? `  — ${against.join("; ")}` : ""}`;
      }),
      options: [...j.options, "leave it open"],
      values: [...j.options, "open"],
    });
  }

  for (const f of review.extra_findings) {
    items.push({
      id: f.id,
      kind: "finding",
      title: f.text,
      detail: f.evidence ? [`[${f.evidence}]`] : f.note ? [f.note] : [],
      options: ["accept", "dismiss"],
      values: ["accepted", "dismissed"],
      evidence: f.evidence,
    });
  }

  return items;
}

/** Answers in, `gate.json` out. Order is preserved so the file reads like the gate. */
export function answersToGate(all: GateAnswer[]): Gate {
  return {
    decisions: all
      .filter((a) => a.kind === "judgment")
      .map((a) => ({ id: a.id, choice: a.value })),
    findings: all
      .filter((a) => a.kind === "finding")
      .map((a) => ({
        id: a.id,
        disposition:
          a.value === "accepted"
            ? ("accepted" as const)
            : a.value === "dismissed"
              ? ("dismissed" as const)
              : ("untriaged" as const),
      })),
  };
}

/**
 * A judgment call as the human should see it: the question, then each option
 * with what it costs. Shared by the CLI's pre-gate summary and the interactive
 * prompt, so `adv run` paused does not say only "1 judgment call" and leave the
 * human to discover what it was after they have to answer it.
 */
export function describeJudgmentCall(
  judgment: Claims["judgment"][number],
  review: Review,
): string[] {
  const tradeoffs = review.tradeoffs.find((t) => t.id === judgment.id);
  const lines = [`${judgment.id}  ${judgment.text}`];
  judgment.options.forEach((option, i) => {
    const against = tradeoffs?.per_option.find((p) => p.option === option)?.against ?? [];
    lines.push(`${i + 1}. ${option}${against.length ? `   — ${against.join("; ")}` : ""}`);
  });
  return lines;
}

/**
 * The gate in text, for the CLI: what the reviewer found, then every judgment
 * call with its options and costs.
 *
 * This exists because `adv run` used to pause with "judgment calls needing you:
 * 1" and nothing else — the human then had to run `adv decide` to discover what
 * the question even was. The TUI never had that problem; the CLI did.
 */
export function gateSummaryLines(
  claims: Claims,
  review: Review,
  checks: AuditRecord[] = [],
): string[] {
  const out: string[] = [];

  // What the orchestrator actually ran, before anything else: a command result
  // is not an opinion, and it explains why a verdict may have changed since the
  // reviewer wrote it.
  if (checks.length) {
    out.push(`checks (${checks.length}):`);
    for (const line of auditLines(checks)) out.push(`  ${line}`);
    out.push("");
  }
  const claimText = (id: string) => claims.verifiable.find((c) => c.id === id)?.text ?? "";

  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  if (refuted.length) {
    out.push(`refuted (${refuted.length}):`);
    for (const v of refuted) {
      if (v.verdict !== "refuted") continue;
      out.push(`  ${v.id}  ${claimText(v.id)}`);
      out.push(`      [${v.evidence}]${v.note ? ` — ${v.note}` : ""}`);
    }
    out.push("");
  }

  const unverifiable = review.verdicts.filter((v) => v.verdict === "unverifiable");
  if (unverifiable.length) {
    out.push(`unverifiable (${unverifiable.length}):`);
    for (const v of unverifiable) {
      if (v.verdict !== "unverifiable") continue;
      out.push(`  ${v.id}  ${claimText(v.id)}`);
      out.push(`      ${v.note}`);
    }
    out.push("");
  }

  if (review.extra_findings.length) {
    out.push(`findings (${review.extra_findings.length}):`);
    for (const f of review.extra_findings) {
      out.push(`  ${f.id}  ${f.text}`);
      if (f.evidence) out.push(`      [${f.evidence}]`);
      else if (f.note) out.push(`      ${f.note}`);
    }
    out.push("");
  }

  if (claims.judgment.length) {
    out.push(`judgment calls needing you (${claims.judgment.length}):`);
    for (const judgment of claims.judgment) {
      for (const line of describeJudgmentCall(judgment, review)) out.push(`  ${line}`);
    }
  } else {
    out.push("no judgment calls — nothing here needs a human decision");
  }

  return out;
}

export interface VerdictCounts {
  claims: number;
  confirmed: number;
  refuted: number;
  unverifiable: number;
  /** Verifiable claims the reviewer returned nothing for. */
  noVerdict: number;
  findings: number;
}

export function verdictCounts(claims: Claims, review: Review): VerdictCounts {
  const verdictOf = (id: string) => review.verdicts.find((v) => v.id === id)?.verdict;
  const counts: VerdictCounts = {
    claims: claims.verifiable.length,
    confirmed: 0,
    refuted: 0,
    unverifiable: 0,
    noVerdict: 0,
    findings: review.extra_findings.length,
  };
  for (const claim of claims.verifiable) {
    const verdict = verdictOf(claim.id);
    if (verdict === "confirmed") counts.confirmed += 1;
    else if (verdict === "refuted") counts.refuted += 1;
    else if (verdict === "unverifiable") counts.unverifiable += 1;
    else counts.noVerdict += 1;
  }
  return counts;
}

/**
 * The one-line state of the review, shown on every gate screen. It used to be
 * shown once, on the first item, and then vanished exactly when the human had
 * moved on to deciding something.
 */
export function statusLine(counts: VerdictCounts): string {
  const parts = [
    `${counts.claims} claim${counts.claims === 1 ? "" : "s"}`,
    `${counts.confirmed} confirmed`,
    `${counts.refuted} refuted`,
    `${counts.unverifiable} unverifiable`,
  ];
  if (counts.noVerdict) parts.push(`${counts.noVerdict} without a verdict`);
  parts.push(`${counts.findings} finding${counts.findings === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function gateWarnings(a: {
  missing: string[];
  evidenceIssues: { id: string; evidence: string; reason: "missing" | "invisible" | "unresolved" }[];
  urlRepairs?: { before: string; after: string }[];
  hasCriteria: boolean;
}): string[] {
  return [
    ...a.missing.map((id) => `no verdict returned for ${id}`),
    ...a.evidenceIssues.map((i) =>
      i.reason === "invisible"
        ? `${i.id} cites evidence containing an invisible character: ${i.evidence}`
        : i.reason === "unresolved"
          ? `${i.id} cites ${i.evidence}, but no such check was recorded`
          : `${i.id} cites a file that does not exist: ${i.evidence}`,
    ),
    ...(a.urlRepairs ?? []).map(
      (r) => `repaired a URL before review (invisible character removed): ${r.before} -> ${r.after}`,
    ),
    ...(a.hasCriteria ? [] : ["no .adv/criteria.md — the reviewer had no criteria to check against"]),
  ];
}

/* ------------------------------------------------------------------ *
 * Scrolling. One implementation, used by the result view and by every
 * panel, so "the list will not move" is one bug and not four.
 * ------------------------------------------------------------------ */

export const maxOffset = (total: number, height: number): number =>
  Math.max(0, total - height);

export const clampOffset = (offset: number, total: number, height: number): number =>
  Math.max(0, Math.min(offset, maxOffset(total, height)));

/* ------------------------------------------------------------------ *
 * Evidence. A reviewer can cite a path, so the gate should be able to
 * show it — but the path came from a model, and it must never be able to
 * name a file outside the repository it was reviewing.
 * ------------------------------------------------------------------ */

export type EvidenceRef =
  | { kind: "file"; file: string; line?: number }
  | { kind: "url"; url: string };

const URL_RE = /^https?:\/\/\S+$/;

export function parseEvidence(evidence: string): EvidenceRef | null {
  const text = evidence.trim();
  if (URL_RE.test(text)) return { kind: "url", url: text };
  if (!text) return null;

  // Anchor the line number at the end. A lazy optional suffix would happily
  // read "src/http.ts:88" as the file "src/http.ts:8".
  const withLine = /^(.+):(\d+)(?:-\d+)?$/.exec(text);
  if (withLine?.[1]) return { kind: "file", file: withLine[1], line: Number(withLine[2]) };
  return { kind: "file", file: text };
}

/** Resolve inside `repo` only; anything that escapes is refused. */
export function resolveInRepo(repo: string, file: string): string | null {
  const root = path.resolve(repo);
  const abs = path.resolve(root, file);
  return abs === root || abs.startsWith(`${root}${path.sep}`) ? abs : null;
}

/**
 * The cited file around the cited line, numbered, so the human can judge a
 * finding instead of taking the reviewer's word for it. Null when the evidence
 * is not a readable file in this repository — the gate then says so.
 */
export async function readEvidenceContext(
  repo: string,
  evidence: string,
  radius = 12,
): Promise<{ lines: string[]; file: string; line?: number } | null> {
  // A verdict may cite two places; show the first one.
  const first = evidence.split(/\s*;\s*/)[0] ?? evidence;
  const ref = parseEvidence(first);
  if (!ref || ref.kind !== "file") return null;

  const abs = resolveInRepo(repo, ref.file);
  if (!abs) return null;

  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return null;
  }
  // A generated bundle or a lockfile is not context. Say so rather than
  // freezing the TUI.
  if (text.length > 512 * 1024) return null;

  const all = text.split("\n");
  const target = ref.line ? Math.min(Math.max(1, ref.line), all.length) : 1;
  const start = Math.max(1, target - radius);
  const end = Math.min(all.length, target + radius);
  const width = String(end).length;
  const lines = all
    .slice(start - 1, end)
    .map((line, i) => {
      const n = start + i;
      const marker = ref.line && n === target ? ">" : " ";
      return `${marker} ${String(n).padStart(width)}  ${line}`;
    });

  return { lines, file: ref.file, ...(ref.line ? { line: ref.line } : {}) };
}
