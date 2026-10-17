import { describe, expect, test } from "bun:test";
import { Review } from "../contracts.ts";
import { normalizeReviewJson } from "./opencode-run.ts";

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
