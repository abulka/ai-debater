import { describe, expect, test } from "bun:test";
import { cleanForTerminal, splitSources } from "./render.ts";

describe("splitSources", () => {
  test("separates a Sources heading and its list from the answer", () => {
    const text = "The answer is X.\n\nSources\n1. https://example.com/a\n2. https://example.com/b";
    const split = splitSources(text);
    expect(split.body).toBe("The answer is X.");
    expect(split.sources).toContain("1. https://example.com/a");
  });

  test("a sentence beginning 'Sources are…' is not a heading", () => {
    const text = "Sources are the articles linked above.";
    expect(splitSources(text)).toEqual({ body: text, sources: null });
  });

  test("no heading means no split", () => {
    expect(splitSources("Just an answer.")).toEqual({ body: "Just an answer.", sources: null });
  });
});

describe("cleanForTerminal", () => {
  test("moves citation brackets into a numbered source list", () => {
    const line =
      "| 1 | Stairway to Heaven | 【https://en.wikipedia.org/wiki/Stairway_to_Heaven】 |";
    const out = cleanForTerminal(line, 100);
    expect(out).toContain("Stairway to Heaven");
    expect(out).toContain("[1]");
    expect(out).toContain("Sources");
    expect(out).toContain("1. https://en.wikipedia.org/wiki/Stairway_to_Heaven");
    expect(out).not.toContain("【");
  });

  test("renders a table as aligned columns with a rule under the header", () => {
    const text = [
      "| Song | Why |",
      "|------|-----|",
      "| Cabaret | title track |",
      "| The Singer | vocal range |",
    ].join("\n");
    const lines = cleanForTerminal(text, 80).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Song\s+Why$/);
    expect(lines[1]).toMatch(/^─+\s+─+$/);
    expect(lines[2]).toMatch(/^Cabaret\s+title track$/);
    expect(lines[3]).toMatch(/^The Singer\s+vocal range$/);
    expect(lines.join("")).not.toContain("|");
  });

  test("re-flows a table that the model wrote as one long line", () => {
    // The 17 Oct run produced exactly this: header, separator and every row on
    // a single line, so the whole table read as one row of fifteen cells.
    const text =
      "| Song | Why | Notes |------|-----|------| Cabaret | title track | listed | Singer | vocal | praised |";
    const lines = cleanForTerminal(text, 100).split("\n");
    expect(lines[0]).toContain("Song");
    expect(lines[0]).toContain("Why");
    expect(lines[1]).toContain("─");
    expect(lines[2]).toContain("Cabaret");
    expect(lines[3]).toContain("Singer");
    expect(lines.some((line) => line.includes("------"))).toBe(false);
  });

  test("a wide table fits the width it is given, wrapping cells", () => {
    const cell = "a fairly long cell that must wrap ".repeat(3).trim();
    const text = ["| One | Two |", "|-----|-----|", `| ${cell} | ${cell} |`].join("\n");
    const lines = cleanForTerminal(text, 60).split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // It wrapped rather than truncating.
    expect(lines.join(" ")).toContain("wrap");
  });

  test("keeps a markdown link as text (url)", () => {
    expect(cleanForTerminal("see [the article](https://example.com/x)", 100)).toBe(
      "see the article (https://example.com/x)",
    );
  });

  test("drops emphasis markers and heading hashes", () => {
    expect(cleanForTerminal("### The list\n\n**Bold** and *italic*")).toBe(
      "The list\n\nBold and italic",
    );
  });

  test("leaves ordinary prose alone", () => {
    const text = "Plant's solo singles charted in 1983 and 1985.";
    expect(cleanForTerminal(text)).toBe(text);
  });

  test("does not eat arithmetic or code-like asterisks", () => {
    expect(cleanForTerminal("3 * 4 = 12")).toBe("3 * 4 = 12");
  });
});
