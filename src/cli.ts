#!/usr/bin/env bun
/**
 * adv — adversarial two-model plan review.
 *
 *   adv                        open the TUI
 *   adv init [--dir <repo>]
 *   adv run "<task>" [--drafter <model>] [--reviewer <model>]
 *                    [--drafter-family <f>] [--reviewer-family <f>]
 *                    [--no-gate] [--dir <repo>]
 *   adv run --resume [<run>]
 *   adv decide [<run>]
 *   adv status [<run>]
 */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import type { FamilyCheck } from "./config.ts";
import type { Claims, Gate, Review } from "./contracts.ts";
import type { Audit, AuditRecord } from "./contracts.ts";
import { collectGate } from "./gate.ts";
import { gateSummaryLines, gateWarnings } from "./gate-model.ts";
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
  runPaths,
  runsDir,
  resumedModels,
  type Paths,
  saveState,
} from "./orchestrator.ts";
import { loadArtifacts, runHead, runTail, saveGate, type Models, type Reporting } from "./pipeline.ts";
import { familyClash } from "./models.ts";
import { renderResult } from "./render.ts";
import type { CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";
import type { ApprovalRequest } from "./audit.ts";

const BOOLEAN_FLAGS = new Set(["no-gate", "general", "help", "strict"]);

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

/** A bare run name resolves against this repository's run store. */
const resolveRun = (repo: string, dirArg: string) => {
  if (path.isAbsolute(dirArg)) return runPaths(repo, dirArg);
  const named = path.join(runsDir(repo), dirArg);
  if (existsSync(named)) return runPaths(repo, named);
  return runPaths(repo, path.resolve(repo, dirArg));
};

/** Per-call timing and cost, so a run is legible while it happens. */
const progress: CallHook = ({ kind, step, retry, ms, usage }) => {
  console.log(
    `    ${kind}/${step}${retry ? " (retry)" : ""}  ${(ms / 1000).toFixed(1)}s  $${usage.cost.toFixed(6)}`,
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
  console.log(
    `\n${renderResult({
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
    })}`,
  );
  console.log(`\nartifacts: ${displayPath(paths.dir)}`);
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
  const mode: Mode = flags.has("general") ? "answer" : cfg.mode;
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
  const head = await runHead(repo, task, criteria.text, decisions, models, mode, runReporting);
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

  const skipGate = flags.has("no-gate");

  // --no-gate: run straight through. No model resolves anything: every judgment
  // call is left open, every finding untriaged, and the plan presents options.
  if (skipGate) {
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

  if (!(cfg.gate && canAsk)) {
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
  await startTui({ repo });
}

function usage() {
  console.log(`adv — adversarial two-model plan review

  adv                        open the TUI
  adv init [--dir <repo>]    criteria, decisions and config (optional)
  adv run "<task>" [--general] [--drafter <model> --drafter-family <f>]
                   [--reviewer <model> --reviewer-family <f>]
                   [--strict] [--no-gate] [--dir <repo>]
  adv run --resume [<run>] [--strict]
  adv decide [<run>]
  adv status [<run>]

  --strict  refuse to run when both models share a family. Use it for any run
            whose result is evidence (the trial, the eval), not for the fast pair.`);
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
    case "status":
      await cmdStatus(flags, positional);
      break;
    default:
      usage();
      process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (err) {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
