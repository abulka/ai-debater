import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
    /** The gate's previous generation of answers, kept by `revise`'s rotation. */
    gatePrev: path.join(dir, "gate.prev.json"),
    changelog: path.join(dir, "changelog.json"),
    planV2: path.join(dir, "plan.v2.md"),
    diff: path.join(dir, "diff.patch"),
    audit: path.join(dir, "audit.json"),
    state: path.join(dir, "state.json"),
    /**
     * Written when the human copies the answer out of the TUI: the clipboard
     * can fail (no `pbcopy`, a remote terminal), and a path is a copy that
     * always works. Not written by a run, because a run makes no copy.
     */
    answer: path.join(dir, "answer.md"),
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

/**
 * Record that this run stopped because something broke.
 *
 * Never let this mask the original error: the reason the step failed is the
 * useful message, and the state file is only bookkeeping. A run that keeps its
 * earlier state after a failure is indistinguishable from one parked at the
 * gate — which is exactly the bug that left a run reading `created` with no
 * artifacts and no way to tell whether it was waiting or dead.
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

export type ModelPair = {
  drafter: { ref: string; family: string };
  reviewer: { ref: string; family: string };
};

/**
 * Which models a resumed run uses.
 *
 * The rebuttal is written by the drafter, so a resumed run must use the models
 * recorded in `state.json`, not whatever `.adv/config.json` says today. These
 * diverge the moment someone passes `--drafter`, changes the config, or picks a
 * new model in the TUI — and the failure is silent: a different model rewrites
 * a plan it did not write, and the artifacts look normal.
 *
 * An explicit flag still wins, because a human naming a model is an instruction,
 * not an accident. It is reported so the inconsistency is on the record.
 */
export function resumedModels(
  recorded: ModelPair,
  configured: ModelPair,
  explicit: { drafter: boolean; reviewer: boolean },
): {
  models: ModelPair;
  overrides: { role: "drafter" | "reviewer"; chosen: string; wrote: string }[];
} {
  const models: ModelPair = {
    drafter: explicit.drafter ? configured.drafter : recorded.drafter,
    reviewer: explicit.reviewer ? configured.reviewer : recorded.reviewer,
  };
  const overrides = (["drafter", "reviewer"] as const)
    .filter((role) => explicit[role] && models[role].ref !== recorded[role].ref)
    .map((role) => ({ role, chosen: models[role].ref, wrote: recorded[role].ref }));
  return { models, overrides };
}

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

export interface RunSummary {
  /** The run directory's name: its timestamp stamp. */
  name: string;
  state: RunState["state"];
  task: string;
  mode: RunState["mode"];
}

/**
 * Every recorded run for this repository, newest first — the list the TUI's
 * past-runs screen renders. Directories without a readable `state.json`
 * (a half-written one) are skipped rather than shown as broken rows.
 */
export async function listRuns(repo: string): Promise<RunSummary[]> {
  let entries;
  try {
    entries = await readdir(runsDir(repo), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  const out: RunSummary[] = [];
  for (const name of names) {
    try {
      const state = await loadState(runPaths(repo, path.join(runsDir(repo), name)));
      out.push({ name, state: state.state, task: state.task, mode: state.mode });
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
 * A settled-decisions entry in the exact shape `appendDecisions` writes:
 * `- <stamp> <id>: <text> -> **<choice>**`, optionally with a trailing
 * parenthetical — the supersede / reopened markers.
 */
const DECISION_ENTRY = /^- \S+ ([VJE]\d+): (.+) -> \*\*([^*]+)\*\*(?: \(.*\))?\s*$/;

/** A marker, not a settlement: the human re-opened the call at a later gate. */
const REOPENED = /^(reopened|superseded)$/i;

/**
 * The feed the draft prompt gets from `decisions.md`: the last entry per id.
 *
 * The file is append-only — `revise` supersedes an old entry by appending a new
 * one, and both lines stay on disk — but the file's own header says "models
 * treat every entry as a closed question", and a *superseded* entry is not
 * closed. The newest line per id is the settlement; earlier lines for the same
 * id leave the feed, and a `reopened` marker un-settles the id entirely so the
 * next draft may argue it again.
 *
 * Non-entry lines — the header, prose a human appended — pass through
 * untouched: the file is the human's, and only lines in the tool's own format
 * are the tool's to deduplicate.
 */
export async function readDecisions(repo: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path.join(advDir(repo), "decisions.md"), "utf8");
  } catch {
    return "(none yet)";
  }

  const lines = text.split("\n");
  const newest = new Map<string, number>();
  const reopened = new Set<string>();
  lines.forEach((line, i) => {
    const m = DECISION_ENTRY.exec(line);
    if (!m) return;
    const id = m[1]!;
    if (REOPENED.test(m[3]!)) reopened.add(id);
    newest.set(id, i);
  });

  if (newest.size === 0) return text;

  let dropped = false;
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = DECISION_ENTRY.exec(line);
    if (!m) {
      out.push(line);
      return;
    }
    const id = m[1]!;
    if (reopened.has(id) || newest.get(id) !== i) {
      // Superseded, or re-opened: it stays on disk, it leaves the feed.
      dropped = true;
      return;
    }
    out.push(line);
  });
  return dropped ? out.join("\n") : text;
}

export interface DecisionEntry {
  id: string;
  text: string;
  choice: string;
  /** A trailing parenthetical — `revise` uses it for the supersede marker. */
  note?: string;
}

/**
 * Freeze the human's gate answers into `decisions.md`, append-only.
 *
 * A no-op when there is no `decisions.md` to append to: that means the human
 * never ran `adv init` here, which in answer mode is the normal case. Creating
 * the file would be a write into a directory adv has no business writing to.
 */
export async function appendDecisions(repo: string, decisions: DecisionEntry[]): Promise<void> {
  if (decisions.length === 0) return;
  const file = path.join(advDir(repo), "decisions.md");
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === null) return;

  const stamp = new Date().toISOString();
  const lines = decisions.map(
    (d) => `- ${stamp} ${d.id}: ${d.text} -> **${d.choice}**${d.note ? ` ${d.note}` : ""}`,
  );
  await writeFile(file, `\n${lines.join("\n")}\n`, { flag: "a" });
}

/**
 * Move the gate's answers one generation back: `gate.json` becomes
 * `gate.prev.json`. `revise` asks the gate again, and the first answers must
 * survive the asking — the comparison that decides whether anything moved needs
 * them, and a human who wants the old view can read the file.
 *
 * One level of history: a third revision overwrites the second's backup.
 * Missing gate file (a hand-mangled run) is not an error.
 */
export async function rotateGate(p: Paths): Promise<void> {
  await rename(p.gate, p.gatePrev).catch(() => {
    /* nothing to rotate */
  });
}
