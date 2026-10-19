import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAAKey, saveAAKey } from "./aa-key.ts";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "adv-aakey-"));

describe("loadAAKey", () => {
  test("a missing file is no key, never a throw", async () => {
    expect(await loadAAKey(path.join(await tmp(), "artificialanalysis.json"))).toBeNull();
  });

  test("malformed JSON and foreign shapes are no key", async () => {
    const dir = await tmp();
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await loadAAKey(bad)).toBeNull();
    const foreign = path.join(dir, "foreign.json");
    await writeFile(foreign, JSON.stringify({ recent: [], favorite: [] }));
    expect(await loadAAKey(foreign)).toBeNull();
    const empty = path.join(dir, "empty.json");
    await writeFile(empty, JSON.stringify({ apiKey: "   " }));
    expect(await loadAAKey(empty)).toBeNull();
  });
});

describe("saveAAKey", () => {
  test("round-trips, trimmed, owner-only", async () => {
    const file = path.join(await tmp(), "artificialanalysis.json");
    await saveAAKey("  aa_secret  ", file);
    expect(await loadAAKey(file)).toBe("aa_secret");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("refuses an empty key", async () => {
    await expect(saveAAKey("   ", path.join(await tmp(), "k.json"))).rejects.toThrow("empty");
  });

  test("an existing file gets its bits tightened", async () => {
    const dir = await tmp();
    const file = path.join(dir, "k.json");
    await writeFile(file, JSON.stringify({ apiKey: "old" }), { mode: 0o644 });
    await saveAAKey("new", file);
    expect(await loadAAKey(file)).toBe("new");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
