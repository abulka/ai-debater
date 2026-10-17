import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  answersToGate,
  buildItems,
  clampOffset,
  describeJudgmentCall,
  gateSummaryLines,
  maxOffset,
  parseEvidence,
  readEvidenceContext,
  statusLine,
  verdictCounts,
} from "./gate-model.ts";
import type { Claims, Review } from "./contracts.ts";

const claims: Claims = {
  verifiable: [
    { id: "V1", text: "counters reset every 60 seconds" },
    { id: "V2", text: "there are no other config files" },
    { id: "V3", text: "node --test loads .ts files" },
  ],
  judgment: [
    { id: "J1", text: "where to store counters", options: ["in-process", "redis"] },
  ],
};

const review: Review = {
  verdicts: [
    { id: "V1", verdict: "refuted", evidence: "src/rateLimit.ts:3" },
    { id: "V2", verdict: "confirmed", evidence: "package.json" },
    { id: "V3", verdict: "unverifiable", note: "needs node --version, which is not a file" },
  ],
  tradeoffs: [
    { id: "J1", per_option: [{ option: "redis", against: ["new dependency"] }] },
  ],
  extra_findings: [
    { id: "E1", text: "no retry path for 429", kind: "verifiable", evidence: "src/http.ts:88" },
  ],
};

describe("buildItems", () => {
  test("a judgment call always offers 'leave it open'", () => {
    const [item] = buildItems(claims, review);
    expect(item?.kind).toBe("judgment");
    expect(item?.options).toEqual(["in-process", "redis", "leave it open"]);
    expect(item?.values).toEqual(["in-process", "redis", "open"]);
  });

  test("trade-offs are attached to the option they are about", () => {
    const [item] = buildItems(claims, review);
    expect(item?.detail).toEqual(["in-process", "redis  — new dependency"]);
  });

  test("findings carry their evidence through to the gate", () => {
    const finding = buildItems(claims, review).find((i) => i.id === "E1");
    expect(finding?.kind).toBe("finding");
    expect(finding?.evidence).toBe("src/http.ts:88");
    expect(finding?.values).toEqual(["accepted", "dismissed"]);
  });
});

describe("describeJudgmentCall", () => {
  test("shows the question and every option with what it costs", () => {
    const lines = describeJudgmentCall(claims.judgment[0]!, review);
    expect(lines[0]).toBe("J1  where to store counters");
    expect(lines[1]).toBe("1. in-process");
    expect(lines[2]).toBe("2. redis   — new dependency");
  });
});

describe("gateSummaryLines", () => {
  test("the CLI's paused summary names the call, not just the count", () => {
    const text = gateSummaryLines(claims, review).join("\n");
    expect(text).toContain("judgment calls needing you (1)");
    expect(text).toContain("J1  where to store counters");
    expect(text).toContain("2. redis   — new dependency");
  });

  test("says so when nothing needs a human", () => {
    const text = gateSummaryLines({ verifiable: [], judgment: [] }, review).join("\n");
    expect(text).toContain("no judgment calls");
  });
});

describe("answersToGate", () => {  test("records a decision and a finding in the shape gate.json expects", () => {
    const gate = answersToGate([
      { id: "J1", kind: "judgment", value: "redis" },
      { id: "E1", kind: "finding", value: "accepted" },
    ]);
    expect(gate).toEqual({
      decisions: [{ id: "J1", choice: "redis" }],
      findings: [{ id: "E1", disposition: "accepted" }],
    });
  });

  test("an open judgment call stays open — it is never silently resolved", () => {
    const gate = answersToGate([{ id: "J1", kind: "judgment", value: "open" }]);
    expect(gate.decisions[0]?.choice).toBe("open");
  });

  test("an unexpected finding value is untriaged, not quietly dismissed", () => {
    const gate = answersToGate([{ id: "E1", kind: "finding", value: "skip" }]);
    expect(gate.findings[0]?.disposition).toBe("untriaged");
  });
});

describe("verdictCounts", () => {
  test("counts verdicts by kind and notices claims with none", () => {
    const counts = verdictCounts(claims, review);
    expect(counts).toEqual({
      claims: 3,
      confirmed: 1,
      refuted: 1,
      unverifiable: 1,
      noVerdict: 0,
      findings: 1,
    });
    expect(statusLine(counts)).toBe(
      "3 claims · 1 confirmed · 1 refuted · 1 unverifiable · 1 finding",
    );
  });

  test("a verdict for a claim that was never asked does not inflate the count", () => {
    const counts = verdictCounts(claims, {
      ...review,
      verdicts: [...review.verdicts, { id: "V9", verdict: "confirmed", evidence: "README.md" }],
    });
    expect(counts.claims).toBe(3);
    expect(counts.confirmed).toBe(1);
  });

  test("a missing verdict is reported separately, not counted as unverifiable", () => {
    const counts = verdictCounts(claims, { ...review, verdicts: review.verdicts.slice(0, 2) });
    expect(counts.noVerdict).toBe(1);
    expect(counts.unverifiable).toBe(0);
    expect(statusLine(counts)).toContain("1 without a verdict");
  });
});

describe("scrolling", () => {
  test("an offset past the end is clamped, so the pane cannot go blank", () => {
    expect(maxOffset(10, 4)).toBe(6);
    expect(clampOffset(99, 10, 4)).toBe(6);
    expect(clampOffset(-5, 10, 4)).toBe(0);
    expect(clampOffset(2, 3, 10)).toBe(0);
  });
});

describe("parseEvidence", () => {
  test("reads a path and a line", () => {
    expect(parseEvidence("src/http.ts:88")).toEqual({ kind: "file", file: "src/http.ts", line: 88 });
  });

  test("reads a line range as its first line", () => {
    expect(parseEvidence("src/http.ts:88-92")).toEqual({
      kind: "file",
      file: "src/http.ts",
      line: 88,
    });
  });

  test("does not eat the last digit of the line number", () => {
    expect(parseEvidence("src/http.ts:88")).not.toMatchObject({ file: "src/http.ts:8" });
  });

  test("recognises a URL and keeps it whole", () => {
    expect(parseEvidence("https://en.wikipedia.org/wiki/Excession")).toEqual({
      kind: "url",
      url: "https://en.wikipedia.org/wiki/Excession",
    });
  });
});

describe("readEvidenceContext", () => {
  const makeRepo = async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "adv-gate-"));
    await mkdir(path.join(repo, "src"));
    await writeFile(
      path.join(repo, "src", "http.ts"),
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    return repo;
  };

  test("shows the cited file around the cited line, numbered", async () => {
    const repo = await makeRepo();
    try {
      const ctx = await readEvidenceContext(repo, "src/http.ts:20", 2);
      expect(ctx?.file).toBe("src/http.ts");
      expect(ctx?.line).toBe(20);
      expect(ctx?.lines.join("\n")).toContain("> 20  line 20");
      expect(ctx?.lines[0]).toContain("line 18");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("refuses a path that escapes the repository", async () => {
    const repo = await makeRepo();
    try {
      expect(await readEvidenceContext(repo, "../../etc/passwd")).toBeNull();
      expect(await readEvidenceContext(repo, "/etc/passwd")).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("returns null for a citation that does not resolve, so the gate can say so", async () => {
    const repo = await makeRepo();
    try {
      expect(await readEvidenceContext(repo, "src/invented.ts:4")).toBeNull();
      expect(await readEvidenceContext(repo, "https://example.com/x")).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
