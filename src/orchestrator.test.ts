import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadState, markFailed, resumedModels, runPaths, saveState } from "./orchestrator.ts";

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
