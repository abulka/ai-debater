import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CEILING,
  DEFAULT_TASK_CEILING,
  loadCeiling,
  loadDisabledProviders,
  loadTaskCeiling,
  roundCeiling,
  saveCeiling,
  saveDisabledProviders,
  saveTaskCeiling,
  stepCeiling,
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
});
