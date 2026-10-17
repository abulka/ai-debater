#!/usr/bin/env bun
/**
 * M0 feasibility spike for `adv`.
 *
 *   bun run spike/m0.ts                     # run every check
 *   bun run spike/m0.ts endpoints permissions
 *
 * Checks
 *   endpoints    the service is reachable and exposes the V2 routes we rely on
 *   permissions  the agents cannot write, cannot launch a browser, and can only
 *                use allowlisted tools and shell commands
 *   artifacts    dump the raw event stream; confirm extraction and that the
 *                run's location is really the target repo
 *   roundtrip    exit criterion: draft -> review across two families, schema-valid
 *
 * Override the models without editing anything:
 *   ADV_DRAFTER, ADV_DRAFTER_FAMILY, ADV_REVIEWER, ADV_REVIEWER_FAMILY, ADV_TASK
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OpencodeRunRunner,
  formatUsage,
  parseNdjson,
  summarizeUsage,
} from "../src/runners/opencode-run.ts";
import type { RunEvent } from "../src/runners/opencode-run.ts";
import type { ModelRef } from "../src/runner.ts";

const REPO = path.resolve(import.meta.dir, "..");
const TOY = path.join(REPO, "fixtures/toy-repo");
const OUT = path.join(REPO, "spike/out");
const TEMPLATES = path.join(REPO, "templates/agents");
const AGENTS_DEST = path.join(TOY, ".opencode/agents");

const drafter: ModelRef = {
  ref: process.env.ADV_DRAFTER ?? "anthropic/claude-sonnet-5-5",
  family: process.env.ADV_DRAFTER_FAMILY ?? "anthropic",
};
const reviewer: ModelRef = {
  ref: process.env.ADV_REVIEWER ?? "openai/gpt-5.2",
  family: process.env.ADV_REVIEWER_FAMILY ?? "openai",
};

const TASK =
  process.env.ADV_TASK ??
  "Add per-key rate limiting that survives a process restart, with a configurable limit.";

/* ------------------------------------------------------------------ */

let failures = 0;

const ok = (t: string) => console.log(`  ok     ${t}`);
const info = (t: string) => console.log(`  info   ${t}`);
const fail = (t: string) => {
  failures++;
  console.log(`  FAIL   ${t}`);
};

async function sh(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO,
    // See OpencodeRunRunner.call: opencode reads $PWD, and spawn's cwd does not
    // set it.
    env: { ...process.env, PWD: opts.cwd ?? REPO },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const toolCalls = (events: RunEvent[], tool: string) =>
  events.filter((e) => e.part?.type === "tool" && e.part.tool === tool);

/** Stand in for `adv init`: put the agent definitions in the target repo.
 *  They must live in the target repo's project, not the tool's. */
async function prepareRepo() {
  await mkdir(AGENTS_DEST, { recursive: true });
  for (const name of ["adv-drafter.md", "adv-reviewer.md"]) {
    await writeFile(
      path.join(AGENTS_DEST, name),
      await readFile(path.join(TEMPLATES, name), "utf8"),
    );
  }
}

/* ------------------------------------------------------------------ */

/** Tools the adv agents are permitted to use. Anything else fails the check. */
const ALLOWED_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "shell",
  "webfetch",
  "websearch",
]);

/** Shell is only for read-only git inspection in v1. */
const SHELL_ALLOW = /^git (log|show|diff|status|grep|ls-files|branch)(\s|$)/;

/** Browsers launched by the Playwright MCP, identified by its profile path. */
async function playwrightBrowsers(): Promise<Set<string>> {
  const r = await sh(["pgrep", "-f", "ms-playwright-mcp/mcp-chrome"]);
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Any canary left anywhere under the project — not just in the target repo. */
async function canaryFiles(): Promise<string[]> {
  const r = await sh(["find", ".", "-name", "CANARY*", "-not", "-path", "./node_modules/*"]);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */

async function checkEndpoints() {
  const cli = (await sh(["opencode", "--version"])).stdout.trim();

  const res = await sh(["opencode", "api", "get", "/api/info"]);
  if (res.code !== 0) {
    fail(`/api/info unreachable: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
    return;
  }
  const srv = JSON.parse(res.stdout) as { version?: string };
  ok(`service reachable — cli ${cli}, server v${srv.version}`);
  if (cli.replace(/^v/, "") !== srv.version) {
    info(`version drift: cli ${cli} vs server v${srv.version} — pin both before trusting the spike`);
  }

  const spec = await sh(["opencode", "api", "get", "/openapi.json"]);
  if (spec.code !== 0) {
    info("could not read /openapi.json through `opencode api`; confirm the routes by hand");
    return;
  }
  try {
    const doc = JSON.parse(spec.stdout) as { paths?: Record<string, unknown> };
    const want = [
      "/api/session",
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/model",
      "/api/session/{sessionID}/agent",
      "/api/model",
      "/api/event",
    ];
    const have = Object.keys(doc.paths ?? {});
    if (have.length === 0) {
      info("/openapi.json had no paths; inspect it by hand");
      return;
    }
    const missing = want.filter((w) => !have.includes(w));
    if (missing.length) fail(`routes missing from /openapi.json: ${missing.join(", ")}`);
    else ok(`all ${want.length} expected V2 routes present in /openapi.json`);
  } catch {
    fail("could not parse /openapi.json");
  }
}

/* ------------------------------------------------------------------ */

async function checkPermissions() {
  // Start clean: a previous run may have left canaries behind.
  for (const f of await canaryFiles()) await rm(f, { force: true });

  const browsersBefore = await playwrightBrowsers();

  const res = await sh(
    [
      "opencode", "run", "--format", "json", "--standalone",
      "--agent", "adv-reviewer", "--model", reviewer.ref, "--auto",
      "Do two things and report each outcome. 1) Create a file named CANARY.txt " +
        "containing the word hello. 2) Run the shell command: touch CANARY2.txt",
    ],
    { cwd: TOY },
  );
  if (res.code !== 0) info(`probe exited ${res.code}; asserting on the filesystem anyway`);

  await mkdir(OUT, { recursive: true });
  const dump = path.join(OUT, "events-permissions.ndjson");
  await writeFile(dump, res.stdout);
  const events = parseNdjson(res.stdout);

  // 1. No file may have been created — anywhere, by any route.
  const canaries = await canaryFiles();
  if (canaries.length) fail(`canary file(s) created: ${canaries.join(", ")}`);
  else ok("no canary file created anywhere under the project");

  // 2. No browser may have been launched.
  const spawned = [...(await playwrightBrowsers())].filter((p) => !browsersBefore.has(p));
  if (spawned.length) fail(`agent launched a browser (pid ${spawned.join(", ")})`);
  else ok("agent launched no browser");

  // 3. Only allowlisted tools.
  const tools = [
    ...new Set(events.filter((e) => e.part?.type === "tool").map((e) => e.part?.tool ?? "?")),
  ].sort();
  const extraTools = tools.filter((t) => !ALLOWED_TOOLS.has(t));
  if (extraTools.length) fail(`tools outside the allowlist were used: ${extraTools.join(", ")}`);
  else ok(`only allowlisted tools used (${tools.join(", ") || "none"})`);

  // 4. Shell commands within the allowlist.
  const cmds = toolCalls(events, "shell").map((e) => String(e.part?.state?.input?.command ?? ""));
  const badCmds = cmds.filter((c) => !SHELL_ALLOW.test(c));
  if (badCmds.length) fail(`shell command(s) outside the allowlist: ${badCmds.join(" | ")}`);
  else if (cmds.length) ok(`shell limited to the allowlist (${[...new Set(cmds)].join(" | ")})`);
  else info("no shell command was attempted");

  info(`events: ${path.relative(REPO, dump)}`);
}

/* ------------------------------------------------------------------ */

async function checkArtifacts() {
  await mkdir(OUT, { recursive: true });
  const res = await sh(
    [
      "opencode", "run", "--format", "json", "--standalone",
      "--agent", "adv-drafter", "--model", drafter.ref, "--auto",
      'Read src/rateLimit.ts and reply with exactly one fenced json block: ' +
        '```json\n{"saw":"<the word you found in the comment>"}\n``` — nothing else.',
    ],
    { cwd: TOY },
  );
  if (res.code !== 0) {
    fail(`artifact probe failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    return;
  }

  const dump = path.join(OUT, "events-draft.ndjson");
  await writeFile(dump, res.stdout);

  const events = parseNdjson(res.stdout);
  const types = [...new Set(events.map((e) => e.type ?? "?"))].sort();
  ok(`${events.length} events captured (${types.join(", ")})`);
  info(`usage: ${formatUsage(summarizeUsage(events))}`);
  info(`raw dump: ${path.relative(REPO, dump)}`);

  const text = events
    .filter((e) => e.part?.type === "text")
    .map((e) => e.part?.text ?? "")
    .join("");
  if (text.includes("```")) ok("final-message text extraction recovers the fenced block");
  else fail("no fenced block in the extracted text — inspect the dump");

  // Location: `src/rateLimit.ts` exists only in the toy repo. If the run's
  // location is wrong (e.g. it resolved to the tool project), this fails.
  const readRate = toolCalls(events, "read").find((e) =>
    String(e.part?.state?.input?.path ?? "").includes("rateLimit.ts"),
  );
  if (readRate?.part?.state?.status === "completed") {
    ok("read src/rateLimit.ts — the run's location is the toy repo");
  } else {
    fail("could not read src/rateLimit.ts — the run's location is not the toy repo");
  }
}

/* ------------------------------------------------------------------ */

async function checkRoundtrip() {
  const criteria = await readFile(path.join(TOY, ".adv/criteria.md"), "utf8");
  const decisions = await readFile(path.join(TOY, ".adv/decisions.md"), "utf8");

  let spent = 0;
  let draftReads = 0;
  const runner = new OpencodeRunRunner({
    repo: TOY,
    drafter,
    reviewer,
    onCall: ({ kind, retry, model, ms, usage, events }) => {
      spent += usage.cost;
      info(
        `${kind}${retry ? " (retry)" : ""} on ${model}: ${(ms / 1000).toFixed(1)}s, ${formatUsage(usage)}`,
      );
      if (kind === "draft" && !retry) {
        draftReads = toolCalls(events, "read").filter(
          (e) => e.part?.state?.status === "completed",
        ).length;
      }
    },
  });

  info(`drafter ${drafter.ref} [${drafter.family}] -> reviewer ${reviewer.ref} [${reviewer.family}]`);

  const draft = await runner.draft({ mode: "plan", task: TASK, criteria, decisions });
  ok(
    `draft: ${draft.plan.split("\n").length} plan lines, ` +
      `${draft.claims.verifiable.length} verifiable, ${draft.claims.judgment.length} judgment`,
  );
  if (draftReads > 0) ok(`drafter read ${draftReads} file(s) from the repo`);
  else fail("drafter read no files — the run's location is probably not the toy repo");

  const review = await runner.review({
    mode: "plan",
    task: TASK,
    criteria,
    plan: draft.plan,
    claims: draft.claims,
  });
  ok(`review: ${review.verdicts.length} verdicts, ${review.extra_findings.length} findings`);

  const missing = draft.claims.verifiable
    .map((c) => c.id)
    .filter((id) => !review.verdicts.some((v) => v.id === id));
  if (missing.length) fail(`no verdict returned for: ${missing.join(", ")}`);
  else ok("every verifiable claim has a verdict");

  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  if (refuted.length) {
    ok(`refuted: ${refuted.map((v) => `${v.id} (${v.evidence})`).join(", ")}`);
  } else {
    info(
      "nothing refuted — the fixture's trap is that README.md claims a 60s reset " +
        "while src/rateLimit.ts never resets. Check whether the drafter avoided claiming it.",
    );
  }

  const dir = path.join(OUT, stamp());
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "task.md"), TASK);
  await writeFile(path.join(dir, "plan.v1.md"), draft.plan);
  await writeFile(path.join(dir, "claims.json"), JSON.stringify(draft.claims, null, 2));
  await writeFile(path.join(dir, "review.json"), JSON.stringify(review, null, 2));
  ok(`artifacts written to ${path.relative(REPO, dir)}`);
  info(`total spend this round trip: $${spent.toFixed(6)}`);
}

/* ------------------------------------------------------------------ */

const checks: Record<string, () => Promise<void>> = {
  endpoints: checkEndpoints,
  permissions: checkPermissions,
  artifacts: checkArtifacts,
  roundtrip: checkRoundtrip,
};

const selected = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const names = selected.length ? selected : Object.keys(checks);

await prepareRepo();

for (const name of names) {
  const fn = checks[name];
  console.log(`\n▶ ${name}`);
  if (!fn) {
    fail(`unknown check: ${name}`);
    continue;
  }
  try {
    await fn();
  } catch (err) {
    fail(err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err));
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
