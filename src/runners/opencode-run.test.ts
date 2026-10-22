import { describe, expect, test } from "bun:test";
import {
  agentFallback,
  formatUsage,
  isUsageError,
  summarizeUsage,
  type RunEvent,
} from "./opencode-run.ts";

const step = (part: NonNullable<RunEvent["part"]>): RunEvent => ({
  type: "step-finish",
  part: { type: "step-finish", ...part },
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

describe("isUsageError", () => {
  test("OpenCode 1's unknown-argument output is a CLI failure, not a model failure", () => {
    expect(isUsageError("Unknown argument: standalone")).toBe(true);
    expect(
      isUsageError(
        "opencode run [message..]\n\nOptions:\n  --auto auto-approve permissions that are not explicitly denied",
      ),
    ).toBe(false);
  });

  test("an ordinary provider error is not mistaken for a usage error", () => {
    expect(isUsageError("model_not_found")).toBe(false);
  });
});

describe("agentFallback", () => {
  test("names the missing agent from the plain-text warning", () => {
    expect(agentFallback('! agent "adv-writer" not found. Falling back to default agent')).toBe(
      "adv-writer",
    );
  });

  test("a fallback warning without a name is still a failure", () => {
    expect(agentFallback("! Falling back to default agent")).toBe("");
  });

  test("the event stream is ignored, and no warning is null", () => {
    const stream = '{"type":"text","part":{"type":"text","text":"agent \\"adv-writer\\" not found. Falling back to default agent"}}';
    expect(agentFallback(stream)).toBeNull();
  });
});
