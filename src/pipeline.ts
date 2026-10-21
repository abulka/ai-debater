import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unifiedDiff } from "./diff.ts";
import {
  NO_CRITERIA,
  createRun,
  loadState,
  markFailed,
  saveState,
  type Paths,
} from "./orchestrator.ts";
import { OpencodeRunRunner, type CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";
import { displayTaskOf } from "./continue.ts";
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

/**
 * One call's timing and cost, as the one line the run log keeps.
 *
 * `$0` is an absence, not a number: a gateway that reports no cost must not
 * make a paid run display as free.
 */
export function formatCallLine(info: {
  kind: "take" | "synthesis";
  step: string;
  retry: boolean;
  ms: number;
  usage: { cost: number; costKnown: boolean };
}): string {
  const what =
    info.kind === "take" && info.step === "take"
      ? "take written"
      : info.kind === "synthesis" && info.step === "synthesis"
        ? "synthesis written"
        : `${info.kind}/${info.step}`;
  const cost = info.usage.costKnown ? `$${info.usage.cost.toFixed(6)}` : "cost not reported";
  return `${what}${info.retry ? " (retry)" : ""} — ${(info.ms / 1000).toFixed(1)}s, ${cost}`;
}

/**
 * A reporting wrapper that persists every line to the run's log file as the
 * run happens, then forwards it for live display. Both front ends share it,
 * so the CLI and the TUI cannot tell two different stories about one run.
 *
 * Appends are chained, so the file order matches the call order even when
 * takes finish in parallel. `flush` settles the chain: callers await it before
 * reading the file back.
 */
function createLogWriter(
  paths: Paths,
  reporting: Reporting,
): Reporting & { flush: () => Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  const append = (line: string) => {
    tail = tail.then(() => appendFile(paths.log, `${line}\n`).then(
      () => {},
      () => {},
    ));
  };
  return {
    onCall: (info) => {
      append(formatCallLine(info));
      reporting.onCall?.(info);
    },
    onNote: (text) => {
      append(text);
      reporting.onNote?.(text);
    },
    flush: () => tail,
  };
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
  opts: { parent?: { name: string; dir: string }; followUp?: string } = {},
): Promise<CouncilHead> {
  const paths = await createRun(repo, task, models, mode, {
    ...(opts.parent ? { parent: opts.parent } : {}),
  });
  const rep = createLogWriter(paths, reporting);
  const note = rep.onNote ?? (() => {});
  const list = activeModels(models);
  const runner = new OpencodeRunRunner({ repo, ...models, onCall: rep.onCall });
  try {
    await saveState(paths, { ...(await loadState(paths)), state: "taking" });
    // The header is emitted through the run's own reporting, so it lands in
    // the log file as well as on screen. A continuation logs its follow-up
    // only: the full task carries the whole previous result, which would
    // bloat the log with what task.md already keeps.
    note(
      `${mode === "answer" ? "general question" : "repository"} · ${list.map((m) => `${m.ref} [${m.family}]`).join(" + ")} (parallel takes, ${models.drafter.ref} synthesises)`,
    );
    note(
      opts.parent && opts.followUp
        ? `continuing ${opts.parent.name} · follow-up: ${displayTaskOf(opts.followUp)}`
        : `${mode === "answer" ? "question" : "task"}: ${displayTaskOf(task)}`,
    );
    if (mode === "plan" && criteria === NO_CRITERIA) {
      note("! no criteria found — using a fallback (adv init to add some)");
    }
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
    const head = {
      paths,
      takes: results.map((r, i) => ({ index: i + 1, model: r.model, text: r.text })),
      urlRepairs,
    };
    await rep.flush();
    return head;
  } catch (err) {
    await rep.flush();
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
  const rep = createLogWriter(paths, reporting);
  const note = rep.onNote ?? (() => {});
  try {
    const peers = takes.slice(1).map((t) => t.model.ref).join(", ");
    note(`synthesising — ${models.drafter.ref} reads ${peers || "its own take"}`);
    const runner = new OpencodeRunRunner({ repo, ...models, onCall: rep.onCall });
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
    await rep.flush();
    return { final, learned, patch };
  } catch (err) {
    await rep.flush();
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
export async function loadCouncil(paths: Paths): Promise<{ takes: CouncilTake[]; final: string; learned: string; patch: string; log: string[] }> {
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
  // Runs recorded before the log file existed read as an empty log, and
  // render as before — no section, no placeholder.
  const log = await readFile(paths.log, "utf8")
    .then((text) => text.split("\n").filter((line) => line.length > 0))
    .catch(() => [] as string[]);
  return { takes, final, learned, patch, log };
}
