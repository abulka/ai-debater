import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunState } from "./contracts.ts";

/** The human's own files: criteria, settled decisions, model choice. Per repo. */
export const advDir = (repo: string) => path.join(repo, ".adv");

/**
 * Run artifacts live in one user-level store, never in the directory `adv` was
 * started in. Plan mode has a repository to write to, but answer mode does not —
 * and "no repository assumed" has to mean no repository written, or every
 * question drops a directory into wherever the human happened to be standing.
 * One rule for both modes is also one thing to remember.
 */
export const runsRoot = (): string => {
  const xdg = process.env["XDG_DATA_HOME"];
  const data = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(data, "adv", "runs");
};

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
    planV1: path.join(dir, "plan.v1.md"),
    claims: path.join(dir, "claims.json"),
    review: path.join(dir, "review.json"),
    gate: path.join(dir, "gate.json"),
    changelog: path.join(dir, "changelog.json"),
    planV2: path.join(dir, "plan.v2.md"),
    diff: path.join(dir, "diff.patch"),
    state: path.join(dir, "state.json"),
  };
}

export type Paths = ReturnType<typeof runPaths>;

export async function createRun(
  repo: string,
  task: string,
  models: RunState["models"],
  mode: RunState["mode"],
): Promise<Paths> {
  const dir = path.join(runsDir(repo), runStamp());
  await mkdir(dir, { recursive: true });
  const p = runPaths(repo, dir);
  await writeFile(p.task, `${task}\n`);
  await saveState(p, {
    state: "created",
    createdAt: new Date().toISOString(),
    task,
    mode,
    models,
  });
  return p;
}

export const saveState = async (p: Paths, state: RunState) =>
  writeJson(p.state, RunState.parse(state));

export const loadState = async (p: Paths): Promise<RunState> =>
  RunState.parse(await readJson(p.state));

/** The most recent run for this repository, if any. */
export async function latestRun(repo: string): Promise<string | null> {
  try {
    const entries = await readdir(runsDir(repo), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return dirs.length ? path.join(runsDir(repo), dirs[dirs.length - 1]!) : null;
  } catch {
    return null;
  }
}

export async function readCriteria(repo: string): Promise<{ text: string; found: boolean }> {
  try {
    return { text: await readFile(path.join(advDir(repo), "criteria.md"), "utf8"), found: true };
  } catch {
    return {
      text: "- (none supplied; use judgement sparingly and flag anything you had to assume)",
      found: false,
    };
  }
}

export async function readDecisions(repo: string): Promise<string> {
  try {
    return await readFile(path.join(advDir(repo), "decisions.md"), "utf8");
  } catch {
    return "(none yet)";
  }
}

/**
 * Freeze the human's gate answers into `decisions.md`, append-only.
 *
 * A no-op when there is no `decisions.md` to append to: that means the human
 * never ran `adv init` here, which in answer mode is the normal case. Creating
 * the file would be a write into a directory adv has no business writing to.
 */
export async function appendDecisions(
  repo: string,
  decisions: { id: string; text: string; choice: string }[],
): Promise<void> {
  if (decisions.length === 0) return;
  const file = path.join(advDir(repo), "decisions.md");
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === null) return;

  const stamp = new Date().toISOString();
  const lines = decisions.map((d) => `- ${stamp} ${d.id}: ${d.text} -> **${d.choice}**`);
  await writeFile(file, `\n${lines.join("\n")}\n`, { flag: "a" });
}
