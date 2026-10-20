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
import { spans, type Span, type StyledLine } from "./markdown.ts";
import { THEME } from "./theme.ts";
import type { DecisionEntry } from "./orchestrator.ts";

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

/**
 * The trailing row a judgment call offers in the TUI: a free-text answer for
 * when none of the model's options make sense. A view concern, not part of
 * `buildItems` — the model never proposed it, and `gate.json` records the
 * typed text itself, not this label.
 */
export const CUSTOM_ROW_LABEL = "type your own answer…";

/** The options as the TUI shows them: judgment calls gain the custom row. */
export function displayOptions(item: GateItem): string[] {
  return item.kind === "judgment" ? [...item.options, CUSTOM_ROW_LABEL] : [...item.options];
}

/** The index of the custom row in the displayed list, for judgment calls. */
export function customRowIndex(item: GateItem): number {
  return item.options.length;
}

/**
 * Whether a recorded choice is free text rather than one of the model's
 * options: a judgment answer that is not among the item's values and is not
 * "open" (which is its own row). Findings keep their enum and never qualify.
 */
export function isCustomChoice(item: GateItem, value: string | undefined): boolean {
  return (
    item.kind === "judgment" &&
    value !== undefined &&
    value !== "" &&
    !item.values.includes(value)
  );
}

/**
 * A custom answer must survive `decisions.md`: one line, no `*` (the entry
 * regex reads `**choice**`), bounded. Both front ends sanitise through here
 * so the CLI and the TUI record the same bytes for the same typing.
 */
export function sanitizeCustomChoice(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\*+/g, "·")
    .slice(0, 300);
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
      options: [...j.options, "I don't know — leave it open; the plan presents the options instead of picking"],
      values: [...j.options, "open"],
    });
  }

  for (const f of review.extra_findings) {
    items.push({
      id: f.id,
      kind: "finding",
      title: f.text,
      detail: f.evidence ? [`[${f.evidence}]`] : f.note ? [f.note] : [],
      // The labels say what the choice does to the deliverable. Bare
      // "accept"/"dismiss" read as a vote with no stated consequence, and the
      // human then has to guess whether accepting rewrites the text.
      options: [
        "yes — rewrite it (one more model call)",
        "no — leave it exactly as it is",
        "later — decide nothing now",
      ],
      values: ["accepted", "dismissed", "untriaged"],
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

/* ------------------------------------------------------------------ *
 * Asking the gate twice.
 *
 * `adv revise` re-asks a gate the human has already answered: every prompt
 * carries the recorded answer, Enter keeps it, and the comparison below says
 * whether anything moved — which decides whether a model call is spent.
 * ------------------------------------------------------------------ */

/** How a recorded finding disposition reads out loud in a prompt. */
export function dispositionLabel(
  d: Gate["findings"][number]["disposition"],
): string {
  return d === "accepted" ? "yes" : d === "dismissed" ? "no" : "later";
}

/**
 * The CLI's judgment prompt. With a recorded answer, Enter is a real reply —
 * keeping the answer — and the prompt must say so. Without one, the old
 * contract holds, plus the escape hatch: anything that is not a number or
 * 'open' is recorded as the human's own answer. A custom recorded answer
 * reads back in full so a revisit does not look lost.
 */
export function judgmentQuestion(
  judgment: Claims["judgment"][number],
  current?: string,
): string {
  const marker = current ? `  (currently: ${current})` : "";
  return `  ${judgment.id}${marker}: ` + (
    current ? "1-N, 'open', your own answer, or Enter to keep: " : "1-N, 'open', or your own answer: "
  );
}

/** The CLI's finding prompt: yes/no/later, as the TUI asks it, with the
 *  recorded choice shown when there is one. */
export function findingQuestion(
  finding: Review["extra_findings"][number],
  current?: Gate["findings"][number]["disposition"],
): string {
  const marker = current ? `  (currently: ${dispositionLabel(current)})` : "";
  return `  ${finding.id}${marker}: yes / no / later — ${finding.text} `;
}

export interface GateChange {
  decisions: { id: string; from: string; to: string }[];
  findings: { id: string; from: string; to: string }[];
}

/**
 * Which answers differ between two gates, matched by id rather than position:
 * the gate is asked in claims order, but order is not a contract, and a
 * re-asked gate with exactly one different answer is a change that a
 * whole-object comparison would miss the moment the order moved.
 *
 * `previous` may be null (no gate file at all): every recorded answer is then
 * a change, with `from` reading "(none)". An item that was recorded but is
 * missing from `current` counts as a change too — a dropped answer must not
 * read as "nothing moved".
 */
export function describeGateChange(previous: Gate | null, current: Gate): GateChange {
  const prevDecision = new Map(previous?.decisions.map((d) => [d.id, d.choice] as const));
  const prevFinding = new Map(
    previous?.findings.map((f) => [f.id, f.disposition] as const),
  );

  const decisions: GateChange["decisions"] = [];
  for (const d of current.decisions) {
    const from = prevDecision.get(d.id) ?? "(none)";
    if (from !== d.choice) decisions.push({ id: d.id, from, to: d.choice });
  }
  for (const d of previous?.decisions ?? []) {
    if (!current.decisions.some((c) => c.id === d.id)) {
      decisions.push({ id: d.id, from: d.choice, to: "(unanswered)" });
    }
  }

  const findings: GateChange["findings"] = [];
  for (const f of current.findings) {
    const from = prevFinding.get(f.id) ?? "(none)";
    if (from !== f.disposition) findings.push({ id: f.id, from, to: f.disposition });
  }
  for (const f of previous?.findings ?? []) {
    if (!current.findings.some((c) => c.id === f.id)) {
      findings.push({ id: f.id, from: f.disposition, to: "(unanswered)" });
    }
  }

  return { decisions, findings };
}

/**
 * What `adv revise` (and the TUI's revisit) appends to `decisions.md`: one
 * entry per judgment call whose settled answer moved, each marked so the
 * append-only file reads in order.
 *
 * A call re-opened at the gate gets a `reopened` marker, which `readDecisions`
 * treats as un-settling the id: the old entry stays on disk, but the next draft
 * is no longer told it is closed. A call that was open and stays open appends
 * nothing — "open" was never written to begin with.
 */
export function decisionEntries(claims: Claims, change: GateChange): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  for (const c of change.decisions) {
    const text = claims.judgment.find((j) => j.id === c.id)?.text ?? "";
    // `from` is the recorded answer, "(none)" when there was no gate file.
    // A settled previous answer is the one that needs a supersede marker.
    const wasSettled = c.from !== "(none)" && c.from !== "open";
    if (c.to === "open") {
      if (wasSettled) {
        entries.push({
          id: c.id,
          text,
          choice: "reopened",
          note: `(the earlier entry for ${c.id} no longer stands)`,
        });
      }
      continue;
    }
    entries.push({
      id: c.id,
      text,
      choice: c.to,
      ...(wasSettled ? { note: `(supersedes the earlier entry for ${c.id})` } : {}),
    });
  }
  return entries;
}

/**
 * Where the gate's cursor lands for an item that already has a recorded
 * answer: on that answer. That is what makes a re-asked gate readable —
 * the current choice is what the cursor sits on, and Enter keeps it.
 * A free-text answer (not among the item's values) lands on the custom row,
 * which the TUI appends after the model's options. Anything else unknown
 * lands on the first option rather than nowhere.
 */
export function selectionForCurrent(item: GateItem, current?: string): number {
  if (!current) return 0;
  const i = item.values.indexOf(current);
  if (i !== -1) return i;
  if (isCustomChoice(item, current)) return customRowIndex(item);
  return 0;
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
/**
 * The review's state as one line of spans.
 *
 * Only the counts that want a decision are coloured: a refuted claim has to be
 * answered, and an unverifiable one is where the human has nothing to go on.
 * "Confirmed" stays plain — a file agreeing with a sentence is not a verdict
 * on whether the sentence is any good, and this tool does not decide that.
 */
export function statusSpans(counts: VerdictCounts): StyledLine {
  const attention = (text: string, when: boolean): Span =>
    when ? { text, color: THEME.warn } : { text };

  return spans(
    `${counts.claims} claim${counts.claims === 1 ? "" : "s"}`,
    " · ",
    `${counts.confirmed} confirmed`,
    " · ",
    attention(`${counts.refuted} refuted`, counts.refuted > 0),
    " · ",
    attention(`${counts.unverifiable} unverifiable`, counts.unverifiable > 0),
    ...(counts.noVerdict ? [" · ", attention(`${counts.noVerdict} without a verdict`, true)] : []),
    " · ",
    `${counts.findings} finding${counts.findings === 1 ? "" : "s"}`,
  );
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

/**
 * Clamp a cursor, not a window: `0` to `length - 1`. The shape
 * `Math.min(Math.max(0, length - 1), i + delta)` reads like a clamp but is
 * not one — when the delta is negative the `min` keeps the negative, and a
 * wheel scrolled upward once parked the picker at index -185 with the window
 * still showing the top. Floor first, then ceiling.
 */
export const clampIndex = (index: number, length: number): number =>
  Math.max(0, Math.min(index, length - 1));

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
