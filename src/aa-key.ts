/**
 * The Artificial Analysis API key: personal, never per-repo.
 *
 * Its own file (`~/.config/adv/artificialanalysis.json`), for the same
 * reason pairs and the value ceiling have theirs: `saveConfig` writes the
 * whole `Config` into the repository's `.adv/` and the user config, so a key
 * on `Config` would be stamped into every repository the moment a model was
 * picked. A missing or malformed file is no key, never a throw — the picker
 * then shows the OpenRouter relay, exactly as before.
 *
 * The key is read at fetch time and never logged, never rendered, and never
 * written anywhere but here. Verification happens before saving, so this
 * file only ever holds a key the API has accepted.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.ts";

export const aaKeyFile = (): string => path.join(configDir(), "adv", "artificialanalysis.json");

/** The stored key, trimmed — or null when there is none to use. */
export async function loadAAKey(file: string = aaKeyFile()): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const key = (raw as { apiKey?: unknown }).apiKey;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/** Store a verified key, readable only by its owner. Refuses an empty one. */
export async function saveAAKey(key: string, file: string = aaKeyFile()): Promise<void> {
  if (!key.trim()) throw new Error("refusing to save an empty API key");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ apiKey: key.trim() }, null, 2)}\n`, { mode: 0o600 });
  // The mode above covers creation; an existing file keeps its old bits.
  await chmod(file, 0o600);
}
