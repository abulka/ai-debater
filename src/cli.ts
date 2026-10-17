#!/usr/bin/env bun
/**
 * adv — adversarial two-model plan review.
 *
 *   adv init [--dir <repo>]
 *   adv run "<task>" [--drafter <model>] [--reviewer <model>]
 *                    [--drafter-family <f>] [--reviewer-family <f>]
 *                    [--no-gate] [--dir <repo>]
 *   adv run --resume [<run>]
 *   adv decide <run>
 *   adv status [<run>]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { assessDiff, unifiedDiff } from "./diff.ts";
import { collectGate } from "./gate.ts";
import {
  appendDecisions,
  createRun,
  latestRun,
  loadState,
  readCriteria,
  readDecisions,
  readJson,
  runPaths,
  type Paths,
  saveState,
  writeJson,
} from "./orchestrator.ts";
import { renderResult } from "./render.ts";
import { OpencodeRunRunner } from "./runners/opencode-run.ts";
import type { Claims, Gate, Review } from "./contracts.ts";
import type { ModelRef } from "./runner.ts";

const TEMPLATES = path.join(import.meta.dir, "..", "templates", "agents");

const CRITERIA_TEMPLATE = `# Criteria

Fixed. Models may not add to or change this list.

- Minimal dependencies: prefer the standard library.
- Solo-maintainable: nothing that needs its own on-call.
- Fast to ship: working today beats elegant next month.
`;

const DECISIONS_TEMPLATE = `# Settled decisions

Append-only. Only the human adds entries here. Models treat every entry as a
closed question.
`;

/* ------------------------------------------------------------------ */

const BOOLEAN_FLAGS = new Set(["no-gate", "help"]);

function parse(args: string[]): {
  flags: Map<string, string | true>;
  positional: string[];
} {
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

const resolveRun = (repo: string, dirArg: string) =>
  runPaths(repo, path.isAbsolute(dirArg) ? dirArg : path.resolve(repo, dirArg));

function modelFrom(
  ref: string | true | undefined,
  family: string | true | undefined,
  fallback: ModelRef,
): ModelRef {
  if (typeof ref !== "string") return fallback;
  return {
    ref,
    family: typeof family === "string" ? family : (ref.split("/")[0] ?? ref),
  };
}

async function writeIfAbsent(file: string, content: string) {
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch {
    // already exists; leave it alone
  }
}

function printGateSummary(claims: Claims, review: Review) {
  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  const unverifiable = review.verdicts.filter((v) => v.verdict === "unverifiable");

  if (refuted.length) {
    console.log(`\n  refuted (${refuted.length}):`);
    for (const v of refuted) {
      const text = claims.verifiable.find((c) => c.id === v.id)?.text ?? "";
      console.log(`    ${v.id}  ${text}\n        [${v.evidence}]`);
    }
  }
  if (unverifiable.length) {
    console.log(`\n  unverifiable: ${unverifiable.map((v) => v.id).join(", ")}`);
  }
  if (review.extra_findings.length) {
    console.log(`\n  findings (${review.extra_findings.length}):`);
    for (const f of review.extra_findings) {
      console.log(`    ${f.id}  ${f.text}\n        [${f.evidence}]`);
    }
  }
  console.log(`\n  judgment calls needing you: ${claims.judgment.length}`);
}

/* ------------------------------------------------------------------ */

async function cmdInit(flags: Map<string, string | true>) {
  const repo = repoOf(flags);
  await mkdir(path.join(repo, ".adv"), { recursive: true });
  await mkdir(path.join(repo, ".opencode", "agents"), { recursive: true });

  await writeIfAbsent(path.join(repo, ".adv", "criteria.md"), CRITERIA_TEMPLATE);
  await writeIfAbsent(path.join(repo, ".adv", "decisions.md"), DECISIONS_TEMPLATE);
  await writeIfAbsent(
    path.join(repo, ".adv", "config.json"),
    `${JSON.stringify(
      {
        models: {
          drafter: { ref: "anthropic/claude-sonnet-5-5", family: "anthropic" },
          reviewer: { ref: "openai/gpt-5.2", family: "openai" },
        },
        gate: true,
      },
      null,
      2,
    )}\n`,
  );

  for (const name of ["adv-drafter.md", "adv-reviewer.md"]) {
    await writeFile(
      path.join(repo, ".opencode", "agents", name),
      await readFile(path.join(TEMPLATES, name), "utf8"),
    );
  }

  console.log(`initialised ${repo}`);
  console.log(`  .adv/criteria.md    — your judgment criteria (edit this)`);
  console.log(`  .adv/decisions.md   — settled decisions, append-only`);
  console.log(`  .adv/config.json    — models`);
  console.log(`  .opencode/agents/   — the drafter and reviewer`);
}

async function finish(
  repo: string,
  p: Paths,
  claims: Claims,
  review: Review,
  gate: Gate,
  models: { drafter: ModelRef; reviewer: ModelRef },
) {
  const state = await loadState(p);
  const planV1 = await readFile(p.planV1, "utf8");
  const runner = new OpencodeRunRunner({ repo, ...models });

  const refuted = review.verdicts
    .filter((v) => v.verdict === "refuted")
    .map((v) => ({
      id: v.id,
      text: claims.verifiable.find((c) => c.id === v.id)?.text ?? "",
      evidence: v.evidence,
    }));

  const acceptedIds = gate.findings
    .filter((f) => f.disposition === "accepted")
    .map((f) => f.id);
  const accepted = review.extra_findings
    .filter((f) => acceptedIds.includes(f.id))
    .map((f) => ({ id: f.id, text: f.text, evidence: f.evidence }));

  const decisions = gate.decisions
    .filter((d) => d.choice !== "open")
    .map((d) => ({
      id: d.id,
      text: claims.judgment.find((j) => j.id === d.id)?.text ?? "",
      choice: d.choice,
    }));

  process.stdout.write("  rebutting…… ");
  const rebut = await runner.rebut({
    task: state.task,
    plan: planV1,
    claims,
    refuted,
    accepted,
    decisions,
  });
  await writeFile(p.planV2, `${rebut.plan}\n`);
  await writeJson(p.changelog, rebut.changelog);
  console.log("ok");

  const patch = await unifiedDiff(p.planV1, p.planV2);
  await writeFile(p.diff, patch ? `${patch}\n` : "");
  const assessment = assessDiff(patch, rebut.changelog);

  console.log(`\n${renderResult({ plan: rebut.plan, changelog: rebut.changelog, patch, assessment, gate, claims })}`);

  await saveState(p, { ...state, state: "done" });
  console.log(`\nartifacts: ${path.relative(repo, p.dir)}`);
}

async function cmdRun(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const cfg = await loadConfig(repo);
  const models = {
    drafter: modelFrom(flags.get("drafter"), flags.get("drafter-family"), cfg.models.drafter),
    reviewer: modelFrom(flags.get("reviewer"), flags.get("reviewer-family"), cfg.models.reviewer),
  };

  const resumeFlag = flags.get("resume");
  if (resumeFlag !== undefined) {
    const dirArg =
      typeof resumeFlag === "string" ? resumeFlag : await latestRun(repo);
    if (!dirArg) throw new Error("no run to resume");
    const p = resolveRun(repo, dirArg);
    const state = await loadState(p);
    if (state.state !== "gated") {
      throw new Error(`run is in state "${state.state}", not "gated" — nothing to resume`);
    }
    const claims = await readJson<Claims>(p.claims);
    const review = await readJson<Review>(p.review);
    const gate = await readJson<Gate>(p.gate);
    // Reuse the run's own models, not the current config: the rebuttal must come
    // from the same drafter that wrote the plan.
    return finish(repo, p, claims, review, gate, state.models);
  }

  const task = positional.join(" ").trim();
  if (!task) throw new Error('usage: adv run "<task>"');

  const criteria = await readCriteria(repo);
  const decisions = await readDecisions(repo);
  const runner = new OpencodeRunRunner({ repo, ...models });
  const p = await createRun(repo, task, {
    drafter: models.drafter,
    reviewer: models.reviewer,
  });
  console.log(`run: ${path.relative(repo, p.dir)}`);
  console.log(`  ${models.drafter.ref} [${models.drafter.family}] -> ${models.reviewer.ref} [${models.reviewer.family}]`);

  process.stdout.write("  drafting…… ");
  const draft = await runner.draft({ task, criteria, decisions });
  await writeFile(p.planV1, `${draft.plan}\n`);
  await writeJson(p.claims, draft.claims);
  console.log(`ok (${draft.claims.verifiable.length} verifiable, ${draft.claims.judgment.length} judgment)`);
  await saveState(p, { ...(await loadState(p)), state: "drafted" });

  process.stdout.write("  reviewing…… ");
  const review = await runner.review({ task, criteria, plan: draft.plan, claims: draft.claims });
  await writeJson(p.review, review);
  console.log(`ok (${review.verdicts.length} verdicts, ${review.extra_findings.length} findings)`);
  await saveState(p, { ...(await loadState(p)), state: "reviewed" });

  const missing = draft.claims.verifiable
    .map((c) => c.id)
    .filter((id) => !review.verdicts.some((v) => v.id === id));
  if (missing.length) console.log(`  warning: no verdict for ${missing.join(", ")}`);
  await saveState(p, { ...(await loadState(p)), state: "validated" });

  const interactive =
    cfg.gate &&
    !flags.has("no-gate") &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true;

  if (!interactive) {
    const empty: Gate = { decisions: [], findings: [] };
    await writeJson(p.gate, empty);
    await saveState(p, { ...(await loadState(p)), state: "gated" });
    console.log("\n── gate ──");
    printGateSummary(draft.claims, review);
    console.log(
      `\n  paused at the gate.\n` +
        `    adv decide ${path.relative(repo, p.dir)}\n` +
        `    adv run --resume ${path.relative(repo, p.dir)}`,
    );
    return;
  }

  console.log("\n── gate ──");
  printGateSummary(draft.claims, review);
  const gate = await collectGate(draft.claims, review);
  await writeJson(p.gate, gate);
  await appendDecisions(
    repo,
    gate.decisions
      .filter((d) => d.choice !== "open")
      .map((d) => ({
        id: d.id,
        text: draft.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
        choice: d.choice,
      })),
  );
  await saveState(p, { ...(await loadState(p)), state: "gated" });

  return finish(repo, p, draft.claims, review, gate, models);
}

async function cmdDecide(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) throw new Error("usage: adv decide <run>");
  const p = resolveRun(repo, dirArg);

  const claims = await readJson<Claims>(p.claims);
  const review = await readJson<Review>(p.review);

  printGateSummary(claims, review);
  const gate = await collectGate(claims, review);
  await writeJson(p.gate, gate);
  await appendDecisions(
    repo,
    gate.decisions
      .filter((d) => d.choice !== "open")
      .map((d) => ({
        id: d.id,
        text: claims.judgment.find((j) => j.id === d.id)?.text ?? "",
        choice: d.choice,
      })),
  );
  console.log(`\n  recorded. next: adv run --resume ${path.relative(repo, p.dir)}`);
}

async function cmdStatus(flags: Map<string, string | true>, positional: string[]) {
  const repo = repoOf(flags);
  const dirArg = positional[0] ?? (await latestRun(repo));
  if (!dirArg) {
    console.log("no runs yet");
    return;
  }
  const p = resolveRun(repo, dirArg);
  const state = await loadState(p);
  console.log(`run:    ${path.relative(repo, p.dir)}`);
  console.log(`state:  ${state.state}`);
  console.log(`task:   ${state.task}`);
  console.log(`models: ${state.models.drafter.ref} -> ${state.models.reviewer.ref}`);
}

function usage() {
  console.log(`adv — adversarial two-model plan review

  adv init [--dir <repo>]
  adv run "<task>" [--drafter <model>] [--reviewer <model>] [--no-gate] [--dir <repo>]
  adv run --resume [<run>]
  adv decide <run>
  adv status [<run>]`);
}

/* ------------------------------------------------------------------ */

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parse(rest);

try {
  switch (command) {
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
      process.exit(command === undefined || command === "help" ? 0 : 2);
  }
} catch (err) {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
