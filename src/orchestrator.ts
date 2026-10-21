import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunState } from "./contracts.ts";
import { displayTaskOf } from "./continue.ts";
import type { ModelRef } from "./runner.ts";

/** The human's own files: criteria and settled decisions. Per repo, opt-in via `adv init`. */
export const advDir = (repo: string) => path.join(repo, ".adv");

/**
 * Run artifacts live in one user-level store, never in the directory `adv` was
 * started in. Plan mode has a repository to write to, but answer mode does not —
 * and "no repository assumed" has to mean no repository written, or every
 * question drops a directory into wherever the human happened to be standing.
 *
 * The store has two kinds of bucket: one per repository, and one for questions
 * (`answersDir`). An earlier version filed both modes under the repository,
 * "one rule for both modes" — which cost a question its identity (its directory
 * named a repository it never read) and hid it from every other directory.
 */
export const advDataRoot = (): string => {
  const xdg = process.env["XDG_DATA_HOME"];
  const data = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(data, "adv");
};

export const runsRoot = (): string => path.join(advDataRoot(), "runs");

/**
 * One directory per repository: a readable name plus a short hash of the
 * absolute path, so two checkouts of `api/` never collide.
 */
export const repoKey = (repo: string): string => {
  const abs = path.resolve(repo);
  const slug = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, "-") || "root";
  return `${slug}-${createHash("sha1").update(abs).digest("hex").slice(0, 8)}`;
};

/** Where this repository's runs are kept. */
export const runsDir = (repo: string) => path.join(runsRoot(), repoKey(repo));

/**
 * Questions live in one bucket, not under a repository.
 *
 * Plan mode has a repository to file under; a general question does not. Filing
 * it under whichever directory the human happened to start `adv` in cost two
 * things: the run directory named a repository the question never read, and the
 * run was then invisible from anywhere else — not in the past-runs list, not by
 * name — because both resolution and listing looked only in that one bucket.
 * One bucket for questions, wherever they were asked from.
 *
 * It cannot collide with a repository's bucket: those always end in `-<hash>`
 * (`api-1f0c2a3b`), this one never does.
 */
export const answersDir = () => path.join(runsRoot(), "answers");

/** Where a run of this mode is filed. */
export const runBucket = (repo: string, mode: RunState["mode"]) =>
  mode === "answer" ? answersDir() : runsDir(repo);

/** Absolute run paths, with `~` for anything under the home directory. */
export const displayPath = (p: string): string => {
  const home = os.homedir();
  return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
};

export const runStamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

export const writeJson = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export function runPaths(repo: string, dir: string) {
  return {
    dir,
    task: path.join(dir, "task.md"),
    /** Council takes: each model's independent answer. take.1.md is the lead's. */
    take1: path.join(dir, "take.1.md"),
    take2: path.join(dir, "take.2.md"),
    take3: path.join(dir, "take.3.md"),
    /** The synthesised final answer. */
    final: path.join(dir, "final.md"),
    diff: path.join(dir, "diff.patch"),
    /**
     * The run's own log: subject, takes, timings, warnings — one line each,
     * appended as the run happens. Read by the result screen's info panel and
     * the whole-result export; removed with the directory, like everything else.
     */
    log: path.join(dir, "log.md"),
    state: path.join(dir, "state.json"),
    /**
     * Written when the human copies the answer out of the TUI: the clipboard
     * can fail (no `pbcopy`, a remote terminal), and a path is a copy that
     * always works. Not written by a run, because a run makes no copy.
     */
    answer: path.join(dir, "answer.md"),
    /** The same, with the run's commentary: what happened, what changed. */
    result: path.join(dir, "result.md"),
  };
}

export type Paths = ReturnType<typeof runPaths>;

export async function createRun(
  repo: string,
  task: string,
  models: RunState["models"],
  mode: RunState["mode"],
  opts?: { parent?: { name: string; dir: string } },
): Promise<Paths> {
  const dir = path.join(runBucket(repo, mode), runStamp());
  await mkdir(dir, { recursive: true });
  const p = runPaths(repo, dir);
  await writeFile(p.task, `${task}\n`);
  await saveState(p, {
    state: "created",
    createdAt: new Date().toISOString(),
    task,
    mode,
    models,
    ...(opts?.parent ? { parent: opts.parent } : {}),
  });
  return p;
}

export const saveState = async (p: Paths, state: RunState) =>
  writeJson(p.state, RunState.parse(state));

export const loadState = async (p: Paths): Promise<RunState> =>
  RunState.parse(await readJson(p.state));

/**
 * Record that this run stopped because something broke.
 *
 * Never let this mask the original error: the reason the step failed is the
 * useful message, and the state file is only bookkeeping.
 */
export async function markFailed(p: Paths, err: unknown): Promise<void> {
  try {
    const current = await loadState(p);
    const error = err instanceof Error ? err.message : String(err);
    await saveState(p, { ...current, state: "failed", error: error.slice(0, 2000) });
  } catch {
    /* the original error is the one worth reporting */
  }
}

/**
 * The most recent run this repository can see — its own, or a question asked
 * from anywhere. Returns the run's directory, which callers pass to `runPaths`.
 */
export async function latestRun(repo: string): Promise<string | null> {
  const runs = await listRuns(repo);
  return runs[0]?.dir ?? null;
}

/**
 * The directory of a run named by its timestamp.
 *
 * This repository's own runs first, then the questions: a bare name can only
 * exist in both if a task and a question were recorded in the same second, and
 * then the repository's own run is the one meant. The TUI's picker does not go
 * through here — each row carries its own directory, so there is nothing to
 * disambiguate.
 */
export function findRunDir(repo: string, name: string): string | null {
  for (const bucket of [runsDir(repo), answersDir()]) {
    const dir = path.join(bucket, name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Remove runs.
 *
 * The one operation here that cannot be undone, so it is guarded twice: nothing
 * outside the store is ever removed — a path that is not under `runsRoot()` is
 * refused rather than handed to `rm` — and a missing directory is not an error,
 * because deleting a run twice should not fail the second time.
 *
 * A run's artefacts are all inside the store, so this never touches a
 * repository: not the source tree, not `.adv/`.
 */
export async function deleteRuns(
  dirs: string[],
): Promise<{ deleted: string[]; failed: { dir: string; error: string }[] }> {
  const root = runsRoot();
  const deleted: string[] = [];
  const failed: { dir: string; error: string }[] = [];

  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (abs === root || !abs.startsWith(`${root}${path.sep}`)) {
      failed.push({ dir, error: "refused: not inside the run store" });
      continue;
    }
    try {
      await rm(abs, { recursive: true, force: true });
      deleted.push(abs);
    } catch (error) {
      failed.push({ dir: abs, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}

/** What a deletion will remove, phrased once for both front ends. */
export interface DeletionSummary {
  /** Runs filed under this repository's bucket. */
  here: number;
  /**
   * Runs under the questions bucket — asked from any directory, which is why
   * the count is stated before anything is removed.
   */
  elsewhere: number;
  /** One line per run: name, state, kind and the start of the task. */
  lines: { dir: string; text: string }[];
}

/**
 * Describe a deletion without performing it.
 *
 * Split by *bucket*, not by mode: what matters before a delete is the blast
 * radius, and a pre-existing question filed under a repository is still inside
 * that repository's bucket. Each line names the run's kind, so the split never
 * misreports what a run is.
 */
export function deletionSummary(runs: RunSummary[], repo: string): DeletionSummary {
  const here = `${runsDir(repo)}${path.sep}`;
  const mine = runs.filter((run) => run.dir.startsWith(here));
  return {
    here: mine.length,
    elsewhere: runs.length - mine.length,
    lines: runs.map((run) => ({
      dir: run.dir,
      text:
        `${run.name}  ${run.state.padEnd(8)} ` +
        `${run.mode === "answer" ? "question" : "task    "} · ` +
        displayTaskOf(run.task),
    })),
  };
}

/**
 * The instant a run must predate to be removed by `--older-than`.
 *
 * `30d`, `12h`, `45m`, or a date (`2026-10-01`, or a full ISO stamp). Null means
 * the argument was not one of those, and the caller says so instead of deleting
 * nothing quietly.
 */
export function olderThanCutoff(spec: string, now = new Date()): Date | null {
  const relative = /^(\d+)\s*([dhm])$/.exec(spec.trim());
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2] === "d" ? 86_400_000 : relative[2] === "h" ? 3_600_000 : 60_000;
    return new Date(now.getTime() - count * unit);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(spec.trim())) return null;
  const date = new Date(spec.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface RunSummary {
  /** The run directory's name: its timestamp stamp. */
  name: string;
  /**
   * The run's own directory. Carried so a caller opens the run it was shown
   * rather than one that happens to share its timestamp in another bucket.
   */
  dir: string;
  state: RunState["state"];
  task: string;
  mode: RunState["mode"];
  /** When the run was created, ISO. Filtering by age is the CLI's business. */
  createdAt: string;
  /**
   * The pair the run used, so callers can offer "the pair that run ran with"
   * without reopening it. Optional because a summary must be renderable from a
   * state that has no models at all — older records, or a hand-written one — and
   * `recentPairs` skips those rather than failing.
   */
  models?: { drafter: ModelRef; reviewer: ModelRef; peer?: ModelRef | null };
  /** The run this one continues, when it continues one. Display only. */
  parent?: { name: string; dir: string };
}

/**
 * Every run this repository can see, newest first — the list the TUI's
 * past-runs screen renders. That is its own runs plus every question, because a
 * question belongs to no repository and would otherwise be reachable only from
 * the directory it was asked in. Directories without a readable `state.json`
 * (a half-written one) are skipped rather than shown as broken rows.
 */
export async function listRuns(repo: string): Promise<RunSummary[]> {
  const found: { name: string; dir: string }[] = [];
  for (const bucket of [runsDir(repo), answersDir()]) {
    let entries;
    try {
      entries = await readdir(bucket, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) found.push({ name: entry.name, dir: path.join(bucket, entry.name) });
    }
  }
  // Timestamps sort as names: newest first, across both buckets.
  found.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

  const out: RunSummary[] = [];
  for (const { name, dir } of found) {
    try {
      const state = await loadState(runPaths(repo, dir));
      out.push({
        name,
        dir,
        state: state.state,
        task: state.task,
        mode: state.mode,
        createdAt: state.createdAt,
        ...(state.models ? { models: state.models } : {}),
        ...(state.parent ? { parent: state.parent } : {}),
      });
    } catch {
      /* no readable state — not a run worth listing */
    }
  }
  return out;
}

/**
 * What the models get when there is no criteria file. Answer mode always uses
 * this: a general question has no repository, and the criteria in whatever
 * directory the human ran from are not its criteria.
 */
export const NO_CRITERIA =
  "- (none supplied; use judgement sparingly and flag anything you had to assume)";

export async function readCriteria(repo: string): Promise<{ text: string; found: boolean }> {
  try {
    return { text: await readFile(path.join(advDir(repo), "criteria.md"), "utf8"), found: true };
  } catch {
    return { text: NO_CRITERIA, found: false };
  }
}

/**
 * The feed the take prompt gets from `decisions.md`. The file is the human's,
 * written by hand or via `adv init`; it passes through untouched.
 */
export async function readDecisions(repo: string): Promise<string> {
  try {
    return await readFile(path.join(advDir(repo), "decisions.md"), "utf8");
  } catch {
    return "(none yet)";
  }
}
