/**
 * Artificial Analysis, direct: the keyed source for the picker's benchmark
 * column (`src/benchmarks.ts` owns the matching, the cache, and the merge).
 *
 * One key, four requests: `GET /api/v2/language/models/free` lists all ~700
 * models at 200 per page (`page_size` is capped server-side — asking for more
 * still returns 200). The legacy `/api/v2/data/llms/models` path returns
 * `410 Gone` after 4 Nov 2026; this module never calls it.
 *
 * Quota is 100 requests per 24h window on a free key (verified in the
 * response headers, October 2026 — not the 1000 the old docs claimed). A
 * full refresh costs 4, a verification costs 1, and the window is shared
 * across the whole key scope. On 429 the module reports the reset time and
 * never retries blindly.
 */

import type { BenchmarkEntry, Benchmarks } from "./benchmarks.ts";
import {
  OPENROUTER_MODELS_URL,
  benchmarksFile,
  buildIndex,
  fetchBenchmarks,
  mergeIndexes,
  saveScores,
} from "./benchmarks.ts";
import { loadAAKey } from "./aa-key.ts";

/** The free language-models list. Paginated at 200/page; `page_size` is capped. */
export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/language/models/free";

/** Safety bound: ~700 models at 200/page is 4; 10 is giving up, not trying. */
const MAX_PAGES = 10;

export interface AAQuota {
  /** Requests allowed in the current window, per `X-RateLimit-Limit`. */
  limit: number | null;
  /** Requests left, per `X-RateLimit-Remaining`. */
  remaining: number | null;
  /** ISO time the window resets, per `X-RateLimit-Reset`. */
  reset: string | null;
}

export interface AAMeta {
  /** The subscription tier that served the request: `free`, `pro`, … */
  tier: string | null;
  /** The Intelligence Index version, e.g. "4.3". The relay never carries this. */
  version: string | null;
  quota: AAQuota;
}

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const header = (res: Response, name: string): string | null => {
  const v = res.headers.get(name);
  return v && v.trim() ? v.trim() : null;
};

const numHeader = (res: Response, name: string): number | null => {
  const v = header(res, name);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function metaOf(res: Response, body: { tier?: unknown; intelligence_index_version?: unknown }): AAMeta {
  const reset = numHeader(res, "x-ratelimit-reset");
  return {
    tier:
      header(res, "x-aa-tier") ??
      (typeof body.tier === "string" && body.tier ? body.tier : null),
    version:
      typeof body.intelligence_index_version === "number" &&
      Number.isFinite(body.intelligence_index_version)
        ? String(body.intelligence_index_version)
        : null,
    quota: {
      limit: numHeader(res, "x-ratelimit-limit"),
      remaining: numHeader(res, "x-ratelimit-remaining"),
      reset: reset ? new Date(reset * 1000).toISOString() : null,
    },
  };
}

/**
 * Parse one AA list payload. Total: anything else-shaped is no entries, which
 * merges to nothing rather than failing the refresh — the same contract
 * `parseBenchmarks` keeps.
 */
export function parseAAPayload(raw: string): BenchmarkEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const entries: BenchmarkEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { slug, name, evaluations, artificial_analysis_intelligence_index_cost } = item as {
      slug?: unknown;
      name?: unknown;
      evaluations?: unknown;
      artificial_analysis_intelligence_index_cost?: unknown;
    };
    if (typeof slug !== "string" || !slug.trim()) continue;
    if (!evaluations || typeof evaluations !== "object" || Array.isArray(evaluations)) continue;
    const ev = evaluations as Record<string, unknown>;
    const scores = {
      ...(finite(ev["artificial_analysis_intelligence_index"]) !== undefined
        ? { intelligence: finite(ev["artificial_analysis_intelligence_index"])! }
        : {}),
      ...(finite(ev["artificial_analysis_coding_index"]) !== undefined
        ? { coding: finite(ev["artificial_analysis_coding_index"])! }
        : {}),
      ...(finite(ev["artificial_analysis_agentic_index"]) !== undefined
        ? { agentic: finite(ev["artificial_analysis_agentic_index"])! }
        : {}),
    };
    if (scores.intelligence === undefined && scores.coding === undefined && scores.agentic === undefined)
      continue;
    // Measured $/task for one Intelligence Index task. The free tier exposes
    // `total_cost` under `cost_per_task`; the per-input/answer split is Pro.
    // Absent on older payloads — then the entry simply has no task cost.
    const costBlock =
      artificial_analysis_intelligence_index_cost &&
      typeof artificial_analysis_intelligence_index_cost === "object" &&
      !Array.isArray(artificial_analysis_intelligence_index_cost)
        ? (artificial_analysis_intelligence_index_cost as Record<string, unknown>)
        : null;
    const perTask =
      costBlock && costBlock["cost_per_task"] && typeof costBlock["cost_per_task"] === "object"
        ? finite((costBlock["cost_per_task"] as Record<string, unknown>)["total_cost"])
        : undefined;
    entries.push({
      id: slug,
      scores,
      source: "aa",
      ...(typeof name === "string" && name ? { name } : {}),
      ...(perTask !== undefined ? { taskCost: perTask } : {}),
    });
  }
  return entries;
}

export interface AAPage {
  entries: BenchmarkEntry[];
  meta: AAMeta;
  /** Whether another page follows. */
  hasMore: boolean;
}

async function fetchAAPage(key: string, page: number, timeoutMs: number): Promise<AAPage> {
  let res: Response;
  try {
    res = await fetch(`${AA_MODELS_URL}?page=${page}`, {
      headers: { Accept: "application/json", "User-Agent": "adv-benchmarks", "x-api-key": key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`AA fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) throw new Error("AA key rejected (401) — the API did not accept it");
  if (res.status === 403)
    throw new Error("AA fetch forbidden (403) — the key's tier does not cover this endpoint");
  if (res.status === 429) {
    const retry = header(res, "retry-after");
    throw new Error(
      `AA rate limit reached (429)${retry ? ` — retry after ${retry}s` : ""} — the window resets, nothing was rewritten`,
    );
  }
  if (!res.ok) throw new Error(`AA fetch failed: HTTP ${res.status}`);
  const raw = await res.text();
  let body: { pagination?: unknown; tier?: unknown; intelligence_index_version?: unknown } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error("AA fetch failed: unparseable payload");
  }
  const pagination =
    body.pagination && typeof body.pagination === "object" && !Array.isArray(body.pagination)
      ? (body.pagination as { has_more?: unknown })
      : {};
  return { entries: parseAAPayload(raw), meta: metaOf(res, body), hasMore: pagination.has_more === true };
}

export interface AAFetched {
  entries: BenchmarkEntry[];
  meta: AAMeta;
  pages: number;
}

/** Every page, in order. One quota unit per page. */
export async function fetchAAAll(key: string, timeoutMs = 30_000): Promise<AAFetched> {
  const entries: BenchmarkEntry[] = [];
  let meta: AAMeta = { tier: null, version: null, quota: { limit: null, remaining: null, reset: null } };
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const fetched = await fetchAAPage(key, page, timeoutMs);
    entries.push(...fetched.entries);
    meta = fetched.meta;
    pages = page;
    if (!fetched.hasMore) break;
  }
  return { entries, meta, pages };
}

export interface AAVerified extends AAMeta {
  /** Scored models on the first page: proof the key reads data, not just auth. */
  models: number;
}

/**
 * One request: does this key work, what tier is it, and what is left of the
 * window? Verify before saving, so the key file only holds accepted keys —
 * except 429, which proves the key and spends the window, so callers save it
 * anyway and report the reset.
 */
export async function verifyAAKey(key: string, timeoutMs = 30_000): Promise<AAVerified> {
  const page = await fetchAAPage(key.trim(), 1, timeoutMs);
  return { ...page.meta, models: page.entries.length };
}

export interface RefreshedBenchmarks {
  scores: Benchmarks;
  at: string;
  indexVersion: string | null;
  /** Index entries per source — the merge, not the listing. */
  aaCount: number;
  orCount: number;
  /** False for a source that failed: the merge used what succeeded. */
  aaOk: boolean;
  orOk: boolean;
  /** False when no key is stored: AA was never attempted. */
  aaKey: boolean;
  /** The freshest quota seen, or null when neither response carried one. */
  quota: AAQuota | null;
  /** What did not make it into the merge, for the notice. */
  warnings: string[];
}

/**
 * Refresh the cache from every available source: AA when a key is stored,
 * the OpenRouter relay always. AA-first merge, one cache write. Throws only
 * when every source failed — callers report it and keep the old cache.
 */
export async function refreshAllBenchmarks(
  file: string = benchmarksFile(),
  timeoutMs = 30_000,
): Promise<RefreshedBenchmarks> {
  const key = await loadAAKey();
  const warnings: string[] = [];
  let or: Benchmarks | null = null;
  try {
    // fetchBenchmarks writes the relay-only cache as a side effect; the
    // merged write below replaces it in the same refresh.
    or = (await fetchBenchmarks(OPENROUTER_MODELS_URL, file, timeoutMs)).scores;
  } catch (err) {
    warnings.push(`relay: ${err instanceof Error ? err.message : String(err)}`);
  }
  let aa: Benchmarks | null = null;
  let meta: AAMeta | null = null;
  if (key) {
    try {
      const fetched = await fetchAAAll(key, timeoutMs);
      aa = buildIndex(fetched.entries);
      meta = fetched.meta;
    } catch (err) {
      warnings.push(`AA: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!aa && !or) throw new Error(warnings.join(" · ") || "no benchmark source responded");
  const scores = aa && or ? mergeIndexes(aa, or) : (aa ?? or)!;
  const at = new Date().toISOString();
  const indexVersion = meta?.version ?? null;
  await saveScores(scores, at, file, indexVersion);
  let aaCount = 0;
  let orCount = 0;
  for (const entry of scores.byId.values()) {
    if (entry.source === "aa") aaCount++;
    else orCount++;
  }
  return {
    scores,
    at,
    indexVersion,
    aaCount,
    orCount,
    aaOk: aa !== null,
    orOk: or !== null,
    aaKey: key !== null,
    quota: meta?.quota ?? null,
    warnings,
  };
}
