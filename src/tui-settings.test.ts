import { describe, expect, test } from "bun:test";

/**
 * The settings screen routes Enter by row id, not by position.
 *
 * The screen draws `settingsOrder(hidePairs)` and Enter reads
 * `settingsOrder(standalone)[settingsSel]`, so a reorder cannot send Enter to
 * the wrong action. This pins the order, that every row draws a label, and
 * that the handler dispatches each id — read from the source, as the phase
 * test does, so importing the TUI (and Ink) is not needed.
 */
const source = await Bun.file(new URL("./tui.tsx", import.meta.url)).text();

function settingsRows(): string[] {
  const block = /const SETTINGS_ROWS = \[([^\]]*)\] as const;/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("settings rows", () => {
  test("the order is highlights, pairs, AA key, cache window, refresh, back", () => {
    expect(settingsRows()).toEqual(["highlights", "pairs", "aakey", "refresh-days", "refresh-now", "back"]);
  });

  test("the list parses — the test reads the constant, not a copy of it", () => {
    expect(settingsRows().length).toBe(6);
  });

  test("every row draws a label", () => {
    for (const id of settingsRows()) {
      expect(source).toContain(`case "${id}":`);
    }
  });

  test("Enter dispatches each row by id, never by index", () => {
    for (const id of ["pairs", "aakey", "highlights", "refresh-days", "refresh-now"]) {
      expect(source).toContain(`row === "${id}"`);
    }
    expect(source).not.toMatch(/sel === [0-9]/);
    expect(source).toContain("settingsOrder(standalone)[settingsSel]");
  });

  test("the bottom of the list is derived from the same order the screen draws", () => {
    expect(source).toContain("const settingsMax = settingsOrder(standalone).length - 1;");
  });
});
