/**
 * Benchmark scores for the model picker: Artificial Analysis indices, with
 * OpenRouter as the fallback and filler.
 *
 * Artificial Analysis publishes an Intelligence Index and a Coding Index that
 * absorb LiveCodeBench, SciCode and Terminal-Bench internally, so one number
 * covers what would otherwise be three sources. Their own API needs a signup
 * key, but OpenRouter relays the same three indices — intelligence, coding,
 * agentic — under `benchmarks.artificial_analysis` on its keyless
 * `GET /api/v1/models`. No auth, one request, ~470 models. So there are two
 * sources for the same numbers: AA direct (keyed, `src/artificialanalysis.ts`,
 * all ~700 models plus the index version OpenRouter never exposes) and the
 * OpenRouter relay (keyless, but a third party's copy, and missing models AA
 * retired). When a key is set, AA is the primary source and the relay fills
 * the gaps; without one the relay is the whole source, and the behaviour is
 * what it always was.
 *
 * Matching is the whole design. `adv` says `opencode-go/glm-5.3-flash`;
 * OpenRouter says `z-ai/glm-5.3-flash`; AA says `glm-5.3-flash` — a bare slug
 * with no namespace at all. The bridge is models.dev's `canonical_model_id`,
 * which OpenCode already caches and `catalogue.ts` carries. A slug match
 * would silently attach one model's score to another — the exact
 * `model.json`/`models.json` failure this repo already documents — so
 * resolution is suffix tiers with no guessing. Tier 1 is the exact normalised
 * canonical id. Tier 2 drops the provider namespace (`zhipuai/glm-5.3-flash`
 * → `glm-5.3-flash`) and matches only when that bare part is unique across
 * the whole index. Tier 3 runs the same suffix chain on the served ref
 * itself, for the refs models.dev knows nothing about. Tier 4 is what the
 * chain already does past one strip: `togetherai/deepseek-ai/…` still ends in
 * the model. Every tier past the first marks the match `≈` rather than
 * assuming it. Ambiguity resolves to nothing: two ids collapsing to one key
 * with different scores is a guess, and the row would rather be blank.
 *
 * AA publishes reasoning and non-reasoning variants of one model as separate
 * entries (`claude-opus-4-5` at 23.7 beside `claude-opus-4-5-thinking` at
 * 29.1). A group that names a reasoning variant resolves to it — `adv`
 * picks a drafter and a reviewer, and the reasoning number is what describes
 * the model in use — and the `≈` says a choice was made. A group with no
 * reasoning variant keeps the exact or base entry. Names come from the
 * source; an entry without one never triggers an override.
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
  /** The id the scores came attached to: an OpenRouter id or an AA slug. */
  id: string;
  scores: BenchmarkScores;
  /** Which source measured it. Required: a row should know its provenance. */
  source: "aa" | "openrouter";
  /** The source's display name, for variant preference. Absent on old caches. */
  name?: string;
  /**
   * Measured dollars per Intelligence Index task, AA only. The OpenRouter
   * relay never carries this. Verbosity and the tokenizer are already inside
   * it — it is what the benchmark run actually cost, not a price-list
   * projection — which is why the picker ranks on it rather than on t/s.
   */
  taskCost?: number;
}

/**
 * The resolved index. `byId` is keyed by normalised full id; `byBare` maps a
 * bare model part to its full-id key, only when unique across the index.
 * `variants` maps a variant-stripped key to the full-id keys of its group,
 * preferred representative first — built once per parse or load, so a row
 * never rebuilds it per keystroke.
 */
export interface Benchmarks {
  byId: Map<string, BenchmarkEntry>;
  byBare: Map<string, string>;
  variants: Map<string, string[]>;
}

/** An index with nothing in it. A factory, because a shared map would be shared state. */
export function emptyBenchmarks(): Benchmarks {
  return { byId: new Map(), byBare: new Map(), variants: new Map() };
}

/**
 * The model part of an id, without the provider namespace. `z-ai/glm-5.3`
 * and `zhipuai/glm-5.3` are the same weights under different namespaces;
 * this is what tier 2 matches on.
 *
 * A bare slug has no namespace to strip, so it is itself: AA ids arrive
 * without one, and returning "" here collapsed every one of them together.
 */
export function bareOf(id: string): string {
  const norm = normalizeId(id);
  const at = norm.indexOf("/");
  return at < 0 ? norm : norm.slice(at + 1);
}

/**
 * Every progressively shorter form of an id: the full id, then minus the
 * first namespace, and so on down to the bare model part. Tiers 2–4 are one
 * loop over this chain: each form is tried against the exact index, then the
 * unique bare shortcut, longest (most specific) first.
 */
export function suffixesOf(id: string): string[] {
  const parts = normalizeId(id)
    .split("/")
    .filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

/** Effort and mode suffixes that mark variants of one model, not a model. */
const VARIANT_SUFFIX = /-(thinking|reasoning|adaptive|non-reasoning|max|high|low|medium|preview|exp)$/;

/**
 * The base a variant belongs to: variant suffixes stripped from the last
 * segment, namespaces kept. Never strips to nothing — `max` alone is a name.
 */
export function baseKeyOf(key: string): string {
  const parts = key.split("/");
  const last = parts[parts.length - 1]!;
  let base = last;
  for (;;) {
    const m = VARIANT_SUFFIX.exec(base);
    if (!m) break;
    const next = base.slice(0, m.index);
    if (!next) {
      base = last;
      break;
    }
    base = next;
  }
  if (base === last) return key;
  return [...parts.slice(0, -1), base].join("/");
}

const NON_REASONING = /non-reasoning/i;
const REASONING = /reasoning|adaptive|\bmax\b/i;

/**
 * Order a variant group, preferred representative first. A group that names a
 * reasoning variant resolves to it (excluding `-non-reasoning` first, because
 * it contains the word "reasoning"); without one, the base slug wins, then
 * alphabetical. Deterministic: the same fetch always picks the same row.
 * Entries without names never trigger an override — only an exact or base
 * match survives.
 */
function preferVariants(keys: string[], byId: Map<string, BenchmarkEntry>): string[] {
  const entries = keys
    .map((k) => ({ key: k, entry: byId.get(k)! }))
    .filter((x) => x.entry !== undefined);
  const eligible = entries.filter((x) => !(x.entry.name && NON_REASONING.test(x.entry.name)));
  const pool = eligible.length > 0 ? eligible : entries;
  const flagged = pool.filter((x) => x.entry.name && REASONING.test(x.entry.name));
  const contenders = flagged.length > 0 ? flagged : pool;
  const isBase = (key: string) => baseKeyOf(key) === key;
  return [...contenders]
    .sort(
      (a, b) =>
        (isBase(a.key) ? 0 : 1) - (isBase(b.key) ? 0 : 1) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((x) => x.key);
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
    entries.push({ id, scores, source: "openrouter" });
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
 *
 * `variants` groups keys by their variant-stripped base, preferred
 * representative first. Single-member groups cost one map entry and change
 * nothing.
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
        e.scores.agentic === first.scores.agentic &&
        e.taskCost === first.taskCost,
    );
    if (same) byId.set(key, first);
  }
  const owners = new Map<string, string>();
  const contested = new Set<string>();
  for (const key of byId.keys()) {
    const bare = bareOf(key);
    if (!bare || contested.has(bare)) continue;
    const owner = owners.get(bare);
    if (owner === undefined) owners.set(bare, key);
    else if (owner !== key) {
      owners.delete(bare);
      contested.add(bare);
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of byId.keys()) {
    const base = baseKeyOf(key);
    const group = groups.get(base);
    if (group) group.push(key);
    else groups.set(base, [key]);
  }
  const variants = new Map<string, string[]>();
  for (const [base, keys] of groups) variants.set(base, preferVariants(keys, byId));
  return { byId, byBare: owners, variants };
}

/**
 * Merge two indexes, AA first. An OpenRouter entry is dropped when AA covers
 * the same model: same normalised key, or an AA key that is a trailing
 * segment-suffix of it (`deepseek-v4-1-flash` beats
 * `deepseek/deepseek-v4-1-flash`). Everything AA never heard of — retired
 * models included — survives. Rebuilds the bare and variant maps over the
 * union, so matching downstream never knows there were two sources; each
 * entry keeps its own `source`.
 */
export function mergeIndexes(aa: Benchmarks, or: Benchmarks): Benchmarks {
  const aaKeys = new Set(aa.byId.keys());
  const coveredByAA = (orKey: string): boolean => {
    const parts = orKey.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (aaKeys.has(parts.slice(i).join("/"))) return true;
    }
    return false;
  };
  const entries: BenchmarkEntry[] = [...aa.byId.values()];
  for (const [key, entry] of or.byId) {
    if (!aaKeys.has(key) && !coveredByAA(key)) entries.push(entry);
  }
  return buildIndex(entries);
}

export interface ResolvedBenchmark extends BenchmarkScores {
  /** The id the scores were read from, so a `≈` can be checked. */
  sourceId: string;
  /** Which source measured it: the row's provenance. */
  source: "aa" | "openrouter";
  /** True when `-`/`.` normalisation was needed to match. A guess, marked. */
  normalised: boolean;
  /** Measured $/task, when the entry carried one. Blank in the row, never 0. */
  taskCost?: number;
}

/**
 * Walk one id's suffix chain — full, then minus the first namespace, down to
 * the bare model part — trying each against the exact index and then the
 * unique bare shortcut. Longest (most specific) first, first hit wins.
 */
function resolveSuffixes(benchmarks: Benchmarks, id: string): BenchmarkEntry | null {
  const seen = new Set<string>();
  for (const form of suffixesOf(id)) {
    if (seen.has(form)) continue;
    seen.add(form);
    const full = benchmarks.byId.get(form);
    if (full) return full;
    const key = benchmarks.byBare.get(form);
    if (key) {
      const bare = benchmarks.byId.get(key);
      if (bare) return bare;
    }
  }
  return null;
}

/**
 * Resolve an `adv` ref to scores via the catalogue's `canonical_model_id`,
 * falling back to the served ref itself when models.dev knows nothing about
 * it.
 *
 * Tiers: the exact normalised canonical id, then its suffix chain, then the
 * served ref's own chain for refs with no canonical id (and as a second
 * chance when the canonical id matches nothing). Every tier past the first
 * marks `≈`. A variant group with a reasoning member resolves to it instead
 * of the matched entry, also marked. Null when nothing matches — and null is
 * blank in the row, never a 0, never a sibling model's number.
 */
export function scoresFor(
  catalogue: Catalogue,
  benchmarks: Benchmarks,
  ref: string,
): ResolvedBenchmark | null {
  const canonical = catalogue.get(ref)?.canonicalModelId;
  let entry: BenchmarkEntry | null = null;
  let lookup = ref;
  if (canonical && canonical.trim()) {
    entry = resolveSuffixes(benchmarks, canonical);
    if (entry) lookup = canonical;
  }
  if (!entry) {
    entry = resolveSuffixes(benchmarks, ref);
    lookup = ref;
  }
  if (!entry) return null;
  // A variant group that names a reasoning variant speaks through it: the
  // drafter and reviewer reason, so the reasoning number is what describes
  // the model in use. Anything else keeps the matched entry.
  let normalised = entry.id.toLowerCase() !== lookup.toLowerCase();
  const key = normalizeId(entry.id);
  const group = benchmarks.variants.get(baseKeyOf(key));
  if (group && group[0] !== key) {
    const preferred = benchmarks.byId.get(group[0]!);
    if (preferred) {
      entry = preferred;
      normalised = true;
    }
  }
  return {
    ...entry.scores,
    sourceId: entry.id,
    source: entry.source,
    normalised,
    ...(entry.taskCost !== undefined ? { taskCost: entry.taskCost } : {}),
  };
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

/**
 * Measured $/task for the row. Blank when unmeasured — an OpenRouter row
 * never has one, however cheap its list price, and blank is never 0.
 * Below half a cent the digits are noise, so the cell says what it means:
 * negligible, not zero.
 */
export function formatTaskCost(v: number | undefined): string {
  if (v === undefined) return "";
  if (v < 0.005) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */

export const benchmarksFile = (): string => path.join(advDataRoot(), "benchmarks.json");

export interface LoadedScores {
  scores: Benchmarks;
  /** ISO fetch time, null when there is no cache. */
  at: string | null;
  ageMs: number | null;
  /** The AA Intelligence Index version that measured these, null when unknown. */
  indexVersion: string | null;
}

/** One serial row: scores plus the provenance the old cache never kept. */
interface SerialEntry extends BenchmarkScores {
  source?: unknown;
  name?: unknown;
  taskCost?: unknown;
}

/**
 * The cache, or an empty one. A malformed file is no scores, never a throw —
 * the picker renders blanks and carries on. Reads caches written before
 * `source` and `indexVersion` existed: those rows are the relay's.
 */
export async function loadScores(file: string = benchmarksFile()): Promise<LoadedScores> {
  const empty = (): LoadedScores => ({
    scores: emptyBenchmarks(),
    at: null,
    ageMs: null,
    indexVersion: null,
  });
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return empty();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return empty();
  }
  const { at, scores, indexVersion } = value as {
    at?: unknown;
    scores?: unknown;
    indexVersion?: unknown;
  };
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
      const serial = s as SerialEntry;
      entries.push({
        id,
        scores: entry,
        source: serial.source === "aa" ? "aa" : "openrouter",
        ...(typeof serial.name === "string" && serial.name ? { name: serial.name } : {}),
        ...(finite(serial.taskCost) !== undefined ? { taskCost: finite(serial.taskCost)! } : {}),
      });
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
  return {
    scores: benchmarks,
    at: stamp,
    ageMs,
    indexVersion: typeof indexVersion === "string" && indexVersion ? indexVersion : null,
  };
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
  /** Entries carrying at least one index. */
  count: number;
  /** The AA Intelligence Index version, when the fetch carried one. */
  indexVersion: string | null;
}

/**
 * Rewrite the cache from a resolved index. One writer for every fetch path,
 * so the relay-only and the merged refreshes cannot drift apart. Caches
 * written by older versions load fine: they just have no source or version.
 */
export async function saveScores(
  scores: Benchmarks,
  at: string,
  file: string = benchmarksFile(),
  indexVersion: string | null = null,
): Promise<void> {
  const serial: Record<string, BenchmarkScores & { source?: string; name?: string; taskCost?: number }> = {};
  for (const entry of scores.byId.values()) {
    serial[entry.id] = {
      ...entry.scores,
      ...(entry.source === "aa" ? { source: "aa" as const } : {}),
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.taskCost !== undefined ? { taskCost: entry.taskCost } : {}),
    };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ at, scores: serial, ...(indexVersion ? { indexVersion } : {}) }, null, 2)}\n`,
  );
}

/**
 * The relay on its own: one keyless GET, then the cache is rewritten. Throws
 * on network failure or an unparseable payload — callers report it and keep
 * the old cache.
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
  await saveScores(scores, at, file);
  return { scores, at, count: scores.byId.size, indexVersion: null };
}

/** How many of these refs resolve, and from which source. */
export interface ScoredSplit {
  total: number;
  aa: number;
  openrouter: number;
}

export function countScoredBySource(
  refs: string[],
  catalogue: Catalogue,
  scores: Benchmarks,
): ScoredSplit {
  let aa = 0;
  let openrouter = 0;
  for (const ref of refs) {
    const r = scoresFor(catalogue, scores, ref);
    if (!r) continue;
    if (r.source === "aa") aa++;
    else openrouter++;
  }
  return { total: aa + openrouter, aa, openrouter };
}

/** How many of these refs resolve to a score. What the refresh notice reports. */
export function countScored(refs: string[], catalogue: Catalogue, scores: Benchmarks): number {
  return countScoredBySource(refs, catalogue, scores).total;
}
