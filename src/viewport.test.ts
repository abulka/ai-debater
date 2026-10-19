import { describe, expect, test } from "bun:test";
import {
  altScreenEnabled,
  cappedLines,
  contentRows,
  gateDetailBudget,
  logWindow,
  LOG_MAX_ROWS,
  MIN_CONTENT_ROWS,
  pairsListHeight,
  pickListHeight,
  runsListHeight,
  scrollerHeight,
} from "./viewport.ts";

describe("contentRows", () => {
  test("subtracts the mouse line", () => {
    expect(contentRows(50)).toBe(49);
  });
  test("never starves the content", () => {
    expect(contentRows(4)).toBe(MIN_CONTENT_ROWS);
  });
  test("a non-finite terminal reads as 24", () => {
    expect(contentRows(Number.NaN)).toBe(23);
  });
});

describe("altScreenEnabled", () => {
  test("on by default", () => {
    expect(altScreenEnabled(false)).toBe(true);
    expect(altScreenEnabled(false, "")).toBe(true);
  });
  test("the flag turns it off", () => {
    expect(altScreenEnabled(true)).toBe(false);
    expect(altScreenEnabled(true, "")).toBe(false);
  });
  test("the env var turns it off", () => {
    for (const v of ["1", "true", "yes", " TRUE ", "Yes"]) {
      expect(altScreenEnabled(false, v)).toBe(false);
    }
  });
  test("anything else leaves it on", () => {
    expect(altScreenEnabled(false, "0")).toBe(true);
    expect(altScreenEnabled(false, "no")).toBe(true);
  });
});

describe("logWindow", () => {
  test("shows everything up to the cap", () => {
    expect(
      logWindow(5, 49, { label: false, minContent: MIN_CONTENT_ROWS, maxLog: LOG_MAX_ROWS }),
    ).toBe(5);
  });
  test("caps at the max while a screen is up", () => {
    expect(
      logWindow(30, 49, { label: false, minContent: MIN_CONTENT_ROWS, maxLog: LOG_MAX_ROWS }),
    ).toBe(LOG_MAX_ROWS);
  });
  test("the spinner reserves its row", () => {
    const without = logWindow(30, 20, { label: false, minContent: 8, maxLog: 20 });
    const labelled = logWindow(30, 20, { label: true, minContent: 8, maxLog: 20 });
    expect(labelled).toBe(without - 1);
  });
  test("the content keeps its minimum", () => {
    // 12 usable rows, 8 reserved: 4 for the log, not 12.
    expect(logWindow(30, 12, { label: false, minContent: 8, maxLog: 30 })).toBe(4);
  });
  test("never negative on a tiny terminal", () => {
    expect(logWindow(30, 3, { label: true, minContent: 8, maxLog: 30 })).toBe(0);
  });
});

describe("screen budgets", () => {
  test("scroller counts its chrome and the notice", () => {
    expect(scrollerHeight(40, false)).toBe(35);
    expect(scrollerHeight(40, true)).toBe(34);
  });
  test("picker grows with the terminal", () => {
    // 50 rows -> 49 usable -> 42 model rows, not 12.
    expect(pickListHeight(contentRows(50), false)).toBe(42);
    expect(pickListHeight(contentRows(50), true)).toBe(40);
  });
  test("pairs subtract warnings", () => {
    expect(pairsListHeight(40, 0, false)).toBe(34);
    expect(pairsListHeight(40, 3, false)).toBe(31);
    expect(pairsListHeight(40, 0, true)).toBe(32);
  });
  test("runs counts its chrome", () => {
    expect(runsListHeight(40)).toBe(33);
  });
  test("every list keeps at least one row", () => {
    expect(scrollerHeight(3, true)).toBe(1);
    expect(pickListHeight(3, true)).toBe(1);
    expect(pairsListHeight(3, 9, true)).toBe(1);
    expect(runsListHeight(3)).toBe(1);
  });
});

describe("gateDetailBudget", () => {
  test("fills what the title and options leave", () => {
    // 40 content rows, 2 title rows, 3 options: 40 - 9 - 2 - 3 = 26.
    expect(
      gateDetailBudget(40, { titleRows: 2, optionRows: 3, extras: false, revisit: false }),
    ).toBe(26);
  });
  test("extras and revisit each cost a row", () => {
    const base = gateDetailBudget(40, { titleRows: 2, optionRows: 3, extras: false, revisit: false });
    expect(gateDetailBudget(40, { titleRows: 2, optionRows: 3, extras: true, revisit: false })).toBe(
      base - 1,
    );
    expect(gateDetailBudget(40, { titleRows: 2, optionRows: 3, extras: true, revisit: true })).toBe(
      base - 2,
    );
  });
  test("floors at zero on a crowded screen", () => {
    expect(
      gateDetailBudget(10, { titleRows: 4, optionRows: 5, extras: true, revisit: true }),
    ).toBe(0);
  });
});

describe("cappedLines", () => {
  test("subtracts the chrome and floors at zero", () => {
    expect(cappedLines(40, 9)).toBe(31);
    expect(cappedLines(5, 9)).toBe(0);
  });
});
