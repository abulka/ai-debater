import { describe, expect, test } from "bun:test";
import { isKillToEnd, isWordLeft, isWordRight, killToEnd, wordLeft, wordRight } from "./lineedit.ts";

const plain = { leftArrow: false, rightArrow: false, ctrl: false, meta: false };
const left = { ...plain, leftArrow: true };
const right = { ...plain, rightArrow: true };

describe("wordLeft", () => {
  test("from mid-word to its start", () => {
    expect(wordLeft("hello world", 8)).toBe(6);
  });

  test("from a word start back over the gap to the previous word", () => {
    expect(wordLeft("hello world", 6)).toBe(0);
  });

  test("from whitespace to the previous word's start", () => {
    expect(wordLeft("hello   world", 8)).toBe(0);
  });

  test("idempotent at 0, and clamps negatives", () => {
    expect(wordLeft("hello", 0)).toBe(0);
    expect(wordLeft("hello", -3)).toBe(0);
  });

  test("clamps past the end", () => {
    expect(wordLeft("hello world", 99)).toBe(6);
  });

  test("empty and all-spaces stay put", () => {
    expect(wordLeft("", 0)).toBe(0);
    expect(wordLeft("   ", 3)).toBe(0);
  });

  test("punctuation is part of the word", () => {
    expect(wordLeft("use openai/gpt-6-luna now", 22)).toBe(4);
  });

  test("non-ASCII and emoji words move whole", () => {
    expect(wordLeft("hallo wörld", 11)).toBe(6);
    expect(wordLeft("a 🎉 party", 5)).toBe(2);
  });
});

describe("wordRight", () => {
  test("from mid-word over the gap to the next word", () => {
    expect(wordRight("hello world", 2)).toBe(6);
  });

  test("from a word start to the next word", () => {
    expect(wordRight("hello world", 0)).toBe(6);
  });

  test("from whitespace straight to the next word", () => {
    expect(wordRight("hello   world", 5)).toBe(8);
  });

  test("idempotent at the end, and clamps past it", () => {
    expect(wordRight("hello", 5)).toBe(5);
    expect(wordRight("hello", 99)).toBe(5);
  });

  test("trailing spaces are skipped, not landed on", () => {
    expect(wordRight("hello   ", 0)).toBe(8);
  });

  test("empty stays put", () => {
    expect(wordRight("", 0)).toBe(0);
  });

  test("punctuation is part of the word", () => {
    expect(wordRight("use openai/gpt-6-luna now", 4)).toBe(22);
  });

  test("non-ASCII and emoji words move whole", () => {
    expect(wordRight("hallo wörld", 0)).toBe(6);
    expect(wordRight("a 🎉 party", 0)).toBe(2);
  });
});

describe("word round-trips", () => {
  test("left then right returns over a word", () => {
    const text = "one two three";
    expect(wordRight(text, wordLeft(text, 6))).toBe(8);
  });

  test("repeated left walks every word start", () => {
    const text = "one two three";
    let c = text.length;
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      c = wordLeft(text, c);
      starts.push(c);
    }
    expect(starts).toEqual([8, 4, 0]);
  });
});

describe("killToEnd", () => {
  test("keeps everything before the caret", () => {
    expect(killToEnd("hello world", 5)).toBe("hello");
  });

  test("at 0 clears, at end keeps", () => {
    expect(killToEnd("hello", 0)).toBe("");
    expect(killToEnd("hello", 5)).toBe("hello");
  });

  test("clamps out-of-range carets", () => {
    expect(killToEnd("hello", 99)).toBe("hello");
    expect(killToEnd("hello", -2)).toBe("");
  });
});

describe("key shapes", () => {
  test("meta+b / meta+f are word motions", () => {
    expect(isWordLeft({ ...plain, meta: true }, "b")).toBe(true);
    expect(isWordRight({ ...plain, meta: true }, "f")).toBe(true);
  });

  test("shifted meta letters still count", () => {
    expect(isWordLeft({ ...plain, meta: true }, "B")).toBe(true);
    expect(isWordRight({ ...plain, meta: true }, "F")).toBe(true);
  });

  test("modified arrows are word motions", () => {
    expect(isWordLeft({ ...left, ctrl: true }, "")).toBe(true);
    expect(isWordRight({ ...right, ctrl: true }, "")).toBe(true);
    expect(isWordLeft({ ...left, meta: true }, "")).toBe(true);
    expect(isWordRight({ ...right, meta: true }, "")).toBe(true);
  });

  test("plain arrows are not word motions", () => {
    expect(isWordLeft(left, "")).toBe(false);
    expect(isWordRight(right, "")).toBe(false);
  });

  test("plain b/f without meta are not word motions", () => {
    expect(isWordLeft(plain, "b")).toBe(false);
    expect(isWordRight(plain, "f")).toBe(false);
  });

  test("ctrl+b / ctrl+f stay free for the picker's paging", () => {
    expect(isWordLeft({ ...plain, ctrl: true }, "b")).toBe(false);
    expect(isWordRight({ ...plain, ctrl: true }, "f")).toBe(false);
  });

  test("ctrl+k kills, anything else does not", () => {
    expect(isKillToEnd({ ctrl: true }, "k")).toBe(true);
    expect(isKillToEnd({ ctrl: false }, "k")).toBe(false);
    expect(isKillToEnd({ ctrl: true }, "K")).toBe(false);
    expect(isKillToEnd({ ctrl: true }, "")).toBe(false);
  });
});
