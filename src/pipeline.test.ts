import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadState, runPaths, saveState } from "./orchestrator.ts";
import { formatCallLine, loadCouncil } from "./pipeline.ts";

describe("formatCallLine", () => {
  test("a take reads as take written, with seconds and cost", () => {
    expect(
      formatCallLine({
        kind: "take",
        step: "take",
        retry: false,
        ms: 10123,
        usage: { cost: 0.000348, costKnown: true },
      }),
    ).toBe("take written — 10.1s, $0.000348");
  });

  test("a synthesis reads as synthesis written", () => {
    expect(
      formatCallLine({
        kind: "synthesis",
        step: "synthesis",
        retry: false,
        ms: 18600,
        usage: { cost: 0.000443, costKnown: true },
      }),
    ).toBe("synthesis written — 18.6s, $0.000443");
  });

  test("a retry is marked, and an unreported cost says so", () => {
    expect(
      formatCallLine({
        kind: "take",
        step: "take",
        retry: true,
        ms: 5000,
        usage: { cost: 0, costKnown: false },
      }),
    ).toBe("take written (retry) — 5.0s, cost not reported");
  });

  test("an unknown step keeps its names instead of guessing", () => {
    expect(
      formatCallLine({
        kind: "take",
        step: "other",
        retry: false,
        ms: 1000,
        usage: { cost: 0, costKnown: true },
      }),
    ).toBe("take/other — 1.0s, $0.000000");
  });
});

describe("loadCouncil log", () => {
  const models = {
    drafter: { ref: "lead/a", family: "lead" },
    reviewer: { ref: "peer/b", family: "peer" },
  };

  const setup = async (log: string[] | null) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-log-"));
    const paths = runPaths(dir, dir);
    await saveState(paths, {
      state: "done",
      createdAt: "2026-10-17T00:00:00.000Z",
      task: "a task",
      mode: "plan",
      models,
    });
    await writeFile(paths.take1, "Take one.\n");
    await writeFile(paths.take2, "Take two.\n");
    await writeFile(paths.final, "The answer.\n");
    await writeFile(paths.diff, "");
    if (log !== null) await writeFile(paths.log, `${log.join("\n")}\n`);
    return { dir, paths };
  };

  test("reads the run log, one line each", async () => {
    const lines = ["repository · lead/a + peer/b (parallel takes)", "take written — 1.0s, $0.000001"];
    const { dir, paths } = await setup(lines);
    try {
      const c = await loadCouncil(paths);
      expect(c.log).toEqual(lines);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a run recorded before the log file reads as an empty log", async () => {
    const { dir, paths } = await setup(null);
    try {
      const c = await loadCouncil(paths);
      expect(c.log).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the log path lives inside the run directory", async () => {
    const { dir, paths } = await setup(["a line"]);
    try {
      expect(paths.log).toBe(path.join(paths.dir, "log.md"));
      expect(await readFile(paths.log, "utf8")).toContain("a line");
      // Deleting the directory removes the log with it: nothing extra to clean.
      await rm(dir, { recursive: true, force: true });
      await expect(readFile(paths.log, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadState still reads a state written without a log file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adv-logstate-"));
    try {
      const paths = runPaths(dir, dir);
      await mkdir(dir, { recursive: true });
      await saveState(paths, {
        state: "done",
        createdAt: "2026-10-17T00:00:00.000Z",
        task: "a task",
        mode: "plan",
        models,
      });
      expect((await loadState(paths)).task).toBe("a task");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
