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
/** `<`/`>` steps in the value view. */
export const CEILING_STEP = 0.1;

export const pickerPrefsFile = (): string => path.join(configDir(), "adv", "picker.json");

/** Rounded to cents: a float that has been stepped ten times reads 0.799999. */
export const roundCeiling = (n: number): number => Math.round(n * 100) / 100;

export async function loadCeiling(file: string = pickerPrefsFile()): Promise<number> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_CEILING;
    const n = (raw as { valueCeiling?: unknown }).valueCeiling;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return DEFAULT_CEILING;
    return roundCeiling(n);
  } catch {
    return DEFAULT_CEILING;
  }
}

export async function saveCeiling(
  ceiling: number,
  file: string = pickerPrefsFile(),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ valueCeiling: roundCeiling(ceiling) }, null, 2)}\n`);
}
