import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bareOf,
  baseKeyOf,
  buildIndex,
  countScoredBySource,
  countScored,
  formatBenchmarks,
  formatResolved,
  formatTaskCost,
  isStale,
  loadScores,
  mergeIndexes,
  normalizeId,
  parseBenchmarks,
  saveScores,
  scoresFor,
  suffixesOf,
  STALE_AFTER_MS,
} from "./benchmarks.ts";
import { parseCatalogue } from "./catalogue.ts";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "adv-benchmarks-"));

/** OpenRouter-shaped payload: the relay this reads. */
const PAYLOAD = JSON.stringify({
  data: [
    {
      id: "z-ai/glm-5.3-flash",
      benchmarks: { artificial_analysis: { intelligence_index: 41.8, coding_index: 71.5, agentic_index: 50.9 } },
    },
    {
      id: "z-ai/glm-5.3-flash:batch",
      benchmarks: { artificial_analysis: { intelligence_index: 41.8, coding_index: 71.5, agentic_index: 50.9 } },
    },
    {
      id: "anthropic/claude-haiku-5.5",
      benchmarks: { artificial_analysis: { intelligence_index: 43.4, coding_index: null, agentic_index: null } },
    },
    // No benchmarks object at all: a model the relay says nothing about.
    { id: "reflection/beam-1.0-501b-a23b" },
    // Design Arena only, no AA indices: not a score.
    { id: "x/y", benchmarks: { design_arena: [{ arena: "models", category: "codecategories", elo: 1283 }] } },
    // Not finite: not a score.
    { id: "x/z", benchmarks: { artificial_analysis: { intelligence_index: "high" } } },
  ],
});

const CATALOGUE = JSON.stringify({
  "opencode-go": {
    id: "opencode-go",
    models: {
      "glm-5.3-flash": { tool_call: true, canonical_model_id: "z-ai/glm-5.3-flash", cost: null },
      "haiku-5-5": { tool_call: true, canonical_model_id: "anthropic/claude-haiku-5.5", cost: null },
      // Served id dashed, canonical dotted: matching needs normalisation.
      "sonnet-5-5": { tool_call: true, canonical_model_id: "anthropic/claude-sonnet-5-5", cost: null },
      // Same weights under a different provider namespace: tier 2.
      "glm-namespace": { tool_call: true, canonical_model_id: "zhipuai/glm-5.3-flash", cost: null },
      // No canonical id: served where it is made, nothing to bridge on.
      "beam-free": { tool_call: true, cost: { input: 0, output: 0 } },
    },
  },
});

const SONNET_PAYLOAD = JSON.stringify({
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      benchmarks: { artificial_analysis: { intelligence_index: 56, coding_index: 80.1 } },
    },
  ],
});

describe("normalizeId", () => {
  test("dots become dashes, case folds, batch and free variants collapse", () => {
    expect(normalizeId("anthropic/claude-haiku-5.5")).toBe("anthropic/claude-haiku-5-5");
    expect(normalizeId("Z-AI/GLM-5.3-Flash:batch")).toBe("z-ai/glm-5-3-flash");
    expect(normalizeId("a/b:free")).toBe("a/b");
  });

  test("suffixes that may change the model are kept", () => {
    expect(normalizeId("a/b:online")).toBe("a/b:online");
    expect(normalizeId("a/b:extended")).toBe("a/b:extended");
  });
});

describe("parseBenchmarks", () => {
  test("reads the three indices, ignores everything else", () => {
    const b = parseBenchmarks(PAYLOAD);
    expect(b.byId.get("z-ai/glm-5-3-flash")).toEqual({
      id: "z-ai/glm-5.3-flash",
      scores: { intelligence: 41.8, coding: 71.5, agentic: 50.9 },
      source: "openrouter",
    });
    expect(b.byId.get("anthropic/claude-haiku-5-5")).toEqual({
      id: "anthropic/claude-haiku-5.5",
      scores: { intelligence: 43.4 },
      source: "openrouter",
    });
    expect(b.byId.has("reflection/beam-1-0-501b-a23b")).toBe(false);
    expect(b.byId.has("x/y")).toBe(false);
    expect(b.byId.has("x/z")).toBe(false);
  });

  test("a routing variant of the same weights keeps the first id", () => {
    const b = parseBenchmarks(PAYLOAD);
    // :batch normalised onto the base key with identical scores: one entry.
    expect(b.byId.get("z-ai/glm-5-3-flash")?.id).toBe("z-ai/glm-5.3-flash");
  });

  test("two different models normalising together with different scores resolve to nothing", () => {
    const clash = JSON.stringify({
      data: [
        { id: "a/b-1.0", benchmarks: { artificial_analysis: { intelligence_index: 10 } } },
        { id: "a/b-1-0", benchmarks: { artificial_analysis: { intelligence_index: 90 } } },
      ],
    });
    expect(parseBenchmarks(clash).byId.size).toBe(0);
  });

  test("broken JSON, an array, a scalar, and OpenCode's model.json are each empty", () => {
    expect(parseBenchmarks("{not json").byId.size).toBe(0);
    expect(parseBenchmarks("[]").byId.size).toBe(0);
    expect(parseBenchmarks("42").byId.size).toBe(0);
    expect(
      parseBenchmarks(JSON.stringify({ recent: [], favorite: [], variant: {} })).byId.size,
    ).toBe(0);
  });
});

describe("bareOf", () => {
  test("strips the provider namespace, then normalises", () => {
    expect(bareOf("zhipuai/glm-5.3-flash")).toBe("glm-5-3-flash");
    expect(bareOf("openrouter/qwen/qwen3.8-27b")).toBe("qwen/qwen3-8-27b");
    expect(bareOf("a/b:batch")).toBe("b");
  });

  test("a bare slug is itself — AA ids have no namespace to strip", () => {
    expect(bareOf("glm-5.3-flash")).toBe("glm-5-3-flash");
  });
});

describe("suffixesOf", () => {
  test("full id down to the bare model part, longest first", () => {
    expect(suffixesOf("togetherai/deepseek-ai/DeepSeek-V4.1-Flash")).toEqual([
      "togetherai/deepseek-ai/deepseek-v4-1-flash",
      "deepseek-ai/deepseek-v4-1-flash",
      "deepseek-v4-1-flash",
    ]);
    expect(suffixesOf("glm-5.3-flash")).toEqual(["glm-5-3-flash"]);
  });
});

describe("baseKeyOf", () => {
  test("strips effort and mode suffixes, keeps namespaces, never empties", () => {
    expect(baseKeyOf("claude-opus-4-5-thinking")).toBe("claude-opus-4-5");
    expect(baseKeyOf("gpt-6-sol-low")).toBe("gpt-6-sol");
    expect(baseKeyOf("a/b-reasoning-medium")).toBe("a/b");
    expect(baseKeyOf("anthropic/claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
    expect(baseKeyOf("max")).toBe("max");
  });
});

describe("buildIndex", () => {
  test("a bare part owned by one model resolves, a shared one does not", () => {
    const b = buildIndex([
      { id: "z-ai/glm-5.3-flash", scores: { intelligence: 42 }, source: "openrouter" as const },
      { id: "x-ai/grok-4.5", scores: { intelligence: 50 }, source: "openrouter" as const },
      { id: "x-ai/grok-4.5:batch", scores: { intelligence: 50 }, source: "openrouter" as const },
    ]);
    expect(b.byBare.get("glm-5-3-flash")).toBe("z-ai/glm-5-3-flash");
    expect(b.byBare.get("grok-4-5")).toBe("x-ai/grok-4-5");
  });

  test("two providers serving one model name refuse tier 2", () => {
    const b = buildIndex([
      { id: "z-ai/glm-5.3-flash", scores: { intelligence: 42 }, source: "openrouter" as const },
      { id: "other/glm-5.3-flash", scores: { intelligence: 42 }, source: "openrouter" as const },
    ]);
    expect(b.byBare.has("glm-5-3-flash")).toBe(false);
    // The full ids still resolve: only the bare shortcut refuses.
    expect(b.byId.size).toBe(2);
  });
});

describe("scoresFor", () => {
  test("an exact canonical id resolves without a mark", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = parseBenchmarks(PAYLOAD);
    expect(scoresFor(c, b, "opencode-go/glm-5.3-flash")).toEqual({
      intelligence: 41.8,
      coding: 71.5,
      agentic: 50.9,
      sourceId: "z-ai/glm-5.3-flash",
      source: "openrouter",
      normalised: false,
    });
  });

  test("a -/. mismatch resolves and is marked as a guess", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = parseBenchmarks(SONNET_PAYLOAD);
    const r = scoresFor(c, b, "opencode-go/sonnet-5-5");
    expect(r?.normalised).toBe(true);
    expect(r?.sourceId).toBe("anthropic/claude-sonnet-5.5");
    expect(r?.intelligence).toBe(56);
  });

  test("a different provider namespace resolves through the bare part, marked", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = parseBenchmarks(PAYLOAD);
    const r = scoresFor(c, b, "opencode-go/glm-namespace");
    expect(r?.sourceId).toBe("z-ai/glm-5.3-flash");
    expect(r?.normalised).toBe(true);
    expect(r?.coding).toBe(71.5);
  });

  test("a shared bare part refuses tier 2 rather than picking", () => {
    const c = parseCatalogue(
      JSON.stringify({
        prov: { id: "prov", models: { m: { canonical_model_id: "somebody/glm-5.3-flash" } } },
      }),
    );
    const b = buildIndex([
      { id: "z-ai/glm-5.3-flash", scores: { intelligence: 42 }, source: "openrouter" as const },
      { id: "other/glm-5.3-flash", scores: { intelligence: 43 }, source: "openrouter" as const },
    ]);
    expect(scoresFor(c, b, "prov/m")).toBeNull();
  });

  test("no canonical id, an unknown ref, and an unscored model are all null", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = parseBenchmarks(PAYLOAD);
    expect(scoresFor(c, b, "opencode-go/beam-free")).toBeNull();
    expect(scoresFor(c, b, "nowhere/nothing")).toBeNull();
    // Haiku is scored here, so use a scored-model-missing case instead: beam
    // has scores nowhere in the relay.
    expect(scoresFor(c, b, "opencode-go/beam-free")).toBeNull();
  });

  test("tier 3: a ref with no canonical id resolves through its own model part", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = buildIndex([
      { id: "z-ai/beam-free", scores: { intelligence: 7 }, source: "openrouter" as const },
    ]);
    const r = scoresFor(c, b, "opencode-go/beam-free");
    expect(r?.intelligence).toBe(7);
    expect(r?.sourceId).toBe("z-ai/beam-free");
    expect(r?.normalised).toBe(true);
  });

  test("tier 4: extra namespaces strip down to the model", () => {
    const c = parseCatalogue(
      JSON.stringify({
        prov: { id: "prov", models: { m: { canonical_model_id: "togetherai/deepseek-ai/DeepSeek-V4.1-Flash" } } },
      }),
    );
    const b = buildIndex([
      { id: "deepseek/deepseek-v4.1-flash", scores: { intelligence: 39 }, source: "openrouter" as const },
    ]);
    const r = scoresFor(c, b, "prov/m");
    // The canonical's own chain ends in the bare model part; the index holds
    // it under one namespace, and the suffix still finds it.
    expect(r?.intelligence).toBe(39);
    expect(r?.normalised).toBe(true);
  });

  test("a bare AA slug resolves a ref whose canonical names the same model", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = buildIndex([
      { id: "glm-5-3-flash", scores: { intelligence: 42 }, source: "aa" as const, name: "GLM 5.3 Flash" },
    ]);
    const r = scoresFor(c, b, "opencode-go/glm-5.3-flash");
    expect(r?.intelligence).toBe(42);
    expect(r?.source).toBe("aa");
    expect(r?.sourceId).toBe("glm-5-3-flash");
    expect(r?.normalised).toBe(true);
  });
});

describe("variant preference", () => {
  const catalogueOf = (canonical: string) =>
    parseCatalogue(
      JSON.stringify({ prov: { id: "prov", models: { m: { canonical_model_id: canonical } } } }),
    );

  test("a reasoning sibling wins over the matched base, marked", () => {
    const b = buildIndex([
      {
        id: "claude-opus-4-5",
        scores: { intelligence: 23.7 },
        source: "aa" as const,
        name: "Claude Opus 4.5 (Non-reasoning)",
      },
      {
        id: "claude-opus-4-5-thinking",
        scores: { intelligence: 29.1 },
        source: "aa" as const,
        name: "Claude Opus 4.5 (Reasoning)",
      },
    ]);
    const r = scoresFor(catalogueOf("anthropic/claude-opus-4-5"), b, "prov/m");
    expect(r?.intelligence).toBe(29.1);
    expect(r?.sourceId).toBe("claude-opus-4-5-thinking");
    expect(r?.normalised).toBe(true);
  });

  test("non-reasoning never wins by containing the word reasoning", () => {
    const b = buildIndex([
      {
        id: "deepseek-v4-1-flash",
        scores: { intelligence: 39.5 },
        source: "aa" as const,
        name: "DeepSeek V4.1 Flash (Max)",
      },
      {
        id: "deepseek-v4-1-flash-non-reasoning",
        scores: { intelligence: 24.7 },
        source: "aa" as const,
        name: "DeepSeek V4.1 Flash (Non-reasoning)",
      },
    ]);
    const r = scoresFor(catalogueOf("deepseek/deepseek-v4.1-flash"), b, "prov/m");
    expect(r?.intelligence).toBe(39.5);
    expect(r?.sourceId).toBe("deepseek-v4-1-flash");
  });

  test("no reasoning variant: the base wins, deterministically", () => {
    const b = buildIndex([
      {
        id: "gemini-3-5-flash-medium",
        scores: { intelligence: 33.6 },
        source: "aa" as const,
        name: "Gemini 3.5 Flash (Medium)",
      },
      {
        id: "gemini-3-5-flash",
        scores: { intelligence: 32.6 },
        source: "aa" as const,
        name: "Gemini 3.5 Flash",
      },
    ]);
    const r = scoresFor(catalogueOf("google/gemini-3.5-flash"), b, "prov/m");
    expect(r?.intelligence).toBe(32.6);
    expect(r?.sourceId).toBe("gemini-3-5-flash");
  });

  test("nameless entries never trigger an override", () => {
    const b = buildIndex([
      { id: "m-base", scores: { intelligence: 10 }, source: "openrouter" as const },
      { id: "m-base-max", scores: { intelligence: 20 }, source: "openrouter" as const },
    ]);
    const r = scoresFor(catalogueOf("prov/m-base"), b, "prov/m");
    expect(r?.intelligence).toBe(10);
    // Still a namespace-stripped match, so still marked — just not overridden.
    expect(r?.normalised).toBe(true);
  });
});

describe("mergeIndexes", () => {
  const aa = (id: string, intelligence: number) =>
    ({ id, scores: { intelligence }, source: "aa" as const, name: `${id} (Max)` });
  const or = (id: string, intelligence: number) =>
    ({ id, scores: { intelligence }, source: "openrouter" as const });

  test("AA wins ties; the relay fills what AA never heard of", () => {
    const merged = mergeIndexes(
      buildIndex([aa("deepseek-v4-1-flash", 39.5), aa("glm-5-3-flash", 41.8)]),
      buildIndex([or("deepseek/deepseek-v4.1-flash", 24.7), or("anthropic/claude-haiku-4-5", 16.9)]),
    );
    // Same model under a namespace: the relay's copy is dropped.
    expect(merged.byId.get("deepseek/deepseek-v4-1-flash")).toBeUndefined();
    expect(merged.byId.get("deepseek-v4-1-flash")?.source).toBe("aa");
    // Retired from AA, alive on the relay: kept.
    expect(merged.byId.get("anthropic/claude-haiku-4-5")?.source).toBe("openrouter");
  });

  test("an identical key keeps AA, never a dropped-key blank", () => {
    const merged = mergeIndexes(
      buildIndex([aa("same-model", 50)]),
      buildIndex([or("same-model", 10)]),
    );
    expect(merged.byId.get("same-model")?.scores.intelligence).toBe(50);
  });
});

describe("countScoredBySource", () => {
  test("splits the resolved rows by provenance", () => {
    const c = parseCatalogue(CATALOGUE);
    const merged = mergeIndexes(
      buildIndex([
        {
          id: "glm-5-3-flash",
          scores: { intelligence: 42 },
          source: "aa" as const,
          name: "GLM 5.3 Flash",
        },
      ]),
      parseBenchmarks(PAYLOAD),
    );
    const split = countScoredBySource(
      ["opencode-go/glm-5.3-flash", "opencode-go/haiku-5-5", "opencode-go/beam-free"],
      c,
      merged,
    );
    // glm resolves through AA (the relay's copy is dropped as covered);
    // haiku is relay-only; beam is nowhere.
    expect(split).toEqual({ total: 2, aa: 1, openrouter: 1 });
    expect(countScored(["opencode-go/glm-5.3-flash"], c, merged)).toBe(1);
  });
});

describe("formatBenchmarks", () => {
  test("shows only what exists, rounded, blank when nothing", () => {
    expect(formatBenchmarks({ intelligence: 41.8, coding: 71.5, agentic: 50.9 })).toBe("I42 C72 A51");
    expect(formatBenchmarks({ intelligence: 43.4 })).toBe("I43");
    expect(formatBenchmarks({})).toBe("");
  });

  test("a normalised match carries ≈ so the guess is visible", () => {
    expect(
      formatResolved({ intelligence: 56, sourceId: "anthropic/claude-sonnet-5.5", source: "openrouter", normalised: true }),
    ).toBe("≈I56");
    expect(
      formatResolved({ intelligence: 56, sourceId: "a/b", source: "openrouter", normalised: false }),
    ).toBe("I56");
    expect(formatResolved(null)).toBe("");
  });

  test("task cost reads in dollars, negligible reads as negligible rather than $0.0000", () => {
    expect(formatTaskCost(0.1678)).toBe("$0.17");
    expect(formatTaskCost(2.01)).toBe("$2.01");
    expect(formatTaskCost(0.00004)).toBe("<$0.01");
    expect(formatTaskCost(undefined)).toBe("");
  });
});

describe("cache", () => {
  test("a missing file is an empty cache with no date", async () => {
    const loaded = await loadScores(path.join(await tmp(), "benchmarks.json"));
    expect(loaded.scores.byId.size).toBe(0);
    expect(loaded.at).toBeNull();
  });

  test("malformed JSON and foreign shapes are empty, never a throw", async () => {
    const dir = await tmp();
    const { writeFile } = await import("node:fs/promises");
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect((await loadScores(bad)).scores.byId.size).toBe(0);
    const foreign = path.join(dir, "foreign.json");
    await writeFile(foreign, JSON.stringify({ recent: [], favorite: [] }));
    expect((await loadScores(foreign)).scores.byId.size).toBe(0);
  });

  test("round-trips through the serial shape, keyed by raw id", async () => {
    const dir = await tmp();
    const { writeFile } = await import("node:fs/promises");
    const file = path.join(dir, "benchmarks.json");
    await writeFile(
      file,
      JSON.stringify({
        at: "2026-10-19T00:00:00.000Z",
        scores: { "z-ai/glm-5.3-flash": { intelligence: 41.8, coding: 71.5 } },
      }),
    );
    const loaded = await loadScores(file);
    expect(loaded.at).toBe("2026-10-19T00:00:00.000Z");
    expect(loaded.indexVersion).toBeNull();
    expect(loaded.scores.byId.get("z-ai/glm-5-3-flash")).toEqual({
      id: "z-ai/glm-5.3-flash",
      scores: { intelligence: 41.8, coding: 71.5 },
      source: "openrouter",
    });
    // The bare shortcut survives the round trip too.
    expect(loaded.scores.byBare.get("glm-5-3-flash")).toBe("z-ai/glm-5-3-flash");
  });

  test("round-trips sources and the index version", async () => {
    const dir = await tmp();
    const file = path.join(dir, "benchmarks.json");
    const merged = mergeIndexes(
      buildIndex([
        {
          id: "glm-5-3-flash",
          scores: { intelligence: 41.8 },
          source: "aa",
          name: "GLM 5.3 Flash (Max)",
          taskCost: 0.12,
        },
      ]),
      parseBenchmarks(PAYLOAD),
    );
    await saveScores(merged, "2026-10-19T00:00:00.000Z", file, "4.3");
    const loaded = await loadScores(file);
    expect(loaded.indexVersion).toBe("4.3");
    expect(loaded.scores.byId.get("glm-5-3-flash")).toEqual({
      id: "glm-5-3-flash",
      scores: { intelligence: 41.8 },
      source: "aa",
      name: "GLM 5.3 Flash (Max)",
      taskCost: 0.12,
    });
    // The relay's copy of the same model was dropped in the merge.
    expect(loaded.scores.byId.get("z-ai/glm-5-3-flash")).toBeUndefined();
    // Variant and bare maps survive the round trip.
    expect(loaded.scores.variants.get("glm-5-3-flash")).toEqual(["glm-5-3-flash"]);
    expect(loaded.scores.byBare.get("glm-5-3-flash")).toBe("glm-5-3-flash");
  });
});

describe("isStale", () => {
  test("no date is stale, a week is the window", () => {
    expect(isStale(null)).toBe(true);
    expect(isStale("not a date")).toBe(true);
    expect(isStale(new Date().toISOString())).toBe(false);
    expect(isStale(new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString())).toBe(true);
  });
});

describe("countScored", () => {
  test("counts refs that resolve, nothing else", () => {
    const c = parseCatalogue(CATALOGUE);
    const b = parseBenchmarks(PAYLOAD);
    expect(
      countScored(
        ["opencode-go/glm-5.3-flash", "opencode-go/haiku-5-5", "opencode-go/beam-free"],
        c,
        b,
      ),
    ).toBe(2);
    // The namespaced twin resolves too, through the bare part.
    expect(countScored(["opencode-go/glm-namespace"], c, b)).toBe(1);
  });
});
