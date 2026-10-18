/**
 * Markdown → styled terminal lines.
 *
 * Model-written Markdown used to be made readable by erasing it: hashes,
 * asterisks and backticks were stripped and what was left was plain text. That
 * threw away the one thing a terminal can do well — headings that stand out,
 * code that does not read as prose — and it destroyed the text on the way to
 * the reader, who often wanted to copy it.
 *
 * This module keeps the structure and consumes the syntax: it parses Markdown
 * into lines of styled spans, so `**bold**` is rendered bold and nothing is
 * removed from the text itself.
 *
 * Two rules shape the whole design.
 *
 * 1. **Every line is wrapped here, not by Ink.** One `StyledLine` must equal
 *    one row on screen. The result pane scrolls by line offset and its
 *    arithmetic (`clampOffset`, `maxOffset`) counts array elements; let Ink
 *    wrap a long line and the count stops matching what the human sees. Every
 *    long run — a paragraph, a URL, a line of code — is broken to fit, and a
 *    word that cannot fit is split rather than allowed to overflow.
 * 2. **No dependency.** The table renderer below already made this choice for
 *    the same reason: a terminal is not a browser, and a Markdown library that
 *    emits ANSI would fight the one that emitted the styles.
 *
 * Emphasis follows the Markdown rule that `_` cannot open a word: `run_audit_now`
 * stays as written, because an underscore inside an identifier is not emphasis.
 * `__init__` is bold, as it is on GitHub and in any CommonMark renderer —
 * pretending otherwise would be this renderer being clever about the text
 * instead of rendering it.
 */

/** One run of text with one style. Styles compose: `{ bold: true, dim: true }`. */
export interface Span {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
}

export type StyledLine = Span[];

/** Plain lines as styled lines, so a pane has exactly one input shape. */
export const textLines = (lines: string[]): StyledLine[] => lines.map((text) => [{ text }]);

/** The default wrap width: the terminal minus the two columns of pane margin. */
export const wrapWidth = (): number => Math.max(40, (process.stdout.columns ?? 100) - 2);

/* ------------------------------------------------------------------ *
 * Citations
 * ------------------------------------------------------------------ */

/**
 * Move citations written as 【url】 to a numbered list.
 *
 * A source you cannot check is worthless, so the URL is not deleted: it is
 * replaced by a `[n]` marker and collected into a list at the end.
 */
export function extractCitations(text: string): { text: string; sources: string[] } {
  const sources: string[] = [];
  const stripped = text.replace(/【\s*(https?:\/\/[^】\s]+)\s*】/g, (_match, url: string) => {
    let index = sources.indexOf(url);
    if (index === -1) {
      sources.push(url);
      index = sources.length - 1;
    }
    return `[${index + 1}]`;
  });
  return { text: stripped, sources };
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

/**
 * Word-wrap for a table cell; a terminal is not a browser.
 *
 * A word that cannot fit the column is split, not allowed to overflow: a table
 * cell is usually a path or a URL, which has no spaces to wrap at, and a cell
 * that overflows its column sets a row wider than the pane.
 */
function wrapWords(text: string, width: number): string[] {
  const usable = Math.max(1, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word.length > usable) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += usable) lines.push(word.slice(i, i + usable));
      continue;
    }
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
export function formatTable(block: string[], width: number): string[] {
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

/** The separator row `formatTable` writes: all rules and spaces, nothing else. */
const isRuleRow = (line: string): boolean => line.length > 0 && /^[─\s]+$/.test(line);

/* ------------------------------------------------------------------ *
 * Inline spans
 * ------------------------------------------------------------------ */

const spanLength = (spans: Span[]): number => spans.reduce((n, s) => n + s.text.length, 0);

/**
 * Parse inline Markdown into styled spans.
 *
 * A scanner rather than a chain of `replace` calls: each rule must be tried at
 * the current position and skipped if it does not apply, or `3 * 4 = 12` turns
 * into italics. When nothing applies, plain text is emitted up to the next
 * character that could start something, which also guarantees the loop
 * advances.
 */
/** `_` opens emphasis only at a word boundary — never inside `run_audit_now`. */
const atWordStart = (text: string, i: number): boolean => i === 0 || !/\w/.test(text[i - 1]!);

/** `_x_` and `__x__` must close before a non-word character, as CommonMark says. */
const CLOSES = "(?=\\s|$|[.,;:)])";

export function inline(text: string): Span[] {
  const spans: Span[] = [];
  const push = (t: string, style: Omit<Span, "text"> = {}) => {
    if (t) spans.push({ ...style, text: t });
  };

  const rules: { re: RegExp; style: Omit<Span, "text">; underscore?: boolean }[] = [
    { re: /^`([^`]+)`/, style: { color: "cyan" } },
    { re: /^\*\*([^*]+)\*\*/, style: { bold: true } },
    { re: new RegExp(`^__([^_]+)__${CLOSES}`), style: { bold: true }, underscore: true },
    { re: /^~~([^~]+)~~/, style: { strike: true } },
    { re: /^\*([^*\s][^*]*?)\*/, style: { italic: true } },
    { re: new RegExp(`^_([^_\\s][^_]*?)_${CLOSES}`), style: { italic: true }, underscore: true },
  ];

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;

    // Links come first: a URL can contain every other delimiter.
    const image = rest.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/);
    const link = image ? null : rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (image) {
      // An image cannot be shown, so the alt text stands in for it.
      push(image[1] || image[2]!, { dim: true });
      if (image[1]) push(` (${image[2]})`, { dim: true });
      i += image[0].length;
      continue;
    }
    if (link) {
      push(link[1]!, { underline: true });
      // "see https://x" is noise when the text already is the address.
      if (link[1] !== link[2]) push(` (${link[2]})`, { dim: true });
      i += link[0].length;
      continue;
    }

    for (const rule of rules) {
      if (rule.underscore && !atWordStart(text, i)) continue;
      const m = rest.match(rule.re);
      if (!m) continue;
      push(m[1]!, rule.style);
      i += m[0].length;
      matched = true;
      break;
    }
    if (matched) continue;

    // Nothing applies here: emit plain text up to the next character that could
    // start something. Progress is guaranteed — the search starts at i + 1.
    const next = text.slice(i + 1).search(/[`*~\[_]/);
    const end = next === -1 ? text.length : i + 1 + next;
    push(text.slice(i, end));
    i = end;
  }
  return spans;
}

/* ------------------------------------------------------------------ *
 * Fitting spans to the terminal
 * ------------------------------------------------------------------ */

/** Break a word that cannot fit on any line into pieces of at most `limit`. */
function chunkWord(word: Span[], limit: number): Span[][] {
  const chunks: Span[][] = [];
  let current: Span[] = [];
  let used = 0;

  for (const span of word) {
    let text = span.text;
    while (text.length) {
      const room = limit - used;
      if (room <= 0) {
        chunks.push(current);
        current = [];
        used = 0;
        continue;
      }
      const take = text.slice(0, room);
      current.push({ ...span, text: take });
      used += take.length;
      text = text.slice(room);
      if (text.length) {
        chunks.push(current);
        current = [];
        used = 0;
      }
    }
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

/** Split styled spans into words, so a break can only happen between them. */
function toWords(spans: Span[]): Span[][] {
  const words: Span[][] = [];
  let current: Span[] = [];
  for (const span of spans) {
    for (const part of span.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (current.length) {
          words.push(current);
          current = [];
        }
      } else {
        current.push({ ...span, text: part });
      }
    }
  }
  if (current.length) words.push(current);
  return words;
}

/**
 * Greedy-wrap spans into lines, exactly as wide as they need to be no wider.
 *
 * `firstIndent` / `restIndent` are the hanging prefixes (a list marker and the
 * spaces that line up under it) and both count against the width, so a wrapped
 * list item stays under its own marker instead of running to the margin.
 * Indents are dim: they are scaffolding, not text.
 */
export function wrapSpans(words: Span[][], width: number, firstIndent = "", restIndent = ""): StyledLine[] {
  const out: StyledLine[] = [];
  let indent = firstIndent;
  let line: Span[] = [];
  let length = 0;

  const emit = () => {
    const prefix: Span[] = indent ? [{ text: indent, dim: true }] : [];
    out.push([...prefix, ...line]);
    line = [];
    length = 0;
    indent = restIndent;
  };

  const queue: Span[][] = [];
  for (const word of words) {
    const room = Math.max(8, width - indent.length);
    const size = spanLength(word);
    queue.push(...(size > room ? chunkWord(word, room) : [word]));
  }

  for (const word of queue) {
    const size = spanLength(word);
    const room = width - indent.length;
    if (line.length && length + 1 + size > room) emit();
    if (line.length) {
      line.push({ text: " " });
      length += 1;
    }
    line.push(...word);
    length += size;
  }

  if (line.length || out.length === 0) emit();
  return out;
}

/**
 * Plain lines, hard-broken to the width.
 *
 * The same invariant as the Markdown renderer, for text that is not Markdown:
 * the pane's scroll arithmetic counts array elements, so one element has to be
 * one row. A patch line, a changelog summary and a header rule all pass through
 * here.
 */
export function fitLines(lines: string[], width = wrapWidth()): StyledLine[] {
  const room = Math.max(8, width);
  return lines.flatMap((line) => chunkWord([{ text: line }], room));
}

/**
 * Re-fit a section header to the terminal.
 *
 * The headers are fixed-width rules (`── what happened ` plus dashes), which is
 * right for text going into a pipe and wrong for a pane: at 60 columns a
 * 64-column rule wraps, and a wrapped line is a line the scroll count cannot
 * see. The label is kept; only the dash run changes.
 */
export function fitHeader(header: string, width: number): string {
  const m = header.match(/^─+ (.+?) ─+$/);
  if (!m) return header;
  const prefix = `── ${m[1]} `;
  return prefix + "─".repeat(Math.max(0, width - prefix.length));
}

/** A block of Markdown, before it becomes lines. */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; items: { marker: string; depth: number; text: string }[] }
  | { kind: "code"; info: string; lines: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; lines: string[] }
  | { kind: "rule" };

const FENCE = /^(\s*)(```+|~~~+)\s*(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Split Markdown into blocks. Paragraphs are joined lines, not one per line. */
function blocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2]!;
      const info = fence[3]!.trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence, or the end of the text
      out.push({ kind: "code", info, lines: body });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = lines[i]!.match(QUOTE);
        if (!q) break;
        body.push(q[1]!);
        i += 1;
      }
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    if (TABLE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && TABLE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      out.push({ kind: "table", lines: body });
      continue;
    }

    if (ITEM.test(line)) {
      const items: { marker: string; depth: number; text: string }[] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(ITEM);
        if (!item) break;
        // Two spaces per level, which is what models actually emit.
        const depth = Math.min(4, Math.floor(item[1]!.length / 2));
        const ordered = /\d/.test(item[2]!);
        items.push({
          marker: ordered ? item[2]!.replace(")", ".") : "•",
          depth,
          text: item[3]!,
        });
        i += 1;
      }
      out.push({ kind: "list", items });
      continue;
    }

    // A paragraph: consecutive ordinary lines, joined.
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        !next.trim() ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        RULE.test(next) ||
        QUOTE.test(next) ||
        TABLE.test(next) ||
        ITEM.test(next)
      ) {
        break;
      }
      body.push(next.trim());
      i += 1;
    }
    out.push({ kind: "para", text: body.join(" ") });
  }

  return out;
}

/**
 * Render Markdown to styled lines that each fit `width`.
 *
 * Block spacing is a single blank line between blocks, never two and never a
 * leading one: the pane above and below the text supplies its own margin, and
 * a leading blank would make the scroll position disagree with the text.
 */
export function renderMarkdownLines(md: string, width = wrapWidth()): StyledLine[] {
  const out: StyledLine[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1]!.length) out.push([]);
  };
  const pushAll = (lines: StyledLine[]) => out.push(...lines);

  for (const block of blocks(md)) {
    blank();

    if (block.kind === "heading") {
      const style = block.level === 1 ? { bold: true, underline: true } : { bold: true };
      pushAll(wrapSpans(toWords(inline(block.text).map((s) => ({ ...style, ...s }))), width));
      continue;
    }

    if (block.kind === "para") {
      pushAll(wrapSpans(toWords(inline(block.text)), width));
      continue;
    }

    if (block.kind === "list") {
      for (const item of block.items) {
        const marker = `${"  ".repeat(item.depth)}${item.marker} `;
        pushAll(
          wrapSpans(toWords(inline(item.text)), width, marker, " ".repeat(marker.length)),
        );
      }
      continue;
    }

    if (block.kind === "code") {
      if (block.info) pushAll([[{ text: block.info, dim: true }]]);
      for (const line of block.lines) {
        // Code is not re-flowed at word boundaries — that would change what it
        // says. A line too long for the pane is broken where it must be, and
        // the continuation is marked so it is not read as a new line. The
        // continuation marker is four columns wide, so it sets the room.
        const room = Math.max(8, width - 4);
        const chunks = chunkWord([{ text: line }], room);
        chunks.forEach((chunk, index) => {
          pushAll([[{ text: index === 0 ? "│ " : "│   ", dim: true }, ...chunk]]);
        });
      }
      continue;
    }

    if (block.kind === "quote") {
      // Rendered as Markdown in its own right, then barred: nesting and lists
      // inside a quote then need no special case.
      const inner = renderMarkdownLines(block.text, Math.max(8, width - 2));
      for (const line of inner) pushAll([[{ text: "│ ", dim: true }, ...line]]);
      continue;
    }

    if (block.kind === "table") {
      const rendered = formatTable(block.lines, width);
      let headerDone = false;
      for (const line of rendered) {
        let style: Span = { text: line };
        if (isRuleRow(line)) {
          headerDone = true;
          style = { text: line, dim: true };
        } else if (!headerDone) {
          style = { text: line, bold: true };
        }
        // Too many columns to shrink into the pane is the one way a table can
        // still outgrow it. The row is broken rather than drawn wide, because a
        // wide line is a line the pane cannot scroll to.
        pushAll(chunkWord([style], Math.max(8, width)));
      }
      continue;
    }

    if (block.kind === "rule") pushAll([[{ text: "─".repeat(Math.max(8, width)), dim: true }]]);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * The same lines, as ANSI
 * ------------------------------------------------------------------ */

const CODES: Record<string, number> = { cyan: 36, green: 32, yellow: 33, red: 31, magenta: 35, blue: 34 };

/**
 * Styled lines as ANSI, for the CLI.
 *
 * The CLI and the TUI render the same lines; only the delivery differs. There
 * is deliberately no second plain-text implementation, because two renderers
 * drift and then the two front ends describe one run two ways.
 *
 * Every span is reset rather than relying on the next one to do it: a bold run
 * that ends at a line break must not make the following line bold.
 */
export function toAnsi(lines: StyledLine[]): string {
  return lines
    .map((line) =>
      line
        .map((span) => {
          const codes: number[] = [];
          if (span.bold) codes.push(1);
          if (span.dim) codes.push(2);
          if (span.italic) codes.push(3);
          if (span.underline) codes.push(4);
          if (span.strike) codes.push(9);
          if (span.color && CODES[span.color]) codes.push(CODES[span.color]!);
          return codes.length ? `\u001b[${codes.join(";")}m${span.text}\u001b[0m` : span.text;
        })
        .join(""),
    )
    .join("\n");
}
