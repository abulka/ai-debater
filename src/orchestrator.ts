import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunState } from "./contracts.ts";

export const advDir = (repo: string) => path.join(repo, ".adv");
export const runsDir = (repo: string) => path.join(advDir(repo), "runs");

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
): Promise<Paths> {
  const dir = path.join(runsDir(repo), runStamp());
  await mkdir(dir, { recursive: true });
  const p = runPaths(repo, dir);
  await writeFile(p.task, `${task}\n`);
  await saveState(p, {
    state: "created",
    createdAt: new Date().toISOString(),
    task,
    models,
  });
  return p;
}

export const saveState = async (p: Paths, state: RunState) =>
  writeJson(p.state, RunState.parse(state));

export const loadState = async (p: Paths): Promise<RunState> =>
  RunState.parse(await readJson(p.state));

/** The most recently modified run under `.adv/runs`, if any. */
export async function latestRun(repo: string): Promise<string | null> {
  try {
    const entries = await readdir(runsDir(repo), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return dirs.length ? path.join(runsDir(repo), dirs[dirs.length - 1]!) : null;
  } catch {
    return null;
  }
}

export async function readCriteria(repo: string): Promise<string> {
  try {
    return await readFile(path.join(advDir(repo), "criteria.md"), "utf8");
  } catch {
    return "- (none supplied; use judgement sparingly and flag anything you had to assume)";
  }
}

export async function readDecisions(repo: string): Promise<string> {
  try {
    return await readFile(path.join(advDir(repo), "decisions.md"), "utf8");
  } catch {
    return "(none yet)";
  }
}

/** Freeze the human's gate answers into `decisions.md`, append-only. */
export async function appendDecisions(
  repo: string,
  decisions: { id: string; text: string; choice: string }[],
): Promise<void> {
  if (decisions.length === 0) return;
  const stamp = new Date().toISOString();
  const lines = decisions.map((d) => `- ${stamp} ${d.id}: ${d.text} -> **${d.choice}**`);
  await writeFile(
    path.join(advDir(repo), "decisions.md"),
    `\n${lines.join("\n")}\n`,
    { flag: "a" },
  );
}
