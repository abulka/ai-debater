import { describe, expect, test } from "bun:test";
import type { Changelog, Claims, Gate, Review } from "./contracts.ts";
import { renderAnswer, renderResult, renderResultLines, splitSources } from "./render.ts";

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

describe("renderAnswer", () => {
  test("collects 【url】 citations into a source list", () => {
    const answer = renderAnswer("Plant's solo is 【https://example.com/solo】.");
    expect(answer.body).toContain("Plant's solo is [1].");
    expect(answer.sources).toBe("1. https://example.com/solo");
  });

  test("one URL cited twice is one source", () => {
    const answer = renderAnswer("A 【https://example.com/x】 and B 【https://example.com/x】");
    expect(answer.body).toContain("[1]");
    expect(answer.body).not.toContain("[2]");
    expect(answer.sources?.split("\n")).toHaveLength(1);
  });

  test("an existing Sources section is not duplicated", () => {
    const answer = renderAnswer("Body 【https://example.com/a】\n\nSources\n1. https://example.com/b");
    expect(answer.body).toBe("Body [1]");
    expect(answer.sources).toBe("1. https://example.com/b");
  });

  test("keeps the Markdown: nothing is erased", () => {
    const answer = renderAnswer("## Heading\n\n**Bold** and `code` and a [link](https://example.com/x)");
    expect(answer.body).toContain("## Heading");
    expect(answer.body).toContain("**Bold**");
    expect(answer.body).toContain("`code`");
    expect(answer.body).toContain("[link](https://example.com/x)");
  });
});

const plan = "# Title\n\n**Bold** claim 【https://example.com/a】";

const claims = {
  verifiable: [{ id: "C1", text: "a claim", evidence: "src/a.ts:1" }],
  judgment: [{ id: "D1", text: "which capacity?", evidence: "" }],
} as unknown as Claims;

const review = {
  verdicts: [{ id: "C1", verdict: "confirmed", evidence: "src/a.ts:1", note: "" }],
  extra_findings: [{ id: "F1", text: "consider X", evidence: "" }],
} as unknown as Review;

const gate = {
  decisions: [{ id: "D1", choice: "open" }],
  findings: [{ id: "F1", disposition: "accepted" }],
} as unknown as Gate;

const changelog = { changes: [] } as unknown as Changelog;

const base = {
  plan,
  changelog,
  patch: "",
  assessment: { hunks: 0, claimedChanges: 0, unexplained: 0, outOfScope: false },
  gate,
  claims,
  review,
  includeDiff: false,
};

describe("renderResult", () => {
  test("keeps the answer as Markdown in the plain text", () => {
    const text = renderResult(base);
    expect(text).toContain("# Title");
    expect(text).toContain("**Bold** claim [1]");
    expect(text).toContain("1. https://example.com/a");
  });

  test("still reports what happened, what changed and what is open", () => {
    const text = renderResult({
      ...base,
      models: {
        drafter: { ref: "drafter-x" },
        reviewer: { ref: "reviewer-y" },
      },
    });
    expect(text).toContain("drafter-x wrote it. reviewer-y checked it.");
    expect(text).toContain("1 claim(s): 1 confirmed · 0 refuted · 0 unverifiable");
    expect(text).toContain("nothing — the answer is unchanged");
    expect(text).toContain("D1  which capacity?");
  });

  test("sections are separated by exactly one blank line", () => {
    const text = renderResult(base);
    expect(text).not.toContain("\n\n\n");
  });

  test("the exact diff is included only when asked for", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    expect(renderResult({ ...base, patch, includeDiff: false })).not.toContain("+new");
    expect(renderResult({ ...base, patch, includeDiff: true })).toContain("  +new");
  });
});

describe("renderResultLines", () => {
  test("renders the answer: headings bold, markers gone", () => {
    const text = renderResultLines(base, 80)
      .map((line) => line.map((span) => `${span.bold ? "B" : ""}${span.text}`).join(""))
      .join("\n");
    expect(text).toContain("BTitle");
    expect(text).not.toContain("**Bold**");
    expect(text).toContain("BBold");
  });

  test("the commentary sections stay plain", () => {
    const lines = renderResultLines(base, 80);
    const text = lines.map((line) => line.map((span) => span.text).join("")).join("\n");
    expect(text).toContain("1 claim(s): 1 confirmed");
    expect(text).toContain("D1  which capacity?");
  });

  test("nothing is wider than the width it was given", () => {
    const wide = `# Title\n\n${"a rather long paragraph that must be wrapped ".repeat(4)}`;
    const lines = renderResultLines({ ...base, plan: wide }, 60);
    for (const line of lines) {
      const width = line.reduce((n, span) => n + span.text.length, 0);
      expect(width).toBeLessThanOrEqual(60);
    }
  });
});
