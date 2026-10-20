/**
 * The picker's own small preferences: the value view's output-cost ceiling,
 * the taskcost view's task ceiling, and the providers the picker hides.
 *
 * Its own file (`~/.config/adv/picker.json`), for the same reason pairs have
 * theirs: `saveConfig` writes the whole `Config` into the repository's
 * `.adv/` and the user's config, so a threshold on `Config` would be stamped
 * into every repository the moment a model was picked. Ceilings and provider
 * visibility are personal, not per-repo. A missing or malformed file is the
 * default, never a throw.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.ts";
import type { FilterMode } from "./models.ts";

/** Output $ per million tokens. $0.80 keeps the value view to the cheap. */
export const DEFAULT_CEILING = 0.8;
/** `<`/`>` steps in the value view. Additive: output prices cluster near a dollar. */
export const CEILING_STEP = 0.1;
/**
 * Measured $ per Intelligence Index task. $0.50 keeps the taskcost view to
 * the cheap — most favourites land under it, most flagships above.
 */
export const DEFAULT_TASK_CEILING = 0.5;
/**
 * `<`/`>` steps multiply and divide by this, rounded to cents. Additive steps
 * are the wrong shape here: costs span $0.01 to $8 a task, and a $0.10 stride
 * cannot resolve the $0.01–$0.15 cluster where most rows live while still
 * reaching $8 in a sane number of presses. ×1.5 walks 0.50 → 0.33 → 0.22 →
 * 0.15 → 0.10 → 0.07 → 0.04 → 0.03 → 0.02 → 0.01, then to empty.
 */
export const CEILING_RATIO = 1.5;

/** One geometric step, decimal-clean. Down stalls at cents, so it ends at 0 (empty) rather than sticking. */
export function stepCeiling(n: number, dir: 1 | -1): number {
  if (dir > 0) return roundCeiling(n <= 0 ? 0.01 : n * CEILING_RATIO);
  if (n <= 0) return 0;
  const next = roundCeiling(n / CEILING_RATIO);
  return next >= n ? 0 : next;
}

export const pickerPrefsFile = (): string => path.join(configDir(), "adv", "picker.json");

/**
 * How often the picker refetches its keyless caches — benchmark scores, AI
 * Coding Daily, the price catalogue. Personal, like the ceilings: one
 * reader's patience with staleness is not another's.
 */
export const DEFAULT_REFRESH_DAYS = 7;
/** The choices Enter cycles through: a day, a few days, weeks. */
export const REFRESH_DAY_CHOICES = [1, 3, 7, 14, 30];

/** A day-count as the milliseconds the staleness checks compare against. */
export const refreshDaysMs = (days: number): number => days * 24 * 60 * 60 * 1000;

/** Next choice up, wrapping round. Unknown values restart at the default. */
export function cycleRefreshDays(days: number): number {
  const i = REFRESH_DAY_CHOICES.indexOf(days);
  if (i < 0) return DEFAULT_REFRESH_DAYS;
  return REFRESH_DAY_CHOICES[(i + 1) % REFRESH_DAY_CHOICES.length] ?? DEFAULT_REFRESH_DAYS;
}

export async function loadRefreshDays(file: string = pickerPrefsFile()): Promise<number> {
  const v = (await readPrefs(file)).refreshDays;
  return typeof v === "number" && REFRESH_DAY_CHOICES.includes(v) ? v : DEFAULT_REFRESH_DAYS;
}

export async function saveRefreshDays(days: number, file: string = pickerPrefsFile()): Promise<void> {
  await writePrefs(file, { refreshDays: days });
}

/** Rounded to cents: a float that has been stepped ten times reads 0.799999. */
export const roundCeiling = (n: number): number => Math.round(n * 100) / 100;

async function readPrefs(file: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* missing or malformed: the defaults, never a throw */
  }
  return {};
}

/** Merge keys so the ceilings and the provider list never wipe each other out. */
async function writePrefs(file: string, patch: Record<string, unknown>): Promise<void> {
  const current = await readPrefs(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? roundCeiling(v) : fallback;

export async function loadCeiling(file: string = pickerPrefsFile()): Promise<number> {
  return numOr((await readPrefs(file)).valueCeiling, DEFAULT_CEILING);
}

export async function saveCeiling(
  ceiling: number,
  file: string = pickerPrefsFile(),
): Promise<void> {
  await writePrefs(file, { valueCeiling: roundCeiling(ceiling) });
}

export async function loadTaskCeiling(file: string = pickerPrefsFile()): Promise<number> {
  return numOr((await readPrefs(file)).taskCeiling, DEFAULT_TASK_CEILING);
}

export async function saveTaskCeiling(
  ceiling: number,
  file: string = pickerPrefsFile(),
): Promise<void> {
  await writePrefs(file, { taskCeiling: roundCeiling(ceiling) });
}

/**
 * Providers the picker hides. Stored as a sorted array of provider ids;
 * unknown or malformed values are `[]` — a provider that cannot be read is
 * shown, never hidden, because hiding on bad data loses models silently.
 */
export async function loadDisabledProviders(file: string = pickerPrefsFile()): Promise<string[]> {
  const v = (await readPrefs(file)).disabledProviders;
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean))];
  out.sort();
  return out;
}

export async function saveDisabledProviders(
  providers: readonly string[],
  file: string = pickerPrefsFile(),
): Promise<void> {
  const out = [...new Set(providers.map((p) => p.trim()).filter(Boolean))];
  out.sort();
  await writePrefs(file, { disabledProviders: out });
}

/**
 * One filter the picker was left with: the text as typed and the AND/OR mode
 * it ran under. Newest first, capped — a line of text, not a lens: the view,
 * the lock and the ceilings stay where they are.
 */
export interface FilterEntry {
  text: string;
  mode: FilterMode;
}

/** How many past filters the `R` panel keeps. Thirty lines of text, not a log. */
export const FILTER_HISTORY_MAX = 30;

/**
 * Front-bump a filter onto the history. Empty or whitespace-only text and
 * `off`-mode text are not filters — they match everything, so remembering
 * them would restore a no-op — and are returned unchanged. Dedupe is
 * case-insensitive (matching is), and the latest casing and mode win.
 */
export function addFilterHistory(
  entries: readonly FilterEntry[],
  text: string,
  mode: FilterMode,
): FilterEntry[] {
  const t = text.trim();
  if (!t || mode === "off") return [...entries];
  const lower = t.toLowerCase();
  return [{ text: t, mode }, ...entries.filter((e) => e.text.toLowerCase() !== lower)].slice(
    0,
    FILTER_HISTORY_MAX,
  );
}

/** Drop one filter, matched case-insensitively. A miss returns a copy. */
export function removeFilterHistory(entries: readonly FilterEntry[], text: string): FilterEntry[] {
  const lower = text.trim().toLowerCase();
  if (!lower) return [...entries];
  return entries.filter((e) => e.text.toLowerCase() !== lower);
}

/**
 * One use of the filter within a picker visit.
 *
 * A visit contributes at most one provisional entry, replaced as the filter is
 * refined — otherwise the history fills with prefixes (`mus`, `muse` on the
 * way to `muse 1.3`). `prev` is the text this visit already recorded, or null
 * once an entry is final; the new text front-bumps and both it and the stale
 * provisional are dropped from behind. Empty and `off`-mode text record
 * nothing, so applying an entry always narrows.
 */
export interface FilterUse {
  /** The provisional text this visit already recorded, or null once final. */
  prev: string | null;
  text: string;
  mode: FilterMode;
}

export function recordFilterUse(entries: readonly FilterEntry[], use: FilterUse): FilterEntry[] {
  const t = use.text.trim();
  if (!t || use.mode === "off") return [...entries];
  const lower = t.toLowerCase();
  const prevLower = use.prev?.trim().toLowerCase() ?? null;
  return [
    { text: t, mode: use.mode },
    ...entries.filter((e) => {
      const el = e.text.toLowerCase();
      if (el === lower) return false;
      if (prevLower !== null && el === prevLower) return false;
      return true;
    }),
  ].slice(0, FILTER_HISTORY_MAX);
}

function isFilterEntry(v: unknown): v is FilterEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as { text?: unknown; mode?: unknown };
  return (
    typeof e.text === "string" &&
    e.text.trim().length > 0 &&
    (e.mode === "and" || e.mode === "or" || e.mode === "off")
  );
}

/**
 * Past filters, newest first. Unknown or malformed values are `[]` — like the
 * provider list, a filter that cannot be read is forgotten, never applied.
 * `off`-mode rows predate the guard (or a hand edit) and are dropped: applying
 * one would look like the panel did nothing.
 */
export async function loadFilterHistory(file: string = pickerPrefsFile()): Promise<FilterEntry[]> {
  const v = (await readPrefs(file)).filterHistory;
  if (!Array.isArray(v)) return [];
  const out: FilterEntry[] = [];
  for (const raw of v) {
    if (!isFilterEntry(raw)) continue;
    const text = raw.text.trim();
    if (raw.mode === "off") continue;
    if (out.some((e) => e.text.toLowerCase() === text.toLowerCase())) continue;
    out.push({ text, mode: raw.mode });
    if (out.length >= FILTER_HISTORY_MAX) break;
  }
  return out;
}

export async function saveFilterHistory(
  entries: readonly FilterEntry[],
  file: string = pickerPrefsFile(),
): Promise<void> {
  const seen = new Set<string>();
  const out: FilterEntry[] = [];
  for (const e of entries) {
    if (!isFilterEntry(e) || e.mode === "off") continue;
    const text = e.text.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ text, mode: e.mode });
    if (out.length >= FILTER_HISTORY_MAX) break;
  }
  await writePrefs(file, { filterHistory: out });
}
