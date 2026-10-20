import { describe, expect, test } from "bun:test";
import { composeContinuation, followUpOf } from "./continue.ts";

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
