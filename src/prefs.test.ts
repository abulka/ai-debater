import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addFilterHistory,
  cycleRefreshDays,
  DEFAULT_CEILING,
  DEFAULT_REFRESH_DAYS,
  DEFAULT_TASK_CEILING,
  FILTER_HISTORY_MAX,
  loadCeiling,
  loadDisabledProviders,
  loadFilterHistory,
  loadRefreshDays,
  loadTaskCeiling,
  recordFilterUse,
  REFRESH_DAY_CHOICES,
  refreshDaysMs,
  removeFilterHistory,
  roundCeiling,
  saveCeiling,
  saveDisabledProviders,
  saveFilterHistory,
  saveRefreshDays,
  saveTaskCeiling,
  stepCeiling,
  type FilterEntry,
} from "./prefs.ts";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "adv-prefs-"));

describe("picker prefs", () => {
  test("a missing file is the default", async () => {
    expect(await loadCeiling(path.join(await tmp(), "picker.json"))).toBe(DEFAULT_CEILING);
  });

  test("malformed JSON and nonsense values are the default, never a throw", async () => {
    const dir = await tmp();
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await loadCeiling(bad)).toBe(DEFAULT_CEILING);
    for (const v of [{}, { valueCeiling: "cheap" }, { valueCeiling: -1 }, { valueCeiling: NaN }, []]) {
      const f = path.join(dir, `${Math.random()}.json`);
      await writeFile(f, JSON.stringify(v));
      expect(await loadCeiling(f)).toBe(DEFAULT_CEILING);
    }
  });

  test("a ceiling round-trips, rounded to cents", async () => {
    const file = path.join(await tmp(), "picker.json");
    await saveCeiling(1.5, file);
    expect(await loadCeiling(file)).toBe(1.5);
    await saveCeiling(0.1 + 0.2, file);
    expect(await loadCeiling(file)).toBe(0.3);
  });

  test("stepping is geometric and decimal-clean", () => {
    // ×1.5 resolves the sub-dollar cluster instead of striding past it.
    expect(stepCeiling(0.5, -1)).toBe(0.33);
    expect(stepCeiling(0.33, -1)).toBe(0.22);
    expect(stepCeiling(0.5, 1)).toBe(0.75);
    expect(stepCeiling(0.8, 1)).toBe(1.2);
    // Down stalls at cents, so it ends at empty rather than sticking.
    expect(stepCeiling(0.01, -1)).toBe(0);
    expect(stepCeiling(0, -1)).toBe(0);
    // Up from empty restarts at a cent, not at zero times anything.
    expect(stepCeiling(0, 1)).toBe(0.01);
    expect(roundCeiling(0.1 + 0.2)).toBe(0.3);
  });

  test("the task ceiling defaults, validates, and round-trips", async () => {
    const file = path.join(await tmp(), "picker.json");
    expect(await loadTaskCeiling(file)).toBe(DEFAULT_TASK_CEILING);
    await saveTaskCeiling(0.35, file);
    expect(await loadTaskCeiling(file)).toBe(0.35);
  });

  test("saving one ceiling keeps the other", async () => {
    const file = path.join(await tmp(), "picker.json");
    await saveCeiling(1.5, file);
    await saveTaskCeiling(0.35, file);
    expect(await loadCeiling(file)).toBe(1.5);
    expect(await loadTaskCeiling(file)).toBe(0.35);
  });

  test("disabled providers default to none, and nonsense is none, never a throw", async () => {
    const dir = await tmp();
    expect(await loadDisabledProviders(path.join(dir, "picker.json"))).toEqual([]);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await loadDisabledProviders(bad)).toEqual([]);
    for (const v of [{}, { disabledProviders: "groq" }, { disabledProviders: [1, null] }, []]) {
      const f = path.join(dir, `${Math.random()}.json`);
      await writeFile(f, JSON.stringify(v));
      expect(await loadDisabledProviders(f)).toEqual([]);
    }
  });

  test("disabled providers round-trip sorted and deduped, keeping the ceilings", async () => {
    const file = path.join(await tmp(), "picker.json");
    await saveCeiling(1.5, file);
    await saveDisabledProviders(["openrouter", "groq", "groq", " groq "], file);
    expect(await loadDisabledProviders(file)).toEqual(["groq", "openrouter"]);
    expect(await loadCeiling(file)).toBe(1.5);
    await saveTaskCeiling(0.35, file);
    expect(await loadDisabledProviders(file)).toEqual(["groq", "openrouter"]);
    expect(await loadTaskCeiling(file)).toBe(0.35);
    await saveDisabledProviders([], file);
    expect(await loadDisabledProviders(file)).toEqual([]);
  });

  test("empty and off-mode filters are never remembered", () => {
    expect(addFilterHistory([], "   ", "and")).toEqual([]);
    expect(addFilterHistory([], "gpt", "off")).toEqual([]);
    expect(removeFilterHistory([{ text: "gpt", mode: "and" }], "  ")).toEqual([
      { text: "gpt", mode: "and" },
    ]);
  });

  test("a reused filter front-bumps, case-insensitively, latest casing and mode winning", () => {
    const start = [
      { text: "gpt", mode: "and" as const },
      { text: "deepseek", mode: "and" as const },
    ];
    expect(addFilterHistory(start, "GPT", "or")).toEqual([
      { text: "GPT", mode: "or" },
      { text: "deepseek", mode: "and" },
    ]);
  });

  test("the history caps at newest-first, trims, and round-trips beside the ceilings", async () => {
    let entries: FilterEntry[] = [];
    for (let i = 0; i < FILTER_HISTORY_MAX + 5; i++) entries = addFilterHistory(entries, `m${i}`, "and");
    expect(entries).toHaveLength(FILTER_HISTORY_MAX);
    expect(entries[0]).toEqual({ text: `m${FILTER_HISTORY_MAX + 4}`, mode: "and" });
    const file = path.join(await tmp(), "picker.json");
    await saveCeiling(1.5, file);
    await saveFilterHistory([{ text: "  gpt  ", mode: "and" }], file);
    expect(await loadFilterHistory(file)).toEqual([{ text: "gpt", mode: "and" }]);
    expect(await loadCeiling(file)).toBe(1.5);
  });

  test("filter history defaults to none, and nonsense is none, never a throw", async () => {
    const dir = await tmp();
    expect(await loadFilterHistory(path.join(dir, "picker.json"))).toEqual([]);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await loadFilterHistory(bad)).toEqual([]);
    for (const v of [{}, { filterHistory: "gpt" }, { filterHistory: [{ text: 1 }] }, []]) {
      const f = path.join(dir, `${Math.random()}.json`);
      await writeFile(f, JSON.stringify(v));
      expect(await loadFilterHistory(f)).toEqual([]);
    }
  });

  test("off-mode and duplicate rows on disk are dropped, on load and on save", async () => {
    const dir = await tmp();
    const f = path.join(dir, "disk.json");
    await writeFile(
      f,
      JSON.stringify({
        filterHistory: [
          { text: "gpt", mode: "and" },
          { text: "GPT", mode: "or" },
          { text: "kept-off", mode: "off" },
          { text: "  ", mode: "and" },
        ],
      }),
    );
    expect(await loadFilterHistory(f)).toEqual([{ text: "gpt", mode: "and" }]);
    const out = path.join(dir, "out.json");
    await saveFilterHistory(
      [
        { text: "gpt", mode: "and" },
        { text: "GPT", mode: "or" },
        { text: "off-row", mode: "off" },
      ],
      out,
    );
    expect(await loadFilterHistory(out)).toEqual([{ text: "gpt", mode: "and" }]);
  });

  test("removing one filter keeps the rest, case-insensitively", async () => {
    const entries = [
      { text: "gpt", mode: "and" as const },
      { text: "deepseek", mode: "or" as const },
    ];
    expect(removeFilterHistory(entries, "GPT")).toEqual([{ text: "deepseek", mode: "or" }]);
    expect(removeFilterHistory(entries, "missing")).toEqual(entries);
    const file = path.join(await tmp(), "picker.json");
    await saveFilterHistory(entries, file);
    await saveFilterHistory(removeFilterHistory(await loadFilterHistory(file), "gpt"), file);
    expect(await loadFilterHistory(file)).toEqual([{ text: "deepseek", mode: "or" }]);
  });

  test("a use front-bumps and replaces the visit's provisional entry", () => {
    // First keystrokes of a visit: nothing provisional behind them.
    expect(recordFilterUse([], { prev: null, text: "mus", mode: "and" })).toEqual([
      { text: "mus", mode: "and" },
    ]);
    // Refined after a pause: the prefix goes, the full filter stays.
    expect(
      recordFilterUse([{ text: "mus", mode: "and" }], { prev: "mus", text: "muse 1.3", mode: "or" }),
    ).toEqual([{ text: "muse 1.3", mode: "or" }]);
  });

  test("a use keeps older entries and drops only the replaced pair", () => {
    const entries = [
      { text: "mus", mode: "and" as const },
      { text: "deepseek", mode: "and" as const },
    ];
    expect(recordFilterUse(entries, { prev: "mus", text: "muse 1.3", mode: "and" })).toEqual([
      { text: "muse 1.3", mode: "and" },
      { text: "deepseek", mode: "and" },
    ]);
  });

  test("a use records nothing for empty or off-mode text", () => {
    const entries = [{ text: "gpt", mode: "and" as const }];
    expect(recordFilterUse(entries, { prev: null, text: "   ", mode: "and" })).toEqual(entries);
    expect(recordFilterUse(entries, { prev: "gpt", text: "gpt", mode: "off" })).toEqual(entries);
  });

  test("a use caps the history newest-first", () => {
    let entries: FilterEntry[] = [];
    for (let i = 0; i < FILTER_HISTORY_MAX + 1; i++)
      entries = recordFilterUse(entries, { prev: null, text: `m${i}`, mode: "and" });
    expect(entries).toHaveLength(FILTER_HISTORY_MAX);
    expect(entries[0]).toEqual({ text: `m${FILTER_HISTORY_MAX}`, mode: "and" });
  });
});

describe("refreshDays", () => {
  test("a missing or wayward file is the 7-day default", async () => {
    const dir = await tmp();
    expect(await loadRefreshDays(path.join(dir, "nope.json"))).toBe(DEFAULT_REFRESH_DAYS);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ refreshDays: "often" }));
    expect(await loadRefreshDays(bad)).toBe(DEFAULT_REFRESH_DAYS);
    // A hand-edited number off the choice list is a default, not a window.
    await writeFile(bad, JSON.stringify({ refreshDays: 10 }));
    expect(await loadRefreshDays(bad)).toBe(DEFAULT_REFRESH_DAYS);
  });

  test("a choice round-trips, and the cycle walks the list and wraps", async () => {
    const file = path.join(await tmp(), "p.json");
    await saveRefreshDays(3, file);
    expect(await loadRefreshDays(file)).toBe(3);
    expect(cycleRefreshDays(1)).toBe(3);
    expect(cycleRefreshDays(3)).toBe(7);
    expect(cycleRefreshDays(30)).toBe(1);
    expect(cycleRefreshDays(10)).toBe(DEFAULT_REFRESH_DAYS);
  });

  test("days size the window in whole days", () => {
    expect(refreshDaysMs(1)).toBe(24 * 60 * 60 * 1000);
    expect(refreshDaysMs(7)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(REFRESH_DAY_CHOICES).toContain(DEFAULT_REFRESH_DAYS);
  });
});
