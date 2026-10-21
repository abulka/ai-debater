import { describe, expect, test } from "bun:test";
import {
  renderAnswer,
  renderCouncil,
  renderCouncilAnswerLines,
  splitSources,
} from "./render.ts";

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

describe("council question header", () => {
  const base = {
    final: "The answer.",
    learned: "",
    takes: [{ index: 1, model: { ref: "lead/a" }, text: "Take one." }],
  };

  test("the question renders above the answer", () => {
    const text = renderCouncil({ ...base, question: "Why is the sky blue?", questionLabel: "question" });
    const q = text.indexOf("the question");
    const a = text.indexOf("the answer");
    expect(q).toBeGreaterThanOrEqual(0);
    expect(a).toBeGreaterThan(q);
    expect(text).toContain("Why is the sky blue?");
  });

  test("a continued run shows the follow-up, not the payload", () => {
    const text = renderCouncil({
      ...base,
      question: "Continuing the debate from run n.\n\nPREVIOUS RESULT\nold answer\n\nFOLLOW-UP\nmy real question\n",
    });
    expect(text).toContain("my real question");
    expect(text).not.toContain("PREVIOUS RESULT");
  });

  test("no question means no header — old runs render as before", () => {
    expect(renderCouncil(base)).not.toContain("the question");
  });

  test("the answer-only view includes the question", () => {
    const lines = renderCouncilAnswerLines({ ...base, question: "Why?", questionLabel: "question" }, 80)
      .map((line) => line.map((s) => s.text).join(""))
      .join("\n");
    expect(lines).toContain("Why?");
  });
});
