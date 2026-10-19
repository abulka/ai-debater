import { describe, expect, test } from "bun:test";
import { exportModelsMd } from "./export-models.ts";
import type { Catalogue } from "./catalogue.ts";
import { buildIndex, emptyBenchmarks } from "./benchmarks.ts";
import { buildAcdIndex } from "./aicodingdaily.ts";
import type { ProbeCache } from "./probe.ts";

const catalogue: Catalogue = new Map([
  [
    "opencode-go/glm-5.3-flash",
    { cost: { kind: "priced", input: 1, output: 2, tiered: false }, toolCall: true },
  ],
  ["openrouter/free-model", { cost: { kind: "free" } }],
  ["mystery/model", { cost: { kind: "unknown" }, toolCall: false }],
  [
    "tiered/model",
    {
      cost: {
        kind: "priced",
        input: 0.1,
        output: 0.5,
        tiered: true,
        tier: { input: 0.5, output: 2.5, overTokens: 100000 },
      },
    },
  ],
]);

const base = {
  total: 3,
  view: "provider" as const,
  filter: "",
  providerLock: null as string | null,
  ceiling: 0.8,
  taskCeiling: 0.5,
  hideUnscored: false,
  subject: "plan" as const,
  catalogue,
  benchmarks: emptyBenchmarks(),
  probes: {} as ProbeCache,
  favourites: new Set<string>(),
  scoresAt: null as string | null,
  indexVersion: null as string | null,
  exportedAt: "2026-10-20T00:00:00.000Z",
};

describe("exportModelsMd", () => {
  test("a table with headers, one row per visible model, in screen order", () => {
    const md = exportModelsMd({ ...base, refs: ["openrouter/free-model", "opencode-go/glm-5.3-flash"] });
    const lines = md.split("\n");
    expect(lines).toContain(
      "| model | provider | price in/out | task $/task | intelligence | coding | agentic | D points | ACD $/task | scores from | ping | notes |",
    );
    const rows = lines.filter((l) => l.startsWith("| openrouter/") || l.startsWith("| opencode-go/"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("| openrouter/free-model | openrouter | free |");
    expect(rows[1]).toContain("| opencode-go/glm-5.3-flash | opencode-go |");
    // Untested models say so, and the legend explains every column.
    expect(rows[0]).toContain("| not tested |");
    expect(md).toContain("## legend");
  });

  test("context names the view, the lock and the score provenance", () => {
    const md = exportModelsMd({
      ...base,
      refs: ["mystery/model"],
      view: "value",
      filter: "my",
      providerLock: "mystery",
      hideUnscored: true,
      scoresAt: "2026-10-19",
      indexVersion: "4.3",
    });
    for (const line of [
      "- 1 of 3 models shown",
      "- view: value",
      '- filter: "my"',
      "- locked to provider: mystery",
      "- value ceiling: $0.80/M output",
      "- hiding unscored",
      "- benchmark scores fetched 2026-10-19 (AA Intelligence Index v4.3)",
    ]) {
      expect(md).toContain(line);
    }
    // No tool calls is a plan-mode verdict, and ? is unknown, never free.
    expect(md).toContain("no tool calls");
    expect(md).toContain("unknown, never free");
  });

  test("AI Coding Daily rides its own columns, with the harness in the notes", () => {
    const md = exportModelsMd({
      ...base,
      refs: ["anthropic/claude-opus-5-5", "opencode-go/glm-5.3-flash"],
      acd: buildAcdIndex([
        { id: "opus-5-5", points: 67.41, costPerPrompt: 0.79, effort: "High", harness: "Claude Code" },
      ]),
      acdAt: "2026-10-20",
    });
    const opus = md.split("\n").find((l) => l.startsWith("| anthropic/claude-opus-5-5"))!;
    // Two different scales, two different columns: D points beside I/C/A,
    // prompt-$ beside task-$.
    expect(opus).toContain("| 67 |");
    expect(opus).toContain("| $0.79 |");
    // The ceiling row's method travels with it, marked when normalised.
    expect(opus).toContain("ACD High via Claude Code ≈");
    // Unmeasured rows stay blank, never 0.
    const glm = md.split("\n").find((l) => l.startsWith("| opencode-go/glm-5.3-flash"))!;
    expect(glm).not.toContain("ACD");
    expect(md).toContain("- AI Coding Daily scores fetched 2026-10-20");
    expect(md).toContain("a different scale from intelligence/coding/agentic");
    expect(md).toContain("measured on different tasks. The taskcost view filters on one or the other");
  });

  test("favourites and ping verdicts travel with their rows", () => {
    const md = exportModelsMd({
      ...base,
      refs: ["opencode-go/glm-5.3-flash"],
      favourites: new Set(["opencode-go/glm-5.3-flash"]),
      probes: {
        "opencode-go/glm-5.3-flash": {
          at: "2026-10-20T00:00:00.000Z",
          verdict: { kind: "ok", detail: "", ms: 4200 },
        },
      },
    });
    expect(md).toContain("★ favourite");
    expect(md).toContain("✓");
  });

  test("task cost and tiered prices travel with their rows", () => {
    const md = exportModelsMd({
      ...base,
      refs: ["tiered/model", "opencode-go/glm-5.3-flash"],
      benchmarks: buildIndex([
        { id: "tiered/model", scores: { intelligence: 43 }, source: "aa", taskCost: 0.1678 },
        { id: "opencode-go/glm-5.3-flash", scores: { intelligence: 42 }, source: "aa" },
      ]),
    });
    // Both prices and the threshold, not the row's magnitude shorthand.
    expect(md).toContain("$0.10/$0.50 to 100k tokens, then $0.50/$2.50");
    // Measured task cost on the AA row, blank on the one without.
    const tiered = md.split("\n").find((l) => l.startsWith("| tiered/model"))!;
    expect(tiered).toContain("| $0.17 |");
    expect(md).toContain("measured dollars per Artificial Analysis Intelligence Index task");
  });
});
