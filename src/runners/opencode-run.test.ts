import { describe, expect, test } from "bun:test";
import { Review } from "../contracts.ts";
import { formatUsage, normalizeReviewJson, summarizeUsage, type RunEvent } from "./opencode-run.ts";

const step = (part: NonNullable<RunEvent["part"]>): RunEvent => ({
  type: "step-finish",
  part: { type: "step-finish", ...part },
});

describe("normalizeReviewJson", () => {
  test("drops a judgment call that was put in the verdict list", () => {
    // The 17 Oct answer-mode run died on exactly this: {"id":"J1","verdict":"judgment"}.
    // The judgment is still handled by tradeoffs; it is not a verdict.
    const raw = {
      verdicts: [
        { id: "V1", verdict: "confirmed", evidence: "src/x.ts:1" },
        { id: "J1", verdict: "judgment" },
        { id: "V3", verdict: "unverifiable", note: "needs a source" },
      ],
      tradeoffs: [{ id: "J1", per_option: [{ option: "a", against: [] }] }],
      extra_findings: [],
    };
    const shaped = normalizeReviewJson(raw) as { verdicts: unknown[] };
    expect(shaped.verdicts).toHaveLength(2);
    const review = Review.parse(shaped);
    expect(review.verdicts.map((v) => v.id)).toEqual(["V1", "V3"]);
    expect(review.tradeoffs).toHaveLength(1);
  });

  test("a mistyped verdict value is dropped, not the whole review", () => {
    const shaped = normalizeReviewJson({
      verdicts: [
        { id: "V1", verdict: "confirmd", evidence: "src/x.ts:1" },
        { id: "V2", verdict: "refuted", evidence: "src/x.ts:2" },
      ],
    }) as { verdicts: unknown[] };
    expect(shaped.verdicts).toHaveLength(1);
  });

  test("a valid review is left exactly as it was", () => {
    const raw = {
      verdicts: [{ id: "V1", verdict: "confirmed", evidence: "src/x.ts:1" }],
      tradeoffs: [],
      extra_findings: [],
    };
    expect(normalizeReviewJson(raw)).toEqual(raw);
  });

  test("a shape that is not a review is left for the schema to reject", () => {
    expect(normalizeReviewJson({ verdicts: "nope" })).toEqual({ verdicts: "nope" });
    expect(normalizeReviewJson(null)).toBeNull();
  });
});

describe("summarizeUsage", () => {
  test("tokens are summed over the run's steps", () => {
    const u = summarizeUsage([
      step({ tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 10, write: 2 } } }),
      step({ tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 1, write: 0 } } }),
    ]);
    expect(u.steps).toBe(2);
    expect(u.input).toBe(110);
    expect(u.output).toBe(55);
    expect(u.reasoning).toBe(6);
  });

  test("a provider that reports no cost is 'not reported', not $0", () => {
    // The openrouter gateway emits step-finish without a cost field; a paid
    // run must not display as free.
    const u = summarizeUsage([
      step({ tokens: { input: 100, output: 50 } }),
      step({ tokens: { input: 10, output: 5 } }),
    ]);
    expect(u.costKnown).toBe(false);
    expect(u.cost).toBe(0);
    expect(formatUsage(u)).toContain("cost not reported");
    expect(formatUsage(u)).not.toContain("$0.000000");
  });

  test("an explicit zero from a free provider is still a reported cost", () => {
    const u = summarizeUsage([step({ cost: 0, tokens: { input: 1, output: 1 } })]);
    expect(u.costKnown).toBe(true);
    expect(formatUsage(u)).toContain("$0.000000");
  });

  test("reported costs are summed", () => {
    const u = summarizeUsage([
      step({ cost: 0.0001, tokens: { input: 1, output: 1 } }),
      step({ cost: 0.0002, tokens: { input: 1, output: 1 } }),
    ]);
    expect(u.cost).toBeCloseTo(0.0003);
    expect(u.costKnown).toBe(true);
  });
});
