import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  answersDir,
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
  runPaths,
  runsDir,
  saveState,
} from "./orchestrator.ts";

const pair = (drafter: string, reviewer: string) => ({
  drafter: { ref: drafter, family: drafter.split("-")[0] ?? drafter },
  reviewer: { ref: reviewer, family: reviewer.split("-")[0] ?? reviewer },
});


describe("markFailed", () => {
  const setup = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-state-"));
    const paths = runPaths(dir, dir);
    await saveState(paths, {
      state: "taking",
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



describe("decisions.md", () => {
  test("a missing file reads as none yet, and a present file passes through", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "adv-decisions-"));
    try {
      expect(await readDecisions(repo)).toBe("(none yet)");
      await mkdir(path.join(repo, ".adv"), { recursive: true });
      await writeFile(path.join(repo, ".adv", "decisions.md"), "# Settled decisions\n\nmy note\n");
      expect(await readDecisions(repo)).toContain("my note");
    } finally {
      await rm(repo, { recursive: true, force: true });
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
      await writeRun(base, "2026-10-17T10-00-00", runState({ state: "taking", task: "earlier" }));
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
      expect(list[2]?.state).toBe("taking");
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
      await writeFile(path.join(run, "final.md"), "the answer\n");

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
