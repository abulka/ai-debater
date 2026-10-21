/**
 * Saved model pairs — the two models that were used, under a name.
 *
 * `Config.models` holds exactly one drafter and one reviewer, so the pair behind
 * the fast test run, the M3 trial or anything else has to be retyped from
 * memory. A pair is those two refs with a name attached, and it is the unit a
 * person actually thinks about: "the trial pair", "the cheap pair".
 *
 * **Its own file**, `~/.config/adv/pairs.json`, rather than a key on `Config`.
 * `saveConfig` writes the whole config to both the user file *and* the
 * repository's `.adv/`, so a pair list on `Config` would be stamped
 * into every repository the moment a model was chosen. Pairs are personal and
 * follow you between directories; a repository keeps pinning its own drafter and
 * reviewer in its own file, as before.
 *
 * **`family` is stored, not guessed.** `familyOf()` is a heuristic for labelling
 * a picker row; the `family` field is a statement the diversity check compares.
 * A pair saved from a picker row gets `familyOf()`'s answer recorded, which is
 * then what the run uses.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.ts";
import { familyClash } from "./models.ts";
import type { RunSummary } from "./orchestrator.ts";
import type { ModelRef } from "./runner.ts";

export interface Pair {
  name: string;
  drafter: ModelRef;
  reviewer: ModelRef;
  savedAt: string;
  /** Set the first time the pair is chosen. The list is ordered by this. */
  lastUsedAt?: string;
}

/** The two models, as `Config.models` holds them. */
export interface Models {
  drafter: ModelRef;
  reviewer: ModelRef;
}

/** A pair that a past run used, offered without being saved. */
export interface RecentPair {
  drafter: ModelRef;
  reviewer: ModelRef;
  /** The run's name — its timestamp stamp. */
  run: string;
  task: string;
  mode: RunSummary["mode"];
  createdAt: string;
}

export const pairsFile = (): string => path.join(configDir(), "adv", "pairs.json");

/**
 * A pair's identity: which two models, in which roles.
 *
 * Families are deliberately not part of it. A family label that disagrees with
 * the ref is a labelling slip, and hiding a pair's name over it would make a
 * perfectly usable pair read as unnamed.
 */
export const pairKey = (models: { drafter: ModelRef; reviewer: ModelRef }): string =>
  // A space cannot occur inside a ref: `listModels` accepts `provider/model`
  // with no whitespace in either half, so joining on one is unambiguous.
  `${models.drafter.ref} ${models.reviewer.ref}`;

/**
 * Just the two models, stripped of a pair's bookkeeping.
 *
 * A `Pair` and a `RecentPair` both *contain* two models and some other fields —
 * a name, a saved date, a run — and both satisfy `{drafter, reviewer}`
 * structurally, so passing one where `Config.models` is expected typechecks and
 * writes `name` and `savedAt` into the repository, where
 * `loadConfig` then reads them back as part of the models. The fix is this
 * function, at the boundary, rather than a type that cannot express the mistake.
 */
export const pairModels = (pair: { drafter: ModelRef; reviewer: ModelRef }): Models => ({
  drafter: pair.drafter,
  reviewer: pair.reviewer,
});

const isModelRef = (value: unknown): value is ModelRef => {
  if (!value || typeof value !== "object") return false;
  const { ref, family } = value as { ref?: unknown; family?: unknown };
  return typeof ref === "string" && ref.trim() !== "" && typeof family === "string";
};

const isPair = (value: unknown): value is Pair => {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Pair>;
  return typeof p.name === "string" && p.name.trim() !== "" && isModelRef(p.drafter) && isModelRef(p.reviewer);
};

/**
 * Every saved pair, most recently used first; never-used ones last by name.
 *
 * The order is the whole point: the pair you used last is the one you are most
 * likely to want again, and a list sorted by name puts it wherever the alphabet
 * puts it.
 */
export const sortedPairs = (pairs: Pair[]): Pair[] =>
  [...pairs].sort((a, b) => {
    const ua = a.lastUsedAt ?? "";
    const ub = b.lastUsedAt ?? "";
    if (ua !== ub) return ua < ub ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

/** The saved pair naming these two models, or null when the current pair has no name. */
export const nameForPair = (
  pairs: Pair[],
  models: { drafter: ModelRef; reviewer: ModelRef },
): string | null =>
  sortedPairs(pairs).find((p) => pairKey(p) === pairKey(models))?.name ?? null;

/** Read the file. A missing or unreadable one is no pairs, not a failure. */
export async function loadPairs(): Promise<Pair[]> {
  let raw: string;
  try {
    raw = await readFile(pairsFile(), "utf8");
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isPair);
}

const write = async (pairs: Pair[]): Promise<void> => {
  await mkdir(path.dirname(pairsFile()), { recursive: true });
  await writeFile(pairsFile(), `${JSON.stringify(pairs, null, 2)}\n`);
};

/**
 * Save under a name, replacing whatever was there.
 *
 * `lastUsedAt` survives a re-save: renaming a pair is not an act of using it,
 * and forgetting that would drop it below every pair that has been used since.
 */
export async function savePair(pair: Omit<Pair, "savedAt"> & { savedAt?: string; lastUsedAt?: string }): Promise<Pair[]> {
  const pairs = await loadPairs();
  const previous = pairs.find((p) => p.name === pair.name);
  const next: Pair = {
    name: pair.name,
    drafter: pair.drafter,
    reviewer: pair.reviewer,
    savedAt: pair.savedAt ?? new Date().toISOString(),
    ...(pair.lastUsedAt ?? previous?.lastUsedAt
      ? { lastUsedAt: pair.lastUsedAt ?? previous?.lastUsedAt }
      : {}),
  };
  await write([...pairs.filter((p) => p.name !== pair.name), next]);
  return loadPairs();
}

/** Record that a pair was chosen, so it sorts first next time. */
export async function markPairUsed(name: string, at = new Date().toISOString()): Promise<Pair[]> {
  const pairs = await loadPairs();
  if (!pairs.some((p) => p.name === name)) return pairs;
  await write(pairs.map((p) => (p.name === name ? { ...p, lastUsedAt: at } : p)));
  return loadPairs();
}

/**
 * Rename a pair, keeping its models and its dates.
 *
 * The name is the identity everywhere else — the list order, the "in use"
 * mark — so a rename carries `savedAt` and `lastUsedAt` across rather than
 * looking brand-new. Renaming onto an existing name replaces that pair,
 * the same answer the name prompt gives a fresh save.
 */
export async function renamePair(from: string, to: string, models: Models): Promise<Pair[]> {
  const pairs = await loadPairs();
  const prev = pairs.find((p) => p.name === from);
  const now = new Date().toISOString();
  const next: Pair = {
    name: to,
    ...models,
    savedAt: prev?.savedAt ?? now,
    ...(prev?.lastUsedAt ? { lastUsedAt: prev.lastUsedAt } : {}),
  };
  await write([...pairs.filter((p) => p.name !== from && p.name !== to), next]);
  return loadPairs();
}

/**
 * A name suggested from the two models: the short end of each ref.
 *
 * `anthropic/claude-haiku-5-5 -> openrouter/openai/gpt-6-luna` becomes
 * `claude-haiku-5-5 -> gpt-6-luna` — a starting point, always editable, and a
 * collision still goes through the overwrite confirm like a typed name.
 */
export function suggestPairName(models: Models): string {
  const short = (ref: string): string => {
    const last = ref.split("/").pop() ?? "";
    return last.trim();
  };
  const drafter = short(models.drafter.ref);
  const reviewer = short(models.reviewer.ref);
  if (!drafter || !reviewer) return "";
  return `${drafter} -> ${reviewer}`;
}

/** Forget a pair. Returns false when there was nothing by that name. */
export async function deletePair(name: string): Promise<boolean> {
  const pairs = await loadPairs();
  const kept = pairs.filter((p) => p.name !== name);
  if (kept.length === pairs.length) return false;
  await write(kept);
  return true;
}

/**
 * The pairs runs have used, newest first, deduplicated.
 *
 * Derived from the run store rather than kept in a second place: every run's
 * `state.json` already records its models, and a list that could disagree with
 * the runs it claims to describe is one more thing to keep true. The corollary
 * is worth knowing: deleting a run deletes its entry here.
 *
 * Pure, and takes the list, so the ordering is testable without a disk.
 */
/** One row of the pair list: a saved pair, a pair a run used, the two ways to make one, or a blank grouping row. */
export type PairRow =
  | { kind: "saved"; key: string; pair: Pair; warnings: string[] }
  | { kind: "recent"; key: string; recent: RecentPair }
  | { kind: "new"; key: string }
  | { kind: "save"; key: string }
  | { kind: "gap"; key: string };

/**
 * The rows, in order. Managing (the settings door): saved pairs (last used
 * first), then pairs runs have used, then the two ways to make one — pick
 * two models by hand, or name the two already in use. Choosing (the debate
 * door): saved pairs only, so a preset is always a keystroke and creating
 * one never happens by accident.
 *
 * A saved pair duplicates a run's pair, so the runs skip those — one pair is one
 * row, named rather than shown twice.
 *
 * `warnings` is what is wrong with a pair now, computed here rather than in the
 * view so there is one answer to "is this pair still usable": two models that
 * share a family (the diversity check's own sentence), and a model
 * `opencode models` no longer lists. A stale pair is shown and marked, never
 * dropped: hiding it because a provider went away would be losing the reader's
 * decision to a config change.
 */
export function pairRows(
  saved: Pair[],
  runs: RunSummary[],
  listed: Set<string>,
  scope: "manage" | "preset" = "manage",
): PairRow[] {
  const stale = (pair: { drafter: ModelRef; reviewer: ModelRef }): string[] => {
    const out: string[] = [];
    const clash = familyClash(pair);
    if (clash) out.push(clash);
    // Only when the list is known: an empty `opencode models` means the listing
    // failed, and calling every pair broken would be a lie.
    if (listed.size) {
      for (const role of ["drafter", "reviewer"] as const) {
        if (!listed.has(pair[role].ref)) out.push(`${pair[role].ref} is not listed any more`);
      }
    }
    return out;
  };
  const stored: PairRow[] = sortedPairs(saved).map((pair) => ({
    kind: "saved",
    key: `saved:${pair.name}`,
    pair,
    warnings: stale(pair),
  }));
  const known = new Set(stored.map((r) => (r.kind === "saved" ? pairKey(r.pair) : "")));
  if (scope === "preset") return stored;
  const fromRuns: PairRow[] = recentPairs(runs)
    .filter((r) => !known.has(pairKey(r)))
    .map((recent) => ({ kind: "recent", key: `recent:${pairKey(recent)}`, recent }));
  // Blank grouping rows: presets, then the runs, then the two ways to make
  // one. A gap is a real row — the cursor skips it, the height budget counts
  // it — so a group never reads as one undifferentiated list, and the scroll
  // arithmetic stays honest. No leading or trailing gaps, and no doubles:
  // a gap only sits between two non-empty groups.
  const gap = (n: number): PairRow => ({ kind: "gap", key: `gap:${n}` });
  const out: PairRow[] = [...stored];
  // The two action rows always follow in this scope, so a non-empty group
  // above them always earns its gap; an empty group earns nothing.
  if (stored.length > 0) out.push(gap(1));
  out.push(...fromRuns);
  if (fromRuns.length > 0) out.push(gap(2));
  out.push({ kind: "new", key: "new" }, { kind: "save", key: "save" });
  return out;
}

export function recentPairs(runs: RunSummary[], limit = 24): RecentPair[] {
  const seen = new Set<string>();
  const out: RecentPair[] = [];
  for (const run of runs) {
    // Optional on the summary: a run whose state predates the field, or was
    // written by a version that had none, has no pair to offer — and is not a
    // reason to fail the list.
    if (!run.models) continue;
    const key = pairKey(run.models);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...run.models, run: run.name, task: run.task, mode: run.mode, createdAt: run.createdAt });
    if (out.length >= limit) break;
  }
  return out;
}
