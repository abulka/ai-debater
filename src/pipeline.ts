import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Changelog, Claims, Gate, Review } from "./contracts.ts";
import { assessDiff, unifiedDiff, type DiffAssessment } from "./diff.ts";
import { createRun, loadState, saveState, writeJson, type Paths } from "./orchestrator.ts";
import { OpencodeRunRunner, type CallHook } from "./runners/opencode-run.ts";
import type { Mode, ModelRef } from "./runner.ts";

export interface Models {
  drafter: ModelRef;
  reviewer: ModelRef;
}

/**
 * The pipeline, shared by the CLI and the TUI. Everything a caller needs to
 * know is in the return values; progress is reported through `onStep`.
 */

export interface Head {
  paths: Paths;
  plan: string;
  claims: Claims;
  review: Review;
  /** Verifiable claims the reviewer returned no verdict for. */
  missing: string[];
  /** Verdicts citing a file that does not exist in the repo. */
  evidenceIssues: { id: string; evidence: string }[];
}

/**
 * A reviewer can invent a plausible-looking path. A path that does not exist is
 * the cheapest forgery to catch, so catch it here rather than trusting the
 * shape of the string.
 */
function collectEvidenceIssues(repo: string, review: Review): { id: string; evidence: string }[] {
  const issues: { id: string; evidence: string }[] = [];
  for (const v of review.verdicts) {
    if (v.verdict === "unverifiable") continue;
    if (/^https?:\/\//.test(v.evidence)) continue;
    const file = v.evidence.replace(/:\d+(?:-\d+)?$/, "");
    if (!existsSync(path.join(repo, file))) issues.push({ id: v.id, evidence: v.evidence });
  }
  return issues;
}

/** Draft, review, validate. Leaves the run in state `validated`. */
export async function runHead(
  repo: string,
  task: string,
  criteria: string,
  decisions: string,
  models: Models,
  mode: Mode,
  onStep?: CallHook,
): Promise<Head> {
  const runner = new OpencodeRunRunner({ repo, ...models, onCall: onStep });
  const paths = await createRun(repo, task, models, mode);

  const draft = await runner.draft({ mode, task, criteria, decisions });
  await writeFile(paths.planV1, `${draft.plan}\n`);
  await writeJson(paths.claims, draft.claims);
  await saveState(paths, { ...(await loadState(paths)), state: "drafted" });

  const review = await runner.review({ mode, task, criteria, plan: draft.plan, claims: draft.claims });
  await writeJson(paths.review, review);
  await saveState(paths, { ...(await loadState(paths)), state: "reviewed" });

  const missing = draft.claims.verifiable
    .map((c) => c.id)
    .filter((id) => !review.verdicts.some((v) => v.id === id));

  const evidenceIssues = collectEvidenceIssues(repo, review);

  await saveState(paths, { ...(await loadState(paths)), state: "validated" });
  return { paths, plan: draft.plan, claims: draft.claims, review, missing, evidenceIssues };
}

export interface Tail {
  plan: string;
  changelog: Changelog;
  patch: string;
  assessment: DiffAssessment;
}

/** Apply the human's gate answers. Produces plan.v2, the changelog and the diff. */
export async function runTail(
  repo: string,
  paths: Paths,
  state: { task: string },
  claims: Claims,
  review: Review,
  gate: Gate,
  models: Models,
  mode: Mode,
  onStep?: CallHook,
): Promise<Tail> {
  const planV1 = await readFile(paths.planV1, "utf8");

  const refuted: { id: string; text: string; evidence: string }[] = [];
  for (const v of review.verdicts) {
    if (v.verdict !== "refuted") continue;
    refuted.push({
      id: v.id,
      text: claims.verifiable.find((c) => c.id === v.id)?.text ?? "",
      evidence: v.note ? `${v.evidence} — ${v.note}` : v.evidence,
    });
  }

  const acceptedIds = gate.findings.filter((f) => f.disposition === "accepted").map((f) => f.id);
  const accepted = review.extra_findings
    .filter((f) => acceptedIds.includes(f.id))
    .map((f) => ({ id: f.id, text: f.text, evidence: f.evidence ?? f.note ?? "" }));

  const decisions = gate.decisions
    .filter((d) => d.choice !== "open")
    .map((d) => ({
      id: d.id,
      text: claims.judgment.find((j) => j.id === d.id)?.text ?? "",
      choice: d.choice,
    }));

  // With nothing authorised there is nothing to rebut, and asking a model to
  // "rewrite, changing nothing" just invites an out-of-scope edit.
  let plan = planV1;
  let changelog: Changelog = { changes: [] };
  if (refuted.length || accepted.length || decisions.length) {
    const runner = new OpencodeRunRunner({ repo, ...models, onCall: onStep });
    const rebut = await runner.rebut({
      mode,
      task: state.task,
      plan: planV1,
      claims,
      refuted,
      accepted,
      decisions,
    });
    plan = `${rebut.plan}\n`;
    changelog = rebut.changelog;
  }
  await writeFile(paths.planV2, plan);
  await writeJson(paths.changelog, changelog);

  const patch = await unifiedDiff(paths.planV1, paths.planV2);
  await writeFile(paths.diff, patch ? `${patch}\n` : "");
  const assessment = assessDiff(patch, changelog);

  const current = await loadState(paths);
  await saveState(paths, { ...current, state: "done" });
  return { plan, changelog, patch, assessment };
}

/** Record the gate answers and mark the run as paused/parked at the gate. */
export async function saveGate(paths: Paths, gate: Gate): Promise<void> {
  await writeJson(paths.gate, gate);
  await saveState(paths, { ...(await loadState(paths)), state: "gated" });
}

export async function loadArtifacts(paths: Paths): Promise<{
  state: Awaited<ReturnType<typeof loadState>>;
  plan: string;
  claims: Claims;
  review: Review;
  gate: Gate | null;
}> {
  const state = await loadState(paths);
  const plan = await readFile(paths.planV1, "utf8");
  const { readJson } = await import("./orchestrator.ts");
  const claims = await readJson<Claims>(paths.claims);
  const review = await readJson<Review>(paths.review);
  const gate = await readJson<Gate>(paths.gate).catch(() => null);
  return { state, plan, claims, review, gate };
}
