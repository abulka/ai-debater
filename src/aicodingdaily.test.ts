import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acdFormsOf,
  acdScoreOf,
  acdTaskCostOf,
  buildAcdIndex,
  emptyAcd,
  fetchAcd,
  formatAcdBadge,
  formatPromptCost,
  loadAcd,
  normalizeAcdId,
  parseACD,
  resolveAcd,
  saveAcd,
} from "./aicodingdaily.ts";
import { rankModels } from "./models.ts";
import type { Catalogue } from "./catalogue.ts";

/**
 * The shape of the real page, cut down: comment-wrapped cost cells, a `N/A`,
 * an effort-variant pair on one slug, a row with no model link.
 */
const FIXTURE = `
<table><tbody>
<tr><td>1</td>
<td><a href="https://aicodingdaily.com/model/opus-5-5">Opus 5.5 (High)</a></td>
<td>67.41</td>
<td><!--[if BLOCK]><![endif]--> $0.79 <!--[if ENDBLOCK]><![endif]--></td>
<td>03:10</td><td></td><td>Claude Code</td><td>18.5</td><td>19.33</td><td>9.58</td><td>20</td></tr>
<tr><td>6</td>
<td><a href="https://aicodingdaily.com/model/opus-5-5">Opus 5.5 (Medium)</a></td>
<td>65.50</td>
<td>$0.56</td>
<td>02:04</td><td></td><td>Claude Code</td><td>18.95</td><td>19.67</td><td>8.13</td><td>18.75</td></tr>
<tr><td>9</td>
<td><a href="https://aicodingdaily.com/model/glm-5-3">GLM-5.3 (High)</a></td>
<td>54.82</td>
<td>N/A</td>
<td>04:58</td><td></td><td>OpenCode</td><td>17.55</td><td>17.67</td><td>4.9</td><td>14.7</td></tr>
<tr><td>10</td>
<td>Header junk without a link</td>
<td>--</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table>`;

const catalogue: Catalogue = new Map([
  ["anthropic/claude-opus-5-5", { cost: { kind: "priced", input: 4, output: 20, tiered: false }, canonicalModelId: "anthropic/claude-opus-5-5", toolCall: true }],
  ["opencode-go/glm-5.3-flash", { cost: { kind: "priced", input: 1, output: 2, tiered: false }, canonicalModelId: "z-ai/glm-5-3-flash", toolCall: true }],
  ["someone/unknown-model", { cost: { kind: "priced", input: 1, output: 1, tiered: false }, toolCall: true }],
]);

describe("parseACD", () => {
  test("rows key on the /model/ slug; the best effort per slug wins", () => {
    const index = parseACD(FIXTURE);
    expect(index.byId.size).toBe(2);
    const opus = index.byId.get("opus-5-5")!;
    // Two variants, one slug: the higher-points row is the ceiling.
    expect(opus.points).toBe(67.41);
    expect(opus.effort).toBe("High");
    expect(opus.harness).toBe("Claude Code");
    expect(opus.costPerPrompt).toBe(0.79);
    // N/A is absent, never 0 — same rule as every other unmeasured cost.
    const glm = index.byId.get("glm-5-3")!;
    expect(glm.costPerPrompt).toBeUndefined();
    expect(glm.harness).toBe("OpenCode");
  });

  test("anything else-shaped is an empty index, never a throw", () => {
    expect(parseACD("").byId.size).toBe(0);
    expect(parseACD("<html>restyled</html>").byId.size).toBe(0);
    expect(parseACD("{not html").byId.size).toBe(0);
  });
});

describe("acdFormsOf", () => {
  test("the vendor word strips off, longest remainder first, and a lone number never matches", () => {
    const forms = acdFormsOf("anthropic/claude-opus-5-5");
    expect(forms[0]).toBe("anthropic/claude-opus-5-5");
    expect(forms).toContain("claude-opus-5-5");
    expect(forms).toContain("opus-5-5");
    // "5-5" and "5" are too generic to mean a model.
    expect(forms).not.toContain("5-5");
    expect(forms).not.toContain("5");
    expect(normalizeAcdId("Opus-5.5")).toBe("opus-5-5");
  });
});

describe("resolveAcd", () => {
  const index = parseACD(FIXTURE);

  test("exact slugs resolve clean; vendor-dropped slugs resolve marked", () => {
    // glm-5-3 is not this ref's slug — but the hyphen tier must not invent it.
    const opus = resolveAcd(catalogue, index, "anthropic/claude-opus-5-5")!;
    expect(opus.points).toBe(67.41);
    expect(opus.normalised).toBe(true);
    expect(opus.sourceId).toBe("opus-5-5");
    expect(opus.effort).toBe("High");
    // Unknown refs stay blank, never a sibling model's number.
    expect(resolveAcd(catalogue, index, "someone/unknown-model")).toBeNull();
    expect(resolveAcd(catalogue, emptyAcd(), "anthropic/claude-opus-5-5")).toBeNull();
  });

  test("a bare slug id matches exactly and is not marked", () => {
    const direct = buildAcdIndex([{ id: "glm-5-3", points: 54.82 }]);
    const cat: Catalogue = new Map([
      ["x/glm-5-3", { cost: { kind: "unknown" }, canonicalModelId: "glm-5-3" }],
    ]);
    expect(resolveAcd(cat, direct, "x/glm-5-3")?.normalised).toBe(false);
  });

  test("a serving tier strips to the measured model, marked", () => {
    const spark = buildAcdIndex([
      { id: "muse-spark-1-3", points: 53.01, costPerPrompt: 0.01, effort: "Max", harness: "OpenCode" },
    ]);
    // No canonical id: the served ref alone must reach the base slug.
    const cat: Catalogue = new Map([["p/muse-spark-1-3-contributor", { cost: { kind: "free" } }]]);
    const r = resolveAcd(cat, spark, "p/muse-spark-1-3-contributor")!;
    expect(r.points).toBe(53.01);
    expect(r.costPerPrompt).toBe(0.01);
    expect(r.sourceId).toBe("muse-spark-1-3");
    expect(r.normalised).toBe(true);
  });

  test("an exact id beats the stripped form", () => {
    const both = buildAcdIndex([
      { id: "foo", points: 10 },
      { id: "foo-free", points: 11 },
    ]);
    const cat: Catalogue = new Map();
    const r = resolveAcd(cat, both, "p/foo-free")!;
    // Exact on the served chain wins; the strip never runs.
    expect(r.points).toBe(11);
    expect(r.sourceId).toBe("foo-free");
  });

  test("`-pro` stays a miss — possibly a sibling model", () => {
    const base = buildAcdIndex([{ id: "foo", points: 10 }]);
    const cat: Catalogue = new Map();
    expect(resolveAcd(cat, base, "p/foo-pro")).toBeNull();
    expect(resolveAcd(cat, base, "p/foo-image")).toBeNull();
  });
});

describe("formatAcdBadge + formatPromptCost", () => {
  test("D badge rounds; prompt cost floors sub-cent noise like task cost does", () => {
    expect(formatAcdBadge(null)).toBe("");
    expect(
      formatAcdBadge({ points: 67.41, sourceId: "opus-5-5", normalised: true }),
    ).toBe("D67");
    expect(formatPromptCost(undefined)).toBe("");
    expect(formatPromptCost(0.001)).toBe("<$0.01");
    expect(formatPromptCost(0.79)).toBe("$0.79");
  });
});

describe("D-toggle adapters", () => {
  // AA disagrees with ACD on purpose: dumb-cheap is the smarter AA model,
  // smart-mid wins on AI Coding Daily. The toggle swaps the source, so the
  // order must flip with it.
  const refs = ["m/dumb-cheap", "m/smart-mid"];
  const cat: Catalogue = new Map(
    refs.map((r) => [r, { cost: { kind: "priced", input: 1, output: 2, tiered: false } }]),
  );
  const acd = buildAcdIndex([
    { id: "dumb-cheap", points: 40, costPerPrompt: 0.05 },
    { id: "smart-mid", points: 68, costPerPrompt: 0.8 },
  ]);
  const aaScore = (ref: string) => (ref === "m/dumb-cheap" ? { intelligence: 60 } : { intelligence: 30 });
  const models = (list: ReturnType<typeof rankModels>) =>
    list.rows
      .filter((r): r is { kind: "model"; ref: string } => r.kind === "model")
      .map((r) => r.ref);

  test("points-as-score re-ranks intelligence by AI Coding Daily", () => {
    const base = { filter: "", scoreOf: aaScore, outputOf: () => 0.5 };
    expect(models(rankModels(refs, "intelligence", base))).toEqual(["m/dumb-cheap", "m/smart-mid"]);
    expect(models(rankModels(refs, "intelligence", { ...base, scoreOf: acdScoreOf(cat, acd) }))).toEqual([
      "m/smart-mid",
      "m/dumb-cheap",
    ]);
  });

  test("prompt-$-as-taskCost filters the taskcost view on the ACD suite", () => {
    const base = {
      filter: "",
      scoreOf: acdScoreOf(cat, acd),
      outputOf: () => 0.5,
      taskCeiling: 1,
    };
    // Both measured, smart-mid ranks first on points.
    expect(
      models(rankModels(refs, "taskcost", { ...base, taskCostOf: acdTaskCostOf(cat, acd) })),
    ).toEqual(["m/smart-mid", "m/dumb-cheap"]);
    // The ceiling bites on prompt $, not on AA task $: $0.80 a prompt is over $0.20.
    expect(
      models(rankModels(refs, "taskcost", { ...base, taskCeiling: 0.2, taskCostOf: acdTaskCostOf(cat, acd) })),
    ).toEqual(["m/dumb-cheap"]);
  });
});

describe("ACD cache", () => {  test("round-trips through the file, and a malformed file is empty, never a throw", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acd-test-"));
    const file = path.join(dir, "aicodingdaily.json");
    const index = parseACD(FIXTURE);
    await saveAcd(index, "2026-10-20T00:00:00.000Z", file);
    const loaded = await loadAcd(file);
    expect(loaded.at).toBe("2026-10-20T00:00:00.000Z");
    expect(loaded.entries.byId.get("opus-5-5")?.points).toBe(67.41);
    expect(loaded.entries.byId.get("opus-5-5")?.harness).toBe("Claude Code");
    expect((await loadAcd(path.join(dir, "missing.json"))).entries.byId.size).toBe(0);
    const bad = path.join(dir, "bad.json");
    await Bun.write(bad, "{nope");
    expect((await loadAcd(bad)).entries.byId.size).toBe(0);
  });

  test("an empty parse never wipes the cache — the fetch throws instead", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acd-test-"));
    const file = path.join(dir, "aicodingdaily.json");
    await saveAcd(parseACD(FIXTURE), "2026-10-20T00:00:00.000Z", file);
    const failing = () =>
      fetchAcd("http://127.0.0.1:1/unreachable", file, 1000);
    await expect(failing()).rejects.toThrow();
    // The good cache survives the failed fetch.
    expect((await loadAcd(file)).entries.byId.size).toBe(2);
  });
});
