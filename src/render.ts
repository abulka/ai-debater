import type { AuditRecord, Changelog, Claims, Gate, Review } from "./contracts.ts";
import type { DiffAssessment } from "./diff.ts";
import { verdictCounts } from "./gate-model.ts";
import {
  extractCitations,
  fitHeader,
  fitSpans,
  lineText,
  renderMarkdownLines,
  spans,
  toAnsi,
  wrapWidth,
  type Span,
  type StyledLine,
} from "./markdown.ts";
import { THEME } from "./theme.ts";

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

/**
 * One part of the result: a header, and the body under it.
 *
 * Two shapes, because the two kinds of body are genuinely different. The answer
 * is model-written Markdown and its source is what gets rendered; the
 * commentary is the tool's own layout, already spans, because those lines carry
 * colour (a `+` line, a warning) that the plain path simply drops when it joins
 * the text.
 */
interface Section {
  header: string;
  /**
   * Where a wrapped line continues, as a column. The changelog is a row of
   * columns — `V14  fixed  …` — and wrapping its summary back to the margin
   * reads as a new entry rather than as the rest of this one.
   */
  hang?: number;
  /** Markdown source, rendered by `renderMarkdownLines`. */
  markdown?: string;
  /** Laid-out lines, ready to wrap. */
  body?: StyledLine[];
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
    { header: `── the answer ${rule(50)}`, markdown: answer.body },
  ];
  if (answer.sources) {
    sections.push({ header: `── sources ${rule(49)}`, markdown: answer.sources });
  }

  /** Something that needs attention is marked; agreement is never celebrated. */
  const needsAttention = (text: string, when: boolean, colour = THEME.warn): Span =>
    when ? { text, color: colour } : { text };

  const happened: StyledLine[] = [];
  if (a.models) {
    happened.push(
      spans({ text: `  ${a.models.drafter.ref} wrote it. ${a.models.reviewer.ref} checked it.`, dim: true }),
    );
  }
  happened.push(
    spans(
      `  ${counts.claims} claim(s): `,
      needsAttention(`${counts.confirmed} confirmed`, false),
      " · ",
      needsAttention(`${counts.refuted} refuted`, counts.refuted > 0),
      " · ",
      needsAttention(`${counts.unverifiable} unverifiable`, counts.unverifiable > 0),
      ...(counts.noVerdict ? [" · ", needsAttention(`${counts.noVerdict} without a verdict`, true)] : []),
    ),
  );
  happened.push(
    spans(
      `  ${counts.findings} finding(s) — ${accepted.length} accepted, ` +
        `${untriaged.length} left for later, ` +
        `${counts.findings - accepted.length - untriaged.length} dismissed`,
    ),
  );
  const checks = a.checks ?? [];
  if (checks.length) {
    const ran = checks.filter((c) => c.outcome !== "not-run").length;
    const disagreed = checks.filter((c) => c.outcome === "mismatched").length;
    happened.push(
      spans(
        `  ${ran} check(s) run, `,
        needsAttention(`${disagreed} disagreed`, disagreed > 0),
      ),
    );
  }
  sections.push({ header: `── what happened ${rule(47)}`, body: happened, hang: 2 });

  // The two columns size themselves to what is in them, so a wrapped summary
  // lines up under the summary column of every entry.
  const changes = a.changelog.changes;
  const itemWidth = Math.max(4, ...changes.map((c) => c.item.length));
  const dispositionWidth = Math.max(9, ...changes.map((c) => c.disposition.length));
  const changed: StyledLine[] = [];
  if (changes.length === 0) {
    changed.push(spans({ text: "  nothing — the answer is unchanged", dim: true }));
  } else {
    for (const c of changes) {
      // The id is a label, the disposition is a fact about the text, and the
      // summary is the part worth reading. Only the label recedes.
      changed.push(
        spans(
          { text: `  ${c.item.padEnd(itemWidth)}`, dim: true },
          ` ${c.disposition.padEnd(dispositionWidth)} ${c.summary}`,
        ),
      );
    }
  }
  changed.push(
    spans({ text: `  diff: ${a.assessment.hunks} hunk(s), ${a.assessment.claimedChanges} claimed change(s)`, dim: true }),
  );
  if (a.assessment.outOfScope) {
    changed.push(
      spans({
        text: "  !! the text changed but the changelog claims nothing — possible out-of-scope edit",
        color: THEME.danger,
      }),
    );
  } else if (a.assessment.unexplained > 0) {
    changed.push(
      spans({
        text: `  !  ${a.assessment.unexplained} hunk(s) not accounted for in the changelog`,
        color: THEME.warn,
      }),
    );
  }
  sections.push({
    header: `── what changed ${rule(48)}`,
    body: changed,
    // Under the summary column when there are entries, under the indent when
    // there are not: the warnings must not wrap under a column they are not in.
    hang: changes.length ? 2 + itemWidth + 1 + dispositionWidth + 1 : 2,
  });

  if (a.includeDiff && a.patch) {
    sections.push({
      header: `── exact changes ${rule(46)}`,
      // A diff is read by scanning the colour of its margins, which is what
      // colour is for. The `+`/`-` prefixes stay: colour is never the only cue.
      body: a.patch.split("\n").map((line) => {
        const body = line.slice(1);
        const colour = line.startsWith("+")
          ? THEME.code
          : line.startsWith("-")
            ? THEME.danger
            : line.startsWith("@@")
              ? THEME.accent
              : undefined;
        return spans("  ", colour ? { text: line, color: colour } : { text: line });
      }),
      hang: 2,
    });
  }

  if (untriaged.length) {
    const idWidth = Math.max(2, ...untriaged.map((f) => f.id.length));
    sections.push({
      header: `── findings left for later ${rule(34)}`,
      body: untriaged.map((f) =>
        spans({ text: `  ${f.id.padEnd(idWidth)}`, dim: true }, `  ${f.text}`),
      ),
      hang: 2 + idWidth + 2,
    });
  }

  const idWidth = Math.max(2, ...open.map((d) => d.id.length));
  sections.push({
    header: `── decisions still open ${rule(40)}`,
    body: open.length
      ? open.map((d) =>
          spans(
            { text: `  ${d.id.padEnd(idWidth)}`, dim: true },
            `  ${a.claims.judgment.find((j) => j.id === d.id)?.text ?? ""}`,
          ),
        )
      : [spans({ text: "  none", dim: true })],
    hang: 2 + idWidth + 2,
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
/** A section's body as plain text, styles dropped: what a pipe gets. */
const sectionText = (section: Section): string =>
  section.markdown ?? (section.body ?? []).map(lineText).join("\n");

export function renderResult(a: Parameters<typeof resultSections>[0]): string {
  // A blank line before every section but the first: the rule that separated
  // them when this was one string, kept in one place.
  return resultSections(a)
    .map((section, i) => `${i === 0 ? "" : "\n"}${section.header}\n${sectionText(section)}`)
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
    // The rules are how a reader finds a section on a screen of text; that is
    // structure, so it takes the accent rather than receding into dim.
    out.push([{ text: fitHeader(section.header, width), color: THEME.accent, bold: true }]);
    out.push(
      ...(section.markdown !== undefined
        ? renderMarkdownLines(section.markdown, width)
        : fitSpans(section.body ?? [], width, section.hang)),
    );
  }
  return out;
}

/** The result for a terminal: styled when the terminal can show styles. */
export function renderResultAnsi(a: Parameters<typeof resultSections>[0], width?: number): string {
  return toAnsi(renderResultLines(a, width));
}
