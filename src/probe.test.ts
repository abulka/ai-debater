import { describe, expect, test } from "bun:test";
import { ago, classify, failedProbes, isFresh, loadProbes, probeBadge, recordProbe, SHORT, tail, type VerdictKind } from "./probe.ts";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "adv-probe-"));

describe("classify", () => {
  test("an exhausted account is no credit, even though it names the model", () => {
    // Order matters. An OpenRouter 402 mentions the model; reporting "no
    // access" sends someone hunting a retired model that is perfectly healthy.
    const v = classify('{"error":{"message":"This request exceeds your credit balance","code":"credit_balance_exhausted"}}');
    expect(v.kind).toBe("no-credit");
    expect(v.detail).toContain("no credit");
  });

  test("a bare 402 is no credit", () => {
    expect(classify("HTTP 402 Payment Required").kind).toBe("no-credit");
  });

  test("groq's exact rejection for a tier-restricted model is no access", () => {
    const v = classify(
      '{"error":{"message":"The model `groq/compound-mini` does not exist or you do not have access to it.","code":"model_not_found"}}',
    );
    expect(v.kind).toBe("no-access");
  });

  test("model_not_found on its own is no access", () => {
    expect(classify("model_not_found").kind).toBe("no-access");
  });

  test("opencode's own no-route refusal is the same verdict as model_not_found", () => {
    // Observed live: `opencode-go/space-bunny-free` is listed and in the
    // catalogue, and opencode refuses to route it at all. Same question, same
    // answer, same remedy — so it must not fall through to "failed".
    const v = classify(
      '{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: opencode-go/space-bunny-free"}}',
    );
    expect(v.kind).toBe("no-access");
  });

  test("a model that is not released yet is not-yet", () => {
    expect(classify("model_coming_soon").kind).toBe("not-yet");
  });

  test("the contributor privacy opt-in is blocked, not failed", () => {
    expect(classify("This workspace requires a privacy opt-in; models train on request data").kind).toBe("blocked");
  });

  test("a rate limit is reachable-but-throttled, which is not the same as broken", () => {
    expect(classify("429 Too Many Requests").kind).toBe("throttled");
  });

  test("the gpt-oss invented-tool rejection is its own verdict", () => {
    // The whole reason a full ping forces a tool call. This model answers
    // perfectly and still cannot be a drafter.
    const v = classify("tool_use_failed: attempted to call tool 'search', which was not in request.tools");
    expect(v.kind).toBe("no-tools");
    expect(v.detail).toContain("tools");
  });

  test("the runner's own timeout is recognised, not reported as a provider error", () => {
    expect(classify("opencode run timed out after 30000ms").kind).toBe("timeout");
  });

  test("a reply is ok, and carries the duration it was given", () => {
    const v = classify("ok", 3200);
    expect(v).toEqual({ kind: "ok", detail: "replied", ms: 3200 });
  });

  test("an unrecognised failure keeps its own words rather than losing them", () => {
    const v = classify("Error: something nobody has seen before\nsecond line");
    expect(v.kind).toBe("failed");
    expect(v.detail).toContain("something nobody has seen before");
  });

  test("empty output is a failure, not a silent pass", () => {
    expect(classify("").kind).toBe("failed");
  });
});

describe("tail", () => {
  test("keeps the last lines and drops the noise above them", () => {
    expect(tail("a\nb\nc\nd\ne\nf")).toBe("c d e f");
  });

  test("truncates rather than overflowing a row", () => {
    expect(tail("x".repeat(500), 40).length).toBeLessThanOrEqual(40);
  });

  test("nothing at all says so", () => {
    expect(tail("   \n  ")).toBe("no output");
  });
});

describe("the probe cache", () => {
  test("round-trips a verdict through the file", async () => {
    const file = path.join(await tmp(), "probes.json");
    await recordProbe("groq/groq/compound-mini", { kind: "no-access", detail: "listed, but this account cannot call it" }, file);
    const loaded = await loadProbes(file);
    expect(loaded["groq/groq/compound-mini"]?.verdict.kind).toBe("no-access");
  });

  test("a malformed file is no probes, never a throw", async () => {
    const dir = await tmp();
    const file = path.join(dir, "probes.json");
    await Bun.write(file, "{not json");
    expect(await loadProbes(file)).toEqual({});
  });

  test("entries with a missing field are skipped, not fatal", async () => {
    const file = path.join(await tmp(), "probes.json");
    await Bun.write(file, JSON.stringify({ "a/b": { at: "2026-10-18T00:00:00Z" }, "c/d": 7, ok: true }));
    expect(Object.keys(await loadProbes(file))).toEqual([]);
  });

  test("prunes anything past the long horizon on write", async () => {
    const file = path.join(await tmp(), "probes.json");
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    await Bun.write(file, JSON.stringify({ "old/model": { at: old, verdict: { kind: "ok", detail: "" } } }));
    await recordProbe("new/model", { kind: "ok", detail: "replied" }, file);
    const left = Object.keys(await loadProbes(file));
    expect(left).toEqual(["new/model"]);
  });

  test("an unreadable date is pruned rather than kept forever", async () => {
    const file = path.join(await tmp(), "probes.json");
    await Bun.write(file, JSON.stringify({ "bad/model": { at: "not a date", verdict: { kind: "ok", detail: "" } } }));
    await recordProbe("good/model", { kind: "ok", detail: "replied" }, file);
    expect(Object.keys(await loadProbes(file))).toEqual(["good/model"]);
  });
});

describe("freshness", () => {
  const rec = (kind: "ok" | "no-credit", ageMs: number) => ({
    at: new Date(Date.now() - ageMs).toISOString(),
    verdict: { kind, detail: "x" },
  });

  test("a success is trusted for a week", () => {
    expect(isFresh(rec("ok", 6 * 24 * 3600_000))).toBe(true);
    expect(isFresh(rec("ok", 8 * 24 * 3600_000))).toBe(false);
  });

  test("a failure is trusted for a day, because credit can be added at any time", () => {
    expect(isFresh(rec("no-credit", 20 * 3600_000))).toBe(true);
    expect(isFresh(rec("no-credit", 30 * 3600_000))).toBe(false);
  });
});

describe("ago", () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();

  test("reads as minutes, then hours, then days", () => {
    expect(ago({ at: at(5 * 60_000), verdict: { kind: "ok", detail: "" } })).toBe("5m");
    expect(ago({ at: at(6 * 3600_000), verdict: { kind: "ok", detail: "" } })).toBe("6h");
    expect(ago({ at: at(6 * 86_400_000), verdict: { kind: "ok", detail: "" } })).toBe("6d");
  });

  test("never says zero minutes", () => {
    expect(ago({ at: new Date().toISOString(), verdict: { kind: "ok", detail: "" } })).toBe("1m");
  });
});

describe("probeBadge", () => {
  const cache = {
    "ok/model": { at: new Date(Date.now() - 3_200).toISOString(), verdict: { kind: "ok" as const, detail: "replied", ms: 3_200 } },
    "stale/model": { at: new Date(Date.now() - 9 * 86_400_000).toISOString(), verdict: { kind: "ok" as const, detail: "replied", ms: 2_000 } },
    "dead/model": { at: new Date(Date.now() - 3600_000).toISOString(), verdict: { kind: "no-credit" as const, detail: "no credit on this account" } },
  };

  test("no record means no badge at all", () => {
    expect(probeBadge({}, "never/seen")).toBeNull();
  });

  test("a fresh success shows the duration", () => {
    expect(probeBadge(cache, "ok/model")?.badge).toBe("✓ 3.2s");
  });

  test("a stale success shows its age, never a bare tick", () => {
    const b = probeBadge(cache, "stale/model");
    expect(b?.badge).toBe("✓ 9d ago");
    expect(b?.stale).toBe(true);
  });

  test("a failure names the reason, in the short form a row can hold", () => {
    // The full sentence is 41 characters and a badge column is 22. A row that
    // wraps is two rows, and every scrolled pane here counts lines.
    expect(probeBadge(cache, "dead/model")?.badge).toBe("✗ no credit");
  });

  test("every short form fits its column", () => {
    for (const kind of Object.keys(SHORT)) {
      expect(SHORT[kind as VerdictKind].length).toBeLessThanOrEqual(12);
    }
  });

  test("failedProbes lists the unusable ones newest first, with their sentence", () => {
    const cache2 = {
      "a/older": { at: new Date(Date.now() - 7200_000).toISOString(), verdict: { kind: "no-access" as const, detail: "listed, but this account cannot call it" } },
      "b/newer": { at: new Date(Date.now() - 60_000).toISOString(), verdict: { kind: "no-credit" as const, detail: "no credit on this account" } },
      "c/fine": { at: new Date().toISOString(), verdict: { kind: "ok" as const, detail: "replied", ms: 900 } },
      "d/slow": { at: new Date().toISOString(), verdict: { kind: "throttled" as const, detail: "reachable, but throttled" } },
    };
    const failed = failedProbes(cache2);
    // `throttled` is reachable — it is rate limited, not broken.
    expect(failed.map((f) => f.ref)).toEqual(["b/newer", "a/older"]);
    expect(failed[0]?.verdict.detail).toBe("no credit on this account");
  });
});
