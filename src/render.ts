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
 * `councilSections` decides *what* the result says — the answer, what we
 * learned, what happened. It is the only place those sentences are written, so
 * the CLI and the TUI cannot tell two different stories about one run.
 *
 * The answer itself is model-written Markdown and stays Markdown.
 * `renderCouncil` joins the sections as text (a pipe, a file);
 * `renderCouncilLines` renders the Markdown ones with real styles (the TUI and
 * `renderCouncilAnsi`). Neither removes anything.
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
   * Where a wrapped line continues, as a column.
   */
  hang?: number;
  /** Markdown source, rendered by `renderMarkdownLines`. */
  markdown?: string;
  /** Laid-out lines, ready to wrap. */
  body?: StyledLine[];
}

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

/**
 * The result as an ordered list of sections.
 *
 * Both front ends render these, so the answer reads the same in the TUI and
 * the CLI.
 */
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
  /** The run's log, one line each: subject, takes, timings, warnings. */
  log?: string[];
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
  // Absent on runs recorded before the log file existed: those render as
  // before, with no section and no placeholder.
  if (a.log?.length) {
    sections.push({
      header: `── run log ${rule(51)}`,
      body: a.log.map((line) =>
        line.startsWith("!")
          ? spans({ text: `  ${line}`, color: THEME.warn })
          : spans({ text: `  ${line}` }),
      ),
      hang: 2,
    });
  }
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
