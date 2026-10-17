import { describe, expect, test } from "bun:test";
import { familyClash, familyOf } from "./models.ts";

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
