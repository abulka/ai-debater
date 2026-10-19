import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CEILING_STEP, DEFAULT_CEILING, loadCeiling, roundCeiling, saveCeiling } from "./prefs.ts";

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

  test("stepping is decimal-clean", () => {
    expect(roundCeiling(0.8 + CEILING_STEP)).toBe(0.9);
    expect(roundCeiling(0.9 - CEILING_STEP)).toBe(0.8);
  });
});
