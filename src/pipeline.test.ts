import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Changelog, Claims, Review, RunState } from "./contracts.ts";
import { headFromArtifacts, loadTail } from "./pipeline.ts";
import { runPaths, type Paths } from "./orchestrator.ts";

const pair = (drafter: string, reviewer: string) => ({
  drafter: { ref: drafter, family: "gpt" },
  reviewer: { ref: reviewer, family: "gpt" },
});

const runState = (over: Partial<RunState> = {}): RunState => ({
  state: "done",
  createdAt: "2026-10-17T12:00:00.000Z",
  task: "add a rate limiter",
  mode: "plan",
  models: pair("groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"),
  ...over,
});

const claims: Claims = {
  verifiable: [
    { id: "V1", text: "counters reset every 60 seconds" },
    { id: "V2", text: "there are no other config files" },
  ],
  judgment: [{ id: "J1", text: "where to store counters", options: ["in-process", "redis"] }],
};

describe("headFromArtifacts", () => {
  test("rebuilds the in-memory head from a finished run's artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-pipeline-"));
    try {
      // A repository in which the cited file does not exist: the rebuilt head
      // must flag it, exactly as a fresh run would.
      const repo = path.join(dir, "repo");
      await mkdir(repo, { recursive: true });

      const paths = runPaths(repo, path.join(dir, "run"));
      const review: Review = {
        verdicts: [
          // Cites a file that is not in the repository.
          { id: "V1", verdict: "confirmed", evidence: "src/real.ts:3" },
        ],
        tradeoffs: [],
        extra_findings: [],
      };
      const head = headFromArtifacts(repo, paths, {
        state: runState(),
        plan: "# Plan\n\nthe counters reset",
        claims,
        review,
        gate: { decisions: [{ id: "J1", choice: "redis" }], findings: [] },
        checks: [],
      });

      // Everything from the bundle comes through unchanged…
      expect(head.plan).toBe("# Plan\n\nthe counters reset");
      expect(head.claims).toBe(claims);
      expect(head.review).toBe(review);
      expect(head.checks).toEqual([]);
      expect(head.paths).toBe(paths);
      // …and the two derived fields are recomputed, not trusted.
      expect(head.missing).toEqual(["V2"]); // no verdict was returned for it
      expect(head.evidenceIssues).toEqual([
        { id: "V1", evidence: "src/real.ts:3", reason: "missing" },
      ]);
      expect(head.urlRepairs).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a citation that resolves in the repository raises no issue", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-pipeline-"));
    try {
      const repo = path.join(dir, "repo");
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "real.ts"), "line one\nline two\nline three\n");

      const review: Review = {
        verdicts: [{ id: "V1", verdict: "confirmed", evidence: "src/real.ts:3" }],
        tradeoffs: [],
        extra_findings: [],
      };
      const head = headFromArtifacts(repo, runPaths(repo, path.join(dir, "run")), {
        state: runState({ urlRepairs: [{ before: "https://ex.com/a", after: "https://ex.com/a" }] }),
        plan: "",
        claims,
        review,
        gate: null,
        checks: [],
      });

      expect(head.evidenceIssues).toEqual([]);
      expect(head.urlRepairs).toEqual([{ before: "https://ex.com/a", after: "https://ex.com/a" }]);
      expect(head.missing).toEqual(["V2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadTail", () => {
  const changelog: Changelog = {
    changes: [
      { item: "V1", disposition: "fixed", summary: "corrected the reset interval" },
      { item: "J1", disposition: "applied", summary: "counters go to redis" },
    ],
  };

  const patch = [
    "--- a/plan.v1.md",
    "+++ b/plan.v2.md",
    "@@ -1,2 +1,2 @@",
    "-the counters reset",
    "+the counters reset every 60 seconds, in redis",
    "",
  ].join("\n");

  const makeRun = async (dir: string, p: Paths) => {
    await mkdir(p.dir, { recursive: true });
    await writeFile(p.planV2, "# Revised plan\n\nin redis, every 60 seconds");
    await writeFile(p.changelog, JSON.stringify(changelog));
    await writeFile(p.diff, patch);
  };

  test("reads the revised text, the changelog and the diff back from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-pipeline-"));
    try {
      const p = runPaths(path.join(dir, "repo"), path.join(dir, "run"));
      await makeRun(dir, p);
      const tail = await loadTail(p);
      expect(await readFile(p.planV2, "utf8")).toBe(tail.plan);
      expect(tail.changelog).toEqual(changelog);
      expect(tail.patch).toBe(patch);
      expect(tail.assessment.hunks).toBe(1);
      expect(tail.assessment.claimedChanges).toBe(2);
      expect(tail.assessment.outOfScope).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a changed plan with an empty changelog is flagged out of scope", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-pipeline-"));
    try {
      const p = runPaths(path.join(dir, "repo"), path.join(dir, "run"));
      await mkdir(p.dir, { recursive: true });
      await writeFile(p.planV2, "# Revised");
      await writeFile(p.changelog, JSON.stringify({ changes: [] } satisfies Changelog));
      await writeFile(p.diff, patch);
      const tail = await loadTail(p);
      expect(tail.assessment.outOfScope).toBe(true);
      expect(tail.assessment.unexplained).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
