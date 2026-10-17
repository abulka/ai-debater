import type { AuditRecord, Changelog, Claims, Gate, Review } from "./contracts.ts";
import type { DiffAssessment } from "./diff.ts";
import { verdictCounts } from "./gate-model.ts";

const rule = (n: number) => "─".repeat(n);

/** Word-wrap for a table cell; a terminal is not a browser. */
function wrapWords(text: string, width: number): string[] {
  const usable = Math.max(1, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > usable && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isSeparator = (cell: string): boolean => /^:?-{2,}:?$/.test(cell);

/**
 * Group a table block into rows.
 *
 * A well-formed table is one row per line. Models also emit the whole thing as
 * one long line, pipes and separator run included — then the only thing that
 * identifies a row boundary is the column count, which the separator run gives
 * us. Without this, the entire table is read as one row of fifteen cells.
 */
function tableRows(block: string[]): string[][] {
  const all: string[] = [];
  for (const line of block) all.push(...cellsOf(line));

  let sepStart = -1;
  let columns = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (isSeparator(all[i]!)) {
      if (sepStart === -1) sepStart = i;
      columns += 1;
    } else if (sepStart !== -1) {
      break;
    }
  }

  const trimRow = (row: string[]): string[] => {
    const copy = [...row];
    while (copy.length && copy[copy.length - 1] === "") copy.pop();
    return copy;
  };

  if (sepStart > 0 && columns > 0 && sepStart === columns) {
    const header = all.slice(0, sepStart);
    const rest = all.slice(sepStart + columns);
    const rows = [header];
    for (let i = 0; i + columns <= rest.length; i += columns) {
      rows.push(rest.slice(i, i + columns));
    }
    return rows.map(trimRow).filter((row) => row.length > 0);
  }

  return block.map((line) => trimRow(cellsOf(line))).filter((row) => row.length > 0);
}

/**
 * Render a table to fit the terminal: columns shrink until the row fits, and
 * cells wrap inside their column instead of being cut off. Four 34-character
 * columns on a 100-column terminal is unreadable however well aligned.
 */
function formatTable(block: string[], width: number): string[] {
  const rows = tableRows(block);
  if (rows.length === 0) return [];

  const columns = Math.max(...rows.map((cells) => cells.length));
  const natural = Array.from({ length: columns }, (_, i) =>
    Math.max(1, ...rows.map((cells) => (cells[i] ?? "").length)),
  );
  const widths = [...natural];
  const MIN_COLUMN = 8;
  const total = () => widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1);

  while (total() > width) {
    const widest = Math.max(...widths);
    if (widest <= MIN_COLUMN) break;
    widths[widths.indexOf(widest)] = widest - 1;
  }

  const renderedRows = rows.map((cells) => {
    const wrapped = cells.map((cell, i) => wrapWords(cell, widths[i] ?? 1));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    const lines: string[] = [];
    for (let h = 0; h < height; h += 1) {
      lines.push(
        wrapped
          .map((cellLines, i) => (cellLines[h] ?? "").padEnd(widths[i] ?? 1))
          .join("  ")
          .trimEnd(),
      );
    }
    return lines;
  });

  const header = renderedRows[0] ?? [];
  const body = renderedRows.slice(1).flat();
  return [
    ...header,
    widths.map((w) => "─".repeat(w)).join("  "),
    ...body,
  ];
}

function renderTables(text: string, width: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]!)) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
      block.push(lines[i]!);
      i += 1;
    }
    out.push(...formatTable(block, width));
  }
  return out.join("\n");
}

/**
 * Make model-written Markdown readable in a terminal without a renderer.
 *
 * Citations written as 【url】 are moved to a numbered list at the end instead of
 * being deleted: the answer should read cleanly, and a source you cannot check is
 * worthless. Asterisks, hashes and backticks go; tables become columns that fit
 * the terminal.
 */
export function cleanForTerminal(
  text: string,
  width = Math.max(40, (process.stdout.columns ?? 100) - 2),
): string {
  const sources: string[] = [];
  let stripped = text.replace(/【\s*(https?:\/\/[^】\s]+)\s*】/g, (_match, url: string) => {
    let index = sources.indexOf(url);
    if (index === -1) {
      sources.push(url);
      index = sources.length - 1;
    }
    return `[${index + 1}]`;
  });

  stripped = stripped
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`/g, "")
    .replace(/^#{1,6}\s+/gm, "");

  let out = renderTables(stripped, width)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (sources.length && !/^\s*(sources|references)\s*$/im.test(out)) {
    out += `\n\nSources\n${sources.map((url, i) => `${i + 1}. ${url}`).join("\n")}`;
  }
  return out;
}

/**
 * Split a "Sources" / "References" / "Footnotes" heading and everything under it
 * from the answer body. Only a line that is *just* that word counts; a sentence
 * that happens to start with "Sources are…" stays in the body.
 */
export function splitSources(text: string): { body: string; sources: string | null } {
  const lines = text.split("\n");
  const index = lines.findIndex((line) =>
    /^\s*(sources?|references?|footnotes?)\s*:?\s*$/i.test(line),
  );
  if (index === -1) return { body: text, sources: null };
  const body = lines.slice(0, index).join("\n").trim();
  const sources = lines.slice(index + 1).join("\n").trim();
  return { body, sources: sources || null };
}

export function renderResult(a: {
  plan: string;
  changelog: Changelog;
  patch: string;
  assessment: DiffAssessment;
  gate: Gate;
  claims: Claims;
  review: Review;
  checks?: AuditRecord[];
  models?: { drafter: { ref: string }; reviewer: { ref: string } };
  /** The exact text diff. Off by default in the TUI; on in the CLI. */
  includeDiff?: boolean;
}): string {
  const out: string[] = [];
  const counts = verdictCounts(a.claims, a.review);
  const accepted = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "accepted",
  );
  const open = a.gate.decisions.filter((d) => d.choice === "open");
  const untriaged = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "untriaged",
  );

  // The answer first, then its sources in their own section. Everything else is
  // commentary on the answer.
  const answer = splitSources(cleanForTerminal(a.plan));
  out.push(`── the answer ${rule(50)}`);
  out.push(answer.body);
  if (answer.sources) {
    out.push("");
    out.push(`── sources ${rule(49)}`);
    out.push(answer.sources);
  }

  out.push("");
  out.push(`── what happened ${rule(47)}`);
  if (a.models) {
    out.push(`  ${a.models.drafter.ref} wrote it. ${a.models.reviewer.ref} checked it.`);
  }
  out.push(
    `  ${counts.claims} claim(s): ${counts.confirmed} confirmed · ${counts.refuted} refuted · ` +
      `${counts.unverifiable} unverifiable` +
      (counts.noVerdict ? ` · ${counts.noVerdict} without a verdict` : ""),
  );
  out.push(
    `  ${counts.findings} finding(s) — ${accepted.length} accepted, ` +
      `${untriaged.length} left for later, ${counts.findings - accepted.length - untriaged.length} dismissed`,
  );
  const checks = a.checks ?? [];
  if (checks.length) {
    const ran = checks.filter((c) => c.outcome !== "not-run").length;
    const disagreed = checks.filter((c) => c.outcome === "mismatched").length;
    out.push(`  ${ran} check(s) run, ${disagreed} disagreed`);
  }

  out.push("");
  out.push(`── what changed ${rule(48)}`);
  if (a.changelog.changes.length === 0) {
    out.push("  nothing — the answer is unchanged");
  } else {
    for (const c of a.changelog.changes) {
      out.push(`  ${c.item.padEnd(4)} ${c.disposition.padEnd(9)} ${c.summary}`);
    }
  }
  out.push(
    `  diff: ${a.assessment.hunks} hunk(s), ${a.assessment.claimedChanges} claimed change(s)`,
  );
  if (a.assessment.outOfScope) {
    out.push("  !! the text changed but the changelog claims nothing — possible out-of-scope edit");
  } else if (a.assessment.unexplained > 0) {
    out.push(`  !  ${a.assessment.unexplained} hunk(s) not accounted for in the changelog`);
  }

  if (a.includeDiff && a.patch) {
    out.push("");
    out.push(`── exact changes ${rule(46)}`);
    out.push(a.patch.split("\n").map((line) => `  ${line}`).join("\n"));
  }

  if (untriaged.length) {
    out.push("");
    out.push(`── findings left for later ${rule(34)}`);
    for (const f of untriaged) out.push(`  ${f.id}  ${f.text}`);
  }

  out.push("");
  out.push(`── decisions still open ${rule(40)}`);
  out.push(
    open.length
      ? open
          .map((d) => `  ${d.id}  ${a.claims.judgment.find((j) => j.id === d.id)?.text ?? ""}`)
          .join("\n")
      : "  none",
  );

  return out.join("\n");
}
