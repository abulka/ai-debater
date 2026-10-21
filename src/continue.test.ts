import { describe, expect, test } from "bun:test";
import { composeContinuation, displayTaskOf, followUpOf, questionOf } from "./continue.ts";

describe("composeContinuation", () => {
  test("the task names the parent, carries the result whole, and ends with the follow-up", () => {
    const { task } = composeContinuation("2026-10-19T12-00-00", "the answer\n", "redo §3 for streaming");
    expect(task).toContain("Continuing the debate from run 2026-10-19T12-00-00.");
    expect(task).toContain("PREVIOUS RESULT\nthe answer");
    expect(task.endsWith("FOLLOW-UP\nredo §3 for streaming\n")).toBe(true);
  });

  test("surrounding whitespace is trimmed, not carried", () => {
    const { task } = composeContinuation("n", "  padded  ", "  follow  ");
    expect(task).toContain("PREVIOUS RESULT\npadded\n");
    expect(task.endsWith("FOLLOW-UP\nfollow\n")).toBe(true);
  });
});

describe("followUpOf", () => {
  test("the flag wins over trailing words", () => {
    expect(followUpOf("from the flag", ["from", "position"])).toBe("from the flag");
  });

  test("trailing positionals join into the follow-up", () => {
    expect(followUpOf(undefined, ["redo", "§3"])).toBe("redo §3");
  });

  test("nothing typed is null, so the caller can ask for it", () => {
    expect(followUpOf(undefined, [])).toBeNull();
    expect(followUpOf("   ", ["  "])).toBeNull();
  });
});

describe("displayTaskOf", () => {
  test("a plain task flattens to one line", () => {
    expect(displayTaskOf("what is this repo about\nand what next")).toBe(
      "what is this repo about and what next",
    );
  });

  test("a continued run shows the follow-up, not the payload", () => {
    const { task } = composeContinuation("2026-10-19T12-00-00", "line one\nline two", "redo §3");
    expect(displayTaskOf(task)).toBe("redo §3");
    expect(questionOf(task)).toBe("redo §3");
  });

  test("questionOf keeps a plain task whole, newlines included", () => {
    expect(questionOf("line one\nline two")).toBe("line one\nline two");
  });

  test("no PREVIOUS RESULT or blank lines leak through", () => {
    const { task } = composeContinuation("n", "the answer", "my real question");
    const shown = displayTaskOf(task);
    expect(shown).not.toContain("PREVIOUS RESULT");
    expect(shown).not.toContain("\n");
  });
});
