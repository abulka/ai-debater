import { describe, expect, test } from "bun:test";
import { buildHintText, hintRowSpans, hintWidth, wrapHintLines, type HintState } from "./hints.ts";

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
  highlightCount: 1,
  highlightsOn: true,
  highlightsOnly: false,
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
    expect(
      buildHintText({ ...base, pickMode: "build", buildStep: "reviewer" }),
    ).toContain("reviewer");
    expect(buildHintText({ ...base, providerLock: "opencode-go" })).toContain(
      "unlock (locked to: opencode-go)",
    );
  });

  test("browse names no assignment — Enter is inert there", () => {
    const browse = buildHintText({ ...base, pickMode: "browse" });
    expect(browse).toContain("^F/^B page");
    expect(browse).toContain("Esc home");
    // The browser stands on its own: no key assigns, and no other screen is named.
    expect(browse).not.toContain("Enter");
    expect(browse).not.toContain("debate screen");
  });

  test("the provider switch names how many are off", () => {
    expect(buildHintText(base)).toContain("F providers on/off");
    expect(buildHintText({ ...base, disabledCount: 2 })).toContain("F providers (2 off)");
  });

  test("the Tab key names its destination, all three ways", () => {
    expect(buildHintText(base)).toContain("Tab\u00A0filter:\u00A0OR");
    expect(buildHintText({ ...base, filterMode: "or" })).toContain("Tab\u00A0filter:\u00A0OFF");
    expect(buildHintText({ ...base, filterMode: "off" })).toContain("Tab\u00A0filter:\u00A0AND");
  });

  test("the filter history key is named on every view, and says it saves", () => {
    expect(buildHintText(base)).toContain("R filter history (saves this filter)");
    expect(buildHintText({ ...base, view: "provider" })).toContain("R filter history");
  });

  test("M names the mute both ways, and only when a pattern exists", () => {
    expect(buildHintText(base)).toContain("M highlights off");
    expect(buildHintText({ ...base, highlightsOn: false })).toContain("M highlights on");
    const none = buildHintText({ ...base, highlightCount: 0 });
    expect(none).not.toContain("M highlights");
  });

  test("N names the narrowing both ways, and only when a pattern exists", () => {
    expect(buildHintText(base)).toContain("N highlighted only");
    expect(buildHintText({ ...base, highlightsOnly: true })).toContain("N show all");
    expect(buildHintText({ ...base, highlightCount: 0 })).not.toContain("N highlighted");
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

describe("hintRowSpans", () => {
  test("concatenating the spans reproduces every real row byte-for-byte", () => {
    // Every combination that changes the hint text: views, ranks, lock, modes.
    const states: HintState[] = [
      base,
      { ...base, pickMode: "browse" },
      { ...base, pickMode: "build", buildStep: "reviewer" },
      { ...base, view: "provider", providerLock: "groq", disabledCount: 2, filterMode: "off" },
      { ...base, view: "value", rankAcd: true, filterMode: "or" },
      { ...base, view: "taskcost", rankCost: true, rankAcd: true },
    ];
    for (const s of states) {
      const text = buildHintText(s);
      for (const width of [44, 60, 100]) {
        for (const row of wrapHintLines(text, width)) {
          expect(hintRowSpans(row).map((p) => p.text).join("")).toBe(row);
        }
      }
    }
  });

  test("only the command head is a key — lookalikes in the tail stay grey", () => {
    const spans = hintRowSpans("D\u00A0sort\u00A0by\u00A0AA\u00A0intelligence");
    expect(spans[0]).toEqual({ text: "D", key: true });
    expect(spans.some((p) => p.key && p.text !== "D")).toBe(false);
    const tab = hintRowSpans("Tab\u00A0filter:\u00A0OR");
    expect(tab[0]).toEqual({ text: "Tab", key: true });
    expect(tab.some((p) => p.text.includes("OR") && p.key)).toBe(false);
  });

  test("bare keys light — commands and navigation alike", () => {
    const spans = hintRowSpans("↑↓ choose · Enter select · V switch view · ? providers");
    expect(spans.filter((p) => p.key).map((p) => p.text)).toEqual(["↑↓", "Enter", "V", "?"]);
    expect(hintRowSpans("^F/^B page · ^D/^U half · Esc back").filter((p) => p.key).map((p) => p.text)).toEqual([
      "^F/^B",
      "^D/^U",
      "Esc",
    ]);
    // The ceiling chord lights whole, never split.
    expect(hintRowSpans("<\u00A0> value ceiling: $0.80").filter((p) => p.key).map((p) => p.text)).toEqual([
      "<\u00A0>",
    ]);
  });
});
