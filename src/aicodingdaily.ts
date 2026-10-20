/**
 * AI Coding Daily's coding leaderboard: a third benchmark source for the
 * picker (`src/benchmarks.ts` owns the AA/OpenRouter matching and merge).
 *
 * ACD measures models through real agent harnesses (Codex CLI, Claude Code,
 * Cursor, Devin, OpenCode) on multi-file projects — Laravel code quality,
 * React-TS code quality, a bug-finding test and edge-case testing — for a
 * total-points score out of 70, plus a measured avg cost per prompt. That is
 * a coding-agentic score on a different scale from AA's Intelligence Index,
 * so it never folds into the intelligence ranking: it rides as its own `D`
 * badge beside the `I`/`C`/`A` one, and its cost rides in its own `prompt $`
 * column, never in `$/task` (one task definition per column).
 *
 * There is no JSON API — the data is one server-rendered HTML `<table>` at a
 * keyless GET. Each model cell links to `/model/<slug>`, which is the machine
 * id the resolver matches on, not the display name. Effort variants are
 * separate rows (`GPT-6-Luna (Max)` beside `(High)`); each slug keeps its
 * highest-points row — the model's ceiling — with that row's effort label
 * and harness.
 *
 * Matching reuses the suffix-chain idea with one extra tier, ACD-only: ACD
 * slugs drop the vendor word our refs carry (`opus-5-5` for
 * `anthropic/claude-opus-5-5`), which no `/`-segment suffix chain reaches,
 * so the last segment also tries trailing hyphen-boundary suffixes, longest
 * first, marked `≈` like every other guess. Anything unmatched stays blank.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { advDataRoot } from "./orchestrator.ts";
import { isStale, stripTier } from "./benchmarks.ts";
import type { Catalogue } from "./catalogue.ts";

/** The leaderboard. One keyless GET carries every scored model. */
export const ACD_URL = "https://aicodingdaily.com/leaderboard";

/** Refresh when the cache is older than this — the reader's window (settings), shared with the AA/OpenRouter cache. */
export { isStale as isAcdStale };

/** One model's ceiling row: highest total points across its effort variants. */
export interface AcdEntry {
  /** The `/model/<slug>` link: the matching key. */
  id: string;
  /** Total points, out of 70. */
  points: number;
  /** Measured avg cost per prompt on ACD's own coding suite. Absent when N/A. */
  costPerPrompt?: number;
  /** The winning row's effort label: `High`, `Max`, `Xhigh`, … */
  effort?: string;
  /** The harness that measured the winning row: `OpenCode`, `Claude Code`, … */
  harness?: string;
}

/** The resolved index, keyed by normalised slug. */
export interface AcdIndex {
  byId: Map<string, AcdEntry>;
}

/** An index with nothing in it. A factory, because a shared map would be shared state. */
export function emptyAcd(): AcdIndex {
  return { byId: new Map() };
}

/** Lowercase; dots become dashes because the two sides disagree on `5.5` vs `5-5`. */
export function normalizeAcdId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

/**
 * Every progressively shorter form of an id: the full id, then minus the
 * first namespace, down to the bare model part — then the bare part minus
 * its leading hyphen components, longest first. The `/` forms are the same
 * suffix chain `benchmarks.ts` matches on; the hyphen forms are the ACD-only
 * tier for vendor-dropped slugs (`claude-opus-5-5` → `opus-5-5`). A remainder
 * keeps at least two hyphen parts and a letter: a lone `5`, or digits-only
 * `5-5`, matches everything and means nothing.
 */
export function acdFormsOf(id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (form: string) => {
    if (form && !seen.has(form)) {
      seen.add(form);
      out.push(form);
    }
  };
  const parts = normalizeAcdId(id)
    .split("/")
    .filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) push(parts.slice(i).join("/"));
  const bare = parts.length > 0 ? parts[parts.length - 1]! : normalizeAcdId(id);
  const segs = bare.split("-").filter((s) => s.length > 0);
  for (let i = 1; i < segs.length; i++) {
    const rest = segs.slice(i).join("-");
    if (rest.split("-").length >= 2 && /[a-z]/.test(rest)) push(rest);
  }
  return out;
}

const stripComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, " ");

const stripTags = (html: string): string =>
  stripComments(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const EFFORT_RE = /\(([^)]+)\)\s*$/;

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Parse the leaderboard HTML. Total: anything else-shaped is an empty index,
 * which renders every row blank rather than failing the picker — the same
 * contract `parseBenchmarks` keeps. Rows without a `/model/<slug>` link are
 * skipped: the slug is the id, and a display name is not one.
 *
 * A zero-entry parse is still returned (the caller decides whether that is
 * "page restyled" and keeps the old cache). Column positions follow the
 * header: rank, model, points, avg cost, avg time, video, harness, then the
 * four per-project scores, which travel nowhere — the total is the score.
 */
export function parseACD(html: string): AcdIndex {
  const bySlug = new Map<string, AcdEntry>();
  const cleaned = stripComments(html);
  const rows = cleaned.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rows) {
    const slugMatch = /\/model\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)/.exec(row);
    if (!slugMatch) continue;
    const slug = slugMatch[1]!;
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]!));
    // Rank, model, points, cost, time, video, harness: seven before the projects.
    if (cells.length < 7) continue;
    const points = Number(cells[2]);
    if (!Number.isFinite(points)) continue;
    const costRaw = (cells[3] ?? "").replace(/^\$/, "").trim();
    const cost = costRaw && costRaw.toUpperCase() !== "N/A" ? Number(costRaw) : NaN;
    const effortMatch = EFFORT_RE.exec(cells[1] ?? "");
    const candidate: AcdEntry = {
      id: slug,
      points,
      ...(Number.isFinite(cost) ? { costPerPrompt: cost } : {}),
      ...(effortMatch ? { effort: effortMatch[1]!.trim() } : {}),
      ...(cells[6] ? { harness: cells[6] } : {}),
    };
    // One row per slug: the highest-points effort is the model's ceiling.
    // Deterministic: points desc, then harness name, so a refetch that adds
    // nothing changes nothing.
    const prev = bySlug.get(slug);
    if (
      !prev ||
      candidate.points > prev.points ||
      (candidate.points === prev.points && (candidate.harness ?? "") < (prev.harness ?? ""))
    ) {
      bySlug.set(slug, candidate);
    }
  }
  const byId = new Map<string, AcdEntry>();
  for (const entry of bySlug.values()) byId.set(normalizeAcdId(entry.id), entry);
  return { byId };
}

/** Build an index from entries directly. One writer for the parse and the cache below. */
export function buildAcdIndex(entries: AcdEntry[]): AcdIndex {
  const byId = new Map<string, AcdEntry>();
  for (const entry of entries) {
    const key = normalizeAcdId(entry.id);
    if (!byId.has(key)) byId.set(key, entry);
  }
  return { byId };
}

export interface ResolvedAcd {
  /** Total points, out of 70. */
  points: number;
  /** Measured avg cost per prompt, when the winning row carried one. */
  costPerPrompt?: number;
  /** The winning row's effort and harness, for the export and the `?` pane. */
  effort?: string;
  harness?: string;
  /** The slug the scores were read from, so a `≈` can be checked. */
  sourceId: string;
  /** True when the hyphen tier (or `/`/`.` normalisation) matched. A guess, marked. */
  normalised: boolean;
}

/**
 * Resolve an `adv` ref to its ACD ceiling row via the catalogue's
 * `canonical_model_id`, falling back to the served ref itself.
 *
 * Tiers: the exact normalised canonical id, then its suffix chain, then the
 * served ref's own chain — and every form also tries its hyphen-stripped
 * remainders for vendor-dropped slugs. Last resort is the serving/effort
 * strip both resolvers share (`-contributor`, `-free`, `-batch`, `-nitro`,
 * then `-thinking`, `-max`, …): the same weights under a different serving
 * arrangement, so `muse-spark-1-3-contributor` reads `muse-spark-1-3`'s row.
 * Every tier past the first marks `≈`. Null when nothing matches — and null
 * is blank in the row, never a 0.
 */
export function resolveAcd(
  catalogue: Catalogue,
  acd: AcdIndex,
  ref: string,
): ResolvedAcd | null {
  const canonical = catalogue.get(ref)?.canonicalModelId;
  const lookups = canonical && canonical.trim() ? [canonical, ref] : [ref];
  for (const lookup of lookups) {
    const forms = acdFormsOf(lookup);
    for (let i = 0; i < forms.length; i++) {
      const entry = acd.byId.get(forms[i]!);
      if (!entry) continue;
      return {
        points: entry.points,
        ...(entry.costPerPrompt !== undefined ? { costPerPrompt: entry.costPerPrompt } : {}),
        ...(entry.effort ? { effort: entry.effort } : {}),
        ...(entry.harness ? { harness: entry.harness } : {}),
        sourceId: entry.id,
        normalised: entry.id.toLowerCase() !== lookup.toLowerCase() || i > 0,
      };
    }
  }
  // Last resort, shared with the benchmarks: one serving/effort tier off the
  // last segment. Anything else-shaped (`-pro`, `-image`) stays a miss —
  // `stripTier` never strips those, because that could be a sibling model.
  for (const lookup of lookups) {
    for (const form of acdFormsOf(lookup)) {
      const stripped = stripTier(form);
      if (!stripped) continue;
      const entry = acd.byId.get(normalizeAcdId(stripped));
      if (!entry) continue;
      return {
        points: entry.points,
        ...(entry.costPerPrompt !== undefined ? { costPerPrompt: entry.costPerPrompt } : {}),
        ...(entry.effort ? { effort: entry.effort } : {}),
        ...(entry.harness ? { harness: entry.harness } : {}),
        sourceId: entry.id,
        normalised: true,
      };
    }
  }
  return null;
}

/** The badge part: `D68`, rounded like the `I`/`C`/`A` badges. Blank when unmeasured. */
export function formatAcdBadge(a: ResolvedAcd | null): string {
  if (!a) return "";
  return `D${Math.round(a.points)}`;
}

/**
 * ACD points as an intelligence score, for the `D` toggle. The picker's flat
 * views rank on `scoreOf`, so handing them this instead of the AA-backed one
 * re-ranks intelligence, value and taskcost by AI Coding Daily — no ranking
 * machinery changes, only the source behind the function.
 */
export function acdScoreOf(
  catalogue: Catalogue,
  acd: AcdIndex,
): (ref: string) => { intelligence?: number } | null {
  return (ref: string) => {
    const a = resolveAcd(catalogue, acd, ref);
    return a ? { intelligence: a.points } : null;
  };
}

/**
 * ACD prompt $ as the measured task cost, for the `D` toggle. Handed to the
 * taskcost view as `taskCostOf`, so its ceiling filters on prompt $ — the
 * score and the cheapness switch sources together, and two task definitions
 * never share one view.
 */
export function acdTaskCostOf(
  catalogue: Catalogue,
  acd: AcdIndex,
): (ref: string) => number | undefined {
  return (ref: string) => resolveAcd(catalogue, acd, ref)?.costPerPrompt;
}

/**
 * Measured $/prompt for the row. Blank when unmeasured, never 0 — same floor
 * rule as `formatTaskCost`: below half a cent the digits are noise, so the
 * cell says negligible, not zero.
 */
export function formatPromptCost(v: number | undefined): string {
  if (v === undefined) return "";
  if (v < 0.005) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */

export const acdFile = (): string => path.join(advDataRoot(), "aicodingdaily.json");

export interface LoadedAcd {
  entries: AcdIndex;
  /** ISO fetch time, null when there is no cache. */
  at: string | null;
  ageMs: number | null;
}

/** One serial row: points plus the row the ceiling came from. */
interface SerialAcdEntry {
  points?: unknown;
  costPerPrompt?: unknown;
  effort?: unknown;
  harness?: unknown;
}

/**
 * The cache, or an empty one. A malformed file is no scores, never a throw —
 * the picker renders blanks and carries on.
 */
export async function loadAcd(file: string = acdFile()): Promise<LoadedAcd> {
  const empty = (): LoadedAcd => ({ entries: emptyAcd(), at: null, ageMs: null });
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty();
  const { at, entries } = value as { at?: unknown; entries?: unknown };
  const list: AcdEntry[] = [];
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, s] of Object.entries(entries as Record<string, unknown>)) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const r = s as SerialAcdEntry;
      const points = finite(r.points);
      if (points === undefined) continue;
      list.push({
        id,
        points,
        ...(finite(r.costPerPrompt) !== undefined ? { costPerPrompt: finite(r.costPerPrompt)! } : {}),
        ...(typeof r.effort === "string" && r.effort ? { effort: r.effort } : {}),
        ...(typeof r.harness === "string" && r.harness ? { harness: r.harness } : {}),
      });
    }
  }
  const stamp = typeof at === "string" ? at : null;
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - (await stat(file)).mtimeMs;
  } catch {
    /* read it, could not stat it: no age to report, not a failure */
  }
  return { entries: buildAcdIndex(list), at: stamp, ageMs };
}

/**
 * Rewrite the cache from a resolved index. One writer for the fetch path, so
 * a restyled page cannot wipe a good cache: callers only call this with a
 * non-empty parse.
 */
export async function saveAcd(index: AcdIndex, at: string, file: string = acdFile()): Promise<void> {
  const serial: Record<string, { points: number; costPerPrompt?: number; effort?: string; harness?: string }> =
    {};
  for (const entry of index.byId.values()) {
    serial[entry.id] = {
      points: entry.points,
      ...(entry.costPerPrompt !== undefined ? { costPerPrompt: entry.costPerPrompt } : {}),
      ...(entry.effort ? { effort: entry.effort } : {}),
      ...(entry.harness ? { harness: entry.harness } : {}),
    };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ at, entries: serial }, null, 2)}\n`);
}

export interface FetchedAcd {
  entries: AcdIndex;
  at: string;
  /** Slugs kept — the ceiling rows, not the effort variants. */
  count: number;
}

/**
 * One keyless GET, then the cache is rewritten. Throws on network failure or
 * an empty parse — a restyled page keeps the old cache, never an empty one.
 */
export async function fetchAcd(
  url: string = ACD_URL,
  file: string = acdFile(),
  timeoutMs = 30_000,
): Promise<FetchedAcd> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": "adv-benchmarks" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`ACD fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`ACD fetch failed: HTTP ${res.status}`);
  const entries = parseACD(await res.text());
  if (entries.byId.size === 0) throw new Error("ACD fetch failed: unparseable payload");
  const at = new Date().toISOString();
  await saveAcd(entries, at, file);
  return { entries, at, count: entries.byId.size };
}
