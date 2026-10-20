import { describe, expect, test } from "bun:test";
import {
  cleanHighlightPatterns,
  DEFAULT_HIGHLIGHTS,
  HIGHLIGHT_MAX,
  highlightColourName,
  highlightFor,
  highlightRules,
  HIGHLIGHT_VALUES,
  isPaletteColour,
  isUsablePattern,
  nextFreeHighlightColour,
} from "./highlight.ts";
import { HIGHLIGHT_PALETTE, SELECTION_BG, SELECTION_FG } from "./theme.ts";

describe("isUsablePattern", () => {
  test("accepts ordinary filter texts, including quoted phrases", () => {
    for (const p of ["deepseek flash v4.1", "muse 1.3", "muse", '"deep 4.1"']) {
      expect(isUsablePattern(p)).toBe(true);
    }
  });
  test("refuses quote-only, separator-only and blank patterns", () => {
    for (const p of ["", "   ", '""', '"', "---", "...", "-_./ ", '" "']) {
      expect(isUsablePattern(p)).toBe(false);
    }
  });
});

describe("cleanHighlightPatterns", () => {
  test("trims, dedupes case-insensitively, drops the unusable", () => {
    expect(cleanHighlightPatterns(["  muse 1.3  ", "MUSE 1.3", "---", "deepseek flash v4.1"])).toEqual([
      "muse 1.3",
      "deepseek flash v4.1",
    ]);
  });
  test("caps the list", () => {
    const many = Array.from({ length: HIGHLIGHT_MAX + 5 }, (_, i) => `model ${i}`);
    expect(cleanHighlightPatterns(many)).toHaveLength(HIGHLIGHT_MAX);
  });
});

describe("default highlight", () => {
  test("the seed matches DeepSeek V4.1 Flash in all its servings, and nothing else", () => {
    const rules = highlightRules(DEFAULT_HIGHLIGHTS);
    expect(rules).toHaveLength(1);
    for (const ref of [
      "opencode-go/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-1-flash",
      "opencode/deepseek-v4.1-flash-free",
      "opencode-go/deepseek-v4-1-flash-1017",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ]) {
      expect(highlightFor(ref, null, rules)?.pattern).toBe(DEFAULT_HIGHLIGHTS[0]);
    }
    for (const ref of [
      "openrouter/deepseek/deepseek-v4-flash",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/qwen3.8-flash",
      "opencode-go/glm-5.3-flash",
      "deepseek/deepseek-v3",
    ]) {
      expect(highlightFor(ref, null, rules)).toBeNull();
    }
  });
});

describe("highlight matching", () => {
  test("uses the picker's loose rule, including quoted phrases and display names", () => {
    const rules = highlightRules(["muse 1.3"]);
    expect(highlightFor("opencode-go/muse-spark-1.3-contributor", null, rules)).not.toBeNull();
    expect(highlightFor("opencode-go/deepseek-v4.1-flash", null, rules)).toBeNull();
    const quoted = highlightRules(['"deep 4.1"']);
    expect(highlightFor("opencode-go/deepseek-v4.1-flash", null, quoted)).not.toBeNull();
    // Matches by benchmark display name as well as by ref.
    expect(highlightFor("opencode-go/muse-spark-1.3", "Muse Spark 1.3 (Max)", rules)).not.toBeNull();
  });
  test("the first rule wins, newest first", () => {
    const rules = highlightRules(["deepseek flash", "deepseek flash v4.1"]);
    const hit = highlightFor("opencode-go/deepseek-v4.1-flash", null, rules);
    expect(hit?.pattern).toBe("deepseek flash");
  });
  test("no rules match nothing", () => {
    expect(highlightFor("opencode-go/deepseek-v4.1-flash", null, [])).toBeNull();
  });
});

describe("highlight colours", () => {
  test("derived from the pattern: stable across calls", () => {
    const a = highlightRules(["muse 1.3", "deepseek flash v4.1"]);
    const b = highlightRules(["muse 1.3", "deepseek flash v4.1"]);
    expect(a).toEqual(b);
  });
  test("distinct patterns read in distinct colours", () => {
    const rules = highlightRules(["muse 1.3", "deepseek flash v4.1", "qwen3.8", "glm 5.3"]);
    expect(new Set(rules.map((r) => r.colour)).size).toBe(rules.length);
  });
  test("the seed keeps orange, wherever the palette puts it", () => {
    const orange = HIGHLIGHT_PALETTE.find((c) => c.name === "orange")!.value;
    expect(highlightRules(DEFAULT_HIGHLIGHTS)[0]?.colour).toBe(orange);
  });
  test("three entries read in three colours", () => {
    const rules = highlightRules(["deepseek flash v4.1", "muse 1.3", "qwen3.8"]);
    expect(new Set(rules.map((r) => r.colour)).size).toBe(3);
  });
  test("a stored override wins over the derived colour", () => {
    const blue = HIGHLIGHT_PALETTE[2]!.value;
    const rules = highlightRules(["muse 1.3"], { "muse 1.3": blue });
    expect(rules[0]?.colour).toBe(blue);
  });
  test("an override that names no palette colour is ignored", () => {
    const derived = highlightRules(["muse 1.3"])[0]?.colour;
    for (const bad of ["cyan", "ansi256(999)", "", 0, null]) {
      const rules = highlightRules(["muse 1.3"], { "muse 1.3": bad as string });
      expect(rules[0]?.colour).toBe(derived);
    }
  });
  test("cycling moves to the next free palette colour and wraps", () => {
    const rules = highlightRules(["aaa", "bbb"]);
    const current = rules.find((r) => r.pattern === "aaa")!.colour;
    const taken = new Set(rules.map((r) => r.colour));
    const recoloured = nextFreeHighlightColour(rules, "aaa");
    expect(recoloured).not.toBeNull();
    expect(recoloured).not.toBe(current);
    expect(taken.has(recoloured!)).toBe(false);
    // The unknown pattern starts the cycle at the palette's head.
    expect(nextFreeHighlightColour([], "new")).toBe(HIGHLIGHT_PALETTE[0]!.value);
  });
  test("cycling skips colours other entries read in", () => {
    const blue = HIGHLIGHT_PALETTE.find((c) => c.name === "blue")!.value;
    const rules = highlightRules(["aaa", "bbb"], { bbb: blue });
    // `aaa`'s own next colour may be taken — whatever comes back, it is not blue.
    expect(nextFreeHighlightColour(rules, "aaa")).not.toBe(blue);
  });
  test("cycling reports null when every colour is taken", () => {
    const colours: Record<string, string> = {};
    HIGHLIGHT_PALETTE.forEach((c, i) => {
      colours[`pattern ${i}`] = c.value;
    });
    const rules = highlightRules(Object.keys(colours), colours);
    expect(rules).toHaveLength(HIGHLIGHT_PALETTE.length);
    expect(nextFreeHighlightColour(rules, "pattern 0")).toBeNull();
  });
  test("colours have names, and every palette value is one", () => {
    const orange = HIGHLIGHT_PALETTE.find((c) => c.name === "orange")!.value;
    expect(highlightColourName(orange)).toBe("orange");
    for (const c of HIGHLIGHT_PALETTE) expect(highlightColourName(c.value)).toBe(c.name);
    expect(isPaletteColour(HIGHLIGHT_PALETTE[0]!.value)).toBe(true);
    expect(isPaletteColour("cyan")).toBe(false);
    expect(HIGHLIGHT_VALUES).toHaveLength(HIGHLIGHT_PALETTE.length);
  });
  test("no palette colour hides on the selection band", () => {
    for (const c of HIGHLIGHT_PALETTE) expect(c.value).not.toBe(SELECTION_BG);
    expect(SELECTION_FG).not.toBe(SELECTION_BG);
    for (const s of [SELECTION_BG, SELECTION_FG]) expect(s).toMatch(/^ansi256\(\d+\)$/);
  });
});
