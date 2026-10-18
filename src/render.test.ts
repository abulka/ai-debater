import { describe, expect, test } from "bun:test";
import type { Changelog, Claims, Gate, Review } from "./contracts.ts";
import {
  changeReasons,
  diffPane,
  renderAnswer,
  renderDiffLines,
  renderResult,
  renderResultLines,
  splitSources,
} from "./render.ts";
import { THEME } from "./theme.ts";

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

  test("a wrapped changelog entry continues under the summary column", () => {
    const long =
      "Replaced the claim that the show moved to USA Network for its final season " +
      "and said what actually happened instead";
    const lines = renderResultLines(
      { ...base, changelog: { changes: [{ item: "V14", disposition: "fixed", summary: long }] } as never },
      60,
    ).map((line) => line.map((span) => span.text).join(""));

    const start = lines.findIndex((line) => line.startsWith("  V14  fixed"));
    expect(start).toBeGreaterThan(-1);
    const entry = lines.slice(start, start + 4).filter((line) => line.length > 0);
    // The first line is the columns; every continuation starts under the summary.
    expect(entry[0]).toContain("Replaced");
    expect(entry[1]!.startsWith(" ".repeat(17))).toBe(true);
    for (const line of entry) expect(line.length).toBeLessThanOrEqual(60);
  });

  test("a wrapped entry is not cut mid-word", () => {
    const lines = renderResultLines(
      {
        ...base,
        changelog: {
          changes: [{ item: "V14", disposition: "fixed", summary: "alpha bravo charlie delta" }],
        } as never,
      },
      40,
    ).map((line) => line.map((span) => span.text).join(""));
    // Every word survives whole, wherever the break landed.
    const reflowed = lines.map((line) => line.trim()).join(" ").replace(/\s+/g, " ");
    expect(reflowed).toContain("alpha bravo charlie delta");
  });

  test("colour marks structure and state, never agreement", () => {
    const mixed = {
      ...base,
      includeDiff: true,
      patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
      claims: {
        verifiable: [
          { id: "C1", text: "the endpoint has no limiter" },
          { id: "C2", text: "the queue is unbounded" },
        ],
        judgment: [],
      } as unknown as Claims,
      review: {
        verdicts: [
          { id: "C1", verdict: "refuted", evidence: "src/a.ts:1", note: "it is bounded" },
          { id: "C2", verdict: "confirmed", evidence: "src/b.ts:2", note: "" },
        ],
        extra_findings: [],
      } as unknown as Review,
    };
    const lines = renderResultLines(mixed, 100);
    const find = (needle: string) =>
      lines.find((l) => l.map((s) => s.text).join("").includes(needle))!;

    // Structure takes the accent.
    expect(find("── the answer").every((span) => span.color === THEME.accent)).toBe(true);
    expect(find("Title").some((span) => span.color === THEME.accent && span.bold)).toBe(true);
    // The span, not the line: the counts share one line.
    const spanFor = (needle: string) => find(needle).find((span) => span.text.includes(needle))!;
    // What needs attention is marked…
    expect(spanFor("1 refuted").color).toBe(THEME.warn);
    // …and agreement is not: the file agreed, which is not an endorsement.
    expect(spanFor("1 confirmed").color).toBeUndefined();
    // A diff is read by its margins.
    expect(find("+new").some((span) => span.color === THEME.code)).toBe(true);
    expect(find("-old").some((span) => span.color === THEME.danger)).toBe(true);
  });

  test("the diff pane asks for the diff and colours its margins", () => {
    const withPatch = {
      ...base,
      patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
    };
    const lines = renderDiffLines(withPatch, 80);
    const text = lines.map((line) => line.map((s) => s.text).join(""));
    expect(text[0]).toContain("exact changes");
    expect(lines[0]!.every((s) => s.color === THEME.accent)).toBe(true);
    const spanFor = (needle: string) =>
      lines.find((l) => l.map((s) => s.text).join("").includes(needle))!
        .find((s) => s.text.includes(needle))!;
    expect(spanFor("+new").color).toBe(THEME.code);
    expect(spanFor("-old").color).toBe(THEME.danger);
    for (const line of lines) {
      expect(line.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(80);
    }
  });

  test("the diff pane is empty when there is no diff to show", () => {
    expect(renderDiffLines({ ...base, patch: "" }, 80)).toEqual([]);
  });

  test("each change is shown with what it was for", () => {
    const report = {
      ...base,
      patch: "--- a/draft\n+++ b/final\n@@ -1 +1 @@\n-old\n+new\n",
      includeDiff: true,
      claims: {
        verifiable: [{ id: "V14", text: "the show moved to USA Network" }],
        judgment: [{ id: "J1", text: "add the caveat?", options: ["yes", "no"] }],
      } as unknown as Claims,
      review: {
        verdicts: [
          { id: "V14", verdict: "refuted", evidence: "src/sources.md:12", note: "NBC, then USA" },
        ],
        extra_findings: [{ id: "E7", text: "the caveat is missing", evidence: "src/s.md:3" }],
      } as unknown as Review,
      gate: {
        decisions: [{ id: "J1", choice: "yes" }],
        findings: [{ id: "E7", disposition: "accepted" }],
      } as unknown as Gate,
      changelog: {
        changes: [
          { item: "V14", disposition: "fixed", summary: "said which seasons aired where", evidence: "plan.v2.md" },
          { item: "J1", disposition: "applied", summary: "added the caveat" },
          { item: "E7", disposition: "applied", summary: "added the caveat" },
          { item: "V9", disposition: "fixed", summary: "edited something nobody authorised" },
        ],
      } as unknown as Changelog,
    };
    const lines = diffPane(report, 100);
    const text = lines.map((line) => line.map((s) => s.text).join("")).join("\n");
    const spanFor = (needle: string) =>
      lines.find((l) => l.map((s) => s.text).join("").includes(needle))!
        .find((s) => s.text.includes(needle))!;

    expect(text).toContain("what it was changed for");
    // The reviewer's words, with the evidence they cited.
    expect(text).toContain("the show moved to USA Network");
    expect(text).toContain("src/sources.md:12 — NBC, then USA");
    expect(spanFor("refuted").color).toBe(THEME.warn);
    // A finding you accepted.
    expect(text).toContain("the caveat is missing");
    // Your own call at the gate, and the option you picked.
    expect(text).toContain("you chose");
    expect(text).toContain("yes");
    // The writer's own citation, which nothing else showed.
    expect(text).toContain("the writer cited");
    expect(spanFor("plan.v2.md").color).toBe(THEME.code);
    // A change nobody asked for is called out…
    expect(text).toContain("not in the authorised scope");
    expect(spanFor("not in the authorised scope").color).toBe(THEME.danger);
  });

  test("an authorised item the changelog says nothing about is called out", () => {
    const report = {
      ...base,
      patch: "",
      includeDiff: false,
      claims: { verifiable: [{ id: "V11", text: "the rule holds" }], judgment: [] } as unknown as Claims,
      review: {
        verdicts: [{ id: "V11", verdict: "refuted", evidence: "src/a.ts:1", note: "" }],
        extra_findings: [],
      } as unknown as Review,
      gate: { decisions: [], findings: [] } as unknown as Gate,
      changelog: { changes: [] } as unknown as Changelog,
    };
    const text = diffPane(report, 100)
      .map((line) => line.map((s) => s.text).join(""))
      .join("\n");
    expect(text).toContain("authorised");
    expect(text).toContain("the changelog says nothing");
  });

  test("the reasons pane never exceeds the width, whatever the summary", () => {
    const report = {
      ...base,
      patch: "",
      claims: { verifiable: [{ id: "V1", text: "a claim" }], judgment: [] } as unknown as Claims,
      review: { verdicts: [], extra_findings: [] } as unknown as Review,
      gate: { decisions: [], findings: [] } as unknown as Gate,
      changelog: {
        changes: [
          { item: "V1", disposition: "fixed", summary: "a summary long enough to wrap more than once at this width, twice over" },
        ],
      } as unknown as Changelog,
    };
    for (const width of [40, 60, 100]) {
      for (const line of changeReasons(report, width)) {
        expect(line.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("the screen's own result never carries the diff, panel or not", () => {
    const text = renderResultLines({ ...base, patch: "--- a/x\n+++ b/x\n" }, 80)
      .map((line) => line.map((s) => s.text).join(""))
      .join("\n");
    expect(text).not.toContain("exact changes");
    // …but the copy of the whole result does.
    expect(renderResult({ ...base, patch: "--- a/x\n+++ b/x\n", includeDiff: true })).toContain(
      "exact changes",
    );
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
