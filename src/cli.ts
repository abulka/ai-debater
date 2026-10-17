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
import type { Claims, Gate, Review } from "./contracts.ts";
import { collectGate } from "./gate.ts";
import { initRepo } from "./init.ts";
import {
  appendDecisions,
  displayPath,
  latestRun,
  loadState,
  readCriteria,
  readDecisions,
  runPaths,
  runsDir,
  type Paths,
  saveState,
} from "./orchestrator.ts";
import { loadArtifacts, runHead, runTail, saveGate, type Models } from "./pipeline.ts";
import { renderResult } from "./render.ts";
import type { CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";

const BOOLEAN_FLAGS = new Set(["no-gate", "general", "help"]);

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

/** Per-step timing and cost, so a run is legible while it happens. */
const progress: CallHook = ({ kind, step, retry, ms, usage }) => {
  console.log(
    `  · ${kind}/${step}${retry ? " (retry)" : ""}  ${(ms / 1000).toFixed(1)}s  $${usage.cost.toFixed(6)}`,
  );
};

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

function printGateSummary(claims: Claims, review: Review) {
  const claimText = (id: string) => claims.verifiable.find((c) => c.id === id)?.text ?? "";

  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  if (refuted.length) {
    console.log(`\n  refuted (${refuted.length}):`);
    for (const v of refuted) {
      if (v.verdict !== "refuted") continue;
      console.log(`    ${v.id}  ${claimText(v.id)}`);
      console.log(`        [${v.evidence}]${v.note ? ` — ${v.note}` : ""}`);
    }
  }

  const unverifiable = review.verdicts.filter((v) => v.verdict === "unverifiable");
  if (unverifiable.length) {
    console.log(`\n  unverifiable (${unverifiable.length}):`);
    for (const v of unverifiable) {
      if (v.verdict !== "unverifiable") continue;
      console.log(`    ${v.id}  ${claimText(v.id)}\n        ${v.note}`);
    }
  }

  if (review.extra_findings.length) {
    console.log(`\n  findings (${review.extra_findings.length}):`);
    for (const f of review.extra_findings) {
      console.log(`    ${f.id}  ${f.text}`);
      if (f.evidence) console.log(`        [${f.evidence}]`);
      else if (f.note) console.log(`        ${f.note}`);
    }
  }

  console.log(`\n  judgment calls needing you: ${claims.judgment.length}`);
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
) {
  const state = await loadState(paths);
  const tail = await runTail(repo, paths, state, claims, review, gate, models, mode, progress);
  console.log(
    `\n${renderResult({
      plan: tail.plan,
      changelog: tail.changelog,
      patch: tail.patch,
      assessment: tail.assessment,
      gate,
      claims,
      review,
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

  const resumeFlag = flags.get("resume");  if (resumeFlag !== undefined) {
    const dirArg = typeof resumeFlag === "string" ? resumeFlag : await latestRun(repo);
    if (!dirArg) throw new Error("no run to resume");
    const paths = resolveRun(repo, dirArg);
    const art = await loadArtifacts(paths);
    if (art.state.state !== "gated") {
      throw new Error(`run is in state "${art.state.state}", not "gated" — nothing to resume`);
    }
    if (!art.gate) throw new Error("run has no gate answers yet — run `adv decide` first");
    return finalize(repo, paths, art.claims, art.review, art.gate, models, art.state.mode);
  }

  const task = positional.join(" ").trim();
  if (!task) throw new Error('usage: adv run "<task>"');

  const criteria = await readCriteria(repo);
  if (!criteria.found) {
    console.log(
      "  warning: .adv/criteria.md not found — using a minimal fallback. " +
        "Run `adv init`, or the reviewer may invent criteria.",
    );
  }
  const decisions = await readDecisions(repo);

  console.log(
    `  mode ${mode} · ${models.drafter.ref} [${models.drafter.family}]  ->  ${models.reviewer.ref} [${models.reviewer.family}]`,
  );
  const head = await runHead(repo, task, criteria.text, decisions, models, mode, progress);
  console.log(`  run: ${displayPath(head.paths.dir)}`);
  if (head.missing.length) console.log(`  warning: no verdict for ${head.missing.join(", ")}`);
  if (head.evidenceIssues.length) {
    console.log("  warning: evidence cites files that do not exist:");
    for (const issue of head.evidenceIssues) {
      console.log(`    ${issue.id}  ${issue.evidence}`);
    }
  }

  console.log("\n── gate ──");
  printGateSummary(head.claims, head.review);

  const skipGate = flags.has("no-gate");
  const canAsk = process.stdin.isTTY === true && process.stdout.isTTY === true;

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
    return finalize(repo, head.paths, head.claims, head.review, openGate, models, mode);
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
  return finalize(repo, head.paths, head.claims, head.review, gate, models, mode);
}

async function cmdDecide(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) throw new Error("usage: adv decide <run>");
  const paths = resolveRun(repo, dirArg);

  const art = await loadArtifacts(paths);
  printGateSummary(art.claims, art.review);
  const gate = await collectGate(art.claims, art.review);
  await saveGate(paths, gate);
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
  console.log(`task:   ${state.task}`);
  console.log(`models: ${state.models.drafter.ref} -> ${state.models.reviewer.ref}`);
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
                   [--no-gate] [--dir <repo>]
  adv run --resume [<run>]
  adv decide [<run>]
  adv status [<run>]`);
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
