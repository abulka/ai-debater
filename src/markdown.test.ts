import { describe, expect, test } from "bun:test";
import {
  extractCitations,
  formatTable,
  inline,
  renderMarkdownLines,
  textLines,
  toAnsi,
  type Span,
  type StyledLine,
} from "./markdown.ts";

/** One span as a readable string: a marker per style, then the text. */
const show = (s: Span): string =>
  `${s.bold ? "b" : ""}${s.dim ? "d" : ""}${s.italic ? "i" : ""}${s.underline ? "u" : ""}` +
  `${s.strike ? "s" : ""}${s.color ? `(${s.color})` : ""}${s.text}`;

/** A line with its styles shown, for compact assertions. */
const lineOf = (line: StyledLine): string => line.map(show).join("");
const render = (md: string, width = 80): string[] => renderMarkdownLines(md, width).map(lineOf);

/** Only the spans that carry a style: the text is asserted separately. */
const styled = (text: string): string[] =>
  inline(text)
    .filter((s) => Object.keys(s).length > 1)
    .map(show);

/** The width that matters: what the pane will draw, markers excluded. */
const widthOf = (line: StyledLine): number => line.reduce((n, s) => n + s.text.length, 0);
const plain = (line: StyledLine): string => line.map((s) => s.text).join("");

describe("inline", () => {
  test("bold, italic, code, strike and links each carry a style", () => {
    expect(styled("**b** *i* `c` ~~s~~ [t](https://x)")).toEqual([
      "bb",
      "ii",
      "(cyan)c",
      "ss",
      "ut",
      "d (https://x)",
    ]);
  });

  test("the markers themselves are gone", () => {
    expect(inline("**bold** and *italic* and `code`").map((s) => s.text).join("")).toBe(
      "bold and italic and code",
    );
  });

  test("a link whose text is the URL is not written twice", () => {
    expect(lineOf(inline("[https://example.com/x](https://example.com/x)"))).toBe(
      "uhttps://example.com/x",
    );
  });

  test("arithmetic is not italics", () => {
    expect(lineOf(inline("3 * 4 = 12"))).toBe("3 * 4 = 12");
  });

  test("an underscore inside an identifier is not emphasis", () => {
    expect(lineOf(inline("run_audit_now and src/rate_limit.ts"))).toBe(
      "run_audit_now and src/rate_limit.ts",
    );
  });

  test("an asterisk with no partner stays as text", () => {
    expect(lineOf(inline("a *b and no closer here"))).toBe("a *b and no closer here");
    expect(lineOf(inline("2 * 3 * 4"))).toBe("2 * 3 * 4");
  });

  test("bold containing italic — a real line from a run — renders as both", () => {
    // From 2026-10-18T01-46-53: the reviewer never saw this, the human did.
    // Refusing the inner star did not just miss the bold: the single-star rule
    // then matched across the sentence and left a stray `*` at each end.
    const line =
      "**Original *Law & Order* ranks first, *Law & Order: SVU* second, and " +
      "*Criminal Intent* third.** The ordering reflects peak ratings first.";
    expect(plain(inline(line))).toBe(
      "Original Law & Order ranks first, Law & Order: SVU second, and " +
        "Criminal Intent third. The ordering reflects peak ratings first.",
    );
    expect(styled(line)).toEqual([
      "bOriginal ",
      "biLaw & Order",
      "b ranks first, ",
      "biLaw & Order: SVU",
      "b second, and ",
      "biCriminal Intent",
      "b third.",
    ]);
  });

  test("italic containing bold, the other way round, also composes", () => {
    // The middle carries both styles, which is what nested emphasis means.
    expect(styled("*a **b** c*")).toEqual(["ia ", "bib", "i c"]);
  });

  test("a marker run that opens nothing stays whole", () => {
    expect(lineOf(inline("trailing stars **"))).toBe("trailing stars **");
    expect(lineOf(inline("a **b and c"))).toBe("a **b and c");
  });

  test("a single star closes on a single star", () => {
    // `*b and c**d` is ambiguous — CommonMark reads emphasis here, at the cost
    // of a stray star. Leaving the markers as written beats guessing and
    // putting a star on screen that the model never wrote at that position.
    expect(lineOf(inline("a *b and c**d"))).toBe("a *b and c**d");
  });
});

describe("headings", () => {
  test("h1 is bold and underlined; deeper levels are bold", () => {
    expect(render("# Title")).toEqual(["buTitle"]);
    expect(render("### Deeper")).toEqual(["bDeeper"]);
  });

  test("the hashes do not survive", () => {
    expect(render("## Approach")[0]).not.toContain("#");
  });

  test("a closing hash run is not part of the heading", () => {
    expect(render("## Approach ##")).toEqual(["bApproach"]);
  });
});

describe("paragraphs and lists", () => {
  test("a paragraph is one logical block, wrapped to the width", () => {
    const lines = render("one two three four five six seven eight", 20);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("bullets are marked and hang on their indent", () => {
    const lines = renderMarkdownLines("- alpha beta gamma delta epsilon zeta", 20);
    expect(lineOf(lines[0]!).startsWith("d• ")).toBe(true);
    expect(lineOf(lines[1]!).startsWith("d  ")).toBe(true);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(20);
  });

  test("an ordered list keeps its numbers", () => {
    expect(render("1. first\n2. second")).toEqual(["d1. first", "d2. second"]);
  });

  test("nested items are indented further", () => {
    const lines = render("- outer\n  - inner");
    expect(lines[0]!.startsWith("d• outer")).toBe(true);
    expect(lines[1]!.startsWith("d  • inner")).toBe(true);
  });
});

describe("code", () => {
  test("the fence never reaches the screen, and the language is kept", () => {
    const lines = render("```ts\nconst x = 1;\n```");
    expect(lines[0]).toBe("dts");
    expect(lines[1]).toBe("d│ const x = 1;");
    expect(lines.join("\n")).not.toContain("`");
  });

  test("a long code line is broken, not wrapped at a space", () => {
    const lines = renderMarkdownLines(`\`\`\`\n${"x".repeat(50)}\n\`\`\``, 20);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(20);
    // Broken, so every character is still present exactly once.
    expect(lines.map(plain).join("").replace(/│\s*/g, "")).toBe("x".repeat(50));
  });

  test("a code fence's info string is not read as prose", () => {
    expect(render("```\nplain\n```")).toEqual(["d│ plain"]);
  });
});

describe("quotes, rules and tables", () => {
  test("a quote is barred and its Markdown still rendered", () => {
    const lines = render("> **important** point");
    expect(lines[0]).toBe("d│ bimportant point");
  });

  test("a rule becomes a rule, not three hyphens", () => {
    expect(render("---")[0]).toMatch(/^d─+$/);
  });

  test("a table cell holding a URL is broken, not allowed to overflow", () => {
    // From a real run: a table of citations, every cell a long URL.
    const md = [
      "| # | Title | Year | Source |",
      "| --- | --- | --- | --- |",
      "| 1 | Consider Phlebas | 1987 | https://en.wikipedia.org/wiki/Consider_Phlebas |",
    ].join("\n");
    const lines = renderMarkdownLines(md, 60);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(60);
    // Split, not dropped.
    expect(lines.map(plain).join("").replace(/\s/g, "")).toContain("Consider_Phlebas");
  });

  test("a table with more columns than fit is broken, not drawn wide", () => {
    // Six columns of long cells: they cannot be shrunk below the minimum, so
    // the row itself has to give.
    const cell = "unbreakable-cell-text";
    const md = [
      `| ${cell} | ${cell} | ${cell} | ${cell} | ${cell} | ${cell} |`,
      "| --- | --- | --- | --- | --- | --- |",
      `| ${cell} | ${cell} | ${cell} | ${cell} | ${cell} | ${cell} |`,
    ].join("\n");
    const lines = renderMarkdownLines(md, 30);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(30);
  });

  test("tables align, the header is bold and the pipes are gone", () => {
    const lines = renderMarkdownLines("| Song | Why |\n| --- | --- |\n| Cabaret | title |", 80);
    expect(plain(lines[0]!)).toMatch(/^Song\s+Why/);
    expect(lines[0]!.every((span) => span.bold)).toBe(true);
    expect(lineOf(lines[1]!)).toMatch(/^d─+\s+─+/);
    expect(plain(lines[2]!)).toMatch(/^Cabaret\s+title/);
    expect(lines.map(plain).join("\n")).not.toContain("|");
  });
});

describe("layout", () => {
  test("no line is wider than the width", () => {
    const md = [
      "# Heading",
      "",
      "- a bullet with quite a lot of words in it that has to wrap somewhere",
      "",
      "| a | b |",
      "| --- | --- |",
      "| one | two |",
      "",
      "> a quoted paragraph that is long enough to need wrapping at this width",
      "",
      "```",
      "a code line that is definitely longer than the width we asked for",
      "```",
    ].join("\n");
    for (const width of [40, 60, 100]) {
      for (const line of renderMarkdownLines(md, width)) {
        expect(widthOf(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("one block is separated from the next by one blank line", () => {
    expect(render("# A\n\nparagraph\n\n# B")).toEqual(["buA", "", "paragraph", "", "buB"]);
  });

  test("a long URL is split rather than overhanging", () => {
    const url = `https://example.com/${"segment/".repeat(8)}`;
    const lines = renderMarkdownLines(url, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(30);
  });

  test("textLines gives plain lines the same shape", () => {
    expect(textLines(["a", "b"])).toEqual([[{ text: "a" }], [{ text: "b" }]]);
  });
});

describe("extractCitations", () => {
  test("collects each URL once, in order", () => {
    const { text, sources } = extractCitations("a 【https://x/1】 b 【https://x/2】 c 【https://x/1】");
    expect(text).toBe("a [1] b [2] c [1]");
    expect(sources).toEqual(["https://x/1", "https://x/2"]);
  });
});

describe("formatTable", () => {
  test("a wide table is shrunk to fit", () => {
    const cell = "a fairly long cell that must wrap ".repeat(3).trim();
    const lines = formatTable(["| One | Two |", "|-----|-----|", `| ${cell} | ${cell} |`], 60);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(60);
    expect(lines.map(plain).join(" ")).toContain("wrap");
  });

  test("a cell's emphasis is rendered, and its markers are not measured", () => {
    const lines = formatTable(["| A | B |", "| --- | --- |", "| **bold** | plain |"], 60);
    const header = plain(lines[0]!);
    const body = plain(lines[2]!);
    expect(body).toContain("bold");
    expect(body).not.toContain("**");
    // A column is as wide as its text, not as wide as its markers.
    expect(header.indexOf("B")).toBe(body.indexOf("plain"));
  });
});

describe("toAnsi", () => {
  test("styles are emitted and reset per span", () => {
    expect(toAnsi([[{ text: "B", bold: true }, { text: " plain" }]])).toBe(
      "\u001b[1mB\u001b[0m plain",
    );
  });

  test("a bold line does not bleed into the next", () => {
    const out = toAnsi([[{ text: "a", bold: true }], [{ text: "b" }]]);
    expect(out).toBe("\u001b[1ma\u001b[0m\nb");
  });

  test("an unstyled line is exactly its text", () => {
    expect(toAnsi([[{ text: "plain" }]])).toBe("plain");
  });
});
