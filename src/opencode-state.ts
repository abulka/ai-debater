/**
 * Read-only access to OpenCode's model state.
 *
 * OpenCode's TUI has favourites: the model picker offers a `Favorite` action,
 * `model.cycle_favorite` cycles them, and the list tags them "(Favorite)". None
 * of that is in `opencode.jsonc` or `cli.json`, and there is no flag or API for
 * it — it lives in a private state file the TUI writes:
 *
 *   ~/.local/state/opencode/model.json
 *   {"recent":[{"providerID":…,"modelID":…}], "favorite":[…], "variant":{…}}
 *
 * Inheriting that list beats inventing one: the models a person marks as their
 * own are already marked, in the tool they spend their day in, and a second list
 * here would only ever disagree with it.
 *
 * **Read-only, deliberately.** OpenCode rewrites that file wholesale on any
 * change, and it has changed shape before (a startup race that wiped favourites,
 * #8375). `adv` writing to it would mean two programs fighting over one JSON
 * file with no lock, and the failure would be *losing the human's favourites*.
 * So this reads defensively and never throws: no file, a broken file or a
 * reshaped one is an empty list, not an error — the picker looks exactly as it
 * did before, which is the whole of the degradation.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface OpenCodeModels {
  /** OpenCode's `favorite`, in its own order, as `provider/modelID` refs. */
  favourites: string[];
  /** OpenCode's `recent`: the last models it ran, most recent first. */
  recents: string[];
}

const EMPTY: OpenCodeModels = { favourites: [], recents: [] };

/**
 * Where OpenCode's state lives, most likely first.
 *
 * `XDG_STATE_HOME` when it is set, then the macOS/Linux default. `~/.cache` is
 * the third candidate because a filed issue names it as the Linux path for the
 * same file; it is never a duplicate of the other two unless `XDG_STATE_HOME`
 * happens to point there, which the de-duplication below settles.
 */
export const openCodeStateDirs = (): string[] => {
  const dirs: string[] = [];
  const xdg = process.env["XDG_STATE_HOME"];
  if (xdg && xdg.trim()) dirs.push(path.join(xdg, "opencode"));
  dirs.push(path.join(os.homedir(), ".local", "state", "opencode"));
  dirs.push(path.join(os.homedir(), ".cache", "opencode"));
  return [...new Set(dirs)];
};

/** `{providerID, modelID}` entries as `provider/modelID`, skipping junk. */
const refs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { providerID, modelID } = entry as { providerID?: unknown; modelID?: unknown };
    const provider = typeof providerID === "string" ? providerID.trim() : "";
    const model = typeof modelID === "string" ? modelID.trim() : "";
    if (!provider || !model) continue;
    const ref = `${provider}/${model}`;
    // OpenCode dedupes on write; if a version ever does not, the picker would
    // show the same ref twice rather than once.
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
};

/** Parse the file's text. Total: every failure is an empty list, not a throw. */
export const parseOpenCodeModels = (raw: string): OpenCodeModels => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const record = value as { favorite?: unknown; recent?: unknown };
  return { favourites: refs(record.favorite), recents: refs(record.recent) };
};

/**
 * What OpenCode's TUI has marked, or empty lists.
 *
 * The first directory that yields a readable `model.json` wins: a machine can
 * legitimately have an old one left behind somewhere, and merging two of them
 * would produce a list of models that no longer exist.
 *
 * `dirs` defaults to the usual candidates. It is a parameter rather than a
 * constant so the empty cases — no file, broken file, reshaped file — can be
 * tested without reading the machine running the tests, whose own OpenCode state
 * is full of real favourites.
 */
export async function readOpenCodeModels(dirs: string[] = openCodeStateDirs()): Promise<OpenCodeModels> {
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, "model.json"), "utf8");
    } catch {
      continue;
    }
    const parsed = parseOpenCodeModels(raw);
    if (parsed.favourites.length || parsed.recents.length) return parsed;
  }
  return EMPTY;
}
