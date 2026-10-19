import { describe, expect, test } from "bun:test";
import {
  familyClash,
  familyOf,
  groupModels,
  orderedModels,
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

  test("ties break alphabetically, so the order is stable between refreshes", () => {
    expect(
      models(rankModels(["p/b-good", "p/a-good"], "intelligence", opts)),
    ).toEqual(["p/a-good", "p/b-good"]);
  });
});
