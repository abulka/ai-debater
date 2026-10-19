/**
 * Ping a model: is it reachable, on this account, today?
 *
 * Everything else `adv` knows about a model is a claim. The catalogue says what
 * it costs and whether it can call tools. `opencode models` says it exists. Both
 * are upstream data filtered by which *providers* hold a credential, and
 * `docs/OPENCODE-MODELS.md` has the receipts: that list disagrees with Groq's
 * own `/models` endpoint in both directions, offering four models the key
 * cannot call and hiding four it can. Only a real call settles it.
 *
 * **The ping runs through `OpencodeRunRunner.call()`** — the same
 * `--standalone`, the same `PWD`, the same injected `OPENCODE_CONFIG_CONTENT`,
 * the same error text. A probe on different plumbing than the run would be a
 * lie: it would pass models whose only real failure is that the agent
 * definitions never reached the child.
 *
 * Two depths, because they cost different amounts and answer different
 * questions:
 *
 * - `cheap` — `adv-writer`, "Reply with exactly: ok", no tools. Seconds. Catches
 *   an exhausted account, a retired model, a blocked one, and a throttled key.
 *   Also proves the agent definitions arrived.
 * - `full` — `adv-drafter` in the repository, forced to make one tool call. The
 *   only thing that catches a model which answers but cannot actually work as a
 *   drafter: gpt-oss invents a `search` tool that does not exist, and OpenCode
 *   rejects the turn. Names the agent it used, because in answer mode the
 *   drafter is `DENY_ALL` and a tool call would prove nothing.
 *
 * Results are classified rather than pass/fail, because "it did not work" is not
 * actionable and every failure mode `adv` has ever hit is distinguishable from
 * the provider's own words.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpencodeRunRunner } from "./runners/opencode-run.ts";
import { advDataRoot } from "./orchestrator.ts";

export type VerdictKind =
  | "ok"
  | "no-access"
  | "no-credit"
  | "not-yet"
  | "blocked"
  | "app-only"
  | "throttled"
  | "no-tools"
  | "timeout"
  | "failed";

export interface Verdict {
  kind: VerdictKind;
  /** One line, human-facing. The reason a verdict exists rather than a boolean. */
  detail: string;
  /** For `ok`: how long the call took. */
  ms?: number;
}

/**
 * The failure modes, most specific first.
 *
 * Order matters: an exhausted OpenRouter account answers `402` *and* mentions
 * the model, and "no credit" is the answer that tells the reader what to do. A
 * bare substring search in the other order reports the wrong cause and sends
 * someone looking for a retired model that is perfectly healthy.
 */
const RULES: { kind: VerdictKind; re: RegExp; detail: string }[] = [
  {
    kind: "no-credit",
    re: /credit_balance_exhausted|insufficient[_ ]?(quota|credit|funds)|402|payment required|billing/i,
    detail: "no credit on this account",
  },
  {
    kind: "not-yet",
    re: /model_coming_soon|model not (yet )?(available|released)|coming soon/i,
    detail: "not available yet",
  },
  {
    kind: "no-access",
    // `no-route` is OpenCode's own refusal — it will not hand the model to a
    // provider at all — and it means what a provider's `model_not_found` means.
    // Both are "listed, but this account cannot call it", both are answered by
    // the same question, so they are one verdict rather than two.
    re: /model_not_found|does not exist or you do not have access|no access to model|model .*not found|not available for (your|this) (account|plan|tier)|provider\.no-route|model unavailable/i,
    detail: "listed, but this account cannot call it",
  },
  {
    kind: "app-only",
    // The one failure that looks like success. These models work perfectly in
    // the OpenCode app — the reader has used them there — and the free tier
    // refuses them from a terminal, which is the only way `adv` can call
    // anything. Observed on `opencode/mimo-v2.6-flash-free`,
    // `opencode/big-pickle` and `opencode/space-bunny-free`.
    //
    // It is its own verdict rather than a flavour of `blocked` because the
    // remedy is opposite: nothing is wrong with the model or the account, and
    // nothing the reader does to their settings will change it.
    re: /FreeTierError|free tier can only be used from within/i,
    detail: "works in the OpenCode app, but its free tier refuses calls from a terminal, so adv cannot use it",
  },
  {
    kind: "blocked",
    re: /privacy|opt[- ]?in|train(s|ing)? on (your )?(request|prompt|data)|data (retention|training) policy/i,
    detail: "blocked by an account setting",
  },
  {
    kind: "throttled",
    re: /rate.?limit|too many requests|429|overloaded|quota exceeded/i,
    detail: "reachable, but throttled",
  },
  {
    kind: "no-tools",
    re: /tool_use_failed|attempted to call tool|which was not in request\.tools|failed_generation/i,
    detail: "answers, but cannot use the tools an agent needs",
  },
  {
    kind: "timeout",
    re: /timed out after \d+ms/,
    detail: "no answer inside the time limit",
  },
];

/**
 * Read a verdict out of whatever the call produced.
 *
 * `ms` present means the call completed, which is success — so success is
 * decided by the caller and never guessed from the reply. The first version
 * sniffed for the literal word "ok" in the model's output, which is right for
 * `Reply with exactly: ok` and wrong for everything else: a full ping that
 * successfully read `README.md` and answered `# adv — adversarial two-model
 * plan review` was reported as **failed**, with a useful-looking line of its own
 * output quoted as the reason. A model's prose is not a status field.
 *
 * `detail` is the raw tail, truncated, for the cases where the rules have
 * nothing to say — an unrecognised failure is still worth seeing verbatim.
 */
export function classify(text: string, ms?: number): Verdict {
  if (ms !== undefined) return { kind: "ok", detail: "replied", ms };
  for (const rule of RULES) {
    if (rule.re.test(text)) return { kind: rule.kind, detail: rule.detail };
  }
  return { kind: "failed", detail: tail(text) };
}

/**
 * The end of a failure, so `?` can show what actually happened.
 *
 * **Keeps the end, not the start.** `opencode run --format json` emits one very
 * long line, so the first 240 characters are `{"type":"step_start","timestamp"…`
 * and the reason the call failed — which arrives last, in a trailing `error`
 * object — is not in the window at all. The first version sliced from the front
 * and reported `opencode run exited 1 {"type":"step_start",…` for a model that
 * had in fact answered with a precise `FreeTierError`. Truncation from the
 * front of a tail is a way of losing the only sentence that mattered.
 */
export const tail = (text: string, max = 240): string => {
  const lines = text.trim().split("\n").filter((l) => l.trim().length);
  const last = lines.slice(-4).join(" ").trim();
  if (!last) return "no output";
  return last.length > max ? `…${last.slice(last.length - max + 1)}` : last;
};

/* ------------------------------------------------------------------ */

export interface PingOptions {
  /** The repository a `full` ping reads. Ignored by `cheap`. */
  repo: string;
  kind: "cheap" | "full";
  timeoutMs?: number;
  /** Set false to classify without recording — used by the tests. */
  record?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The prompt each depth sends. Both ask for one thing, which is where models get flaky. */
const PROMPTS = {
  cheap: "Reply with exactly: ok",
  // The tool call is the point: a model that cannot call tools fails here and
  // nowhere else until the first real run.
  full: [
    "Use your file tools to read the first 20 lines of README.md in the current",
    "directory. Then reply with exactly one line: either the first heading you",
    "found, or NO README if there is no README.md. Do not use any other tool.",
  ].join(" "),
};

const AGENTS = { cheap: "adv-writer", full: "adv-drafter" } as const;

/**
 * Ping one model and record the result.
 *
 * A run of the ping is a real model call and costs tokens. Nothing here fires
 * without a keypress: the TUI's `P`/`T`, `adv ping`, and the ping-all's `y` on
 * an armed list are the only callers.
 */
export async function pingModel(ref: string, opts: PingOptions): Promise<Verdict> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The runner is how a run reaches a model, so it is how a ping does too.
  const runner = new OpencodeRunRunner({
    repo: opts.repo,
    drafter: { ref, family: "" },
    reviewer: { ref, family: "" },
    timeoutMs,
  });

  const t0 = Date.now();
  let verdict: Verdict;
  try {
    const call = await runner.call({
      model: ref,
      agent: AGENTS[opts.kind],
      message: PROMPTS[opts.kind],
      cwd: opts.repo,
    });
    const ms = Date.now() - t0;
    // A full ping's question is not "did it reply" but "did it reach for a
    // tool". A model that answers from memory without calling `read` would pass
    // a prose check and then fail the first real run, which is the whole reason
    // this depth exists — so the event stream, not the wording, decides.
    const usedTool = call.events.some((e) => e.part?.type === "tool");
    if (opts.kind === "full" && call.text.trim() && !usedTool) {
      verdict = {
        kind: "no-tools",
        detail: "answered without reaching for a tool — it will not work as a drafter",
      };
    } else if (call.text.trim()) {
      verdict = classify(call.text, ms);
    } else {
      // Ran, exited clean, said nothing.
      verdict = { kind: "failed", detail: `no reply (${call.usage.steps} step(s))` };
    }
  } catch (err) {
    verdict = classify(err instanceof Error ? err.message : String(err));
    if (verdict.kind === "ok") verdict = { kind: "failed", detail: tail(String(err)) };
  }

  if (opts.record !== false) await recordProbe(ref, verdict, probesFile(), opts.kind);
  return verdict;
}

/* ------------------------------------------------------------------ */

/**
 * Probe results, in the data root beside the runs.
 *
 * Not beside the pairs (`~/.config/adv/pairs.json`). A pair is something the
 * reader chose and meant; a probe is an observation about their account that
 * goes stale on its own. Different lifetimes, different files.
 *
 * Successes are trusted for a week, failures for a day: a `402` becomes a pass
 * the moment credit is added, which can happen at any time.
 */
export const probesFile = (): string => path.join(advDataRoot(), "probes.json");

export const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FAIL_TTL_MS = 24 * 60 * 60 * 1000;
/** Anything older than this is pruned on the next write, whatever its TTL. */
export const PRUNE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProbeRecord {
  at: string;
  verdict: Verdict;
  /**
   * Which depth produced this. `full` supersedes `cheap`: it proves more, so a
   * record from it replaces one from `cheap` rather than being a second opinion
   * beside it.
   */
  depth?: "cheap" | "full";
}

export type ProbeCache = Record<string, ProbeRecord>;

/** Defensive: a malformed file is no probes, never a throw. */
export async function loadProbes(file: string = probesFile()): Promise<ProbeCache> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ProbeCache = {};
    for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as {
        at?: unknown;
        depth?: unknown;
        verdict?: { kind?: unknown; detail?: unknown; ms?: unknown };
      };
      if (typeof v.at !== "string" || typeof v.verdict?.kind !== "string") continue;
      out[ref] = {
        at: v.at,
        // Depth must survive the read. `recordProbe` reads the whole file before
        // writing one entry back, so a field the reader drops is a field that
        // every subsequent write erases — which is exactly how `depth` came to
        // be missing from every record and the row never showed its `T`.
        ...(v.depth === "cheap" || v.depth === "full" ? { depth: v.depth } : {}),
        verdict: {
          kind: v.verdict.kind as VerdictKind,
          detail: typeof v.verdict.detail === "string" ? v.verdict.detail : "",
          ...(typeof v.verdict.ms === "number" ? { ms: v.verdict.ms as number } : {}),
        },
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function recordProbe(
  ref: string,
  verdict: Verdict,
  file: string = probesFile(),
  depth: "cheap" | "full" = "cheap",
): Promise<void> {
  const cache = await loadProbes(file);
  const at = new Date().toISOString();
  cache[ref] = { at, verdict, depth };
  const cutoff = Date.now() - PRUNE_MS;
  for (const [key, rec] of Object.entries(cache)) {
    const when = Date.parse(rec.at);
    if (!Number.isFinite(when) || when < cutoff) delete cache[key];
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`);
}

/** Whether a record is still worth showing. */
export const isFresh = (rec: ProbeRecord, now = Date.now()): boolean => {
  const when = Date.parse(rec.at);
  if (!Number.isFinite(when)) return false;
  return now - when < (rec.verdict.kind === "ok" ? OK_TTL_MS : FAIL_TTL_MS);
};

/** `3h`, `6d` — short, because a badge is not a place for detail. */
export function ago(rec: ProbeRecord, now = Date.now()): string {
  const ms = now - Date.parse(rec.at);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * The verdict's short form, for a row.
 *
 * A row is one line or it is a bug — every scrolled pane here counts lines. The
 * sentences are up to forty characters and a badge column is twenty, so the row
 * gets the shape of the verdict and `?` gets the sentence.
 */
export const SHORT: Record<VerdictKind, string> = {
  ok: "ok",
  "no-access": "no access",
  "no-credit": "no credit",
  "not-yet": "not yet",
  blocked: "blocked",
  "app-only": "app only",
  throttled: "throttled",
  "no-tools": "no tools",
  timeout: "timeout",
  failed: "failed",
};

/**
 * Whether `adv` can actually use this model.
 *
 * `throttled` counts as usable: a rate limit is a bad moment, not a bad model.
 * `app-only` does not, and that is the whole point of separating it — it works
 * for the reader in the app, which is exactly the confusion it exists to name.
 */
export const isUsable = (v: Verdict): boolean => v.kind === "ok" || v.kind === "throttled";

/**
 * The row badge, or `null` when there is nothing to say.
 *
 * A badge always carries its age. `✓` on its own claims a fact about a model
 * that may have changed since the run — which is the entire reason the ping
 * exists — and a reader has no way to see how old it is.
 *
 * It also carries **which depth answered**, because that is the difference
 * between `P` and `T` and the footer cannot keep saying it: `✓ 2.6s` is "it
 * replies", `✓ 5.6s T` is "it replies *and* reached for a tool". A cheap-only
 * pass shows `T?`, so the row itself says the stronger question is still open.
 */
export function probeBadge(
  cache: ProbeCache,
  ref: string,
  now = Date.now(),
): { badge: string; stale: boolean; rec?: ProbeRecord } | null {
  const rec = cache[ref];
  if (!rec) return null;
  const age = ago(rec, now);
  const stale = !isFresh(rec, now);
  // A record written before depths were recorded is treated as cheap: that is
  // what it was.
  const full = rec.depth === "full";
  if (rec.verdict.kind === "ok") {
    const how = rec.verdict.ms ? `${(rec.verdict.ms / 1000).toFixed(1)}s` : "ok";
    const mark = stale ? `${age} ago` : `${how}${full ? " T" : ""}`;
    return { badge: `✓ ${mark}`, stale, rec };
  }
  return { badge: `✗ ${SHORT[rec.verdict.kind] ?? rec.verdict.kind}`, stale, rec };
}

/**
 * The hint for a row nobody has pinged, or has only tested cheaply.
 *
 * The picker's blank status column was doing no work: the reader could not tell
 * an untested model from a clean one, and the footer had to carry the difference
 * between `P` and `T` in two words. Both live in the row now.
 */
export function probeHint(cache: ProbeCache, ref: string): string {
  const rec = cache[ref];
  if (!rec) return "P to test";
  if (rec.depth === "full" || rec.verdict.kind !== "ok") return "";
  return "T? try tools";
}

/** Every failure on record, newest first — what the provider pane spells out. */
export function failedProbes(
  cache: ProbeCache,
): { ref: string; at: string; verdict: Verdict }[] {
  return Object.entries(cache)
    .filter(([, rec]) => !isUsable(rec.verdict))
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .map(([ref, rec]) => ({ ref, at: rec.at, verdict: rec.verdict }));
}

/**
 * What fraction of what has been tested has failed.
 *
 * Without this the provider pane's failure list reads as "these were the only
 * failures", which is the reading that makes a five-line list look like a
 * complete survey. It is not: it is five failures out of however many models
 * have been pinged, and the untested ones are the large majority.
 */
export function probeCoverage(cache: ProbeCache): { tested: number; failed: number } {
  const entries = Object.entries(cache);
  return {
    tested: entries.length,
    failed: entries.filter(([, rec]) => !isUsable(rec.verdict)).length,
  };
}
