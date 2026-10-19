/**
 * Benchmark scores for the model picker, relayed keyless via OpenRouter.
 *
 * Artificial Analysis publishes an Intelligence Index and a Coding Index that
 * absorb LiveCodeBench, SciCode and Terminal-Bench internally, so one number
 * covers what would otherwise be three sources. Their own API needs a signup
 * key (`401 API key is required`, verified October 2026), but OpenRouter
 * relays the same three indices — intelligence, coding, agentic — under
 * `benchmarks.artificial_analysis` on its keyless `GET /api/v1/models`.
 * No auth, one request, ~471 models. That is the source, and the keyed API
 * stays unwired until the relay proves too thin.
 *
 * Matching is the whole design. `adv` says `opencode-go/glm-5.3-flash`;
 * OpenRouter says `z-ai/glm-5.3-flash`. The bridge is models.dev's
 * `canonical_model_id`, which OpenCode already caches and `catalogue.ts`
 * carries. A slug match would silently attach one model's score to another —
 * the exact `model.json`/`models.json` failure this repo already documents —
 * so resolution is two tiers with no guessing. Tier 1 is the exact normalised
 * canonical id. Tier 2 drops the provider namespace (`zhipuai/glm-5.3-flash`
 * → `glm-5.3-flash`) and matches only when that bare part is unique across
 * the whole index — measured zero collisions, so the check costs nothing and
 * is insurance for the day one appears. Both tiers mark anything that needed
 * normalisation `≈` rather than assuming it. Ambiguity resolves to nothing:
 * two OpenRouter ids collapsing to one key with different scores is a guess,
 * and the row would rather be blank.
 *
 * Scores are observations, cached beside the probes with their own lifetime.
 * A benchmark number without its date is a claim about today, so the fetch
 * date is always carried and always shown.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { advDataRoot } from "./orchestrator.ts";
import type { Catalogue } from "./catalogue.ts";

/** The three Artificial Analysis indices OpenRouter relays. All optional. */
export interface BenchmarkScores {
  intelligence?: number;
  coding?: number;
  agentic?: number;
}

export interface BenchmarkEntry {
  /** The OpenRouter id the scores came attached to. */
  id: string;
  scores: BenchmarkScores;
}

/**
 * The resolved index. `byId` is keyed by normalised full id; `byBare` maps a
 * bare model part to its full-id key, only when unique across the index.
 * Built once per parse or load, so a row never rebuilds it per keystroke.
 */
export interface Benchmarks {
  byId: Map<string, BenchmarkEntry>;
  byBare: Map<string, string>;
}

/** An index with nothing in it. A factory, because a shared map would be shared state. */
export function emptyBenchmarks(): Benchmarks {
  return { byId: new Map(), byBare: new Map() };
}

/**
 * The model part of an id, without the provider namespace. `z-ai/glm-5.3`
 * and `zhipuai/glm-5.3` are the same weights under different namespaces;
 * this is what tier 2 matches on.
 */
export function bareOf(id: string): string {
  return normalizeId(id.split("/").slice(1).join("/"));
}

/** One keyless GET carries every benchmark. Nothing here spends a model call. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Refresh when the cache is older than this. A week: indices move on AA's own monthly-ish cadence. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Normalise an id for matching.
 *
 * Lowercase; `:batch`/`:free`/`:nitro` are pricing and routing variants of
 * the same weights, so they go; other suffixes (`:online`, `:extended`) may
 * change what the model is and stay. Dots become dashes because the two
 * sources disagree on `claude-haiku-5-5` vs `claude-haiku-5.5`.
 */
export function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/:(free|batch|nitro)$/, "")
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Parse OpenRouter's `/models` payload. Total: anything else-shaped is an
 * empty index, which degrades every row to blank rather than failing the
 * picker — the same contract `parseCatalogue` keeps. Index rules live in
 * `buildIndex`.
 */
export function parseBenchmarks(raw: string): Benchmarks {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyBenchmarks();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyBenchmarks();
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return emptyBenchmarks();

  const entries: BenchmarkEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, benchmarks } = item as { id?: unknown; benchmarks?: unknown };
    if (typeof id !== "string" || !id.trim()) continue;
    const aa =
      benchmarks && typeof benchmarks === "object" && !Array.isArray(benchmarks)
        ? (benchmarks as { artificial_analysis?: unknown }).artificial_analysis
        : undefined;
    if (!aa || typeof aa !== "object" || Array.isArray(aa)) continue;
    const a = aa as Record<string, unknown>;
    const scores: BenchmarkScores = {
      ...(finite(a["intelligence_index"]) !== undefined
        ? { intelligence: finite(a["intelligence_index"])! }
        : {}),
      ...(finite(a["coding_index"]) !== undefined ? { coding: finite(a["coding_index"])! } : {}),
      ...(finite(a["agentic_index"]) !== undefined ? { agentic: finite(a["agentic_index"])! } : {}),
    };
    if (scores.intelligence === undefined && scores.coding === undefined && scores.agentic === undefined)
      continue;
    entries.push({ id, scores });
  }

  return buildIndex(entries);
}

/**
 * One index from one entry list, whatever produced it — the parse above or
 * the cache below.
 *
 * Variants of one model (`:batch` beside the base) normalise together with
 * identical scores and keep the first id. Two *different* ids normalising
 * together with different scores are ambiguous, and the key is dropped
 * rather than guessed.
 *
 * `byBare` keeps a bare model part only when a single full-id key owns it:
 * two providers serving one model name is a guess, and tier 2 refuses it
 * rather than picking.
 */
export function buildIndex(entries: BenchmarkEntry[]): Benchmarks {
  const buckets = new Map<string, BenchmarkEntry[]>();
  for (const entry of entries) {
    const key = normalizeId(entry.id);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  const byId = new Map<string, BenchmarkEntry>();
  for (const [key, bucket] of buckets) {
    const first = bucket[0]!;
    const same = bucket.every(
      (e) =>
        e.scores.intelligence === first.scores.intelligence &&
        e.scores.coding === first.scores.coding &&
        e.scores.agentic === first.scores.agentic,
    );
    if (same) byId.set(key, first);
  }
  const owners = new Map<string, string>();
  const contested = new Set<string>();
  for (const key of byId.keys()) {
    const bare = bareOf(key);
    if (contested.has(bare)) continue;
    const owner = owners.get(bare);
    if (owner === undefined) owners.set(bare, key);
    else if (owner !== key) {
      owners.delete(bare);
      contested.add(bare);
    }
  }
  return { byId, byBare: owners };
}

export interface ResolvedBenchmark extends BenchmarkScores {
  /** The OpenRouter id the scores were read from, so a `≈` can be checked. */
  openrouterId: string;
  /** True when `-`/`.` normalisation was needed to match. A guess, marked. */
  normalised: boolean;
}

/**
 * Resolve an `adv` ref to scores via the catalogue's `canonical_model_id`.
 *
 * Two tiers: the exact normalised canonical id, then the bare model part
 * when it is unique across the index (`zhipuai/…` vs `z-ai/…`). Both tiers
 * mark anything needing normalisation `≈`. Null when the catalogue never
 * heard of the model, carries no canonical id, or nothing matches — and null
 * is blank in the row, never a 0, never a sibling model's number.
 */
export function scoresFor(
  catalogue: Catalogue,
  benchmarks: Benchmarks,
  ref: string,
): ResolvedBenchmark | null {
  const canonical = catalogue.get(ref)?.canonicalModelId;
  if (!canonical || !canonical.trim()) return null;
  const full = benchmarks.byId.get(normalizeId(canonical));
  if (full) {
    return {
      ...full.scores,
      openrouterId: full.id,
      normalised: full.id.toLowerCase() !== canonical.toLowerCase(),
    };
  }
  const key = benchmarks.byBare.get(bareOf(canonical));
  const bare = key ? benchmarks.byId.get(key) : undefined;
  if (!bare) return null;
  return { ...bare.scores, openrouterId: bare.id, normalised: true };
}

/**
 * The row badge: `I56 C78 A62`, only what exists. Blank when nothing — two
 * thirds of rows have no score, and `?` already means "unknown money".
 * Rounded to integers: the column is 14 wide and decimals buy nothing while
 * scanning.
 */
export function formatBenchmarks(s: BenchmarkScores): string {
  const parts: string[] = [];
  if (s.intelligence !== undefined) parts.push(`I${Math.round(s.intelligence)}`);
  if (s.coding !== undefined) parts.push(`C${Math.round(s.coding)}`);
  if (s.agentic !== undefined) parts.push(`A${Math.round(s.agentic)}`);
  const text = parts.join(" ");
  return text ? text : "";
}

/** `≈` marks a match that needed normalisation: a guess the reader can see. */
export function formatResolved(r: ResolvedBenchmark | null): string {
  if (!r) return "";
  const text = formatBenchmarks(r);
  return text ? (r.normalised ? `≈${text}` : text) : "";
}

/* ------------------------------------------------------------------ */

export const benchmarksFile = (): string => path.join(advDataRoot(), "benchmarks.json");

export interface LoadedScores {
  scores: Benchmarks;
  /** ISO fetch time, null when there is no cache. */
  at: string | null;
  ageMs: number | null;
}

/**
 * The cache, or an empty one. A malformed file is no scores, never a throw —
 * the picker renders blanks and carries on.
 */
export async function loadScores(file: string = benchmarksFile()): Promise<LoadedScores> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { scores: emptyBenchmarks(), at: null, ageMs: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { scores: emptyBenchmarks(), at: null, ageMs: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { scores: emptyBenchmarks(), at: null, ageMs: null };
  }
  const { at, scores } = value as { at?: unknown; scores?: unknown };
  const entries: BenchmarkEntry[] = [];
  if (scores && typeof scores === "object" && !Array.isArray(scores)) {
    for (const [id, s] of Object.entries(scores as Record<string, unknown>)) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const r = s as Record<string, unknown>;
      const entry: BenchmarkScores = {
        ...(finite(r["intelligence"]) !== undefined ? { intelligence: finite(r["intelligence"])! } : {}),
        ...(finite(r["coding"]) !== undefined ? { coding: finite(r["coding"])! } : {}),
        ...(finite(r["agentic"]) !== undefined ? { agentic: finite(r["agentic"])! } : {}),
      };
      if (
        entry.intelligence === undefined &&
        entry.coding === undefined &&
        entry.agentic === undefined
      )
        continue;
      entries.push({ id, scores: entry });
    }
  }
  const benchmarks = buildIndex(entries);
  const stamp = typeof at === "string" ? at : null;
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - (await stat(file)).mtimeMs;
  } catch {
    /* read it, could not stat it: no age to report, not a failure */
  }
  return { scores: benchmarks, at: stamp, ageMs };
}

/** True when there is no cache, its date is unreadable, or it is past the window. */
export function isStale(at: string | null, now = Date.now()): boolean {
  if (!at) return true;
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return true;
  return now - when > STALE_AFTER_MS;
}

export interface FetchedScores {
  scores: Benchmarks;
  at: string;
  /** OpenRouter entries carrying at least one index. */
  count: number;
}

/**
 * One keyless GET, then the cache is rewritten. Throws on network failure or
 * an unparseable payload — callers report it and keep the old cache.
 */
export async function fetchBenchmarks(
  url: string = OPENROUTER_MODELS_URL,
  file: string = benchmarksFile(),
  timeoutMs = 30_000,
): Promise<FetchedScores> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "adv-benchmarks" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      `benchmark fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new Error(`benchmark fetch failed: HTTP ${res.status}`);
  const scores = parseBenchmarks(await res.text());
  const at = new Date().toISOString();
  const serial: Record<string, BenchmarkScores> = {};
  for (const entry of scores.byId.values()) serial[entry.id] = entry.scores;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ at, scores: serial }, null, 2)}\n`);
  return { scores, at, count: scores.byId.size };
}

/** How many of these refs resolve to a score. What the refresh notice reports. */
export function countScored(refs: string[], catalogue: Catalogue, scores: Benchmarks): number {
  let n = 0;
  for (const ref of refs) if (scoresFor(catalogue, scores, ref)) n++;
  return n;
}
