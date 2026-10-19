import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchAAAll,
  parseAAPayload,
  verifyAAKey,
} from "./artificialanalysis.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Free-tier shape, verified October 2026. */
const AA_PAYLOAD = JSON.stringify({
  tier: "free",
  intelligence_index_version: 4.3,
  pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
  data: [
    {
      id: "033e4aa9-5564-4227-87c3-34201607c025",
      name: "Claude Sonnet 5.5 (Medium, Default Fallback)",
      slug: "claude-sonnet-5-5-medium",
      release_date: "2026-09-28",
      model_creator: { id: "f0aa413f-e8ae-4fcd-9c48-0e049f4f3128", name: "Anthropic" },
      evaluations: {
        artificial_analysis_intelligence_index: 40.8,
        artificial_analysis_coding_index: null,
        artificial_analysis_agentic_index: null,
        artificial_analysis_economics_index: 47.2,
      },
      pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 10 },
      artificial_analysis_intelligence_index_cost: {
        total_cost: 20.69,
        cost_per_task: { total_cost: 0.1678 },
      },
    },
    {
      // No index values at all: not an entry.
      name: "Unmeasured Model",
      slug: "unmeasured-model",
      evaluations: {
        artificial_analysis_intelligence_index: null,
        artificial_analysis_coding_index: null,
        artificial_analysis_agentic_index: null,
      },
    },
    // Not an object, no slug, no evaluations: not entries.
    42,
    { name: "No Slug", evaluations: { artificial_analysis_intelligence_index: 1 } },
    { slug: "no-evaluations" },
  ],
});

describe("parseAAPayload", () => {
  test("reads the three indices, keeps the name, skips the unscored", () => {
    const entries = parseAAPayload(AA_PAYLOAD);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "claude-sonnet-5-5-medium",
      scores: { intelligence: 40.8 },
      source: "aa",
      name: "Claude Sonnet 5.5 (Medium, Default Fallback)",
      taskCost: 0.1678,
    });
  });

  test("a cost without scores is not an entry — there is nothing to rank it by", () => {
    const raw = JSON.stringify({
      data: [
        {
          slug: "costly-ghost",
          evaluations: { artificial_analysis_intelligence_index: null },
          artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.5 } },
        },
      ],
    });
    expect(parseAAPayload(raw)).toEqual([]);
  });

  test("broken JSON, arrays, and scalars are no entries", () => {
    expect(parseAAPayload("{not json")).toEqual([]);
    expect(parseAAPayload("[]")).toEqual([]);
    expect(parseAAPayload("42")).toEqual([]);
  });
});

const pageResponse = (page: number, hasMore: boolean) =>
  new Response(
    JSON.stringify({
      tier: "free",
      intelligence_index_version: 4.3,
      pagination: { page, page_size: 200, total_pages: hasMore ? 2 : page, has_more: hasMore },
      data: [
        {
          slug: `model-p${page}`,
          name: `Model P${page}`,
          evaluations: { artificial_analysis_intelligence_index: page },
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "x-aa-tier": "free",
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": String(100 - page),
        "x-ratelimit-reset": "1792473163",
      },
    },
  );

describe("fetchAAAll", () => {
  test("walks every page and carries the quota", async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      pageResponse(String(url).includes("page=2") ? 2 : 1, !String(url).includes("page=2"))) as unknown as typeof fetch;
    const fetched = await fetchAAAll("aa_key");
    expect(fetched.pages).toBe(2);
    expect(fetched.entries.map((e) => e.id)).toEqual(["model-p1", "model-p2"]);
    expect(fetched.meta.tier).toBe("free");
    expect(fetched.meta.version).toBe("4.3");
    expect(fetched.meta.quota).toEqual({
      limit: 100,
      remaining: 98,
      reset: new Date(1792473163 * 1000).toISOString(),
    });
  });

  test("a 401 names the key, a 429 names the reset", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchAAAll("aa_bad")).rejects.toThrow("rejected (401)");
    globalThis.fetch = (async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "60" } })) as unknown as typeof fetch;
    await expect(fetchAAAll("aa_key")).rejects.toThrow("429");
  });
});

describe("verifyAAKey", () => {
  test("one request proves the key reads data", async () => {
    globalThis.fetch = (async () => pageResponse(1, true)) as unknown as typeof fetch;
    const v = await verifyAAKey("aa_key");
    expect(v.models).toBe(1);
    expect(v.tier).toBe("free");
    expect(v.version).toBe("4.3");
    expect(v.quota.remaining).toBe(99);
  });
});
