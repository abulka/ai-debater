import { describe, expect, test } from "bun:test";
import {
  classifyCommand,
  mergeAuditIntoReview,
  nextAuditId,
  outcomeOf,
  resolveAuditRef,
  runCommand,
  runProposedChecks,
  scrubbedEnv,
  toAuditRecord,
} from "./audit.ts";
import { AuditRecord, CheckProposal, Evidence, Review } from "./contracts.ts";

describe("classifyCommand", () => {
  test("quick checks run by themselves", () => {
    expect(classifyCommand(["bun", "--version"]).tier).toBe("auto");
    expect(classifyCommand(["git", "rev-parse", "HEAD"]).tier).toBe("auto");
  });

  test("slow project checks ask first", () => {
    expect(classifyCommand(["bun", "test"]).tier).toBe("ask");
    expect(classifyCommand(["bun", "run", "typecheck"]).tier).toBe("ask");
  });

  test("extra arguments are a different command", () => {
    expect(classifyCommand(["bun", "test", "--watch"]).tier).toBe("refuse");
  });

  test("a whole shell line in one string matches nothing", () => {
    expect(classifyCommand(["bun test; rm -rf /"]).tier).toBe("refuse");
  });

  test("an unlisted command is refused, whatever it is", () => {
    expect(classifyCommand(["rm", "-rf", "/"]).tier).toBe("refuse");
    expect(classifyCommand(["./scripts/test.sh", "--all"]).tier).toBe("refuse");
  });

  test("an empty command is refused rather than spawned", () => {
    expect(classifyCommand([]).tier).toBe("refuse");
    expect(classifyCommand(["bun", " "]).tier).toBe("refuse");
  });

  test("the classification carries the rule and its timeout", () => {
    const { rule } = classifyCommand(["bun", "run", "typecheck"]);
    expect(rule?.timeoutMs).toBe(120_000);
    expect(rule?.why).toContain("project check");
  });
});

describe("scrubbedEnv", () => {
  test("keeps only what a command needs to run", () => {
    const { env, names } = scrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-secret",
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(names).toEqual(["HOME", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("secret");
  });
});

describe("runCommand", () => {
  test("runs an argv with no shell and keeps the output", async () => {
    const run = await runCommand(["/bin/echo", "hello"], { cwd: process.cwd() });
    expect(run.status).toBe("ran");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("hello\n");
    expect(run.truncated).toBe(false);
    expect(run.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reports a non-zero exit instead of throwing", async () => {
    const run = await runCommand(["/bin/sh", "-c", "echo bad; exit 3"], {
      cwd: process.cwd(),
    });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toContain("bad");
  });

  test("caps what it stores but still counts and hashes everything", async () => {
    const run = await runCommand(["/bin/sh", "-c", "yes a | head -c 5000"], {
      cwd: process.cwd(),
      capBytes: 100,
    });
    expect(run.truncated).toBe(true);
    expect(run.totalBytes).toBe(5000);
    expect(Buffer.byteLength(run.stdout)).toBe(100);
  });

  test("kills a command that overruns its timeout and says so", async () => {
    const t0 = Date.now();
    const run = await runCommand(["/bin/sleep", "5"], { cwd: process.cwd(), timeoutMs: 100 });
    expect(run.status).toBe("timed-out");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a missing binary is a spawn error, not a crash", async () => {
    const run = await runCommand(["/definitely/not/here"], { cwd: process.cwd() });
    expect(run.status).toBe("spawn-error");
    expect(run.totalBytes).toBe(0);
  });

  test("the same command twice hashes the same", async () => {
    const a = await runCommand(["/bin/echo", "same"], { cwd: process.cwd() });
    const b = await runCommand(["/bin/echo", "same"], { cwd: process.cwd() });
    expect(a.sha256).toBe(b.sha256);
  });
});

describe("outcomeOf", () => {
  const ran = (stdout: string, exitCode = 0) =>
    ({
      status: "ran" as const,
      exitCode,
      startedAt: "",
      durationMs: 1,
      stdout,
      stderr: "",
      truncated: false,
      totalBytes: stdout.length,
      sha256: "",
      envNames: [],
    });

  test("matches on exit code and substring", () => {
    expect(outcomeOf({ exitCode: 0 }, ran("ok"))).toBe("matched");
    expect(outcomeOf({ stdoutIncludes: "ok" }, ran("all ok"))).toBe("matched");
  });

  test("a wrong exit code or a missing substring is a mismatch", () => {
    expect(outcomeOf({ exitCode: 0 }, ran("ok", 1))).toBe("mismatched");
    expect(outcomeOf({ stdoutIncludes: "passing" }, ran("failing"))).toBe("mismatched");
  });

  test("a run that did not complete is not a mismatch", () => {
    expect(outcomeOf({ exitCode: 0 }, { ...ran(""), status: "timed-out" })).toBe("not-run");
  });
});

describe("toAuditRecord", () => {
  const proposal = CheckProposal.parse({
    argv: ["bun", "--version"],
    expect: { exitCode: 0, stdoutIncludes: "1." },
  });

  const base = {
    id: "A1",
    proposal,
    claim: "V3",
    proposedBy: "opencode-go/gpt-6-luna",
    cwd: "/repo",
    tier: "auto" as const,
    decision: "auto-allowed" as const,
    decidedAt: "2026-10-17T00:00:00.000Z",
    tree: { head: "abc123", dirty: false },
    planVersion: 1,
    planSha256: "deadbeef",
  };

  test("a record that never ran is still a record", () => {
    const record = toAuditRecord({ ...base, run: null });
    expect(AuditRecord.parse(record).status).toBe("not-run");
    expect(record.outcome).toBe("not-run");
    expect(record.stdout).toBe("");
  });

  test("a refusal records why nothing happened", () => {
    const record = AuditRecord.parse(
      toAuditRecord({ ...base, decision: "refused", run: null }),
    );
    expect(record.decision).toBe("refused");
    expect(record.env).toEqual([]);
  });

  test("a completed check records output, hash, tree and outcome", async () => {
    const run = await runCommand(["/bin/echo", "1.3.14"], { cwd: process.cwd() });
    const record = AuditRecord.parse(toAuditRecord({ ...base, run }));
    expect(record.status).toBe("ran");
    expect(record.outcome).toBe("matched");
    expect(record.stdout).toContain("1.3.14");
    expect(record.tree.head).toBe("abc123");
    expect(record.planVersion).toBe(1);
  });

  test("ids are A-prefixed; a claim id is not accepted as an audit id", () => {
    expect(() => AuditRecord.parse(toAuditRecord({ ...base, id: "V1", run: null }))).toThrow();
  });
});

describe("audit references", () => {
  const record = AuditRecord.parse({
    id: "A7",
    claim: "V3",
    proposedBy: "m",
    argv: ["bun", "--version"],
    cwd: "/repo",
    tier: "auto",
    decision: "auto-allowed",
    decidedAt: "2026-10-17T00:00:00.000Z",
    status: "not-run",
    stdout: "",
    stderr: "",
    truncated: false,
    totalBytes: 0,
    sha256: "x",
    tree: { head: null, dirty: false },
    env: [],
    planVersion: 1,
    planSha256: "y",
    outcome: "not-run",
  });

  test("a reference resolves only against a record that exists", () => {
    expect(resolveAuditRef("audit:A7", [record])?.id).toBe("A7");
    expect(resolveAuditRef("audit:A9", [record])).toBeNull();
  });

  test("a non-reference does not resolve, so it cannot smuggle evidence", () => {
    expect(resolveAuditRef("src/http.ts:88", [record])).toBeNull();
    expect(resolveAuditRef("audit:V1", [record])).toBeNull();
  });

  test("ids continue from the highest existing one", () => {
    expect(nextAuditId([])).toBe("A1");
    expect(nextAuditId([{ id: "A1" }, { id: "A3" }])).toBe("A4");
  });
});

describe("contracts", () => {
  test("evidence accepts an audit reference and still rejects command text", () => {
    expect(Evidence.parse("audit:A1")).toBe("audit:A1");
    expect(() => Evidence.parse("npm test fails")).toThrow();
    expect(() => Evidence.parse("./scripts/test.sh --all")).not.toThrow();
  });

  test("a proposal must say what it expects, or it cannot be judged", () => {
    expect(() => CheckProposal.parse({ argv: ["bun", "test"], expect: {} })).toThrow();
    expect(CheckProposal.parse({ argv: ["bun", "test"], expect: { exitCode: 0 } }).argv).toEqual([
      "bun",
      "test",
    ]);
  });

  test("an unverifiable verdict may carry a proposal", () => {
    const review = Review.parse({
      verdicts: [
        {
          id: "V1",
          verdict: "unverifiable",
          note: "needs the tool version",
          proposes: { argv: ["bun", "--version"], expect: { exitCode: 0 } },
        },
      ],
      tradeoffs: [],
      extra_findings: [],
    });
    const first = review.verdicts[0];
    expect(first?.verdict === "unverifiable" && first.proposes?.argv[0]).toBe("bun");
  });

  test("a confirmed verdict may carry a proposal, but it is stripped — it already claims proof", () => {
    const review = Review.parse({
      verdicts: [
        {
          id: "V1",
          verdict: "confirmed",
          evidence: "src/http.ts:88",
          proposes: { argv: ["bun", "test"], expect: { exitCode: 0 } },
        },
      ],
      tradeoffs: [],
      extra_findings: [],
    });
    expect(review.verdicts[0]).not.toHaveProperty("proposes");
  });
});

describe("runProposedChecks", () => {
  const allow = [
    { argv: ["/bin/echo", "quick"], tier: "auto" as const, why: "test" },
    { argv: ["/bin/echo", "slow"], tier: "ask" as const, why: "test" },
  ];

  const reviewWith = (argv: string[], expectSpec = { exitCode: 0 }): Review =>
    Review.parse({
      verdicts: [
        {
          id: "V1",
          verdict: "unverifiable",
          note: "needs a check",
          proposes: { argv, expect: expectSpec },
        },
      ],
      tradeoffs: [],
      extra_findings: [],
    });

  const opts = {
    repo: process.cwd(),
    planText: "the plan",
    proposedBy: "model",
    allowlist: allow,
  };

  test("a quick check runs without asking, and a match is recorded", async () => {
    const records = await runProposedChecks(reviewWith(["/bin/echo", "quick"]), opts);
    expect(records[0]?.decision).toBe("auto-allowed");
    expect(records[0]?.status).toBe("ran");
    expect(records[0]?.outcome).toBe("matched");
  });

  test("a slow check with nobody to ask is recorded as declined, not run", async () => {
    const records = await runProposedChecks(reviewWith(["/bin/echo", "slow"]), opts);
    expect(records[0]?.decision).toBe("human-rejected");
    expect(records[0]?.status).toBe("not-run");
  });

  test("a slow check runs when the human says yes", async () => {
    let asked: string[] = [];
    const records = await runProposedChecks(reviewWith(["/bin/echo", "slow"]), {
      ...opts,
      approve: async (request) => {
        asked = request.argv;
        return true;
      },
    });
    expect(asked).toEqual(["/bin/echo", "slow"]);
    expect(records[0]?.decision).toBe("human-approved");
    expect(records[0]?.outcome).toBe("matched");
  });

  test("an unlisted command is refused and never spawned", async () => {
    const records = await runProposedChecks(reviewWith(["/bin/echo", "nope"]), opts);
    expect(records[0]?.decision).toBe("refused");
    expect(records[0]?.tier).toBe("none");
    expect(records[0]?.status).toBe("not-run");
  });

  test("a disagreement is recorded as a mismatch", async () => {
    const records = await runProposedChecks(
      reviewWith(["/bin/echo", "quick"], { exitCode: 3 }),
      opts,
    );
    expect(records[0]?.outcome).toBe("mismatched");
  });
});

describe("mergeAuditIntoReview", () => {
  const review = Review.parse({
    verdicts: [
      {
        id: "V1",
        verdict: "unverifiable",
        note: "needs a check",
        proposes: { argv: ["bun", "--version"], expect: { exitCode: 0 } },
      },
      {
        id: "V2",
        verdict: "unverifiable",
        note: "needs a check",
        proposes: { argv: ["bun", "--version"], expect: { exitCode: 0 } },
      },
      { id: "V3", verdict: "unverifiable", note: "no check proposed" },
      { id: "V4", verdict: "confirmed", evidence: "src/x.ts:1" },
    ],
    tradeoffs: [],
    extra_findings: [],
  });

  const record = (claim: string, outcome: "matched" | "mismatched" | "not-run"): AuditRecord =>
    AuditRecord.parse({
      id: "A1",
      claim,
      proposedBy: "m",
      argv: ["bun", "--version"],
      cwd: "/r",
      tier: "auto",
      decision: "auto-allowed",
      decidedAt: "2026-10-17T00:00:00.000Z",
      status: "ran",
      stdout: "",
      stderr: "",
      truncated: false,
      totalBytes: 0,
      sha256: "x",
      tree: { head: null, dirty: false },
      env: [],
      planVersion: 1,
      planSha256: "y",
      outcome,
    });

  test("a matched check makes the claim confirmed, citing the record", () => {
    const merged = mergeAuditIntoReview(review, [record("V1", "matched")]);
    expect(merged.verdicts[0]).toMatchObject({ verdict: "confirmed", evidence: "audit:A1" });
  });

  test("a mismatch makes the claim refuted — the plan will be corrected", () => {
    const merged = mergeAuditIntoReview(review, [record("V2", "mismatched")]);
    expect(merged.verdicts[1]).toMatchObject({ verdict: "refuted", evidence: "audit:A1" });
  });

  test("a check that did not complete leaves the claim unverifiable and says why", () => {
    const merged = mergeAuditIntoReview(review, [record("V1", "not-run")]);
    const first = merged.verdicts[0]!;
    expect(first.verdict).toBe("unverifiable");
    expect(first.verdict === "unverifiable" && first.note).toContain("did not complete");
  });

  test("claims with no check, and verdicts already settled, are untouched", () => {
    const merged = mergeAuditIntoReview(review, [record("V1", "matched")]);
    expect(merged.verdicts[2]?.verdict).toBe("unverifiable");
    expect(merged.verdicts[3]?.verdict).toBe("confirmed");
  });

  test("the reviewer's version is not mutated", () => {
    mergeAuditIntoReview(review, [record("V1", "mismatched")]);
    expect(review.verdicts[0]?.verdict).toBe("unverifiable");
  });
});
