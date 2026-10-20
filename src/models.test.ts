import { describe, expect, test } from "bun:test";
import {
  familyClash,
  familyOf,
  groupModels,
  isReferenceRow,
  matchesFilter,
  orderedModels,
  parseFilterTerms,
  providerOf,
  providerRank,
  rankModels,
  type ModelRow,
} from "./models.ts";

const ref = (ref: string, family: string) => ({ ref, family });
/** The refs out of `rows`, dropping the headers — what the reader actually sees. */
const models = (rows: ModelRow[]) =>
  rows.filter((r): r is { kind: "model"; ref: string } => r.kind === "model").map((r) => r.ref);
const labels = (rows: ModelRow[]) => rows.filter((r) => r.kind !== "model").map((r) => r);

describe("familyClash", () => {
  test("two models of one family are flagged", () => {
    expect(
      familyClash({
        drafter: ref("groq/openai/gpt-oss-120b", "gpt"),
        reviewer: ref("groq/openai/gpt-oss-20b", "gpt"),
      }),
    ).toContain("share family");
  });

  test("a gateway pair from different families passes, even under one provider", () => {
    expect(
      familyClash({
        drafter: ref("opencode-go/deepseek-v4.1-flash", "deepseek"),
        reviewer: ref("opencode-go/glm-5.3-flash", "glm"),
      }),
    ).toBeNull();
  });

  test("the explicit family decides, not the provider in the ref", () => {
    expect(
      familyClash({
        drafter: ref("gateway/model-a", "anthropic"),
        reviewer: ref("gateway/model-b", "openai"),
      }),
    ).toBeNull();
  });

  test("casing and padding do not defeat the check", () => {
    expect(
      familyClash({ drafter: ref("a/b", "GPT "), reviewer: ref("c/d", "gpt") }),
    ).toContain("share family");
  });

  test("a label that is a prefix of another is still the same family", () => {
    // The miss this exists for. `familyOf` says `deepseek`; the catalogue says
    // `deepseek-flash`. Under `familyCheck: "require"` a trial started on this
    // pair would measure "an extra pass" while claiming cross-family review.
    expect(
      familyClash({ drafter: ref("a/deepseek-v4.1", "deepseek"), reviewer: ref("b/deepseek-flash", "deepseek-flash") }),
    ).toContain("share family");
  });

  test("the prefix has to be a real one, not a shared first letter", () => {
    expect(familyClash({ drafter: ref("a/gpt-5", "gpt"), reviewer: ref("b/glm-5", "glm") })).toBeNull();
    expect(familyClash({ drafter: ref("a/qwen3", "qwen"), reviewer: ref("b/qwen3.8", "qwen3.8") })).toContain(
      "share family",
    );
  });

  test("an unset family is not a clash", () => {
    expect(familyClash({ drafter: ref("a/b", ""), reviewer: ref("c/d", "gpt") })).toBeNull();
  });
});

describe("familyOf", () => {
  test("reads the model name, not the gateway", () => {
    expect(familyOf("groq/openai/gpt-oss-120b")).toBe("openai");
    expect(familyOf("opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
  });
});

describe("providerOf", () => {
  test("is the first segment, even when the model id carries its own namespace", () => {
    expect(providerOf("opencode-go/space-bunny-free")).toBe("opencode-go");
    expect(providerOf("groq/groq/compound-mini")).toBe("groq");
    expect(providerOf("local/lmstudio/qwen3.8-27b-mlx")).toBe("local");
  });
});

describe("isReferenceRow", () => {
  test("pins DeepSeek V4.1 Flash in all its servings, and nothing else", () => {
    for (const ref of [
      "opencode-go/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-1-flash",
      "opencode/deepseek-v4.1-flash-free",
      "opencode-go/deepseek-v4-1-flash-1017",
    ]) {
      expect(isReferenceRow(ref)).toBe(true);
    }
    for (const ref of [
      "opencode-go/deepseek-v4-pro",
      "opencode-go/qwen3.8-flash",
      "opencode-go/glm-5.3-flash",
      "deepseek/deepseek-v3",
    ]) {
      expect(isReferenceRow(ref)).toBe(false);
    }
  });
});

describe("groupModels", () => {
  const all = [
    "groq/openai/gpt-oss-120b",
    "anthropic/claude-sonnet-5-5",
    "opencode-go/glm-5.3-flash",
  ];

  test("favourites first, then recents, then the rest alphabetically", () => {
    const grouped = groupModels(all, ["opencode-go/glm-5.3-flash"], ["anthropic/claude-sonnet-5-5"]);
    expect(grouped.favourites).toEqual(["opencode-go/glm-5.3-flash"]);
    expect(grouped.recents).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(grouped.rest).toEqual(["groq/openai/gpt-oss-120b"]);
    expect([...grouped.favourites, ...grouped.recents, ...grouped.rest]).toEqual([
      "opencode-go/glm-5.3-flash",
      "anthropic/claude-sonnet-5-5",
      "groq/openai/gpt-oss-120b",
    ]);
  });

  test("an unavailable favourite is dropped from the picker AND reported", () => {
    // Offering it would offer a run that cannot happen; the pair list marks a
    // stale model `!` instead of hiding it. The report is the part that was
    // missing: four of twenty favourites once vanished with nothing to say why.
    const grouped = groupModels(all, ["gone/model", "opencode-go/glm-5.3-flash"], []);
    expect(grouped.favourites).toEqual(["opencode-go/glm-5.3-flash"]);
    expect(grouped.dropped).toEqual(["gone/model"]);
  });
});

describe("orderedModels", () => {
  const all = [
    "groq/openai/gpt-oss-120b",
    "anthropic/claude-sonnet-5-5",
    "opencode-go/glm-5.3-flash",
  ];

  test("a model that is both a favourite and recent is listed once, in the better group", () => {
    const { rows } = orderedModels(all, ["opencode-go/glm-5.3-flash"], ["opencode-go/glm-5.3-flash"]);
    expect(models(rows).filter((m) => m === "opencode-go/glm-5.3-flash")).toHaveLength(1);
    expect(models(rows)[0]).toBe("opencode-go/glm-5.3-flash");
  });

  test("a filter keeps the group order and can reach anything", () => {
    expect(models(orderedModels(all, ["opencode-go/glm-5.3-flash"], ["anthropic/claude-sonnet-5-5"], "OSS").rows)).toEqual([
      "groq/openai/gpt-oss-120b",
    ]);
    expect(models(orderedModels(all, [], [], "-").rows)).toEqual([
      "anthropic/claude-sonnet-5-5",
      "groq/openai/gpt-oss-120b",
      "opencode-go/glm-5.3-flash",
    ]);
  });

  test("a filter that matches a favourite shows it first", () => {
    const { rows, favourite } = orderedModels(all, ["opencode-go/glm-5.3-flash"], [], "o");
    expect(models(rows)[0]).toBe("opencode-go/glm-5.3-flash");
    expect(favourite.has("opencode-go/glm-5.3-flash")).toBe(true);
    expect(favourite.has("groq/openai/gpt-oss-120b")).toBe(false);
  });

  test("a filter flattens everything: no headers to compete with a short result", () => {
    const { rows } = orderedModels(all, ["opencode-go/glm-5.3-flash"], ["anthropic/claude-sonnet-5-5"], "o");
    expect(rows.every((r) => r.kind === "model")).toBe(true);
  });

  test("unfiltered, the favourites header states how many were dropped and why", () => {
    const { rows, dropped } = orderedModels(all, ["gone/model", "opencode-go/glm-5.3-flash"], []);
    expect(dropped).toEqual(["gone/model"]);
    const header = rows[0];
    expect(header).toMatchObject({ kind: "group", note: "1 not available — ? to see which" });
    expect((header as { label: string }).label).toBe(
      "★ favourites OpenCode marks (1 of 2 reachable)",
    );
  });

  test("a clean favourites group says so without a note", () => {
    const { rows } = orderedModels(all, ["opencode-go/glm-5.3-flash"], []);
    expect(rows[0]).toMatchObject({ kind: "group", label: "★ favourites OpenCode marks (1 of 1 reachable)" });
    expect("note" in (rows[0] as object)).toBe(false);
  });

  test("the rest is split by provider, subscribed providers first", () => {
    const { rows } = orderedModels(
      ["openrouter/z-ai/glm-5.3-flash", "opencode-go/glm-5.3-flash", "opencode/muse-spark-1.3"],
      [],
      [],
    );
    expect(rows.map((r) => (r.kind === "provider" ? r.provider : r.kind))).toEqual([
      "opencode-go",
      "model",
      "openrouter",
      "model",
      "opencode",
      "model",
    ]);
    // and each header carries its count
    const providers = rows.filter((r) => r.kind === "provider");
    expect(providers.map((p) => (p as { count: number }).count)).toEqual([1, 1, 1]);
  });

  test("headers are not selectable, so the cursor's arithmetic stays over models", () => {
    const { rows, items } = orderedModels(all, ["opencode-go/glm-5.3-flash"], ["anthropic/claude-sonnet-5-5"]);
    expect(items).toHaveLength(3);
    // Every item points at a real model row, so no header is reachable.
    for (const item of items) expect(rows[item.row]).toMatchObject({ kind: "model", ref: item.ref });
    expect(items.map((i) => i.row)).toEqual([1, 3, 5]);
  });

  test("there is no row cap — 651 models draw, and the count is the real count", () => {
    // The cap was two bugs: the footer reported the truncated number, and the
    // keyboard handler used an untruncated list, so the cursor could walk off the
    // end of what was drawn into a blank screen.
    const many = Array.from({ length: 800 }, (_, i) => `p/model-${String(i).padStart(3, "0")}`);
    const { rows, items } = orderedModels(many, [], [], "model");
    expect(items).toHaveLength(800);
    expect(items.at(-1)?.ref).toBe("p/model-799");
  });

  test("hideUnscored drops unscored rows and empties their groups", () => {
    const scoreOf = (ref: string) => (ref.includes("scored") ? { intelligence: 50 } : null);
    const { rows, items } = orderedModels(
      ["opencode-go/scored-a", "opencode-go/plain-b", "openrouter/scored-c"],
      [],
      [],
      "",
      { hideUnscored: true, scoreOf },
    );
    expect(items.map((i) => i.ref)).toEqual(["opencode-go/scored-a", "openrouter/scored-c"]);
    expect(rows.every((r) => r.kind !== "group")).toBe(true);
    // Without the toggle nothing is dropped.
    const kept = orderedModels(
      ["opencode-go/scored-a", "opencode-go/plain-b"],
      [],
      [],
      "",
      { hideUnscored: false, scoreOf },
    );
    expect(kept.items).toHaveLength(2);
  });

  test("providerLock narrows the pool before grouping, and composes with the filter", () => {
    const pool = ["opencode-go/a", "opencode-go/b", "openrouter/c"];
    const locked = orderedModels(pool, ["opencode-go/a"], [], "", { providerLock: "opencode-go" });
    // Favourites still group first, but only from the locked provider.
    expect(models(locked.rows)).toEqual(["opencode-go/a", "opencode-go/b"]);
    // The filter applies inside the lock, not instead of it.
    const filtered = orderedModels(pool, [], [], "b", { providerLock: "opencode-go" });
    expect(models(filtered.rows)).toEqual(["opencode-go/b"]);
    // An unknown provider is an empty list, not an error.
    expect(orderedModels(pool, [], [], "", { providerLock: "nope" }).items).toHaveLength(0);
  });

  test("disabled providers hide everywhere and compose with the lock", () => {
    const pool = ["opencode-go/a", "opencode-go/b", "openrouter/c"];
    const off = new Set(["openrouter"]);
    expect(models(orderedModels(pool, [], [], "", { disabled: off }).rows)).toEqual([
      "opencode-go/a",
      "opencode-go/b",
    ]);
    // With the filter: the hidden provider contributes nothing.
    expect(models(orderedModels(pool, [], [], "openrouter", { disabled: off }).rows)).toEqual([]);
    // With the lock: both filters apply, so a lock on a disabled provider is empty.
    expect(
      models(orderedModels(pool, [], [], "", { providerLock: "openrouter", disabled: off }).rows),
    ).toEqual([]);
    expect(
      models(orderedModels(pool, [], [], "", { providerLock: "opencode-go", disabled: off }).rows),
    ).toEqual(["opencode-go/a", "opencode-go/b"]);
  });

  test("a favourite on a disabled provider vanishes silently, never as dropped", () => {
    // Still listed and reachable — just hidden by choice — so the header must
    // not claim it is unavailable, and the `?` pane must not report it.
    const pool = ["opencode-go/a", "openrouter/c"];
    const { rows, dropped, items } = orderedModels(pool, ["openrouter/c", "opencode-go/a"], [], "", {
      disabled: new Set(["openrouter"]),
    });
    expect(dropped).toEqual([]);
    expect(models(rows)).toEqual(["opencode-go/a"]);
    expect(items).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "group", label: "★ favourites OpenCode marks (1 of 1 reachable)" });
    expect("note" in (rows[0] as object)).toBe(false);
  });

  test("the filter matches ref tokens and benchmark names together", () => {
    const refs = [
      "opencode-go/muse-spark-1-3-contributor",
      "openrouter/meta/muse-spark-1-2-contributor",
      "opencode-go/glm-5.3-flash",
    ];
    const nameOf = (ref: string) =>
      ref.includes("muse-spark-1-3")
        ? "Muse Spark 1.3 (Max)"
        : ref.includes("muse-spark-1-2")
          ? "Muse Spark 1.2 (Xhigh)"
          : null;
    // By ref fragments, separators aside.
    expect(models(orderedModels(refs, [], [], "muse 1.3", { nameOf }).rows)).toEqual([
      "opencode-go/muse-spark-1-3-contributor",
    ]);
    // By the benchmark's own wording — Max is an AA name, not a ref part.
    expect(models(orderedModels(refs, [], [], "muse max", { nameOf }).rows)).toEqual([
      "opencode-go/muse-spark-1-3-contributor",
    ]);
    // All tokens must match: 1.2 is not 1.3.
    expect(models(orderedModels(refs, [], [], "muse 1.3 1.2", { nameOf }).rows)).toEqual([]);
    // Without names the same rule holds on refs alone.
    expect(models(orderedModels(refs, [], [], "muse 1.3").rows)).toEqual([
      "opencode-go/muse-spark-1-3-contributor",
    ]);
  });

  test("filterMode or is the union across refs and names", () => {
    const refs = [
      "opencode-go/muse-spark-1-3-contributor",
      "opencode-go/mimo-v2-flash",
      "opencode-go/glm-5.3-flash",
    ];
    const nameOf = (ref: string) => (ref.includes("muse-spark") ? "Muse Spark 1.3 (Max)" : null);
    expect(models(orderedModels(refs, [], [], "muse mimo", { nameOf, filterMode: "or" }).rows)).toEqual([
      "opencode-go/mimo-v2-flash",
      "opencode-go/muse-spark-1-3-contributor",
    ]);
    // AND is still the default: the same query is empty without the flag.
    expect(models(orderedModels(refs, [], [], "muse mimo", { nameOf }).rows)).toEqual([]);
  });

  test("filterMode off ignores the text: groups and headers, not the flat list", () => {
    const refs = ["opencode-go/muse-spark-1-3-contributor", "opencode-go/mimo-v2-flash"];
    const list = orderedModels(refs, [], [], "zzz-no-match", { filterMode: "off" });
    // The text would match nothing; OFF shows everything, grouped by provider.
    expect(list.items).toHaveLength(2);
    expect(list.rows[0]).toMatchObject({ kind: "provider" });
    // Same shape as the empty filter — OFF is an empty filter with kept text.
    const plain = orderedModels(refs, [], [], "");
    expect(list.rows).toEqual(plain.rows);
  });
});

describe("matchesFilter", () => {
  test("empty and blank filters match everything", () => {
    expect(matchesFilter("opencode-go/glm-5.3", null, "")).toBe(true);
    expect(matchesFilter("opencode-go/glm-5.3", null, "   ")).toBe(true);
  });

  test("a single token is the old substring rule", () => {
    expect(matchesFilter("opencode-go/glm-5.3", null, "glm")).toBe(true);
    expect(matchesFilter("opencode-go/glm-5.3", null, "zzz")).toBe(false);
  });

  test("every token must match, in any order", () => {
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "muse spark")).toBe(true);
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "spark muse")).toBe(true);
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "muse wonder")).toBe(false);
  });

  test("separators are ignored on both sides", () => {
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "muse 1.3")).toBe(true);
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "spark 13")).toBe(true);
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "spark-1.3")).toBe(true);
  });

  test("tokens also match the benchmark display name", () => {
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", "max")).toBe(true);
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", "muse max")).toBe(true);
    expect(matchesFilter("x/y", null, "max")).toBe(false);
    // The name never excuses a ref token that matches nothing.
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", "muse zzz")).toBe(false);
  });

  test("an all-separator token matches nothing, never everything", () => {
    expect(matchesFilter("abc", null, "-")).toBe(false);
    expect(matchesFilter("abc", "Some Name", "-")).toBe(false);
  });

  test("OR needs any token: the union, not the intersection", () => {
    expect(matchesFilter("opencode-go/muse-spark-1-3", null, "muse mimo", "or")).toBe(true);
    expect(matchesFilter("x/mimo-v2", null, "muse mimo", "or")).toBe(true);
    expect(matchesFilter("x/other", null, "muse mimo", "or")).toBe(false);
  });

  test("OR matches names the same way AND does", () => {
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", "zzz max", "or")).toBe(true);
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", "zzz www", "or")).toBe(false);
  });

  test("OR with an empty filter still matches everything; a bare separator still matches nothing", () => {
    expect(matchesFilter("abc", null, "", "or")).toBe(true);
    expect(matchesFilter("abc", null, "   ", "or")).toBe(true);
    expect(matchesFilter("abc", null, "-", "or")).toBe(false);
    expect(matchesFilter("x/glm-1", null, "glm -", "or")).toBe(true);
    // The separator is dead weight, not a vote: with no live token it is a miss.
    expect(matchesFilter("abc", null, "- -", "or")).toBe(false);
  });
});

describe("parseFilterTerms", () => {
  const words = (filter: string) => parseFilterTerms(filter);
  test("bare words are single-word terms", () => {
    expect(words("muse mimo")).toEqual([
      { words: ["muse"], phrase: false },
      { words: ["mimo"], phrase: false },
    ]);
  });
  test("a quote pair is one phrase term", () => {
    expect(words('"deep 4.1" mimo')).toEqual([
      { words: ["deep", "4.1"], phrase: true },
      { words: ["mimo"], phrase: false },
    ]);
  });
  test("an unterminated quote takes the rest; empties and strays vanish", () => {
    expect(words('muse "deep 4')).toEqual([
      { words: ["muse"], phrase: false },
      { words: ["deep", "4"], phrase: true },
    ]);
    expect(words('""')).toEqual([]);
    expect(words('"')).toEqual([]);
    expect(words("")).toEqual([]);
  });
});

describe("matchesFilter phrases", () => {
  test("a phrase needs its words in order, gaps allowed, separators relaxed", () => {
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"deep 4.1"')).toBe(true);
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"deep flash"')).toBe(true);
    // Wrong order is a miss: 4.1 never comes before deep.
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"4.1 deep"')).toBe(false);
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"deep wonder"')).toBe(false);
  });
  test("a phrase matches by AA name too, but never across ref and name", () => {
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", '"spark max"')).toBe(true);
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", '"spark 1.3"')).toBe(true);
    // "y spark": y is only in the ref, spark only in the name — split, so a miss.
    expect(matchesFilter("x/y", "Muse Spark 1.3 (Max)", '"y spark"')).toBe(false);
  });
  test("a phrase is one term in OR: no bare-word explosion", () => {
    // Bare `deep` alone would match the ref; `"q deep"` must not.
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"q deep" mimo', "or")).toBe(false);
    expect(matchesFilter("opencode-go/deepseek-v4.1-flash", null, '"deep 4.1" mimo', "or")).toBe(true);
    expect(matchesFilter("x/mimo-v2", null, '"deep 4.1" mimo', "or")).toBe(true);
  });
  test("an all-separator phrase matches nothing", () => {
    expect(matchesFilter("abc", null, '"- ."')).toBe(false);
    expect(matchesFilter("abc", null, '"- ."', "or")).toBe(false);
  });
});

describe("providerRank", () => {
  test("opencode-go, openrouter, deepseek, then the long tail", () => {
    expect(providerRank("opencode-go")).toBe(0);
    expect(providerRank("openrouter")).toBe(1);
    expect(providerRank("deepseek")).toBe(2);
    expect(providerRank("anthropic")).toBeGreaterThan(providerRank("deepseek"));
    expect(providerRank("groq")).toBe(providerRank("anthropic"));
  });
});

describe("rankModels", () => {
  const refs = ["p/cheap-good", "p/cheap-best", "p/cheap-plain", "p/pricey-good", "p/unknown-cost"];
  const scoreOf = (ref: string) => {
    if (ref.endsWith("good")) return { intelligence: 50 };
    if (ref.endsWith("best")) return { intelligence: 70 };
    return null;
  };
  const outputOf = (ref: string) => {
    if (ref.startsWith("p/cheap")) return 0.5;
    if (ref.startsWith("p/pricey")) return 5;
    return undefined;
  };
  const opts = { scoreOf, outputOf, favourites: [] as string[] };
  const models = (list: { items: { ref: string }[] }) => list.items.map((i) => i.ref);

  test("intelligence view: highest first, unscored after, never above a measured one", () => {
    expect(models(rankModels(refs, "intelligence", opts))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
      "p/pricey-good",
      "p/cheap-plain",
      "p/unknown-cost",
    ]);
  });

  test("value view: at or under the ceiling, scored first, unknown cost excluded", () => {
    expect(models(rankModels(refs, "value", { ...opts, ceiling: 0.8 }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
      "p/cheap-plain",
    ]);
    // A higher ceiling admits the pricey model, ranked by its score.
    expect(models(rankModels(refs, "value", { ...opts, ceiling: 5 }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
      "p/pricey-good",
      "p/cheap-plain",
    ]);
  });

  test("hideUnscored drops the tail in both flat views", () => {
    expect(models(rankModels(refs, "intelligence", { ...opts, hideUnscored: true }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
      "p/pricey-good",
    ]);
    expect(models(rankModels(refs, "value", { ...opts, hideUnscored: true, ceiling: 0.8 }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
    ]);
  });

  test("the text filter means the same as in the provider view", () => {
    expect(models(rankModels(refs, "intelligence", { ...opts, filter: "cheap" }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
      "p/cheap-plain",
    ]);
  });

  test("the filter takes ref tokens and benchmark names", () => {
    const named = { ...opts, nameOf: (ref: string) => (ref.endsWith("best") ? "Best Effort (Max)" : null) };
    // By name alone, in a flat view.
    expect(models(rankModels(refs, "intelligence", { ...named, filter: "max" }))).toEqual([
      "p/cheap-best",
    ]);
    // Mixed: one token from the ref, one from the name.
    expect(models(rankModels(refs, "intelligence", { ...named, filter: "cheap max" }))).toEqual([
      "p/cheap-best",
    ]);
    // Without names the same query is empty — Max lives in no ref.
    expect(models(rankModels(refs, "intelligence", { ...opts, filter: "max" }))).toEqual([]);
  });

  test("filterMode or is the union in a flat view too", () => {
    expect(
      models(rankModels(refs, "intelligence", { ...opts, filter: "best pricey", filterMode: "or" })),
    ).toEqual(["p/cheap-best", "p/pricey-good"]);
    // AND still the default: no ref carries both words.
    expect(models(rankModels(refs, "intelligence", { ...opts, filter: "best pricey" }))).toEqual([]);
  });

  test("ties break alphabetically, so the order is stable between refreshes", () => {
    expect(
      models(rankModels(["p/b-good", "p/a-good"], "intelligence", opts)),
    ).toEqual(["p/a-good", "p/b-good"]);
  });

  test("providerLock composes with the ceiling and the filter in the flat views", () => {
    const locked = ["q/cheap-best", "q/cheap-good", "q/pricey-good", "p/cheap-good"];
    const qOutput = (ref: string) => {
      if (ref.includes("cheap")) return 0.5;
      if (ref.includes("pricey")) return 5;
      return undefined;
    };
    const qOpts = { ...opts, outputOf: qOutput };
    expect(models(rankModels(locked, "intelligence", { ...qOpts, providerLock: "q" }))).toEqual([
      "q/cheap-best",
      "q/cheap-good",
      "q/pricey-good",
    ]);
    // The ceiling still applies inside the lock: pricey is over 0.8.
    expect(models(rankModels(locked, "value", { ...qOpts, providerLock: "q", ceiling: 0.8 }))).toEqual([
      "q/cheap-best",
      "q/cheap-good",
    ]);
    // So does the filter — and an unknown provider is an empty list.
    expect(models(rankModels(locked, "intelligence", { ...qOpts, providerLock: "q", filter: "pricey" }))).toEqual([
      "q/pricey-good",
    ]);
    expect(models(rankModels(locked, "intelligence", { ...qOpts, providerLock: "nope" }))).toEqual([]);
  });

  test("rankBy cost: cheapest measured task first, unmeasured trailing", () => {
    const trefs = ["p/dumb-cheap", "p/smart-mid", "p/unscored-cheap", "p/smart-unmeasured"];
    const tScore = (ref: string) => {
      if (ref.endsWith("smart-mid")) return { intelligence: 90 };
      if (ref.endsWith("dumb-cheap")) return { intelligence: 40 };
      return null;
    };
    const tTask = (ref: string) => {
      if (ref.endsWith("smart-mid")) return 0.8;
      if (ref.endsWith("dumb-cheap")) return 0.05;
      if (ref.endsWith("unscored-cheap")) return 0.05;
      return undefined;
    };
    const tOpts = { ...opts, scoreOf: tScore, taskCostOf: tTask, taskCeiling: 1, rankBy: "cost" as const };
    // Cost ranks now: the two $0.05 rows alphabetically, then $0.80 — smarts
    // buys nothing. The unmeasured row trails, score or no score.
    expect(models(rankModels(trefs, "taskcost", tOpts))).toEqual([
      "p/dumb-cheap",
      "p/unscored-cheap",
      "p/smart-mid",
    ]);
    // The score default is untouched: same inputs, intelligence first.
    expect(models(rankModels(trefs, "taskcost", { ...tOpts, rankBy: "score" as const }))).toEqual([
      "p/smart-mid",
      "p/dumb-cheap",
      "p/unscored-cheap",
    ]);
    // Cost order composes with the ceiling, the lock and H — and H still
    // means "has a score", so the unscored-cheap row goes however cheap.
    expect(models(rankModels(trefs, "taskcost", { ...tOpts, taskCeiling: 0.2 }))).toEqual([
      "p/dumb-cheap",
      "p/unscored-cheap",
    ]);
    expect(
      models(rankModels(trefs, "taskcost", { ...tOpts, hideUnscored: true })),
    ).toEqual(["p/dumb-cheap", "p/smart-mid"]);
  });

  test("taskcost view filters on task, ranks on intelligence like value does", () => {
    const trefs = ["p/dumb-cheap", "p/smart-mid", "p/unscored-cheap", "p/smart-unmeasured"];
    const tScore = (ref: string) => {
      if (ref.endsWith("smart-mid")) return { intelligence: 90 };
      if (ref.endsWith("dumb-cheap")) return { intelligence: 40 };
      return null;
    };
    const tTask = (ref: string) => {
      if (ref.endsWith("smart-mid")) return 0.8;
      if (ref.endsWith("dumb-cheap")) return 0.05;
      if (ref.endsWith("unscored-cheap")) return 0.05;
      return undefined;
    };
    const tOpts = { ...opts, scoreOf: tScore, taskCostOf: tTask };
    // Cheapest task does not come first: intelligence ranks, the ceiling filters.
    expect(models(rankModels(trefs, "taskcost", { ...tOpts, taskCeiling: 1 }))).toEqual([
      "p/smart-mid",
      "p/dumb-cheap",
      "p/unscored-cheap",
    ]);
    // The ceiling bites the smart one: $0.80 a task is over $0.20.
    expect(models(rankModels(trefs, "taskcost", { ...tOpts, taskCeiling: 0.2 }))).toEqual([
      "p/dumb-cheap",
      "p/unscored-cheap",
    ]);
    // Unmeasured is never cheap, however smart — and without a task-cost
    // source the view is empty, not alphabetical. (The `?` pane says why.)
    expect(models(rankModels(trefs, "taskcost", opts))).toEqual([]);
    // The lock composes, and H drops the unscored tail.
    expect(
      models(rankModels(["q/smart-mid", "q/dumb-cheap", "p/dumb-cheap"], "taskcost", {
        ...tOpts,
        taskCeiling: 1,
        providerLock: "q",
      })),
    ).toEqual(["q/smart-mid", "q/dumb-cheap"]);
    expect(
      models(rankModels(trefs, "taskcost", { ...tOpts, taskCeiling: 1, hideUnscored: true })),
    ).toEqual(["p/smart-mid", "p/dumb-cheap"]);
  });

  test("disabled providers hide from the flat views too", () => {
    const refs = ["p/cheap-best", "p/cheap-good", "q/cheap-good"];
    const off = new Set(["q"]);
    expect(models(rankModels(refs, "intelligence", { ...opts, disabled: off }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
    ]);
    // Composes with the ceiling and the filter, like the lock.
    expect(models(rankModels(refs, "value", { ...opts, disabled: off, ceiling: 0.8 }))).toEqual([
      "p/cheap-best",
      "p/cheap-good",
    ]);
    expect(
      models(rankModels(refs, "intelligence", { ...opts, disabled: off, filter: "cheap-good" })),
    ).toEqual(["p/cheap-good"]);
    // Everything off is an empty list, not an error.
    expect(
      models(rankModels(refs, "intelligence", { ...opts, disabled: new Set(["p", "q"]) })),
    ).toEqual([]);
  });
});
