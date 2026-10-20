#!/usr/bin/env bun
/**
 * adv — adversarial two-model plan review.
 *
 *   adv                        open the TUI
 *   adv init [--dir <repo>]
 *   adv run "<task>" [--drafter <model>] [--reviewer <model>]
 *                    [--drafter-family <f>] [--reviewer-family <f>]
 *                    [--no-gate] [--general] [--plan] [--dir <repo>]
 *   adv run --resume [<run>]
 *   adv decide [<run>]
 *   adv revise [<run>] [--rewrite]
 *   adv continue [<run>] [--instructions "…"]
 *   adv status [<run>]
 *   adv ping <model-or-pair>… [--full] [--timeout <ms>]
 *   adv benchmarks [--refresh] [<ref>]
 *   adv rm <run> | --all | --older-than 30d [--yes]
 *
 *   ping makes one real model call per argument and says whether the model is
 *   reachable on this account today. The only thing in adv that costs a call,
 *   and it never runs unless asked. See docs/OPENCODE-MODELS.md.
 *
 *   rm removes run directories from the store. Nothing in a repository is touched:
 *   not the source, not .adv/. Decisions already written to .adv/decisions.md stay.
 *   Without a terminal it refuses unless --yes is passed.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.ts";
import type { FamilyCheck } from "./config.ts";
import { loadCatalogue } from "./catalogue.ts";
import {
  countScoredBySource,
  isStale,
  loadScores,
  scoresFor,
  type Benchmarks,
} from "./benchmarks.ts";
import { refreshAllBenchmarks } from "./artificialanalysis.ts";
import { fetchAcd, formatPromptCost, loadAcd, resolveAcd } from "./aicodingdaily.ts";
import { listModels } from "./models.ts";
import { loadRefreshDays, refreshDaysMs } from "./prefs.ts";
import { loadPairs } from "./pairs.ts";
import { pingModel } from "./probe.ts";
import type { Claims, Gate, Review } from "./contracts.ts";
import type { Audit, AuditRecord } from "./contracts.ts";
import { collectGate } from "./gate.ts";
import { decisionEntries, describeGateChange, gateSummaryLines, gateWarnings } from "./gate-model.ts";
import { initRepo } from "./init.ts";
import {
  appendDecisions,
  NO_CRITERIA,
  displayPath,
  latestRun,
  loadState,
  readCriteria,
  readDecisions,
  readJson,
  rotateGate,
  runPaths,
  deleteRuns,
  deletionSummary,
  findRunDir,
  listRuns,
  olderThanCutoff,
  resumedModels,
  type Paths,
  saveState,
} from "./orchestrator.ts";
import { loadArtifacts, loadTail, runHead, runTail, saveGate, type Models, type Reporting } from "./pipeline.ts";
import { composeContinuation, followUpOf } from "./continue.ts";
import { familyClash } from "./models.ts";
import { renderResult, renderResultAnsi } from "./render.ts";
import type { CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";
import type { ApprovalRequest } from "./audit.ts";

const BOOLEAN_FLAGS = new Set(["no-gate", "general", "plan", "rewrite", "help", "strict", "all", "yes", "refresh"]);

function parse(args: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positional };
}

function repoOf(flags: Map<string, string | true>): string {
  const dir = flags.get("dir");
  return path.resolve(typeof dir === "string" ? dir : process.cwd());
}

/**
 * A bare run name resolves against this repository's runs, then the questions.
 * An explicit path is taken as given.
 */
const resolveRun = (repo: string, dirArg: string) => {
  if (path.isAbsolute(dirArg)) return runPaths(repo, dirArg);
  const found = findRunDir(repo, dirArg);
  if (found) return runPaths(repo, found);
  return runPaths(repo, path.resolve(repo, dirArg));
};

/**
 * Per-call timing and cost, so a run is legible while it happens.
 *
 * `$0` is not a number, it is an absence: a provider that does not report cost
 * (the openrouter gateway) must read "not reported", or a paid run displays as
 * free. An explicit zero from a free provider (the groq pair) still reads $0.
 */
const progress: CallHook = ({ kind, step, retry, ms, usage }) => {
  const cost = usage.costKnown ? `$${usage.cost.toFixed(6)}` : "cost not reported";
  console.log(
    `    ${kind}/${step}${retry ? " (retry)" : ""}  ${(ms / 1000).toFixed(1)}s  ${cost}`,
  );
};

/** What the pipeline is doing, in words. The TUI renders the same lines. */
const reporting: Reporting = {
  onCall: progress,
  onNote: (text) => console.log(`  ${text}`),
};

/**
 * Same-family models are a warning by default, and a hard stop when the result
 * is meant to be evidence (`familyCheck: "require"`, or `--strict`).
 *
 * The trial and the §12 eval exist to measure *cross-family* review. A run that
 * silently used one family would measure an extra pass instead, and would do it
 * with the most expensive experiment in the project.
 */
function checkFamily(models: Models, check: FamilyCheck, source: string): void {
  const clash = familyClash(models);
  if (!clash) return;
  if (check === "require") {
    throw new Error(
      `${clash}.\n  refused: familyCheck is "require" (${source}). ` +
        `Choose a reviewer from another family, or set it back to "warn".`,
    );
  }
  console.log(`  warning: ${clash}`);
}

/**
 * A model override must name its family. Defaulting to the provider ID is
 * exactly wrong when both models sit behind one gateway: the diversity check
 * would compare "opencode-go" with "opencode-go" and pass regardless.
 */
function requireFamily(which: "drafter" | "reviewer", flags: Map<string, string | true>) {
  if (flags.has(which) && !flags.has(`${which}-family`)) {
    throw new Error(
      `--${which} needs --${which}-family. The provider is not the family: a gateway ` +
        `serves several families under one provider, which is the case the check exists for.`,
    );
  }
}

function modelFrom(
  ref: string | true | undefined,
  family: string | true | undefined,
  fallback: ModelRef,
): ModelRef {
  if (typeof ref !== "string") return fallback;
  return { ref, family: typeof family === "string" ? family : (ref.split("/")[0] ?? ref) };
}

function printGateSummary(claims: Claims, review: Review, checks: AuditRecord[] = []) {
  for (const line of gateSummaryLines(claims, review, checks)) console.log(line);
}

/** Ask before running a slow check the reviewer proposed. */
async function askApproval(request: ApprovalRequest): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const why = request.why ? `\n    why: ${request.why}` : "";
    const answer = (
      await rl.question(
        `  the reviewer asks to run: ${request.argv.join(" ")}  (for ${request.claim})${why}\n  run it? [y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ */

async function cmdInit(flags: Map<string, string | true>) {
  const repo = repoOf(flags);
  const { created, kept } = await initRepo(repo);
  console.log(`initialised ${repo}`);
  for (const f of created) console.log(`  created  ${f}`);
  for (const f of kept) console.log(`  kept     ${f}  (already existed)`);
  console.log(`  edit .adv/criteria.md with your judgment criteria`);
}

async function finalize(
  repo: string,
  paths: Paths,
  claims: Claims,
  review: Review,
  gate: Gate,
  models: Models,
  mode: Mode,
  checks: AuditRecord[] = [],
) {
  const state = await loadState(paths);
  const tail = await runTail(repo, paths, state, claims, review, gate, models, mode, reporting);
  const report = {
    plan: tail.plan,
    changelog: tail.changelog,
    patch: tail.patch,
    assessment: tail.assessment,
    gate,
    claims,
    review,
    checks,
    models,
    includeDiff: true,
  };
  // A terminal gets the rendered Markdown, a pipe gets the Markdown itself:
  // `adv run … > plan.md` should write a plan, not a plan with its headings
  // and emphasis scraped off. NO_COLOR is honoured because it is the setting
  // people actually use to say "do not style this".
  const styles = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(`\n${styles ? renderResultAnsi(report) : renderResult(report)}`);
  console.log(`\nartifacts: ${displayPath(paths.dir)}`);
}

/**
 * The shared tail of every fresh run: criteria, decisions, head, gate, tail.
 * `cmdRun` and `cmdContinue` differ only in where the task comes from — typed
 * by the human, or composed from a previous result — so both end here. A
 * chained run is a normal run: fresh draft, fresh cross-family review, and
 * the gate again.
 */
async function runFreshTask(
  repo: string,
  opts: {
    task: string;
    models: Models;
    mode: Mode;
    check: FamilyCheck;
    checkSource: string;
    gateEnabled: boolean;
    skipGate: boolean;
    parent?: { name: string; dir: string };
  },
) {
  const { task, models, mode, check, checkSource } = opts;
  // Answer mode has no repository: no criteria from the directory it was run
  // in, and no settled decisions either. Both are repo-specific, and loading
  // them made a general question answer itself from this project's notes.
  const criteria =
    mode === "answer" ? { text: NO_CRITERIA, found: false } : await readCriteria(repo);
  // Answer mode assumes no repository, so no criteria is the normal case, not a
  // fault. Warning about it there is noise that makes a correct state look broken.
  if (!criteria.found && mode === "plan") {
    console.log(
      "  warning: .adv/criteria.md not found — using a minimal fallback. " +
        "Run `adv init`, or the reviewer may invent criteria.",
    );
  }
  const decisions =
    mode === "answer" ? "(none — this is a general question)" : await readDecisions(repo);

  console.log(
    `  subject ${mode === "answer" ? "general question" : "this repository"} · ` +
      `${models.drafter.ref} [${models.drafter.family}]  ->  ${models.reviewer.ref} [${models.reviewer.family}]`,
  );
  checkFamily(models, check, checkSource);
  const canAsk = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const runReporting: Reporting = {
    ...reporting,
    // Only ask when there is someone to ask. Without a terminal, a slow check is
    // recorded as declined rather than silently run.
    ...(canAsk ? { onApprove: askApproval } : {}),
  };
  const head = await runHead(repo, task, criteria.text, decisions, models, mode, runReporting, {
    ...(opts.parent ? { parent: opts.parent } : {}),
  });
  console.log(`  run: ${displayPath(head.paths.dir)}`);
  for (const warning of gateWarnings({
    missing: head.missing,
    evidenceIssues: head.evidenceIssues,
    urlRepairs: head.urlRepairs,
    hasCriteria: criteria.found || mode === "answer",
  })) {
    console.log(`  warning: ${warning}`);
  }

  console.log("\n── gate ──");
  printGateSummary(head.claims, head.review, head.checks);

  // --no-gate: run straight through. No model resolves anything: every judgment
  // call is left open, every finding untriaged, and the plan presents options.
  if (opts.skipGate) {
    const openGate: Gate = {
      decisions: head.claims.judgment.map((j) => ({ id: j.id, choice: "open" })),
      findings: head.review.extra_findings.map((f) => ({
        id: f.id,
        disposition: "untriaged" as const,
      })),
    };
    await saveGate(head.paths, openGate);
    console.log(
      `\n  --no-gate: ${openGate.decisions.length} judgment call(s) left open, ` +
        `${openGate.findings.length} finding(s) untriaged. Nothing was decided for you.`,
    );
    return finalize(repo, head.paths, head.claims, head.review, openGate, models, mode, head.checks);
  }

  if (!(opts.gateEnabled && canAsk)) {
    await saveGate(head.paths, { decisions: [], findings: [] });
    console.log(
      `\n  paused at the gate.\n` +
        `    adv decide ${path.basename(head.paths.dir)}\n` +
        `    adv run --resume ${path.basename(head.paths.dir)}`,
    );
    return;
  }

  const gate = await collectGate(head.claims, head.review);
  await saveGate(head.paths, gate);
  // A gate answer to a general question is not a repository decision.
  if (mode === "plan") {
    await appendDecisions(
      repo,
      gate.decisions
        .filter((d) => d.choice !== "open")
        .map((d) => ({
          id: d.id,
          text: head.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
          choice: d.choice,
        })),
    );
  }
  return finalize(repo, head.paths, head.claims, head.review, gate, models, mode, head.checks);
}

async function cmdRun(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const cfg = await loadConfig(repo);
  requireFamily("drafter", flags);
  requireFamily("reviewer", flags);
  const models: Models = {
    drafter: modelFrom(flags.get("drafter"), flags.get("drafter-family"), cfg.models.drafter),
    reviewer: modelFrom(flags.get("reviewer"), flags.get("reviewer-family"), cfg.models.reviewer),
  };
  // An explicit flag beats the saved subject, either way. Without `--plan` a
  // plan-mode run would require editing config or the TUI first — one key in
  // the TUI, zero flags on the command line.
  const mode: Mode = flags.has("general")
    ? "answer"
    : flags.has("plan")
      ? "plan"
      : cfg.mode;
  const check: FamilyCheck = flags.has("strict") ? "require" : cfg.familyCheck;
  const checkSource = flags.has("strict") ? "--strict" : ".adv/config.json";

  const resumeFlag = flags.get("resume");
  if (resumeFlag !== undefined) {
    const dirArg = typeof resumeFlag === "string" ? resumeFlag : await latestRun(repo);
    if (!dirArg) throw new Error("no run to resume");
    const paths = resolveRun(repo, dirArg);
    const art = await loadArtifacts(paths);
    if (art.state.state !== "gated") {
      throw new Error(`run is in state "${art.state.state}", not "gated" — nothing to resume`);
    }
    if (!art.gate) throw new Error("run has no gate answers yet — run `adv decide` first");

    // The rebuttal is written by the drafter. Resuming with whatever the config
    // says now means a model can rewrite a plan it did not write, so the run's
    // own record wins unless the human asks for something else by name.
    const explicit = {
      drafter: flags.has("drafter") || flags.has("drafter-family"),
      reviewer: flags.has("reviewer") || flags.has("reviewer-family"),
    };
    const { models: chosen, overrides } = resumedModels(art.state.models, models, explicit);
    for (const o of overrides) {
      console.log(
        `  warning: --${o.role} ${o.chosen} is not the ${o.role} that wrote plan.v1 ` +
          `(${o.wrote}) — the rebuttal will be written by a different model`,
      );
    }
    console.log(
      `  models: ${chosen.drafter.ref} [${chosen.drafter.family}]  ->  ` +
        `${chosen.reviewer.ref} [${chosen.reviewer.family}]  (from the run)`,
    );
    checkFamily(chosen, check, checkSource);
    return finalize(repo, paths, art.claims, art.review, art.gate, chosen, art.state.mode, art.checks);
  }

  const task = positional.join(" ").trim();
  if (!task) throw new Error('usage: adv run "<task>"');

  return runFreshTask(repo, {
    task,
    models,
    mode,
    check,
    checkSource,
    gateEnabled: cfg.gate,
    skipGate: flags.has("no-gate"),
  });
}

/**
 * `adv continue [<run>] [--instructions "…"]` — continue a debate by content.
 *
 * Sessions cannot chain (each `--standalone` run owns its session store), so
 * the previous result travels inside the new task, whole, plus the human's
 * follow-up — which is what makes this a continuation rather than a rerun.
 * The new run is otherwise normal: fresh draft, fresh review, the gate again.
 */
async function cmdContinue(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const cfg = await loadConfig(repo);
  requireFamily("drafter", flags);
  requireFamily("reviewer", flags);
  const models: Models = {
    drafter: modelFrom(flags.get("drafter"), flags.get("drafter-family"), cfg.models.drafter),
    reviewer: modelFrom(flags.get("reviewer"), flags.get("reviewer-family"), cfg.models.reviewer),
  };
  const check: FamilyCheck = flags.has("strict") ? "require" : cfg.familyCheck;
  const checkSource = flags.has("strict") ? "--strict" : ".adv/config.json";

  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) throw new Error("usage: adv continue [<run>] [--instructions \"…\"]");
  const parentPaths = resolveRun(repo, dirArg);
  const parentState = await loadState(parentPaths);
  if (parentState.state === "failed") {
    throw new Error(
      `run failed${parentState.error ? ` — ${parentState.error.split("\n")[0]!}` : ""}.\n` +
        `  continue needs a run with a result to continue from; this one has none.`,
    );
  }
  // The tail is the result; a run parked at the gate has no tail yet, so the
  // draft-so-far stands in, said out loud.
  let previousResult: string;
  try {
    previousResult = (await loadTail(parentPaths)).plan;
  } catch {
    try {
      previousResult = await readFile(parentPaths.planV1, "utf8");
    } catch {
      throw new Error(
        `run is in state "${parentState.state}" — continue needs a run with a draft or a result.`,
      );
    }
  }

  const followUp = followUpOf(flags.get("instructions"), positional.slice(1));
  if (!followUp) {
    throw new Error(
      'usage: adv continue [<run>] [--instructions "…"] — say what should happen next',
    );
  }

  const parentName = path.basename(parentPaths.dir);
  const { task } = composeContinuation(parentName, previousResult, followUp);
  console.log(`  continuing run ${parentName} (${parentState.state})`);
  return runFreshTask(repo, {
    task,
    models,
    mode: parentState.mode,
    check,
    checkSource,
    gateEnabled: cfg.gate,
    skipGate: flags.has("no-gate"),
    parent: { name: parentName, dir: parentPaths.dir },
  });
}

async function cmdDecide(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) throw new Error("usage: adv decide <run>");
  const paths = resolveRun(repo, dirArg);

  // Deciding is only meaningful for a run parked at the gate. Without this
  // check a finished run could be re-parked at `gated` by re-answering it, and
  // an interrupted one would fail later on a missing artifact instead of
  // saying what state it is actually in.
  const state = await loadState(paths);
  if (state.state === "done") {
    throw new Error("this run is already done — there is nothing left to decide.");
  }
  if (state.state !== "validated" && state.state !== "gated") {
    throw new Error(
      `run is in state "${state.state}", not at the gate — only a run that finished ` +
        `drafting and reviewing can be decided. \`adv status\` shows what it has.`,
    );
  }

  const art = await loadArtifacts(paths);
  printGateSummary(art.claims, art.review, art.checks);
  const gate = await collectGate(art.claims, art.review);
  await saveGate(paths, gate);
  if (art.state.mode === "plan") {
    await appendDecisions(
      repo,
      gate.decisions
        .filter((d) => d.choice !== "open")
        .map((d) => ({
          id: d.id,
          text: art.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
          choice: d.choice,
        })),
    );
  }
  console.log(`\n  recorded. next: adv run --resume ${path.basename(paths.dir)}`);
}

/**
 * The door back into a finished run: re-ask the gate with the recorded answers
 * prefilled, then re-run only the tail. The head — draft, review, checks — is
 * immutable and is never re-run; the cost is two model calls or zero.
 *
 * Spec: docs/REVISE.md.
 */
async function cmdRevise(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const cfg = await loadConfig(repo);
  requireFamily("drafter", flags);
  requireFamily("reviewer", flags);
  const models: Models = {
    drafter: modelFrom(flags.get("drafter"), flags.get("drafter-family"), cfg.models.drafter),
    reviewer: modelFrom(flags.get("reviewer"), flags.get("reviewer-family"), cfg.models.reviewer),
  };
  const check: FamilyCheck = flags.has("strict") ? "require" : cfg.familyCheck;
  const checkSource = flags.has("strict") ? "--strict" : ".adv/config.json";

  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) throw new Error("no run to revise");
  const paths = resolveRun(repo, dirArg);

  // The only states revise accepts. A failed run has no completed review to
  // revise; a run that never reached the gate has no answers to re-ask.
  const state = await loadState(paths);
  if (state.state === "failed") {
    throw new Error(
      `run failed${state.error ? ` — ${state.error.split("\n")[0]!}` : ""}.\n` +
        `  revise needs a run that finished its review; this one did not get that far.`,
    );
  }
  if (state.state !== "done" && state.state !== "gated") {
    throw new Error(
      `run is in state "${state.state}" — revise needs a run parked at the gate ` +
        `or finished. \`adv status\` shows where it is.`,
    );
  }

  const art = await loadArtifacts(paths);
  // A CLI run paused at the gate saved an empty gate: nothing to prefill, so
  // the gate is simply asked fresh.
  const previous = art.gate ?? { decisions: [], findings: [] };

  console.log(`  run: ${displayPath(paths.dir)}  (state: ${state.state})`);
  console.log(`\n── the gate, asked again ${"─".repeat(20)}`);
  printGateSummary(art.claims, art.review, art.checks);
  const gate = await collectGate(art.claims, art.review, previous);

  const change = describeGateChange(previous, gate);
  const changed = change.decisions.length + change.findings.length;
  for (const d of change.decisions) console.log(`  changed  ${d.id}: ${d.from} -> ${d.to}`);
  for (const f of change.findings) console.log(`  changed  ${f.id}: ${f.from} -> ${f.to}`);

  if (changed === 0 && !flags.has("rewrite")) {
    if (state.state === "done") {
      // The tail already ran with exactly these answers: the run stands as it
      // is, and the head is not worth re-running to say so.
      console.log(`\n  nothing changed — the run stands as it is. No model calls made.`);
      console.log(`    pass --rewrite to re-run the tail with the same answers anyway.`);
      return;
    }
    // A run parked at the gate (gated) never ran its tail: "nothing changed"
    // means the recorded answers stand, and the one thing left to do is to
    // apply them. That is a resume wearing revise's clothing.
    console.log(`\n  no answers changed — the recorded gate stands; running the tail.`);
  }

  // The rebuttal is written by the drafter: the run's recorded models win,
  // same as resume. An explicit flag is a human instruction, reported as such.
  const explicit = {
    drafter: flags.has("drafter") || flags.has("drafter-family"),
    reviewer: flags.has("reviewer") || flags.has("reviewer-family"),
  };
  const { models: chosen, overrides } = resumedModels(state.models, models, explicit);
  for (const o of overrides) {
    console.log(
      `  warning: --${o.role} ${o.chosen} is not the ${o.role} that wrote plan.v1 ` +
        `(${o.wrote}) — the rewrite will be by a different model`,
    );
  }
  console.log(
    `  models: ${chosen.drafter.ref} [${chosen.drafter.family}]  ->  ` +
      `${chosen.reviewer.ref} [${chosen.reviewer.family}]  (from the run)`,
  );
  checkFamily(chosen, check, checkSource);

  // Order matters: the answers are asked and the gate rotated before a model is
  // called, so an abort or a failed tail never leaves the old answers recorded
  // under a new state — and the previous answers survive in gate.prev.json.
  await rotateGate(paths);
  await saveGate(paths, gate);
  if (state.mode === "plan") {
    await appendDecisions(repo, decisionEntries(art.claims, change));
  }

  try {
    return await finalize(repo, paths, art.claims, art.review, gate, chosen, state.mode, art.checks);
  } catch (err) {
    // The head is intact and the answers just given are recorded: the run is
    // parked at its own gate again, and `adv run --resume` retries the tail.
    // `failed` (the head's rule) would be a dead end — decide, resume and
    // revise all refuse it — so a failed tail comes back to `gated` with the
    // error recorded, where `adv status` still shows what broke.
    const error = err instanceof Error ? err.message : String(err);
    await saveState(paths, { ...state, state: "gated", error: error.slice(0, 2000) });
    throw err;
  }
}

async function cmdStatus(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) {
    console.log("no runs yet");
    return;
  }
  const paths = resolveRun(repo, dirArg);
  const state = await loadState(paths);
  console.log(`run:    ${displayPath(paths.dir)}`);
  console.log(`state:  ${state.state}`);
  if (state.error) {
    const first = state.error.split("\n")[0] ?? state.error;
    console.log(`error:  ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`);
  }
  console.log(`task:   ${state.task}`);
  console.log(`models: ${state.models.drafter.ref} -> ${state.models.reviewer.ref}`);
  if (state.parent) console.log(`continues: ${state.parent.name}  (↳ ${displayPath(state.parent.dir)})`);
  const clash = familyClash(state.models);
  if (clash) console.log(`        ! ${clash}`);
  for (const r of state.urlRepairs ?? []) {
    console.log(`repaired: ${r.before} -> ${r.after}`);
  }
  const audit = await readJson<Audit>(paths.audit).catch(() => null);
  if (audit?.records.length) {
    const ran = audit.records.filter((r) => r.outcome !== "not-run").length;
    const disagreed = audit.records.filter((r) => r.outcome === "mismatched").length;
    console.log(`checks: ${ran} run, ${disagreed} disagreed, ${audit.records.length - ran} not run`);
  }
}

async function cmdTui(flags: Map<string, string | true>) {
  const repo = repoOf(flags);
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('the TUI needs a terminal. Use `adv run "<task>"` for scripted use.');
  }
  const { startTui } = await import("./tui.tsx");
  const { altScreenEnabled } = await import("./viewport.ts");
  await startTui({
    repo,
    altScreen: altScreenEnabled(flags.has("no-alt-screen"), process.env.ADV_NO_ALT_SCREEN),
  });
}


/**
 * `adv rm` — remove runs.
 *
 * One run by name, or every run this directory can see (`--all`), or those
 * older than a span (`--older-than 30d`). Deleting is not undoable and the
 * questions bucket reaches runs asked from other directories, so the set is
 * printed before it goes and a terminal is asked to confirm: without one, the
 * command refuses unless `--yes` says the caller already decided.
 */
async function cmdRm(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const name = positional[0];
  const all = flags.has("all");
  const olderSpec = typeof flags.get("older-than") === "string" ? (flags.get("older-than") as string) : null;

  if (name && (all || olderSpec)) {
    throw new Error("usage: adv rm <run> | adv rm --all | adv rm --older-than 30d — pick one");
  }
  if (!name && !all && !olderSpec) {
    throw new Error("usage: adv rm <run> | adv rm --all | adv rm --older-than 30d");
  }

  let dirs: string[];
  if (name) {
    const found = findRunDir(repo, name) ?? (path.isAbsolute(name) ? name : null);
    if (!found) throw new Error(`no run called ${name}`);
    dirs = [found];
  } else {
    const runs = await listRuns(repo);
    let chosen = runs;
    if (olderSpec) {
      const cutoff = olderThanCutoff(olderSpec);
      if (!cutoff) {
        throw new Error(
          `--older-than takes a span (30d, 12h, 45m) or a date (2026-10-01), not "${olderSpec}"`,
        );
      }
      chosen = [];
      const undated: string[] = [];
      for (const run of runs) {
        const at = new Date(run.createdAt).getTime();
        // `createdAt` is a plain string in the schema, so an odd one is
        // possible. Pruning must say it left such a run alone rather than look
        // like it covered everything.
        if (Number.isNaN(at)) undated.push(run.name);
        else if (at < cutoff.getTime()) chosen.push(run);
      }
      if (undated.length) {
        console.log(
          `left alone: ${undated.length} run(s) with no readable timestamp — ${undated.join(", ")}`,
        );
      }
    }
    if (chosen.length === 0) {
      console.log("nothing to remove");
      return;
    }
    dirs = chosen.map((run) => run.dir);
    const summary = deletionSummary(chosen, repo);
    console.log(
      `\n${dirs.length} run(s): ${summary.here} filed under this repository, ` +
        `${summary.elsewhere} question(s) asked from any directory`,
    );
    for (const line of summary.lines) console.log(`  ${line.text}`);
    // A terminal is asked; a script must say --yes instead of having stdin read
    // as "no" and a delete that silently did nothing.
    if (!flags.has("yes")) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("refusing to delete without a terminal — pass --yes if you mean it");
      }
      process.stdout.write("\ndelete these? (y/N) ");
      const answer = await readLine();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("nothing was deleted");
        return;
      }
    }
  }

  const result = await deleteRuns(dirs);
  for (const dir of result.deleted) console.log(`deleted ${displayPath(dir)}`);
  for (const f of result.failed) console.log(`not deleted ${displayPath(f.dir)} — ${f.error}`);
  if (result.failed.length) process.exitCode = 1;
}

/** One line from stdin, for the one question this CLI asks. */
async function readLine(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("");
}

function usage() {
  console.log(`adv — adversarial two-model plan review

  adv [--no-alt-screen]    open the TUI (fullscreen; ADV_NO_ALT_SCREEN=1 disables)
  adv init [--dir <repo>]    criteria, decisions and config (optional)
  adv run "<task>" [--general] [--plan] [--drafter <model> --drafter-family <f>]
                   [--reviewer <model> --reviewer-family <f>]
                   [--strict] [--no-gate] [--dir <repo>]
  adv run --resume [<run>] [--strict]
  adv decide [<run>]
  adv revise [<run>] [--rewrite] [--strict]
  adv continue [<run>] [--instructions "…"] [--strict] [--no-gate]
  adv status [<run>]
  adv ping <model-or-pair>… [--full] [--timeout <ms>]
  adv benchmarks [--refresh] [<ref>]
  adv rm <run> | --all | --older-than 30d [--yes]

  rm removes run directories from the store. Nothing in a repository is touched:
  not the source, not .adv/. Decisions already written to .adv/decisions.md stay.
  Without a terminal it refuses unless --yes is passed.

  --general / --plan   force the subject for this run, without changing the saved one
  --strict             refuse to run when both models share a family. Use it for any
                       run whose result is evidence (the trial, the eval), not the
                       fast pair
  --rewrite            revise: re-run the tail even when no answers changed

  revise re-asks the gate with your recorded answers (Enter keeps one) and re-runs
  only the rewrite: the draft and the review are never repeated.

  continue starts a new run from a finished one: the previous result plus your
  follow-up becomes the new task, so the debate continues with fresh eyes.
  Needs --instructions (or trailing words) saying what should happen next.`);
}

/* ------------------------------------------------------------------ */

/**
 * `adv ping <model-or-pair>…` — is this reachable, on this account, today?
 *
 * The one check in `adv` that costs a model call, so it is never implicit:
 * nothing runs it unless this command or a keypress asks. `docs/OPENCODE-MODELS.md`
 * is why it exists — `opencode models` is a catalogue, and it offers models the
 * provider will refuse.
 *
 * An argument is a saved pair's name when one matches, and a ref otherwise, so
 * `adv ping trial` checks the pair and `adv ping groq/groq/compound-mini`
 * checks the model. Results are written to the probe cache, so the TUI shows
 * them afterwards; the exit code is non-zero if anything failed, so a script
 * can gate on it.
 */
async function cmdPing(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const wanted = positional.filter((p) => !p.startsWith("-"));
  if (wanted.length === 0) throw new Error("usage: adv ping <model-or-pair>… [--full] [--timeout <ms>]");

  const timeoutRaw = flags.get("timeout");
  const timeoutMs = typeof timeoutRaw === "string" ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`--timeout wants milliseconds, got "${String(timeoutRaw)}"`);
  }
  const kind = flags.has("full") ? "full" : "cheap";

  // A name wins over a ref, because a pair is what a reader is asking about
  // and a ref is what they would type if they had no pair.
  const pairs = await loadPairs();
  const refs: string[] = [];
  for (const arg of wanted) {
    const pair = pairs.find((p) => p.name === arg);
    if (pair) refs.push(pair.drafter.ref, pair.reviewer.ref);
    else refs.push(arg);
  }

  console.log(
    `  ping (${kind}${kind === "full" ? ": adv-drafter, one tool call" : ": adv-writer, one word"})` +
      `${timeoutMs ? `, ${Math.round(timeoutMs / 1000)}s cap` : ", 30s cap"}`,
  );

  let failed = 0;
  for (const ref of refs) {
    process.stdout.write(`  ${ref} … `);
    const verdict = await pingModel(ref, { repo, kind, ...(timeoutMs ? { timeoutMs } : {}) });
    const ok = verdict.kind === "ok";
    const ms = verdict.ms ? ` ${(verdict.ms / 1000).toFixed(1)}s` : "";
    if (!ok) failed += 1;
    console.log(`${ok ? "ok" : `FAILED — ${verdict.detail}`}${ms}`);
  }
  if (failed > 0) process.exit(1);
}

/**
 * `adv benchmarks [--refresh] [<ref>]` — Artificial Analysis indices for the
 * models `opencode models` lists.
 *
 * No model call, and network only with `--refresh`: without it the command
 * reads the cache the picker's `B` and auto-refresh keep. With a key stored
 * (TUI settings), a refresh reads AA direct and the relay fills the gaps;
 * without one it is the relay alone, exactly as before. A ref prints its
 * three indices and the id they came from, so a `≈` guess can be checked;
 * without one, every listed model that resolves.
 */
async function cmdBenchmarks(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const ref = positional.find((p) => !p.startsWith("-"));

  const { catalogue } = await loadCatalogue();
  let scores: Benchmarks;
  let at: string | null;
  let indexVersion: string | null;
  if (flags.has("refresh")) {
    try {
      const refreshed = await refreshAllBenchmarks();
      scores = refreshed.scores;
      at = refreshed.at;
      indexVersion = refreshed.indexVersion;
      const quota =
        refreshed.quota?.remaining !== null && refreshed.quota?.remaining !== undefined
          ? ` · quota ${refreshed.quota.remaining}/${refreshed.quota.limit ?? "?"}`
          : "";
      console.log(
        `  fetched ${refreshed.aaCount + refreshed.orCount} scored models` +
          (refreshed.aaOk && refreshed.orOk
            ? ` (${refreshed.aaCount} AA + ${refreshed.orCount} relay)`
            : refreshed.aaOk
              ? " (AA only — relay unreachable)"
              : refreshed.aaKey
                ? " (relay only — AA unreachable)"
                : " (relay only — no AA key stored)") +
          (indexVersion ? ` · AA Intelligence Index v${indexVersion}` : "") +
          quota,
      );
      for (const w of refreshed.warnings) console.log(`  ! ${w}`);
      // AI Coding Daily rides its own cache: one source failing never blocks
      // the other, and a restyled page keeps the old cache, never an empty one.
      try {
        const acd = await fetchAcd();
        console.log(`  fetched ${acd.count} AI Coding Daily models · fetched ${acd.at.slice(0, 10)}`);
      } catch (err) {
        console.log(`  ! ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.log(`  ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    ({ scores, at, indexVersion } = await loadScores());
  }
  if (scores.byId.size === 0) {
    console.log("  no benchmark cache — run `adv benchmarks --refresh` to fetch it");
    return;
  }

  const age = at
    ? ` · fetched ${at.slice(0, 10)}${isStale(at, Date.now(), refreshDaysMs(await loadRefreshDays())) ? " (stale — --refresh)" : ""}`
    : "";
  const version = indexVersion ? ` · AA Intelligence Index v${indexVersion}` : "";
  const via = (r: NonNullable<ReturnType<typeof scoresFor>>) =>
    r.source === "aa" ? "Artificial Analysis" : "OpenRouter relay";
  const num = (n: number | undefined) => (n === undefined ? "—" : String(Math.round(n * 10) / 10));

  if (ref) {
    const r = scoresFor(catalogue, scores, ref);
    const a = resolveAcd(catalogue, (await loadAcd()).entries, ref);
    if (!r && !a) {
      console.log(`  no benchmark data for ${ref}${age}`);
      return;
    }
    console.log(`  ${ref}`);
    if (r)
      console.log(`    intelligence ${num(r.intelligence)} · coding ${num(r.coding)} · agentic ${num(r.agentic)}`);
    if (r) console.log(`    via ${r.sourceId} (${via(r)})${r.normalised ? " ≈ normalised match" : ""}${age}`);
    if (a)
      console.log(
        `    AI Coding Daily ${Math.round(a.points)}/70` +
          `${a.costPerPrompt !== undefined ? ` · ${formatPromptCost(a.costPerPrompt)}/prompt` : ""}` +
          `${a.effort ? ` · ${a.effort}` : ""}${a.harness ? ` via ${a.harness}` : ""}` +
          `${a.normalised ? " ≈ normalised match" : ""}`,
      );
    return;
  }

  const acdEntries = (await loadAcd()).entries;

  const listing = await listModels(repo).catch(() => [] as string[]);
  const split = countScoredBySource(listing, catalogue, scores);
  const rows = listing
    .map((m) => ({ ref: m, r: scoresFor(catalogue, scores, m) }))
    .filter((row): row is { ref: string; r: NonNullable<ReturnType<typeof scoresFor>> } => row.r !== null)
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  console.log(
    `  ${rows.length} of ${listing.length} listed models scored` +
      (split.aa > 0 ? ` (${split.aa} AA + ${split.openrouter} relay)` : "") +
      `${age}${version}`,
  );
  for (const { ref: m, r } of rows) {
    const a = resolveAcd(catalogue, acdEntries, m);
    console.log(
      `    ${m}  I${num(r.intelligence)} C${num(r.coding)} A${num(r.agentic)}` +
        `${a ? ` D${Math.round(a.points)}` : ""}` +
        `${r.normalised || a?.normalised ? " ≈" : ""}` +
        `${r.source === "aa" ? "" : " · relay"}`,
    );
  }
  console.log(`  Artificial Analysis indices (attribution: artificialanalysis.ai)`);
  console.log(`  D points: AI Coding Daily coding leaderboard (aicodingdaily.com/leaderboard)`);
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
// A leading flag means no subcommand: `adv --dir X` opens the TUI in X.
const hasCommand = argv.length > 0 && !argv[0]!.startsWith("--");
const command = hasCommand ? argv[0] : undefined;
const { flags, positional } = parse(hasCommand ? argv.slice(1) : argv);

try {
  switch (command) {
    case undefined:
      // `adv --help` used to fall through to the TUI and fail with "needs a
      // terminal", which is a bad answer to a question about usage.
      if (flags.has("help")) {
        usage();
        break;
      }
      await cmdTui(flags);
      break;
    case "tui":
      await cmdTui(flags);
      break;
    case "init":
      await cmdInit(flags);
      break;
    case "run":
      await cmdRun(flags, positional);
      break;
    case "decide":
      await cmdDecide(flags, positional);
      break;
    case "revise":
      await cmdRevise(flags, positional);
      break;
    case "continue":
      await cmdContinue(flags, positional);
      break;
    case "rm":
      await cmdRm(flags, positional);
      break;
    case "status":
      await cmdStatus(flags, positional);
      break;
    case "ping":
      await cmdPing(flags, positional);
      break;
    case "benchmarks":
      await cmdBenchmarks(flags, positional);
      break;
    default:
      usage();
      process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (err) {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
