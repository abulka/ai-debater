import { describe, expect, test } from "bun:test";
import { familyClash, familyOf, groupModels, orderedModels } from "./models.ts";

const ref = (ref: string, family: string) => ({ ref, family });

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
});

describe("familyOf", () => {
  test("reads the model name, not the gateway", () => {
    expect(familyOf("groq/openai/gpt-oss-120b")).toBe("openai");
    expect(familyOf("opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
  });
});

describe("ordering the picker", () => {
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

  test("a model that is both a favourite and recent is listed once", () => {
    const { rows } = orderedModels(all, ["opencode-go/glm-5.3-flash"], ["opencode-go/glm-5.3-flash"]);
    expect(rows.filter((r) => r === "opencode-go/glm-5.3-flash")).toHaveLength(1);
    // And it stays in the better group.
    expect(rows[0]).toBe("opencode-go/glm-5.3-flash");
  });

  test("a favourite for a model OpenCode no longer lists is dropped from the picker", () => {
    // Offering it would offer a run that cannot happen; the pair list marks a
    // stale model `!` instead of hiding it.
    const { rows } = orderedModels(all, ["gone/model", "opencode-go/glm-5.3-flash"], []);
    expect(rows).not.toContain("gone/model");
    expect(rows[0]).toBe("opencode-go/glm-5.3-flash");
  });

  test("a filter keeps the group order and can reach anything", () => {
    const { rows } = orderedModels(all, ["opencode-go/glm-5.3-flash"], ["anthropic/claude-sonnet-5-5"], "OSS");
    expect(rows).toEqual(["groq/openai/gpt-oss-120b"]);

    const everything = orderedModels(all, [], [], "-");
    expect(everything.rows).toEqual([
      "anthropic/claude-sonnet-5-5",
      "groq/openai/gpt-oss-120b",
      "opencode-go/glm-5.3-flash",
    ]);
  });

  test("a filter that matches a favourite shows it first", () => {
    const { rows, favourite } = orderedModels(all, ["opencode-go/glm-5.3-flash"], [], "o");
    expect(rows[0]).toBe("opencode-go/glm-5.3-flash");
    expect(favourite.has("opencode-go/glm-5.3-flash")).toBe(true);
    expect(favourite.has("groq/openai/gpt-oss-120b")).toBe(false);
  });

  test("the list is capped so a one-character filter cannot draw forever", () => {
    const many = Array.from({ length: 800 }, (_, i) => `p/model-${i}`);
    expect(orderedModels(many, [], [], "model").rows).toHaveLength(500);
  });
});
