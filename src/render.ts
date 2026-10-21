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
import { questionOf } from "./continue.ts";

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
  /** The run's task: shown above the answer. Continued runs show the follow-up. */
  question?: string;
  /** "question" in answer mode, "task" in plan mode. */
  questionLabel?: string;
}): Section[] {
  const counts = verdictCounts(a.claims, a.review);
  const accepted = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "accepted",
  );
  const open = a.gate.decisions.filter((d) => d.choice === "open");
  const untriaged = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "untriaged",
  );

  // The question first (for continued runs: the follow-up, not the payload),
  // then the answer, then its sources. Everything else is commentary.
  const sections: Section[] = [];
  if (a.question?.trim()) {
    sections.push({
      header: `── the ${a.questionLabel ?? "question"} ${rule(48)}`,
      markdown: questionOf(a.question),
    });
  }
  const answer = renderAnswer(a.plan);
  sections.push({ header: `── the answer ${rule(50)}`, markdown: answer.body });
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

/** The header rule takes the accent: it is how a reader finds a section. */
const headerLine = (header: string, width: number): StyledLine => [
  { text: fitHeader(header, width), color: THEME.accent, bold: true },
];

/** A section, header and body, as styled lines. One implementation, two callers. */
function sectionLines(section: Section, width: number): StyledLine[] {
  return [
    headerLine(section.header, width),
    ...(section.markdown !== undefined
      ? renderMarkdownLines(section.markdown, width)
      : fitSpans(section.body ?? [], width, section.hang)),
  ];
}

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
 *
 * Council results (parallel takes + synthesis) render through
 * `councilSections` below: the synthesised answer first, then what we learned.
 */
export function renderResultLines(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const [i, section] of resultSections(a).entries()) {
    if (i > 0) out.push([]);
    out.push(...sectionLines(section, width));
  }
  return out;
}

/**
 * The answer and its sources, nothing else — the result screen's default.
 *
 * The commentary (what happened, what changed, decisions open) is one `i` away,
 * not scrolled above the fold: a reader opening the result wants the answer,
 * and the counts pushed it down the screen.
 *
 * Sections are ordered — answer, sources, then commentary — so "answer-only"
 * is a prefix, and the first non-answer header ends it.
 */
const isAnswerSection = (section: Section): boolean =>
  /^── (the question|the task|the answer|sources) /.test(section.header);

export function renderAnswerOnlyLines(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const section of resultSections(a)) {
    if (!isAnswerSection(section)) break;
    out.push(...sectionLines(section, width));
  }
  return out;
}

/** The complement: what happened, what changed, decisions open — behind `i`. */
export function renderCommentaryLines(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const section of resultSections(a)) {
    if (isAnswerSection(section)) continue;
    out.push(...sectionLines(section, width));
  }
  return out;
}

/**
 * The exact changes on their own, for the pane that shows them.
 *
 * The CLI prints the diff inline, at the end of the result, which is right for
 * a pipe and wrong for a pane: the diff is 30 rows of the 60, so a reader had
 * to scroll past everything to find it, and toggling it looked like it did
 * nothing. The panel asks for the same section instead of drawing it twice.
 */
export function renderDiffLines(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const section = resultSections({ ...a, includeDiff: true }).find((s) =>
    s.header.startsWith("── exact changes"),
  );
  return section ? sectionLines(section, width) : [];
}

/** Why an authorised item was in scope, and who put it there. */
interface Cause {
  label: string;
  text: string;
  detail: string;
  colour: string | undefined;
}

/** The items the rebuttal was authorised to touch, by id. */
function authorisedCauses(a: Parameters<typeof resultSections>[0]): Map<string, Cause> {
  const causes = new Map<string, Cause>();

  for (const v of a.review.verdicts) {
    if (v.verdict !== "refuted") continue;
    causes.set(v.id, {
      label: "refuted",
      text: a.claims.verifiable.find((c) => c.id === v.id)?.text ?? "",
      detail: v.note ? `${v.evidence} — ${v.note}` : v.evidence,
      colour: THEME.warn,
    });
  }

  const acceptedIds = new Set(
    a.gate.findings.filter((f) => f.disposition === "accepted").map((f) => f.id),
  );
  for (const f of a.review.extra_findings) {
    if (!acceptedIds.has(f.id)) continue;
    causes.set(f.id, {
      label: "accepted",
      text: f.text,
      detail: f.evidence ?? f.note ?? "",
      colour: THEME.accent,
    });
  }

  for (const d of a.gate.decisions) {
    if (d.choice === "open") continue;
    causes.set(d.id, {
      label: "you chose",
      text: a.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
      detail: d.choice,
      colour: THEME.accent,
    });
  }

  return causes;
}

/**
 * What each change was for.
 *
 * The diff says what changed; the changelog says what the writer claims it did;
 * neither says *why*. The reason lives in three places already in hand: the
 * reviewer refuted a claim, the reviewer raised a finding you accepted, or you
 * made a judgment call at the gate. This joins them by item id.
 *
 * By item id, never by hunk. `assessDiff` counts hunks against changelog
 * entries and cannot map one to the other, so nothing here pretends that a
 * particular hunk was caused by a particular item — it says which items were
 * authorised and what the writer reported doing about each.
 *
 * Two absences matter as much as the entries, and both are shown: a change to
 * an item that was never authorised, and an authorised item the changelog says
 * nothing about.
 */
export function changeReasons(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const causes = authorisedCauses(a);
  const changes = a.changelog.changes;
  if (causes.size === 0 && changes.length === 0) return [];

  const itemWidth = Math.max(4, ...changes.map((c) => c.item.length));
  const dispositionWidth = Math.max(9, ...changes.map((c) => c.disposition.length));
  // The same columns as "what changed", so the two panes line up.
  const column = 2 + itemWidth + 1 + dispositionWidth + 1;
  const pad = (n: number) => " ".repeat(n);
  const out: StyledLine[] = [];

  /** Fit one logical line at its own hanging column. */
  const put = (line: StyledLine, hang: number) => out.push(...fitSpans([line], width, hang));

  for (const c of changes) {
    put(
      spans(
        { text: `  ${c.item.padEnd(itemWidth)}`, dim: true },
        ` ${c.disposition.padEnd(dispositionWidth)} ${c.summary}`,
      ),
      column,
    );
    const cause = causes.get(c.item);
    if (cause) {
      put(
        spans(pad(column), { text: cause.label.padEnd(9), color: cause.colour, bold: true }, cause.text),
        column + 10,
      );
      if (cause.detail) {
        put(spans(pad(column + 9), { text: cause.detail, dim: true }), column + 10);
      }
    } else {
      put(
        spans(pad(column), {
          text: "not in the authorised scope — the writer changed something it was not asked to",
          color: THEME.danger,
        }),
        column,
      );
    }
    if (c.evidence) {
      put(
        spans(
          { text: `${pad(column)}the writer cited `, dim: true },
          { text: c.evidence, color: THEME.code },
        ),
        column + 10,
      );
    }
  }

  const claimed = new Set(changes.map((c) => c.item));
  for (const [id, cause] of causes) {
    if (claimed.has(id)) continue;
    put(
      spans(
        { text: `  ${id.padEnd(itemWidth)}`, dim: true },
        { text: " nothing  ", color: THEME.warn },
        { text: "authorised", color: THEME.warn },
      ),
      column,
    );
    put(
      spans(pad(column), {
        text: "the writer was asked to change this and the changelog says nothing",
        color: THEME.warn,
      }),
      column,
    );
    if (cause.text) put(spans(pad(column), { text: cause.text, dim: true }), column);
  }

  return out;
}

/**
 * The scope, in one row: what the rebuttal was allowed to touch, and how each
 * item got there. The tool already says this while it runs ("in scope: …"), and
 * a reader opening the diff deserves the same sentence.
 */
function scopeLede(causes: [string, Cause][]): StyledLine {
  const parts: Span[] = [{ text: "in scope: ", dim: true }];
  for (const [id, cause] of causes.slice(0, 4)) {
    if (parts.length > 1) parts.push({ text: " · ", dim: true });
    parts.push({ text: id, color: THEME.accent, bold: true }, { text: ` ${cause.label}`, color: cause.colour });
  }
  if (causes.length > 4) parts.push({ text: ` · +${causes.length - 4} more`, dim: true });
  return parts;
}

/**
 * The diff pane: the exact changes, then what each change was for.
 *
 * The diff is 30 rows of the 60, which is why it is a pane and not a section of
 * the result — and having opened a pane for it, the reasons fit beside it
 * rather than in a third place.
 */
export function diffPane(
  a: Parameters<typeof resultSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const diff = renderDiffLines(a, width);
  const reasons = changeReasons(a, width);
  const causes = [...authorisedCauses(a).entries()];
  const out: StyledLine[] = [];
  if (causes.length) out.push(...fitSpans([scopeLede(causes)], width, 0));
  out.push(...diff);
  if (diff.length && reasons.length) out.push([]);
  if (reasons.length) {
    out.push(headerLine(`── what it was changed for ${rule(38)}`, width));
    out.push(...reasons);
  }
  return out;
}

/** The result for a terminal: styled when the terminal can show styles. */
export function renderResultAnsi(a: Parameters<typeof resultSections>[0], width?: number): string {
  return toAnsi(renderResultLines(a, width));
}

/* ------------------------------------------------------------------ *
 * Council — parallel takes plus one synthesis.
 * ------------------------------------------------------------------ */

/** Council result: the synthesised answer, what was learned, and the takes. */
export function councilSections(a: {
  final: string;
  learned: string;
  takes: { index: number; model: { ref: string }; text: string }[];
  patch?: string;
  models?: { drafter: { ref: string }; reviewer: { ref: string }; peer?: { ref: string } | null };
  /** The run's task: shown above the answer. Continued runs show the follow-up. */
  question?: string;
  /** "question" in answer mode, "task" in plan mode. */
  questionLabel?: string;
}): Section[] {
  const sections: Section[] = [];
  if (a.question?.trim()) {
    sections.push({
      header: `── the ${a.questionLabel ?? "question"} ${rule(48)}`,
      markdown: questionOf(a.question),
    });
  }
  const answer = renderAnswer(a.final);
  sections.push({ header: `── the answer ${rule(50)}`, markdown: answer.body });
  if (answer.sources) sections.push({ header: `── sources ${rule(49)}`, markdown: answer.sources });
  if (a.learned.trim()) {
    sections.push({ header: `── what we learned ${rule(43)}`, markdown: a.learned });
  }
  const happened: StyledLine[] = [];
  if (a.models) {
    const who = [a.models.drafter.ref, a.models.reviewer.ref, ...(a.models.peer ? [a.models.peer.ref] : [])];
    happened.push(spans({ text: `  ${who.join(" · ")} took part; ${a.models.drafter.ref} synthesised.`, dim: true }));
  }
  happened.push(
    spans({ text: `  takes: ${a.takes.map((t) => `take ${t.index} (${t.model.ref})`).join(" · ")}`, dim: true }),
  );
  sections.push({ header: `── what happened ${rule(47)}`, body: happened, hang: 2 });
  if (a.patch) {
    sections.push({
      header: `── exact changes ${rule(46)}`,
      body: a.patch.split("\n").map((line) => {
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
  return sections;
}

export function renderCouncil(a: Parameters<typeof councilSections>[0]): string {
  return councilSections(a)
    .map((section, i) => `${i === 0 ? "" : "\n"}${section.header}\n${sectionText(section)}`)
    .join("\n");
}

export function renderCouncilLines(
  a: Parameters<typeof councilSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const [i, section] of councilSections(a).entries()) {
    if (i > 0) out.push([]);
    out.push(...sectionLines(section, width));
  }
  return out;
}

/** The council's question, final answer and sources — the result screen's default. */
export function renderCouncilAnswerLines(
  a: Parameters<typeof councilSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const section of councilSections(a)) {
    if (!/^── (the question|the task|the answer|sources) /.test(section.header)) break;
    out.push(...sectionLines(section, width));
  }
  return out;
}

/** The complement: what we learned, what happened, the diff — behind `i`/`x`. */
export function renderCouncilCommentaryLines(
  a: Parameters<typeof councilSections>[0],
  width = wrapWidth(),
): StyledLine[] {
  const out: StyledLine[] = [];
  for (const section of councilSections(a)) {
    if (/^── (the question|the task|the answer|sources) /.test(section.header)) continue;
    out.push(...sectionLines(section, width));
  }
  return out;
}

export function renderCouncilAnsi(a: Parameters<typeof councilSections>[0], width?: number): string {
  return toAnsi(renderCouncilLines(a, width));
}
