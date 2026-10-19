import { costOf, cannotUseTools, formatCostFull } from "./catalogue.ts";
import type { Catalogue } from "./catalogue.ts";
import { scoresFor, formatTaskCost } from "./benchmarks.ts";
import type { Benchmarks } from "./benchmarks.ts";
import { emptyAcd, formatPromptCost, resolveAcd } from "./aicodingdaily.ts";
import type { AcdIndex } from "./aicodingdaily.ts";
import { providerOf } from "./models.ts";
import type { PickerView } from "./models.ts";
import { probeBadge } from "./probe.ts";
import type { ProbeCache } from "./probe.ts";
import type { Mode } from "./runner.ts";

/**
 * Export the picker's visible list as a Markdown table, for pasting into
 * another LLM for a second opinion.
 *
 * The rows are what is on screen — after the filter, the lock, the view and
 * `H` — in screen order, with the context that makes them interpretable
 * (what was filtered, where the scores came from and when) and a legend at
 * the bottom, because a table of numbers without provenance is a rumour.
 * Pipes are escaped so a ref can never break the table.
 */
export interface ModelsExportInput {
  /** The visible refs, in screen order. */
  refs: string[];
  /** The catalogue size, for "N of M shown". */
  total: number;
  view: PickerView;
  filter: string;
  providerLock: string | null;
  ceiling: number;
  /** Measured $/task ceiling, for the taskcost view's context line. */
  taskCeiling: number;
  hideUnscored: boolean;
  subject: Mode;
  catalogue: Catalogue;
  benchmarks: Benchmarks;
  probes: ProbeCache;
  favourites: Set<string>;
  /** ISO fetch time of the benchmark cache, null when there is none. */
  scoresAt: string | null;
  /** AA Intelligence Index version, null when unknown. */
  indexVersion: string | null;
  /** AI Coding Daily leaderboard, for the D badge and prompt-$ column. Optional: older callers predate it. */
  acd?: AcdIndex;
  /** ISO fetch time of the ACD cache, null when there is none. */
  acdAt?: string | null;
  /** The picker ranked by AI Coding Daily (`D`) when the export was taken. */
  rankAcd?: boolean;
  /** Now, overridable for tests. */
  exportedAt?: string;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

const num = (v: number | undefined): string => (v === undefined ? "" : String(Math.round(v)));

export function exportModelsMd(input: ModelsExportInput): string {
  const {
    refs,
    total,
    view,
    filter,
    providerLock,
    ceiling,
    taskCeiling,
    hideUnscored,
    subject,
    catalogue,
    benchmarks,
    probes,
    favourites,
    scoresAt,
    indexVersion,
    // Older callers predate ACD: the export works without it, badges blank.
    acd = emptyAcd(),
    acdAt = null,
    rankAcd = false,
    exportedAt = new Date().toISOString(),
  } = input;

  const context: string[] = [
    `exported ${exportedAt}`,
    `${refs.length} of ${total} models shown`,
    `view: ${view}`,
  ];
  if (filter.trim()) context.push(`filter: "${filter.trim()}"`);
  if (providerLock) context.push(`locked to provider: ${providerLock}`);
  if (view === "value") context.push(`value ceiling: $${ceiling.toFixed(2)}/M output`);
  if (view === "taskcost") context.push(`task ceiling: $${taskCeiling.toFixed(2)}/task`);
  if (hideUnscored) context.push("hiding unscored");
  context.push(`subject: ${subject === "answer" ? "general question" : "this repository"}`);
  context.push(
    scoresAt
      ? `benchmark scores fetched ${scoresAt}${indexVersion ? ` (AA Intelligence Index v${indexVersion})` : ""}`
      : "no benchmark cache",
  );
  context.push(
    acdAt ? `AI Coding Daily scores fetched ${acdAt}` : "no AI Coding Daily cache",
  );
  if (rankAcd) context.push("ranked by AI Coding Daily (D on — points for the order, ACD $/task for the taskcost view)");

  const header =
    "| model | provider | price in/out | task $/task | intelligence | coding | agentic | D points | ACD $/task | scores from | ping | notes |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = refs.map((ref) => {
    const price = formatCostFull(costOf(catalogue, ref));
    const resolved = scoresFor(catalogue, benchmarks, ref);
    const a = resolveAcd(catalogue, acd, ref);
    const badge = probeBadge(probes, ref);
    const notes: string[] = [];
    if (favourites.has(ref)) notes.push("★ favourite");
    if (cannotUseTools(catalogue, ref, subject)) notes.push("no tool calls");
    // The ceiling row the D badge came from: best effort, and the harness
    // that measured it — an ACD score without its harness is a number
    // without its method.
    if (a) notes.push(`ACD ${a.effort ?? "effort n/a"} via ${a.harness ?? "harness n/a"}${a.normalised ? " ≈" : ""}`);
    return (
      `| ${cell(ref)} | ${cell(providerOf(ref))} | ${cell(price)} | ` +
      `${cell(formatTaskCost(resolved?.taskCost))} | ` +
      `${cell(num(resolved?.intelligence))} | ${cell(num(resolved?.coding))} | ` +
      `${cell(num(resolved?.agentic))} | ` +
      `${cell(a ? String(Math.round(a.points)) : "")} | ` +
      `${cell(formatPromptCost(a?.costPerPrompt))} | ` +
      `${cell(
        resolved
          ? `${resolved.source === "aa" ? "Artificial Analysis" : "OpenRouter"}${
              resolved.normalised ? " ≈" : ""
            }`
          : "",
      )} | ` +
      `${cell(badge ? `${badge.badge}${badge.stale ? " (stale)" : ""}` : "not tested")} | ` +
      `${cell(notes.join("; "))} |`
    );
  });

  return (
    `# model shortlist\n\n` +
    context.map((c) => `- ${c}\n`).join("") +
    `\n${header}\n${divider}\n` +
    rows.map((r) => `${r}\n`).join("") +
    `\n## legend\n\n` +
    `- model: the ref as \`opencode models\` lists it, provider first.\n` +
    `- price in/out: US$ per million tokens. \`free\` costs nothing; \`?\` means the catalogue is silent — unknown, never free. A tiered price lists both: base to the threshold, then the long-context price (Haiku 5.5: $0.10/$0.50 to 100k tokens, then $0.50/$2.50).\n` +
    `- task $/task: measured dollars per Artificial Analysis Intelligence Index task — what the benchmark run actually cost, verbosity and tokenizer included. Higher is dearer, blank is unmeasured (never 0), and only Artificial Analysis rows have one: the OpenRouter relay never carries it.\n` +
    `- D points: AI Coding Daily's coding leaderboard (max 70, best effort per model) — real agent harnesses on multi-file projects, a different scale from intelligence/coding/agentic, shown beside them and never ranked on. Blank means unscored, not zero.\n` +
    `- ACD $/task: AI Coding Daily's measured cost per task on that 4-project coding suite — the same concept as task $/task, measured on different tasks. The taskcost view filters on one or the other (D switches), never both. Blank is unmeasured, never 0.\n` +
    `- intelligence / coding / agentic: benchmark scores, higher is better. Blank means unscored, not zero.\n` +
    `- scores from: who measured it. \`≈\` means the id needed normalising to match and is the weaker claim.\n` +
    `- ping: a real model call made from here. \`✓\` reachable (\`T\` also reached for a tool); \`✗\` failed; \`not tested\` means what it says.\n` +
    `- ★ favourite: OpenCode's own mark — a model you use, not a quality verdict.\n` +
    `- no tool calls: the catalogue says this model cannot call tools, so it cannot be a repository agent.\n`
  );
}
