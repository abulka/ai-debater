import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unifiedDiff } from "./diff.ts";
import {
  createRun,
  loadState,
  markFailed,
  saveState,
  type Paths,
} from "./orchestrator.ts";
import { OpencodeRunRunner, type CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";
import { repairUrls } from "./urls.ts";
import { nameTakesInLearned, splitLearned } from "./prompts.ts";

export interface Models {
  drafter: ModelRef;
  reviewer: ModelRef;
  peer?: ModelRef | null;
}

/**
 * How the pipeline describes itself while it runs.
 *
 * `onCall` is machine-shaped (kind, step, ms, cost). `onNote` is a sentence a
 * human can read: what is happening now, and what came back. Both front ends
 * pass the same reporting object, so the CLI and the TUI cannot tell two
 * different stories about one run.
 */
export interface Reporting {
  onCall?: CallHook;
  onNote?: (text: string) => void;
}

export interface CouncilTake {
  index: number;
  model: ModelRef;
  text: string;
}

export interface CouncilHead {
  paths: Paths;
  takes: CouncilTake[];
  urlRepairs: { before: string; after: string }[];
}

export interface CouncilTail {
  final: string;
  learned: string;
  patch: string;
}

function activeModels(models: Models): ModelRef[] {
  return [models.drafter, models.reviewer, ...(models.peer ? [models.peer] : [])];
}

function takePath(paths: Paths, index: number): string {
  return index === 1 ? paths.take1 : index === 2 ? paths.take2 : paths.take3;
}

/** Fire all takes in parallel; each take is one clean, independent answer. */
export async function runTakes(
  repo: string,
  task: string,
  criteria: string,
  decisions: string,
  models: Models,
  mode: Mode,
  reporting: Reporting = {},
): Promise<CouncilHead> {
  const note = reporting.onNote ?? (() => {});
  const list = activeModels(models);
  const runner = new OpencodeRunRunner({ repo, ...models, onCall: reporting.onCall });
  const paths = await createRun(repo, task, models, mode);
  try {
    await saveState(paths, { ...(await loadState(paths)), state: "taking" });
    note(`taking — ${list.length} model(s) in parallel: ${list.map((m) => m.ref).join(", ")}`);
    const results = await Promise.all(
      list.map(async (model, i) => {
        const { text } = await runner.take(model, { mode, task, criteria, decisions });
        const { text: repaired, repairs } = repairUrls(text);
        await writeFile(takePath(paths, i + 1), `${repaired}\n`);
        note(`take ${i + 1} done — ${model.ref}`);
        return { model, text: repaired, repairs };
      }),
    );
    const urlRepairs = results.flatMap((r) => r.repairs);
    if (urlRepairs.length) await saveState(paths, { ...(await loadState(paths)), urlRepairs });
    for (const r of urlRepairs) note(`! repaired a URL in a take: ${r.before} -> ${r.after}`);
    const state = await loadState(paths);
    await saveState(paths, { ...state, state: "synthesizing" });
    return {
      paths,
      takes: results.map((r, i) => ({ index: i + 1, model: r.model, text: r.text })),
      urlRepairs,
    };
  } catch (err) {
    await markFailed(paths, err);
    throw err;
  }
}

/** Synthesise the takes into the final answer. One call, by the lead. */
export async function runSynthesis(
  repo: string,
  paths: Paths,
  task: string,
  criteria: string,
  takes: CouncilTake[],
  models: Models,
  mode: Mode,
  reporting: Reporting = {},
): Promise<CouncilTail> {
  const note = reporting.onNote ?? (() => {});
  try {
    const peers = takes.slice(1).map((t) => t.model.ref).join(", ");
    note(`synthesising — ${models.drafter.ref} reads ${peers || "its own take"}`);
    const runner = new OpencodeRunRunner({ repo, ...models, onCall: reporting.onCall });
    const raw = await runner.synthesize({
      mode,
      task,
      criteria,
      takes: takes.map((t) => ({ model: t.model, text: t.text })),
    });
    // Take numbers are the tool's bookkeeping, not the reader's vocabulary:
    // name them deterministically (the prompt asks, but prose is probabilistic).
    const owners = takes.map((t) => ({ ref: t.model.ref }));
    const final = nameTakesInLearned(raw.final, owners);
    const learned = nameTakesInLearned(raw.learned, owners);
    await writeFile(paths.final, `${final}${learned ? `\n\n${learned}\n` : "\n"}`);
    const patch = await diffTakes(takes[0]?.text ?? "", final);
    await writeFile(paths.diff, patch ? `${patch}\n` : "");
    const current = await loadState(paths);
    await saveState(paths, { ...current, state: "done", error: undefined });
    note(`synthesised — final answer written`);
    return { final, learned, patch };
  } catch (err) {
    await markFailed(paths, err);
    throw err;
  }
}

async function diffTakes(before: string, after: string): Promise<string> {
  const { mkdtemp, writeFile: wf, readFile: rf, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "adv-council-"));
  try {
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");
    await wf(a, before);
    await wf(b, after);
    return await unifiedDiff(a, b);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rebuild a council run's takes + final from disk (for the TUI past-runs list). */
export async function loadCouncil(paths: Paths): Promise<{ takes: CouncilTake[]; final: string; learned: string; patch: string }> {
  const state = await loadState(paths);
  const order: ModelRef[] = [
    state.models.drafter,
    state.models.reviewer,
    ...(state.models.peer ? [state.models.peer] : []),
  ];
  const files = [paths.take1, paths.take2, paths.take3];
  const takes: CouncilTake[] = [];
  for (let i = 0; i < order.length; i++) {
    try {
      const text = await readFile(files[i]!, "utf8");
      takes.push({ index: i + 1, model: order[i]!, text });
    } catch {
      /* take not on disk (interrupted) — skip */
    }
  }
  const raw = await readFile(paths.final, "utf8");
  const { final, learned } = splitLearned(raw);
  const patch = await readFile(paths.diff, "utf8").catch(() => "");
  return { takes, final, learned, patch };
}
