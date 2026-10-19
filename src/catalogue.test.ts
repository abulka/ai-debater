import { describe, expect, test } from "bun:test";
import { cannotUseTools, costOf, formatCost, parseCatalogue, splitRef, toolsOf } from "./catalogue.ts";

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

  test("a model whose upstream entry is null is absent, not a crash", () => {
    // groq/beam-free is literally null in the real catalogue.
    const c = parseCatalogue(FIXTURE);
    expect(c.has("groq/beam-free")).toBe(false);
    expect(costOf(c, "groq/beam-free")).toEqual({ kind: "unknown" });
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

  test("a sub-cent price keeps enough decimals to mean something", () => {
    expect(formatCost({ kind: "priced", input: 0.003, output: 0.03, tiered: false })).toBe("$0.0030/$0.03");
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
