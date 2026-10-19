import { describe, expect, test } from "bun:test";
import { exportModelsMd } from "./export-models.ts";
import type { Catalogue } from "./catalogue.ts";
import { emptyBenchmarks } from "./benchmarks.ts";
import type { ProbeCache } from "./probe.ts";

const catalogue: Catalogue = new Map([
  [
    "opencode-go/glm-5.3-flash",
    { cost: { kind: "priced", input: 1, output: 2, tiered: false }, toolCall: true },
  ],
  ["openrouter/free-model", { cost: { kind: "free" } }],
  ["mystery/model", { cost: { kind: "unknown" }, toolCall: false }],
]);

const base = {
  total: 3,
  view: "provider" as const,
  filter: "",
  providerLock: null as string | null,
  ceiling: 0.8,
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
      "| model | provider | price in/out | intelligence | coding | agentic | scores from | ping | notes |",
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
});
