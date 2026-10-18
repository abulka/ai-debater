import { describe, expect, test } from "bun:test";
import { lineText } from "./markdown.ts";
import { THEME } from "./theme.ts";

/** The plain form of the status line, for asserting the wording. */
const statusLine = (counts: Parameters<typeof statusSpans>[0]) => lineText(statusSpans(counts));
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  answersToGate,
  buildItems,
  clampOffset,
  decisionEntries,
  describeGateChange,
  describeJudgmentCall,
  findingQuestion,
  gateSummaryLines,
  judgmentQuestion,
  maxOffset,
  parseEvidence,
  readEvidenceContext,
  selectionForCurrent,
  statusSpans,
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
  test("a judgment call always offers 'leave it open', saying what that means", () => {
    const [item] = buildItems(claims, review);
    expect(item?.kind).toBe("judgment");
    expect(item?.options[1]).toBe("redis");
    expect(item?.options[2]).toContain("leave it open — don't decide now");
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
    expect(finding?.values).toEqual(["accepted", "dismissed", "untriaged"]);
    expect(finding?.options[0]).toContain("yes");
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

describe("describeGateChange", () => {
  const old = {
    decisions: [{ id: "J1", choice: "redis" }],
    findings: [{ id: "E1", disposition: "accepted" as const }],
  };

  test("identical gates differ in nothing, in any order", () => {
    expect(describeGateChange(old, { ...old })).toEqual({ decisions: [], findings: [] });
    const shuffled = {
      decisions: [...old.decisions].reverse(),
      findings: [...old.findings].reverse(),
    };
    expect(describeGateChange(old, shuffled)).toEqual({ decisions: [], findings: [] });
  });

  test("a changed answer is reported by id, old and new value included", () => {
    const next = {
      decisions: [{ id: "J1", choice: "in-process" }],
      findings: [{ id: "E1", disposition: "untriaged" as const }],
    };
    expect(describeGateChange(old, next)).toEqual({
      decisions: [{ id: "J1", from: "redis", to: "in-process" }],
      findings: [{ id: "E1", from: "accepted", to: "untriaged" }],
    });
  });

  test("a gate with no recorded answers is all new", () => {
    const change = describeGateChange(null, old);
    expect(change.decisions).toEqual([{ id: "J1", from: "(none)", to: "redis" }]);
    expect(change.findings).toEqual([{ id: "E1", from: "(none)", to: "accepted" }]);
  });

  test("a recorded answer that is missing from the new gate counts as a change", () => {
    // A hand-edited gate.json is all that can drop an item; if it does, the
    // drop must not read as "nothing moved".
    expect(describeGateChange(old, { decisions: [], findings: [] })).toEqual({
      decisions: [{ id: "J1", from: "redis", to: "(unanswered)" }],
      findings: [{ id: "E1", from: "accepted", to: "(unanswered)" }],
    });
  });
});

describe("decisionEntries", () => {
  const j1 = claims.judgment[0]!;

  test("a moved settled answer is appended marked as a supersede", () => {
    const entries = decisionEntries(claims, {
      decisions: [{ id: "J1", from: "redis", to: "in-process" }],
      findings: [],
    });
    expect(entries).toEqual([
      {
        id: "J1",
        text: j1.text,
        choice: "in-process",
        note: "(supersedes the earlier entry for J1)",
      },
    ]);
  });

  test("re-opening a settled answer appends a reopened marker, no choice", () => {
    const entries = decisionEntries(claims, {
      decisions: [{ id: "J1", from: "redis", to: "open" }],
      findings: [],
    });
    expect(entries).toEqual([
      {
        id: "J1",
        text: j1.text,
        choice: "reopened",
        note: "(the earlier entry for J1 no longer stands)",
      },
    ]);
  });

  test("a call that was open and now settles appends a plain entry, no supersede", () => {
    const entries = decisionEntries(claims, {
      decisions: [{ id: "J1", from: "open", to: "redis" }],
      findings: [],
    });
    expect(entries).toEqual([{ id: "J1", text: j1.text, choice: "redis" }]);
  });

  test("a call that was never settled and stays open appends nothing", () => {
    const entries = decisionEntries(claims, {
      decisions: [{ id: "J1", from: "open", to: "open" }],
      findings: [],
    });
    expect(entries).toEqual([]);
  });

  test("a first-time answer (no recorded previous) appends plain, no supersede", () => {
    const entries = decisionEntries(claims, {
      decisions: [{ id: "J1", from: "(none)", to: "redis" }],
      findings: [],
    });
    expect(entries).toEqual([{ id: "J1", text: j1.text, choice: "redis" }]);
  });

  test("findings never become decision entries", () => {
    const entries = decisionEntries(claims, {
      decisions: [],
      findings: [{ id: "E1", from: "accepted", to: "dismissed" }],
    });
    expect(entries).toEqual([]);
  });
});

describe("selectionForCurrent", () => {
  const items = buildItems(claims, review);
  const judgment = items.find((i) => i.kind === "judgment")!;
  const finding = items.find((i) => i.kind === "finding")!;

  test("lands on the recorded answer among the item's values", () => {
    expect(selectionForCurrent(judgment!, "redis")).toBe(1);
    expect(selectionForCurrent(judgment!, "in-process")).toBe(0);
    expect(selectionForCurrent(judgment!, "open")).toBe(2);
  });

  test("a finding lands on its recorded disposition", () => {
    expect(selectionForCurrent(finding!, "dismissed")).toBe(1);
    expect(selectionForCurrent(finding!, "untriaged")).toBe(2);
  });

  test("no recorded answer, or one that is not a value, lands on the first option", () => {
    expect(selectionForCurrent(judgment!)).toBe(0);
    expect(selectionForCurrent(judgment!, "a stale value")).toBe(0);
  });
});

describe("gate prompts", () => {
  const judgment = claims.judgment[0]!;
  const finding = review.extra_findings[0]!;

  test("a prefilled judgment prompt offers to keep the recorded answer", () => {
    expect(judgmentQuestion(judgment, "redis")).toContain("(currently: redis)");
    expect(judgmentQuestion(judgment, "redis")).toContain("Enter to keep");
    expect(judgmentQuestion(judgment)).not.toContain("Enter to keep");
  });

  test("a prefilled finding prompt shows the recorded choice in words", () => {
    expect(findingQuestion(finding, "accepted")).toContain("(currently: yes)");
    expect(findingQuestion(finding, "dismissed")).toContain("(currently: no)");
    expect(findingQuestion(finding, "untriaged")).toContain("(currently: later)");
    expect(findingQuestion(finding)).not.toContain("currently");
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

  test("the status line colours what wants a decision, and only that", () => {
    const mixed = { claims: 4, confirmed: 1, refuted: 1, unverifiable: 2, noVerdict: 0, findings: 1 };
    const spanFor = (needle: string) =>
      statusSpans(mixed).find((span) => span.text.includes(needle))!;
    expect(spanFor("1 refuted").color).toBe(THEME.warn);
    expect(spanFor("2 unverifiable").color).toBe(THEME.warn);
    // The file agreeing is not a verdict on the sentence.
    expect(spanFor("1 confirmed").color).toBeUndefined();

    const clean = { claims: 2, confirmed: 2, refuted: 0, unverifiable: 0, noVerdict: 0, findings: 0 };
    expect(statusSpans(clean).every((span) => span.color === undefined)).toBe(true);
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
