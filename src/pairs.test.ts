import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deletePair,
  loadPairs,
  markPairUsed,
  nameForPair,
  pairKey,
  pairModels,
  pairRows,
  pairsFile,
  recentPairs,
  renamePair,
  savePair,
  sortedPairs,
  suggestPairName,
} from "./pairs.ts";
import type { PairRow, RecentPair } from "./pairs.ts";
import type { RunSummary } from "./orchestrator.ts";

let tmp = "";
let previousXdg: string | undefined;

beforeEach(async () => {
  previousXdg = process.env["XDG_CONFIG_HOME"];
  tmp = await mkdtemp(path.join(os.tmpdir(), "adv-pairs-"));
  process.env["XDG_CONFIG_HOME"] = path.join(tmp, "config");
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  await rm(tmp, { recursive: true, force: true });
});

const models = (drafter: string, reviewer: string) => ({
  drafter: { ref: drafter, family: drafter.split("/")[0] ?? "x" },
  reviewer: { ref: reviewer, family: reviewer.split("/")[0] ?? "y" },
});

const run = (name: string, over: Partial<RunSummary> = {}): RunSummary => ({
  name,
  dir: `/runs/${name}`,
  state: "done",
  task: `task ${name}`,
  mode: "plan",
  createdAt: `2026-10-18T0${name}:00:00Z`,
  ...over,
});

describe("saved pairs", () => {
  test("a pair survives a round trip through the file", async () => {
    await savePair({ name: "trial", ...models("anthropic/claude-sonnet-5-5", "opencode-go/gpt-6-luna") });

    const loaded = await loadPairs();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("trial");
    expect(loaded[0]!.drafter.ref).toBe("anthropic/claude-sonnet-5-5");
    // The family is recorded, not re-derived: it is what the diversity check reads.
    expect(loaded[0]!.reviewer.family).toBe("opencode-go");
    expect(loaded[0]!.savedAt).toBeTruthy();
  });

  test("saving under an existing name replaces that pair and nothing else", async () => {
    await savePair({ name: "trial", ...models("a/one", "b/two") });
    await savePair({ name: "cheap", ...models("c/three", "d/four") });
    await savePair({ name: "trial", ...models("e/five", "f/six") });

    const loaded = await loadPairs();
    expect(loaded.map((p) => p.name).sort()).toEqual(["cheap", "trial"]);
    expect(loaded.find((p) => p.name === "trial")!.drafter.ref).toBe("e/five");
  });

  test("re-saving a name is not using it: the last-used mark survives", async () => {
    await savePair({ name: "trial", ...models("a/one", "b/two") });
    await markPairUsed("trial", "2026-10-18T12:00:00Z");
    await savePair({ name: "trial", ...models("a/one", "b/three") });

    const loaded = await loadPairs();
    expect(loaded[0]!.lastUsedAt).toBe("2026-10-18T12:00:00Z");
  });

  test("a broken file is no pairs, not a crash", async () => {
    await mkdir(path.dirname(pairsFile()), { recursive: true });
    await writeFile(pairsFile(), "{not json");
    expect(await loadPairs()).toEqual([]);
  });

  test("an entry without two models is skipped, the rest are kept", async () => {
    await savePair({ name: "good", ...models("a/one", "b/two") });
    await mkdir(path.dirname(pairsFile()), { recursive: true });
    const raw = JSON.parse(await readFile(pairsFile(), "utf8"));
    raw.push({ name: "no-models", savedAt: "2026-01-01T00:00:00Z" });
    raw.push({ name: "", drafter: { ref: "a/one", family: "a" }, reviewer: { ref: "b/two", family: "b" } });
    await writeFile(pairsFile(), JSON.stringify(raw));

    expect((await loadPairs()).map((p) => p.name)).toEqual(["good"]);
  });

  test("marking an unknown pair changes nothing and deleting one says so", async () => {
    await savePair({ name: "trial", ...models("a/one", "b/two") });
    expect(await markPairUsed("nope")).toHaveLength(1);
    expect(await deletePair("nope")).toBe(false);
    expect(await deletePair("trial")).toBe(true);
    expect(await loadPairs()).toEqual([]);
  });

  test("a pair carries bookkeeping that must not reach the config's models", async () => {
    // A `Pair` and a `RecentPair` both satisfy `{drafter, reviewer}` while
    // carrying a name and dates, and `Config.models` took one whole once: the
    // repository's config.json ended up with `name` and `savedAt` inside
    // `models`, where loadConfig read them back as part of the models.
    await savePair({ name: "trial", ...models("a/one", "b/two") });
    const stored = (await loadPairs())[0]!;
    expect(pairModels(stored)).toEqual({ drafter: stored.drafter, reviewer: stored.reviewer });
    expect(Object.keys(pairModels(stored)).sort()).toEqual(["drafter", "reviewer"]);
    // The same for a pair a run used, which also carries run, task and dates.
    const fromRun: RecentPair = { ...models("a/one", "b/two"), run: "x", task: "t", mode: "plan", createdAt: "now" };
    expect(Object.keys(pairModels(fromRun)).sort()).toEqual(["drafter", "reviewer"]);
  });

  test("the key is the two refs, and a space cannot be inside either", () => {
    // Refs carry no whitespace, so the separator is unambiguous and two
    // different pairs cannot collide on it.
    expect(pairKey(models("a/one", "b/two"))).toBe(pairKey(models("a/one", "b/two")));
    expect(pairKey(models("a/one", "b/two"))).not.toBe(pairKey(models("a/one", "b/two x")));
  });

  test("renaming keeps the models and the dates, under the new name", async () => {
    await savePair({ name: "old", ...models("a/one", "b/two") });
    await markPairUsed("old", "2026-10-18T12:00:00Z");
    const before = (await loadPairs())[0]!;

    await renamePair("old", "new", pairModels(before));

    const loaded = await loadPairs();
    expect(loaded.map((p) => p.name)).toEqual(["new"]);
    expect(loaded[0]!.drafter.ref).toBe("a/one");
    expect(loaded[0]!.savedAt).toBe(before.savedAt);
    expect(loaded[0]!.lastUsedAt).toBe("2026-10-18T12:00:00Z");
  });

  test("renaming onto an existing name replaces that pair", async () => {
    await savePair({ name: "old", ...models("a/one", "b/two") });
    await savePair({ name: "taken", ...models("c/three", "d/four") });

    await renamePair("old", "taken", models("a/one", "b/two"));

    const loaded = await loadPairs();
    expect(loaded.map((p) => p.name)).toEqual(["taken"]);
    expect(loaded[0]!.drafter.ref).toBe("a/one");
  });
});

describe("suggested pair names", () => {
  test("the short end of each ref, joined without spaces", () => {
    expect(suggestPairName(models("anthropic/claude-haiku-5-5", "openrouter/openai/gpt-6-luna"))).toBe(
      "claude-haiku-5-5 -> gpt-6-luna",
    );
  });

  test("refs without a provider still suggest something", () => {
    expect(suggestPairName(models("one", "b/two"))).toBe("one -> two");
  });

  test("a blank ref suggests nothing — the prompt still requires a name", () => {
    expect(suggestPairName(models("", "b/two"))).toBe("");
    expect(suggestPairName(models("a/one", "  "))).toBe("");
  });
});

describe("ordering pairs by use", () => {
  test("the last used pair comes first, and unused ones come last by name", () => {
    const sorted = sortedPairs([
      { name: "never-b", savedAt: "x", ...models("a/1", "b/2") },
      { name: "older", savedAt: "x", lastUsedAt: "2026-10-01T00:00:00Z", ...models("a/1", "b/2") },
      { name: "newest", savedAt: "x", lastUsedAt: "2026-10-18T00:00:00Z", ...models("a/1", "b/2") },
      { name: "never-a", savedAt: "x", ...models("a/1", "b/2") },
    ]);
    expect(sorted.map((p) => p.name)).toEqual(["newest", "older", "never-a", "never-b"]);
  });

  test("the settings row names the pair the current models are, by model not by position", () => {
    const pairs = [
      { name: "trial", savedAt: "x", ...models("a/one", "b/two") },
      { name: "cheap", savedAt: "x", ...models("a/three", "b/four") },
    ];
    // Two names for one pair: whichever sorts first is the one shown.
    expect(nameForPair(pairs, models("a/three", "b/four"))).toBe("cheap");
    // A family label that disagrees with the ref does not hide the name.
    expect(nameForPair(pairs, { drafter: { ref: "a/one", family: "wrong" }, reviewer: { ref: "b/two", family: "wrong" } })).toBe(
      "trial",
    );
    // An unnamed pair says nothing rather than naming the wrong one.
    expect(nameForPair(pairs, models("z/other", "y/other"))).toBeNull();
  });
});

describe("pairs runs have used", () => {
  test("newest first, deduplicated, and each pair names the run that used it", () => {
    const list = recentPairs([
      run("3", { models: models("a/one", "b/two") }),
      run("2", { models: models("a/one", "b/two") }),
      run("1", { models: models("c/three", "d/four") }),
    ]);
    expect(list.map((p) => p.run)).toEqual(["3", "1"]);
    expect(list[0]!.drafter.ref).toBe("a/one");
    expect(list[0]!.task).toBe("task 3");
  });

  test("a run with no recorded models is skipped, not a failure", () => {
    const list = recentPairs([run("2"), run("1", { models: models("a/one", "b/two") })]);
    expect(list.map((p) => p.run)).toEqual(["1"]);
  });

  test("the list is capped, newest kept", () => {
    const list = recentPairs(
      Array.from({ length: 20 }, (_, i) => run(`${20 - i}`, { models: models(`a/${i}`, "b/2") })),
      8,
    );
    expect(list).toHaveLength(8);
    expect(list[0]!.run).toBe("20");
    expect(list[7]!.run).toBe("13");
  });
});

describe("the rows the pair screen draws", () => {
  const pair = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    savedAt: "2026-10-01T00:00:00Z",
    ...models("a/one", "b/two"),
    ...over,
  });

  test("saved pairs first (last used first), then the runs, then the two ways to make one", () => {
    const rows = pairRows(
      [
        pair("unused", { lastUsedAt: undefined }),
        pair("used-yesterday", { lastUsedAt: "2026-10-17T00:00:00Z" }),
        pair("used-today", { lastUsedAt: "2026-10-18T00:00:00Z" }),
      ],
      [run("1", { models: models("c/three", "d/four") })],
      new Set(),
    );
    expect(rows.map((r) => (r.kind === "saved" ? r.pair.name : r.kind === "recent" ? r.recent.run : r.kind))).toEqual([
      "used-today",
      "used-yesterday",
      "unused",
      "gap",
      "1",
      "gap",
      "new",
      "save",
    ]);
  });

  test("gaps only sit between non-empty groups — never leading, trailing, or doubled", () => {
    const kinds = (rows: PairRow[]) => rows.map((r) => r.kind);
    // Saved only: one gap before the two action rows.
    expect(kinds(pairRows([pair("a")], [], new Set()))).toEqual(["saved", "gap", "new", "save"]);
    // Runs only: one gap before the two action rows.
    expect(kinds(pairRows([], [run("1", { models: models("c/three", "d/four") })], new Set()))).toEqual([
      "recent",
      "gap",
      "new",
      "save",
    ]);
    // Neither: just the two action rows, no gaps at all.
    expect(kinds(pairRows([], [], new Set()))).toEqual(["new", "save"]);
  });

  test("the preset scope lists saved pairs only — no runs, no way to make one", () => {
    const rows = pairRows(
      [pair("trial")],
      [run("1", { models: models("c/three", "d/four") })],
      new Set(),
      "preset",
    );
    expect(rows.map((r) => (r.kind === "saved" ? r.pair.name : r.kind))).toEqual(["trial"]);
  });

  test("a saved pair is not repeated by the run that used it", () => {
    const rows = pairRows([pair("trial")], [run("1", { models: models("a/one", "b/two") })], new Set());
    expect(rows.filter((r) => r.kind === "recent")).toHaveLength(0);
    expect(rows).toHaveLength(4);
  });

  test("a same-family pair is marked, not hidden", () => {
    const [row] = pairRows(
      [pair("same", { drafter: { ref: "groq/one", family: "gpt" }, reviewer: { ref: "groq/two", family: "gpt" } })],
      [],
      new Set(),
    );
    expect(row!.kind).toBe("saved");
    expect((row as { warnings: string[] }).warnings.join(" ")).toContain("share family");
  });

  test("a model that is gone is marked, and both problems are reported", () => {
    const [row] = pairRows(
      [pair("stale", { reviewer: { ref: "gone/model", family: "gone" } })],
      [],
      new Set(["a/one"]),
    );
    expect((row as { warnings: string[] }).warnings).toEqual(["gone/model is not listed any more"]);
  });

  test("an unknown model list marks nothing — a failed listing is not a broken pair", () => {
    const [row] = pairRows([pair("fine", { reviewer: { ref: "not/listed", family: "not" } })], [], new Set());
    expect((row as { warnings: string[] }).warnings).toEqual([]);
  });

  test("every row has a key of its own, which is what the cursor moves over", () => {
    const rows = pairRows([pair("a"), pair("b")], [run("1", { models: models("c/three", "d/four") })], new Set());
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
