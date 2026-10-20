import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cannotUseTools,
  costOf,
  formatCost,
  formatCostBasis,
  formatCostFull,
  loadBestCatalogue,
  parseCatalogue,
  splitRef,
  toolsOf,
} from "./catalogue.ts";

/** A catalogue shaped like the real one, including a `null` model entry. */
const FIXTURE = JSON.stringify({
  groq: {
    id: "groq",
    api: "https://api.groq.com/openai/v1",
    models: {
      "qwen/qwen3.8-27b": { family: "qwen", tool_call: true, cost: { input: 0.8, output: 4 }, limit: { context: 131072 } },
      "compound-mini": { family: "groq", tool_call: false, cost: null },
      "beam-free": null,
    },
  },
  "opencode-go": {
    id: "opencode-go",
    models: {
      "space-bunny-free": { family: "space-bunny", tool_call: true, cost: { input: 0, output: 0 } },
      "muse-spark-1.3-contributor": {
        family: "muse",
        tool_call: true,
        cost: { input: 0.1, output: 0.2, tiers: [{ input: 0.2, output: 0.4 }] },
      },
    },
  },
});

describe("splitRef", () => {
  test("splits on the first slash only, so a model id may contain slashes", () => {
    expect(splitRef("openrouter/qwen/qwen3.8-27b")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.8-27b",
    });
  });

  test("a models.dev id that already carries the provider still splits once", () => {
    expect(splitRef("groq/groq/compound-mini")).toEqual({ provider: "groq", model: "groq/compound-mini" });
  });

  test("nonsense is rejected rather than half-split", () => {
    expect(splitRef("no-slash")).toBeNull();
    expect(splitRef("/leading")).toBeNull();
    expect(splitRef("trailing/")).toBeNull();
  });
});

describe("parseCatalogue", () => {
  test("keys entries by the ref adv already uses", () => {
    const c = parseCatalogue(FIXTURE);
    expect(c.has("groq/qwen/qwen3.8-27b")).toBe(true);
    expect(c.has("opencode-go/space-bunny-free")).toBe(true);
  });

  test("a model whose upstream entry is null is absent, but its `-free` name still says free", () => {
    // groq/beam-free is literally null in the real catalogue — absent from the
    // map, and the suffix rule below recovers it.
    const c = parseCatalogue(FIXTURE);
    expect(c.has("groq/beam-free")).toBe(false);
    expect(costOf(c, "groq/beam-free")).toEqual({ kind: "free" });
  });

  test("REJECTS OpenCode's model.json, which parses as JSON and is not a catalogue", () => {
    // The failure this prevents is silent: read the wrong file, every lookup
    // misses, every row renders "?", nothing reports an error.
    const state = JSON.stringify({
      recent: [{ providerID: "groq", modelID: "qwen/qwen3.8-27b" }],
      favorite: [{ providerID: "opencode-go", modelID: "space-bunny-free" }],
      variant: { "groq/qwen": "high" },
    });
    expect(parseCatalogue(state).size).toBe(0);
  });

  test("an empty-ish state file with only variant is still rejected", () => {
    expect(parseCatalogue(JSON.stringify({ variant: {} })).size).toBe(0);
  });

  test("broken JSON, an array, and a scalar are each an empty catalogue", () => {
    expect(parseCatalogue("{not json").size).toBe(0);
    expect(parseCatalogue("[]").size).toBe(0);
    expect(parseCatalogue("42").size).toBe(0);
    expect(parseCatalogue("").size).toBe(0);
  });

  test("providers with no models key are skipped, not fatal", () => {
    const c = parseCatalogue(JSON.stringify({ foo: { id: "foo" }, bar: { models: { m: { cost: null } } } }));
    expect(c.size).toBe(1);
    expect(c.has("bar/m")).toBe(true);
  });
});

describe("cost", () => {
  const c = parseCatalogue(FIXTURE);

  test("zero in and zero out is free", () => {
    expect(costOf(c, "opencode-go/space-bunny-free")).toEqual({ kind: "free" });
  });

  test("a null cost is unknown, never free", () => {
    // The one rule that matters: rendering an unknown cost as "free" bills real
    // money later.
    expect(costOf(c, "groq/compound-mini")).toEqual({ kind: "unknown" });
  });

  test("an absent `-free` model is free: every upstream `-free` is one", () => {
    // The catalogue has not caught up with opencode/deepseek-v4.1-flash-free;
    // its name is the evidence. Only a silence infers — never an override.
    expect(costOf(c, "opencode/deepseek-v4.1-flash-free")).toEqual({ kind: "free" });
    expect(costOf(c, "nowhere/something-free")).toEqual({ kind: "free" });
  });

  test("the `-free` inference never overrides what the catalogue states", () => {
    // Priced stays priced even under a free-shaped name; a bare `free` is a
    // name, not a tier.
    const priced = parseCatalogue(
      JSON.stringify({ p: { id: "p", models: { "x-free": { cost: { input: 1, output: 2 } } } } }),
    );
    expect(costOf(priced, "p/x-free")).toMatchObject({ kind: "priced", input: 1 });
    expect(costOf(c, "nowhere/free")).toEqual({ kind: "unknown" });
  });

  test("an absent model is unknown, never free", () => {
    expect(costOf(c, "nowhere/nothing")).toEqual({ kind: "unknown" });
  });

  test("a price with tiers is flagged, because a long run costs more", () => {
    const cost = costOf(c, "opencode-go/muse-spark-1.3-contributor");
    expect(cost).toMatchObject({ kind: "priced", input: 0.1, output: 0.2, tiered: true });
  });

  test("a price without tiers is not flagged", () => {
    expect(costOf(c, "groq/qwen/qwen3.8-27b")).toMatchObject({ kind: "priced", tiered: false });
  });
});

describe("loadBestCatalogue", () => {
  const tmp = () => mkdtemp(path.join(os.tmpdir(), "adv-catalogue-"));
  const shaped = (model: string) =>
    JSON.stringify({ p: { id: "p", models: { [model]: { cost: { input: 1, output: 2 } } } } });
  const stamp = async (file: string, ageMs: number) => {
    // mtime is the age: utimes sets it back by ageMs.
    const t = new Date(Date.now() - ageMs);
    const { utimes } = await import("node:fs/promises");
    await utimes(file, t, t);
  };

  test("the newer copy wins", async () => {
    const dir = await tmp();
    const opencode = path.join(dir, "opencode.json");
    const adv = path.join(dir, "adv.json");
    await writeFile(opencode, shaped("old-model"));
    await writeFile(adv, shaped("new-model"));
    await stamp(opencode, 10 * 24 * 60 * 60 * 1000);
    await stamp(adv, 1000);
    const r = await loadBestCatalogue(opencode, adv);
    expect(r.catalogue.has("p/new-model")).toBe(true);
  });

  test("a newer copy that parses to nothing falls back to the older", async () => {
    const dir = await tmp();
    const opencode = path.join(dir, "opencode.json");
    const adv = path.join(dir, "adv.json");
    await writeFile(opencode, shaped("good-model"));
    await writeFile(adv, "{not json");
    await stamp(opencode, 10 * 24 * 60 * 60 * 1000);
    await stamp(adv, 1000);
    const r = await loadBestCatalogue(opencode, adv);
    expect(r.catalogue.has("p/good-model")).toBe(true);
  });

  test("no files is an empty catalogue, not a throw", async () => {
    const dir = await tmp();
    const r = await loadBestCatalogue(path.join(dir, "a.json"), path.join(dir, "b.json"));
    expect(r.catalogue.size).toBe(0);
    expect(r.ageMs).toBeNull();
  });
});

describe("formatCost", () => {
  test("free says free", () => {
    expect(formatCost({ kind: "free" })).toBe("free");
  });

  test("unknown says ?, which is the honest reading", () => {
    expect(formatCost({ kind: "unknown" })).toBe("?");
  });

  test("a price reads input/output, with + when a longer context bills more", () => {
    expect(formatCost({ kind: "priced", input: 0.1, output: 0.5, tiered: false })).toBe("$0.10/$0.50");
    expect(formatCost({ kind: "priced", input: 0.1, output: 0.5, tiered: true })).toBe("$0.10/$0.50+");
  });

  test("a known tier shows the bump magnitude — the base price is not the price of a long run", () => {
    // Haiku 5.5: $0.10/$0.50 to 100k tokens, then $0.50/$2.50.
    const haiku = {
      kind: "priced" as const,
      input: 0.1,
      output: 0.5,
      tiered: true,
      tier: { input: 0.5, output: 2.5, overTokens: 100000 },
    };
    expect(formatCost(haiku)).toBe("$0.10/$0.50+5x");
    expect(formatCostFull(haiku)).toBe("$0.10/$0.50 to 100k tokens, then $0.50/$2.50");
    // Untiered prices are unchanged by the full form.
    expect(
      formatCostFull({ kind: "priced", input: 0.1, output: 0.5, tiered: false }),
    ).toBe("$0.10/$0.50");
  });

  test("even the longest realistic badge fits the picker's price column", () => {
    // This exact string once rendered as `$10.00/$50.00+1.` — truncated
    // mid-badge by a fixed-width column. The column sizes to content now,
    // capped at 20.
    const big = {
      kind: "priced" as const,
      input: 10,
      output: 50,
      tiered: true,
      tier: { input: 15, output: 75, overTokens: 200000 },
    };
    const badge = formatCostBasis(big, "low");
    expect(badge).toBe("$10.00/$50.00+1.5x");
    expect(badge.length).toBeLessThanOrEqual(20);
  });

  test("a context tier is parsed off the catalogue's tier list", () => {
    const c = parseCatalogue(
      JSON.stringify({
        anthropic: {
          models: {
            "claude-haiku-5-5": {
              cost: {
                input: 0.1,
                output: 0.5,
                tiers: [{ input: 0.5, output: 2.5, tier: { type: "context", size: 100000 } }],
              },
            },
          },
        },
      }),
    );
    expect(costOf(c, "anthropic/claude-haiku-5-5")).toEqual({
      kind: "priced",
      input: 0.1,
      output: 0.5,
      tiered: true,
      tier: { input: 0.5, output: 2.5, overTokens: 100000 },
    });
  });

  test("a sub-cent price keeps enough decimals to mean something", () => {
    expect(formatCost({ kind: "priced", input: 0.003, output: 0.03, tiered: false })).toBe("$0.0030/$0.03");
  });

  test("the high basis shows the price a long session pays, still marked tiered", () => {
    const haiku = {
      kind: "priced" as const,
      input: 0.1,
      output: 0.5,
      tiered: true,
      tier: { input: 0.5, output: 2.5, overTokens: 100000 },
    };
    expect(formatCostBasis(haiku, "low")).toBe("$0.10/$0.50+5x");
    expect(formatCostBasis(haiku, "high")).toBe("$0.50/$2.50+");
    // Untiered prices read the same on either basis.
    const flat = { kind: "priced" as const, input: 0.15, output: 0.6, tiered: false };
    expect(formatCostBasis(flat, "high")).toBe("$0.15/$0.60");
  });
});

describe("tool calling", () => {
  const c = parseCatalogue(FIXTURE);

  test("reads the catalogue, not the ref", () => {
    expect(toolsOf(c, "groq/compound-mini")).toBe(false);
    expect(toolsOf(c, "groq/qwen/qwen3.8-27b")).toBe(true);
    expect(toolsOf(c, "nowhere/nothing")).toBeUndefined();
  });

  test("no tools is fatal in repository mode, where the agents have tools", () => {
    expect(cannotUseTools(c, "groq/compound-mini", "plan")).toBe(true);
  });

  test("no tools is harmless answering a general question — the agents are DENY_ALL", () => {
    // Marking these dead in answer mode would grey out models that work.
    expect(cannotUseTools(c, "groq/compound-mini", "answer")).toBe(false);
  });
});

describe("canonical model id", () => {
  test("carried when present, absent when not, never a throw", () => {
    const c = parseCatalogue(
      JSON.stringify({
        "opencode-go": {
          id: "opencode-go",
          models: {
            "glm-5.3-flash": { canonical_model_id: "z-ai/glm-5.3-flash", cost: null },
            "beam-free": { cost: { input: 0, output: 0 } },
          },
        },
      }),
    );
    expect(c.get("opencode-go/glm-5.3-flash")?.canonicalModelId).toBe("z-ai/glm-5.3-flash");
    expect(c.get("opencode-go/beam-free")?.canonicalModelId).toBeUndefined();
  });
});
