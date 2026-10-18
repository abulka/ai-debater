import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  answersDir,
  appendDecisions,
  createRun,
  deleteRuns,
  deletionSummary,
  findRunDir,
  latestRun,
  listRuns,
  olderThanCutoff,
  runsRoot,
  loadState,
  markFailed,
  readDecisions,
  repoKey,
  resumedModels,
  rotateGate,
  runPaths,
  runsDir,
  saveState,
} from "./orchestrator.ts";

const pair = (drafter: string, reviewer: string) => ({
  drafter: { ref: drafter, family: drafter.split("-")[0] ?? drafter },
  reviewer: { ref: reviewer, family: reviewer.split("-")[0] ?? reviewer },
});

describe("resumedModels", () => {
  const recorded = pair("groq/drafter-a", "groq/reviewer-a");
  const configured = pair("groq/drafter-b", "groq/reviewer-b");

  test("the run's own record wins when nothing is asked for", () => {
    const { models, overrides } = resumedModels(recorded, configured, {
      drafter: false,
      reviewer: false,
    });
    expect(models).toEqual(recorded);
    expect(overrides).toEqual([]);
  });

  test("changing .adv/config.json does not change who writes the rebuttal", () => {
    // This is the bug: the config default used to win here, so a different
    // model rebutted a plan it had never seen.
    const { models } = resumedModels(recorded, configured, { drafter: false, reviewer: false });
    expect(models.drafter.ref).toBe("groq/drafter-a");
  });

  test("an explicit flag is a human instruction and is honoured, with a record", () => {
    const { models, overrides } = resumedModels(recorded, configured, {
      drafter: true,
      reviewer: false,
    });
    expect(models.drafter.ref).toBe("groq/drafter-b");
    expect(models.reviewer.ref).toBe("groq/reviewer-a");
    expect(overrides).toEqual([
      { role: "drafter", chosen: "groq/drafter-b", wrote: "groq/drafter-a" },
    ]);
  });

  test("naming the model that already wrote the plan is not an override", () => {
    const { overrides } = resumedModels(recorded, recorded, { drafter: true, reviewer: true });
    expect(overrides).toEqual([]);
  });
});

describe("markFailed", () => {
  const setup = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-state-"));
    const paths = runPaths(dir, dir);
    await saveState(paths, {
      state: "reviewed",
      createdAt: "2026-10-17T00:00:00.000Z",
      task: "a task",
      mode: "plan",
      models: pair("groq/drafter", "groq/reviewer"),
    });
    return { dir, paths };
  };

  test("a broken run is recorded as failed, not left looking parked", async () => {
    const { dir, paths } = await setup();
    try {
      await markFailed(paths, new Error("opencode run exited 1"));
      const state = await loadState(paths);
      expect(state.state).toBe("failed");
      expect(state.error).toContain("opencode run exited 1");
      // The rest of the record survives, so `adv status` can still say what it was.
      expect(state.task).toBe("a task");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marking a failed run that cannot be read never masks the original error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-state-"));
    try {
      const paths = runPaths(dir, path.join(dir, "gone"));
      await expect(markFailed(paths, new Error("first"))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("decisions.md — append-only, last entry wins", () => {
  const setup = async (content: string) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "adv-decisions-"));
    await mkdir(path.join(repo, ".adv"), { recursive: true });
    await writeFile(path.join(repo, ".adv", "decisions.md"), content);
    return repo;
  };

  test("a superseded entry leaves the feed but stays on disk", async () => {
    const repo = await setup(
      "# Settled decisions\n\n" +
        "prose a human wrote, which is not an entry\n\n" +
        "- 2026-10-01T00:00:00.000Z J1: where to store counters -> **redis**\n" +
        "- 2026-10-02T00:00:00.000Z J1: where to store counters -> **in-process** (supersedes the earlier entry for J1)\n" +
        "- 2026-10-01T00:00:00.000Z J2: what counts as a series -> **scripted only**\n",
    );
    try {
      const feed = await readDecisions(repo);
      expect(feed).toContain("prose a human wrote"); // untouched: not an entry
      expect(feed).toContain("**in-process**"); // the newest entry for J1
      expect(feed).not.toContain("**redis**"); // superseded: out of the feed
      expect(feed).toContain("**scripted only**"); // a different id is untouched
      const disk = await readFile(path.join(repo, ".adv", "decisions.md"), "utf8");
      expect(disk).toContain("**redis**"); // the file is append-only
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a reopened marker un-settles the id entirely, so the next draft may argue it", async () => {
    const repo = await setup(
      "# Settled decisions\n\n" +
        "- 2026-10-01T00:00:00.000Z J1: where to store counters -> **redis**\n" +
        "- 2026-10-02T00:00:00.000Z J1: where to store counters -> **reopened** (the earlier entry for J1 no longer stands)\n",
    );
    try {
      const feed = await readDecisions(repo);
      expect(feed).not.toContain("redis");
      expect(feed).not.toContain("reopened");
      expect(feed).toContain("# Settled decisions"); // the header survives
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a file with no entries in the tool's format is fed through whole", async () => {
    const repo = await setup("# Settled decisions\n\nnothing yet, and some human prose\n");
    try {
      expect(await readDecisions(repo)).toBe(
        "# Settled decisions\n\nnothing yet, and some human prose\n",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("appendDecisions writes the supersede marker and leaves the old line alone", async () => {
    const repo = await setup(
      "# Settled decisions\n\n- 2026-10-01T00:00:00.000Z J1: where to store counters -> **redis**\n",
    );
    try {
      await appendDecisions(repo, [
        {
          id: "J1",
          text: "where to store counters",
          choice: "in-process",
          note: "(supersedes the earlier entry for J1)",
        },
      ]);
      const file = await readFile(path.join(repo, ".adv", "decisions.md"), "utf8");
      expect(file).toContain("**redis**");
      expect(file).toContain(
        "J1: where to store counters -> **in-process** (supersedes the earlier entry for J1)",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("appendDecisions is a no-op without a file: answer mode never creates one", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "adv-decisions-"));
    try {
      await appendDecisions(repo, [{ id: "J1", text: "x", choice: "y" }]);
      const { stat } = await import("node:fs/promises");
      await expect(stat(path.join(repo, ".adv", "decisions.md"))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("rotateGate", () => {
  const gate = { decisions: [{ id: "J1", choice: "redis" }], findings: [] };

  test("the current answers become gate.prev.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-rotate-"));
    const paths = runPaths(dir, dir);
    try {
      await writeFile(paths.gate, JSON.stringify(gate));
      await rotateGate(paths);
      expect(await readFile(paths.gatePrev, "utf8")).toBe(JSON.stringify(gate));
      await expect(readFile(paths.gate, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing gate file is not an error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-rotate-"));
    const paths = runPaths(dir, dir);
    try {
      await expect(rotateGate(paths)).resolves.toBeUndefined();
      const { stat } = await import("node:fs/promises");
      await expect(stat(paths.gatePrev)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A readable run state, for the store tests below. */
const runState = (over: Record<string, unknown> = {}) => ({
  state: "done",
  createdAt: "2026-10-17T12:00:00.000Z",
  task: "what is the meaning of life?",
  mode: "answer",
  models: pair("groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"),
  ...over,
});

/** Put a run with this name in this bucket, without going through a model. */
const writeRun = async (bucket: string, name: string, s: object) => {
  const run = path.join(bucket, name);
  await mkdir(run, { recursive: true });
  await writeFile(path.join(run, "state.json"), JSON.stringify(s));
};

describe("listRuns", () => {
  test("lists every recorded run, newest first, with its state and task", async () => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-listruns-"));
    const saved = process.env["XDG_DATA_HOME"];
    const repo = path.join(xdg, "repo");
    await mkdir(repo, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      const base = runsDir(repo);
      await writeRun(base, "2026-10-17T10-00-00", runState({ state: "gated", task: "earlier" }));
      await writeRun(base, "2026-10-17T12-03-36", runState());
      await writeRun(base, "2026-10-17T11-00-00", runState({ state: "failed", task: "middle" }));

      const list = await listRuns(repo);
      expect(list.map((r) => r.name)).toEqual([
        "2026-10-17T12-03-36",
        "2026-10-17T11-00-00",
        "2026-10-17T10-00-00",
      ]);
      // The pair comes along: every run records the two models it ran with, and
      // the pair screen offers them without reopening anything.
      expect(list[0]).toEqual({
        name: "2026-10-17T12-03-36",
        dir: path.join(base, "2026-10-17T12-03-36"),
        state: "done",
        task: "what is the meaning of life?",
        mode: "answer",
        createdAt: "2026-10-17T12:00:00.000Z",
        models: pair("groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"),
      });
      expect(list[1]?.state).toBe("failed");
      expect(list[2]?.state).toBe("gated");
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  });

  test("skips a directory whose state does not read", async () => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-listruns-"));
    const saved = process.env["XDG_DATA_HOME"];
    const repo = path.join(xdg, "repo");
    await mkdir(repo, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      const base = runsDir(repo);
      await writeRun(base, "2026-10-17T10-00-00", { not: "a state" });
      await writeRun(base, "2026-10-17T11-00-00", runState());

      const list = await listRuns(repo);
      expect(list.map((r) => r.name)).toEqual(["2026-10-17T11-00-00"]);
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  });

  test("a question is visible from a repository it was never asked in", async () => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-listruns-"));
    const saved = process.env["XDG_DATA_HOME"];
    const mine = path.join(xdg, "mine");
    const other = path.join(xdg, "other");
    await mkdir(mine, { recursive: true });
    await mkdir(other, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      // Asked in a different directory: it belongs to no repository.
      await writeRun(answersDir(), "2026-10-17T12-00-00", runState());
      await writeRun(runsDir(mine), "2026-10-17T11-00-00", runState({ mode: "plan", task: "my task" }));

      const list = await listRuns(mine);
      expect(list.map((r) => r.name)).toEqual(["2026-10-17T12-00-00", "2026-10-17T11-00-00"]);
      expect(list.map((r) => r.mode)).toEqual(["answer", "plan"]);
      // Each row carries its own directory, so opening one cannot open the other.
      expect(list[0]?.dir).toBe(path.join(answersDir(), "2026-10-17T12-00-00"));
      expect(list[1]?.dir).toBe(path.join(runsDir(mine), "2026-10-17T11-00-00"));

      // …and another repository sees the question but not my task.
      expect((await listRuns(other)).map((r) => r.name)).toEqual(["2026-10-17T12-00-00"]);
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  });

  test("an empty store lists nothing", async () => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-listruns-"));
    const saved = process.env["XDG_DATA_HOME"];
    const repo = path.join(xdg, "repo");
    await mkdir(repo, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      await expect(listRuns(repo)).resolves.toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe("where a run is filed", () => {
  const withStore = async (run: (repo: string) => Promise<void>) => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-store-"));
    const saved = process.env["XDG_DATA_HOME"];
    const repo = path.join(xdg, "repo");
    await mkdir(repo, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      await run(repo);
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  };

  test("a question is filed under the questions, a task under the repository", async () => {
    await withStore(async (repo) => {
      const question = await createRun(
        repo,
        "what is the meaning of life?",
        pair("groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"),
        "answer",
      );
      // The directory it was asked in must not appear anywhere in the path.
      expect(question.dir.startsWith(answersDir())).toBe(true);
      expect(question.dir).not.toContain(repoKey(repo));

      const task = await createRun(
        repo,
        "add a limiter",
        pair("groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"),
        "plan",
      );
      expect(task.dir.startsWith(runsDir(repo))).toBe(true);
    });
  });

  test("the latest run is the latest across both", async () => {
    await withStore(async (repo) => {
      await writeRun(runsDir(repo), "2026-10-17T11-00-00", runState({ mode: "plan" }));
      await writeRun(answersDir(), "2026-10-17T12-00-00", runState());
      expect(await latestRun(repo)).toBe(path.join(answersDir(), "2026-10-17T12-00-00"));

      await writeRun(runsDir(repo), "2026-10-17T13-00-00", runState({ mode: "plan" }));
      expect(await latestRun(repo)).toBe(path.join(runsDir(repo), "2026-10-17T13-00-00"));
    });
  });

  test("a bare name finds a question, and prefers the repository's own run", async () => {
    await withStore(async (repo) => {
      expect(findRunDir(repo, "2026-10-17T12-00-00")).toBeNull();

      await writeRun(answersDir(), "2026-10-17T12-00-00", runState());
      expect(findRunDir(repo, "2026-10-17T12-00-00")).toBe(
        path.join(answersDir(), "2026-10-17T12-00-00"),
      );

      // Only the same second in both buckets is ambiguous, and then the
      // repository's own run is the one meant.
      await writeRun(runsDir(repo), "2026-10-17T12-00-00", runState({ mode: "plan" }));
      expect(findRunDir(repo, "2026-10-17T12-00-00")).toBe(
        path.join(runsDir(repo), "2026-10-17T12-00-00"),
      );
    });
  });
});

describe("deleting runs", () => {
  const withStore = async (run: (repo: string, xdg: string) => Promise<void>) => {
    const xdg = await mkdtemp(path.join(os.tmpdir(), "adv-delete-"));
    const saved = process.env["XDG_DATA_HOME"];
    const repo = path.join(xdg, "repo");
    await mkdir(repo, { recursive: true });
    process.env["XDG_DATA_HOME"] = xdg;
    try {
      await run(repo, xdg);
    } finally {
      if (saved === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved;
      await rm(xdg, { recursive: true, force: true });
    }
  };

  test("removes a run, and everything in its directory", async () => {
    await withStore(async (repo) => {
      const run = path.join(runsDir(repo), "2026-10-17T12-00-00");
      await writeRun(runsDir(repo), "2026-10-17T12-00-00", runState());
      await writeFile(path.join(run, "plan.v2.md"), "the answer\n");

      const result = await deleteRuns([run]);
      expect(result.deleted).toEqual([run]);
      expect(result.failed).toEqual([]);
      expect(existsSync(run)).toBe(false);
    });
  });

  test("refuses anything outside the store, and says so", async () => {
    await withStore(async (repo) => {
      // The guard is the whole point: a bug passing a repository path, or the
      // store root itself, must not reach `rm`.
      const victim = path.join(repo, "src");
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "important.ts"), "export const x = 1;\n");

      const result = await deleteRuns([victim, runsRoot(), path.join(repo, "..", "elsewhere")]);
      expect(result.deleted).toEqual([]);
      expect(result.failed.every((f) => f.error.includes("not inside the run store"))).toBe(true);
      expect(existsSync(path.join(victim, "important.ts"))).toBe(true);
    });
  });

  test("a run that is already gone is not a failure", async () => {
    await withStore(async (repo) => {
      const gone = path.join(runsDir(repo), "2026-10-17T12-00-00");
      const result = await deleteRuns([gone]);
      expect(result.failed).toEqual([]);
      expect(result.deleted).toEqual([gone]);
    });
  });

  test("says what will go, split by where it is filed", async () => {
    await withStore(async (repo) => {
      await writeRun(runsDir(repo), "2026-10-17T11-00-00", runState({ mode: "plan", task: "a task" }));
      // A question of this directory filed before questions had their own bucket.
      await writeRun(runsDir(repo), "2026-10-17T11-30-00", runState({ task: "an old question" }));
      await writeRun(answersDir(), "2026-10-17T12-00-00", runState({ task: "asked elsewhere" }));

      const summary = deletionSummary(await listRuns(repo), repo);
      expect({ here: summary.here, elsewhere: summary.elsewhere }).toEqual({ here: 2, elsewhere: 1 });
      // The split is by bucket, and each line still names what the run is.
      expect(summary.lines[0]?.text).toContain("question · asked elsewhere");
      expect(summary.lines.find((l) => l.text.includes("an old question"))?.text).toContain(
        "question",
      );
      expect(summary.lines.find((l) => l.text.includes("a task"))?.text).toContain("task");
    });
  });

  test("a multi-line task stays on one line", async () => {
    await withStore(async (repo) => {
      await writeRun(
        runsDir(repo),
        "2026-10-17T12-00-00",
        runState({ task: "first line\nsecond line\tthird" }),
      );
      const summary = deletionSummary(await listRuns(repo), repo);
      expect(summary.lines[0]?.text).toContain("first line second line third");
    });
  });
});

describe("olderThanCutoff", () => {
  const now = new Date("2026-10-18T12:00:00.000Z");

  test("relative spans: days, hours, minutes", () => {
    expect(olderThanCutoff("30d", now)?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(olderThanCutoff("12h", now)?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(olderThanCutoff("45m", now)?.toISOString()).toBe("2026-10-18T11:15:00.000Z");
  });

  test("a date, at midnight UTC", () => {
    expect(olderThanCutoff("2026-10-01", now)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(olderThanCutoff("2026-10-01T09:30:00.000Z", now)?.toISOString()).toBe(
      "2026-10-01T09:30:00.000Z",
    );
  });

  test("anything else is null, so the caller can complain instead of deleting nothing", () => {
    for (const bad of ["", "30", "d", "30 w", "yesterday", "2026-13-99", "-1d"]) {
      expect(olderThanCutoff(bad, now)).toBeNull();
    }
  });
});
