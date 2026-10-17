import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendDecisions,
  loadState,
  markFailed,
  readDecisions,
  resumedModels,
  rotateGate,
  runPaths,
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
