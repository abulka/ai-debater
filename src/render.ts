import type { AuditRecord, Changelog, Claims, Gate, Review } from "./contracts.ts";
import type { DiffAssessment } from "./diff.ts";
import { verdictCounts } from "./gate-model.ts";
import {
  extractCitations,
  fitHeader,
  fitLines,
  renderMarkdownLines,
  toAnsi,
  wrapWidth,
  type StyledLine,
} from "./markdown.ts";

/**
 * The result: one set of sections, two ways of drawing them.
 *
 * `resultSections` decides *what* the result says — the answer, what happened,
 * what changed, what is still open. It is the only place those counts and
 * sentences are written, so the CLI and the TUI cannot tell two different
 * stories about one run.
 *
 * The answer itself is model-written Markdown and stays Markdown. `renderResult`
 * joins the sections as text (a pipe, a file, `adv run > plan.md`);
 * `renderResultLines` renders the Markdown ones with real styles (the TUI and
 * `renderResultAnsi`). Neither removes anything.
 */

const rule = (n: number) => "─".repeat(n);

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

/**
 * The answer as Markdown, with its citations collected.
 *
 * Nothing is removed: a citation written 【url】 is turned into a numbered
 * marker plus a source list, because a source you cannot check is worthless,
 * and an existing Sources section is the same section. `【url】` is not
 * Markdown, so this is the one place the text is rewritten, and the URL stays.
 */
export function renderAnswer(text: string): { body: string; sources: string | null } {
  const cited = extractCitations(text);
  const hasSources = /^\s*(sources|references)\s*:?\s*$/im.test(cited.text);
  const assembled =
    cited.sources.length && !hasSources
      ? `${cited.text}\n\nSources\n${cited.sources.map((url, i) => `${i + 1}. ${url}`).join("\n")}`
      : cited.text;
  const split = splitSources(assembled);
  // Trailing and leading blank lines would become blank rows in a pane, and the
  // scroll position is computed from the row count.
  return { body: split.body.trim(), sources: split.sources };
}

/** One part of the result: a header, and the body under it. */
interface Section {
  header: string;
  /** The body is model-written Markdown and is rendered, never stripped. */
  markdown?: boolean;
  body: string;
}

/**
 * The result as an ordered list of sections.
 *
 * Both front ends render these, so "what happened" cannot be counted one way in
 * the TUI and another way in the CLI. Only the last step differs: `renderResult`
 * joins the sections as text, `renderResultLines` renders the Markdown ones.
 */
export function resultSections(a: {
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
}): Section[] {
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
  const answer = renderAnswer(a.plan);
  const sections: Section[] = [
    { header: `── the answer ${rule(50)}`, body: answer.body, markdown: true },
  ];
  if (answer.sources) {
    sections.push({ header: `── sources ${rule(49)}`, body: answer.sources, markdown: true });
  }

  const happened: string[] = [];
  if (a.models) {
    happened.push(`  ${a.models.drafter.ref} wrote it. ${a.models.reviewer.ref} checked it.`);
  }
  happened.push(
    `  ${counts.claims} claim(s): ${counts.confirmed} confirmed · ${counts.refuted} refuted · ` +
      `${counts.unverifiable} unverifiable` +
      (counts.noVerdict ? ` · ${counts.noVerdict} without a verdict` : ""),
  );
  happened.push(
    `  ${counts.findings} finding(s) — ${accepted.length} accepted, ` +
      `${untriaged.length} left for later, ${counts.findings - accepted.length - untriaged.length} dismissed`,
  );
  const checks = a.checks ?? [];
  if (checks.length) {
    const ran = checks.filter((c) => c.outcome !== "not-run").length;
    const disagreed = checks.filter((c) => c.outcome === "mismatched").length;
    happened.push(`  ${ran} check(s) run, ${disagreed} disagreed`);
  }
  sections.push({ header: `── what happened ${rule(47)}`, body: happened.join("\n") });

  const changed: string[] = [];
  if (a.changelog.changes.length === 0) {
    changed.push("  nothing — the answer is unchanged");
  } else {
    for (const c of a.changelog.changes) {
      changed.push(`  ${c.item.padEnd(4)} ${c.disposition.padEnd(9)} ${c.summary}`);
    }
  }
  changed.push(
    `  diff: ${a.assessment.hunks} hunk(s), ${a.assessment.claimedChanges} claimed change(s)`,
  );
  if (a.assessment.outOfScope) {
    changed.push(
      "  !! the text changed but the changelog claims nothing — possible out-of-scope edit",
    );
  } else if (a.assessment.unexplained > 0) {
    changed.push(`  !  ${a.assessment.unexplained} hunk(s) not accounted for in the changelog`);
  }
  sections.push({ header: `── what changed ${rule(48)}`, body: changed.join("\n") });

  if (a.includeDiff && a.patch) {
    sections.push({
      header: `── exact changes ${rule(46)}`,
      body: a.patch.split("\n").map((line) => `  ${line}`).join("\n"),
    });
  }

  if (untriaged.length) {
    sections.push({
      header: `── findings left for later ${rule(34)}`,
      body: untriaged.map((f) => `  ${f.id}  ${f.text}`).join("\n"),
    });
  }

  sections.push({
    header: `── decisions still open ${rule(40)}`,
    body: open.length
      ? open
          .map((d) => `  ${d.id}  ${a.claims.judgment.find((j) => j.id === d.id)?.text ?? ""}`)
          .join("\n")
      : "  none",
  });

  return sections;
}

/**
 * The whole result as plain text, Markdown intact.
 *
 * This is what a pipe gets, and what `adv run > plan.md` writes: the answer is
 * Markdown because it is Markdown, and rewriting it into prose for a reader who
 * is not there would be throwing the text away on their behalf.
 */
export function renderResult(a: Parameters<typeof resultSections>[0]): string {
  // A blank line before every section but the first: the rule that separated
  // them when this was one string, kept in one place.
  return resultSections(a)
    .map((section, i) => `${i === 0 ? "" : "\n"}${section.header}\n${section.body}`)
    .join("\n");
}

/**
 * The whole result as styled lines, ready for the TUI or for `toAnsi`.
 *
 * Markdown sections are rendered; the commentary is already shaped text. The
 * headers come from `resultSections`, so both paths describe the same run.
 */
export function renderResultLines(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const [i, section] of resultSections(a).entries()) {
    if (i > 0) out.push([]);
    out.push([{ text: fitHeader(section.header, width), dim: true }]);
    out.push(
      ...(section.markdown
        ? renderMarkdownLines(section.body, width)
        : fitLines(section.body.split("\n"), width)),
    );
  }
  return out;
}

/** The result for a terminal: styled when the terminal can show styles. */
export function renderResultAnsi(a: Parameters<typeof resultSections>[0], width?: number): string {
  return toAnsi(renderResultLines(a, width));
}
