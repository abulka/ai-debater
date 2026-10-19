/**
 * The picker's own small preferences: the value view's output-cost ceiling.
 *
 * Its own file (`~/.config/adv/picker.json`), for the same reason pairs have
 * theirs: `saveConfig` writes the whole `Config` into the repository's
 * `.adv/` and the user's config, so a threshold on `Config` would be stamped
 * into every repository the moment a model was picked. A ceiling is personal,
 * not per-repo. A missing or malformed file is the default, never a throw.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.ts";

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

/** Merge one key so the two ceilings never wipe each other out. */
async function writePrefs(file: string, patch: Record<string, number>): Promise<void> {
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
