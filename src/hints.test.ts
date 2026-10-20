import { describe, expect, test } from "bun:test";
import { buildHintText, hintWidth, wrapHintLines, type HintState } from "./hints.ts";

const base: HintState = {
  pickMode: "select",
  buildStep: null,
  view: "intelligence",
  rankAcd: false,
  rankCost: false,
  providerLock: null,
  disabledCount: 0,
  filterMode: "and",
  ceiling: 0.8,
  taskCeiling: 0.5,
};

describe("buildHintText", () => {
  test("names keys that work and hides dead ones", () => {
    // Intelligence: D and S both answer, no ceiling anywhere.
    const intel = buildHintText(base);
    expect(intel).toContain("D\u00A0sort\u00A0by\u00A0ACD\u00A0intelligence");
    expect(intel).toContain("S\u00A0sort\u00A0by:\u00A0$/task");
    expect(intel).not.toContain("ceiling");
    // Provider: grouped, not ranked — neither toggle is named.
    const prov = buildHintText({ ...base, view: "provider" });
    expect(prov).not.toContain("D sort");
    expect(prov).not.toContain("S sort");
    expect(prov).toContain("V switch view");
  });

  test("the ceiling only shows where its keys work", () => {
    expect(buildHintText({ ...base, view: "value" })).toContain("value ceiling: $0.80");
    expect(buildHintText({ ...base, view: "taskcost" })).toContain("task ceiling: $0.50/task");
    expect(buildHintText({ ...base, view: "taskcost", rankAcd: true })).toContain(
      "task ceiling: $0.50/task (ACD)",
    );
  });

  test("every toggle names its destination, both ways", () => {
    // D names where it goes: ACD intelligence off, AA intelligence on.
    expect(buildHintText(base)).toContain("D\u00A0sort\u00A0by\u00A0ACD\u00A0intelligence");
    expect(buildHintText({ ...base, rankAcd: true })).toContain("D\u00A0sort\u00A0by\u00A0AA\u00A0intelligence");
    // With S on, D would switch the cost source instead.
    expect(buildHintText({ ...base, rankCost: true })).toContain("D\u00A0sort\u00A0by\u00A0ACD\u00A0$/task");
    expect(buildHintText({ ...base, rankAcd: true, rankCost: true })).toContain("D\u00A0sort\u00A0by\u00A0$/task");
    // S names where it goes: cost off, intelligence on — per source.
    expect(buildHintText({ ...base, rankCost: true })).toContain("S\u00A0sort\u00A0by:\u00A0AA\u00A0intelligence");
    expect(buildHintText({ ...base, rankAcd: true, rankCost: true })).toContain(
      "S\u00A0sort\u00A0by:\u00A0ACD\u00A0intelligence",
    );
    expect(buildHintText({ ...base, rankAcd: true })).toContain("S\u00A0sort\u00A0by:\u00A0ACD\u00A0$/task");
  });

  test("modes and locks read in the navigation", () => {
    expect(buildHintText({ ...base, pickMode: "browse" })).toContain("browsing");
    expect(
      buildHintText({ ...base, pickMode: "build", buildStep: "reviewer" }),
    ).toContain("reviewer");
    expect(buildHintText({ ...base, providerLock: "opencode-go" })).toContain(
      "unlock (locked to: opencode-go)",
    );
  });

  test("the provider switch names how many are off", () => {
    expect(buildHintText(base)).toContain("F providers on/off");
    expect(buildHintText({ ...base, disabledCount: 2 })).toContain("F providers (2 off)");
  });

  test("the Tab key names its destination, both ways", () => {
    expect(buildHintText(base)).toContain("Tab\u00A0filter:\u00A0OR");
    expect(buildHintText({ ...base, filterMode: "or" })).toContain("Tab\u00A0filter:\u00A0AND");
  });
});

describe("wrapHintLines", () => {
  test("a wide terminal keeps one row", () => {
    expect(wrapHintLines(buildHintText(base), 500)).toHaveLength(1);
  });

  test("rows break at spaces and fit the width", () => {
    for (const width of [60, 80, 100]) {
      for (const line of wrapHintLines(buildHintText(base), width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("no cap: the menu shows every row, overflow truncates only on demand", () => {
    // Uncapped, a narrow terminal gets the whole menu — six rows at 60 wide,
    // none of them marked.
    const rows = wrapHintLines(buildHintText(base), 60);
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.some((r) => r.endsWith("…"))).toBe(false);
    // An explicit maxRows still truncates, and marks the cut.
    const cut = wrapHintLines(buildHintText(base), 60, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith("…")).toBe(true);
  });

  test("the toggle labels never split across rows", () => {
    // `D`/`S` labels are glued with non-breaking spaces: a wrap may break
    // before one, never inside it — "S\u00A0sort\u00A0by:" dangling with "$/task" on
    // the next row reads as a cut label.
    const text = buildHintText({ ...base, view: "value" });
    for (const width of [60, 70, 80, 100]) {
      const rows = wrapHintLines(text, width);
      for (const r of rows) {
        expect(r.endsWith("S\u00A0sort\u00A0by:")).toBe(false);
        expect(r.endsWith("D\u00A0sort\u00A0by")).toBe(false);
      }
      expect(rows.join(" ")).toContain("S\u00A0sort\u00A0by:\u00A0$/task");
    }
  });

  test("the < > pair never splits across rows", () => {
    const text = buildHintText({ ...base, view: "value" });
    for (const width of [60, 70, 80, 100]) {
      const rows = wrapHintLines(text, width);
      const joined = rows.join("\n");
      expect(joined).toContain("<\u00A0>");
      // No row ends with a bare `<` or starts with a bare `>`.
      for (const r of rows) {
        expect(r.endsWith("<")).toBe(false);
        expect(r.startsWith(">")).toBe(false);
      }
    }
  });

  test("hintWidth never drops below the row floor", () => {
    expect(hintWidth(10)).toBe(24);
    expect(hintWidth(100)).toBe(99);
  });
});
