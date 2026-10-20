/**
 * The models.dev catalogue OpenCode already keeps on disk.
 *
 * OpenCode fetches `https://models.dev/api.json` and caches it at
 * `~/.cache/opencode/models.json`. That file is the only place, short of paying
 * for a call, where a model's **price**, **tool-calling ability** and **real
 * family** are written down. `adv` reads it; it never writes it, for the same
 * reason `opencode-state.ts` does not write `model.json`.
 *
 * **This is not `model.json`.** OpenCode's favourites state is
 * `~/.local/state/opencode/model.json` — singular — and this catalogue is
 * `~/.cache/opencode/models.json` — plural. One character apart, both under a
 * directory named `opencode`, and `openCodeStateDirs()` already lists
 * `~/.cache/opencode` as a candidate for the singular one. Reading the wrong
 * file does not fail: the state file parses as JSON, and every lookup against
 * it returns `undefined`, and every row in the picker silently renders `?`.
 * Nothing anywhere reports an error. `parseCatalogue` therefore rejects the
 * state file's shape by name, and that rejection is a test.
 *
 * **What this is not.** It is not an availability check. See
 * `docs/OPENCODE-MODELS.md`: `opencode models` — the list `adv` offers from —
 * is a catalogue filtered by which providers hold a credential, and disagrees
 * with the provider's own `/models` endpoint in both directions. The catalogue
 * agrees with `opencode models` about which models *exist*, because they come
 * from the same upstream. It disagrees about *cost* and *capability*, because
 * nobody checks either against the credential. So: prices and tool-calling come
 * from here, and whether a call actually succeeds comes from `probe.ts`.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advDataRoot } from "./orchestrator.ts";

/**
 * What a model costs. `unknown` is a real answer and is never rendered
 * "free" — with one documented exception: a ref the catalogue has never
 * heard of whose name ends in `-free` (`costOf` infers from the suffix, which
 * is unanimous upstream). Unknown is silence; free must be said.
 */
export type Cost =
  | { kind: "free" }
  | {
      kind: "priced";
      input: number;
      output: number;
      tiered: boolean;
      /**
       * The first long-context tier, when the catalogue names one: the prices
       * past the threshold, and the threshold itself in prompt tokens. Haiku
       * 5.5 is 5x past 100k — the row shows the magnitude, the export and the
       * `?` pane show the numbers, because a 14-wide column cannot hold both.
       */
      tier?: { input: number; output: number; overTokens: number };
    }
  | { kind: "unknown" };

export interface CatalogueEntry {
  /**
   * The catalogue's own family label. **Display only — never stored as a
   * `ModelRef.family`.** It is finer-grained than the families `adv` compares:
   * `claude-haiku` where `familyOf` says `claude`, `gpt-luna` where it says
   * `gpt`, `deepseek-flash` where it says `deepseek`. Substituting it would
   * make `familyClash` *miss* a `deepseek`/`deepseek-flash` pair, which is the
   * one thing the diversity check exists to catch. `familyClash` compares
   * prefixes instead; this stays a label for the reader.
   */
  family?: string;
  /** Whether the model can call tools. `undefined` when the catalogue is silent. */
  toolCall?: boolean;
  /**
   * The canonical `provider/model` id — the same weights under one name.
   * What `benchmarks.ts` matches on: an `adv` ref names where a model is
   * *served* (`opencode-go/glm-5.3-flash`), the canonical id names what it
   * *is* (`z-ai/glm-5.3-flash`). Display-only otherwise; never a family.
   */
  canonicalModelId?: string;
  cost: Cost;
  /** Max input context, when the catalogue knows it. */
  context?: number;
}

/** Keyed by the same `provider/model` ref `adv` uses everywhere else. */
export type Catalogue = Map<string, CatalogueEntry>;

const EMPTY: Catalogue = new Map();

/** Where OpenCode puts the catalogue. `XDG_CACHE_HOME`, then the usual path. */
export const catalogueFile = (): string => {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "opencode", "models.json");
};

/**
 * Where `adv` keeps its own copy. OpenCode's file has no refresh owner —
 * nothing fetches it on any schedule — so `adv` fetches models.dev itself
 * past staleness and reads whichever copy is newer. Never written into
 * OpenCode's file: that one is not ours to touch.
 */
export const advCatalogueFile = (): string => path.join(advDataRoot(), "catalogue.json");

/** What `adv` fetches: the same upstream OpenCode caches. Keyless, one GET. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Split a ref the way the catalogue is keyed.
 *
 * Provider first, everything after it is the model id — which may itself
 * contain slashes (`openrouter/qwen/qwen3.8-27b`). And a models.dev id may
 * already carry the provider namespace, which is why `groq/groq/compound-mini`
 * is a legitimate ref whose model id is `groq/compound-mini`. Splitting on the
 * first slash only is what makes both work.
 */
export function splitRef(ref: string): { provider: string; model: string } | null {
  const at = ref.indexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

const cost = (raw: unknown): Cost => {
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const c = raw as { input?: unknown; output?: unknown; tiers?: unknown };
  if (typeof c.input !== "number" || typeof c.output !== "number") return { kind: "unknown" };
  if (c.input === 0 && c.output === 0) return { kind: "free" };
  // The first context tier, when there is one. models.dev carries the whole
  // list; the row only has room for the magnitude, so one tier is enough —
  // the export spells out the rest.
  let tier: { input: number; output: number; overTokens: number } | undefined;
  if (Array.isArray(c.tiers) && c.tiers.length > 0) {
    const t = c.tiers[0] as { input?: unknown; output?: unknown; tier?: unknown };
    const size =
      t.tier && typeof t.tier === "object" && !Array.isArray(t.tier)
        ? (t.tier as { type?: unknown; size?: unknown })
        : null;
    if (
      typeof t.input === "number" &&
      typeof t.output === "number" &&
      size?.type === "context" &&
      typeof size.size === "number"
    ) {
      tier = { input: t.input, output: t.output, overTokens: size.size };
    }
  }
  return {
    kind: "priced",
    input: c.input,
    output: c.output,
    // Long inputs bill at a higher rate. A run that crosses the threshold costs
    // more than the number on the row, so the row says so.
    tiered: Array.isArray(c.tiers) && c.tiers.length > 0,
    ...(tier ? { tier } : {}),
  };
};

/**
 * Parse the catalogue text. Total: every failure is an empty catalogue, which
 * degrades every row to `?` rather than failing the picker.
 *
 * A catalogue is `{providerId: {id, api, models: {modelId: {...}}}}`. Anything
 * else is not one, and is rejected rather than half-read — specifically
 * `model.json`, whose top level is `{recent, favorite, variant}`.
 */
export const parseCatalogue = (raw: string): Catalogue => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;

  const root = value as Record<string, unknown>;
  // Named rejection. Without this the state file parses, every provider fails
  // the shape test below, and the result is indistinguishable from "no file".
  if ("favorite" in root || "recent" in root || "variant" in root) return EMPTY;

  const out: Catalogue = new Map();
  for (const [provider, body] of Object.entries(root)) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const models = (body as { models?: unknown }).models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, entry] of Object.entries(models as Record<string, unknown>)) {
      // `groq/beam-free` is literally `null` upstream. That is a fact about the
      // model, not a broken file, and it becomes `?` rather than a throw.
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as {
        family?: unknown;
        tool_call?: unknown;
        cost?: unknown;
        limit?: { context?: unknown };
        canonical_model_id?: unknown;
      };
      const ref = `${provider}/${model}`;
      out.set(ref, {
        ...(typeof e.family === "string" && e.family.trim() ? { family: e.family.trim() } : {}),
        ...(typeof e.tool_call === "boolean" ? { toolCall: e.tool_call } : {}),
        ...(typeof e.canonical_model_id === "string" && e.canonical_model_id.trim()
          ? { canonicalModelId: e.canonical_model_id.trim() }
          : {}),
        cost: cost(e.cost),
        ...(typeof e.limit?.context === "number" ? { context: e.limit.context } : {}),
      });
    }
  }
  return out;
};

/**
 * The catalogue, or an empty one.
 *
 * `file` is a parameter so the empty cases — no file, unreadable, malformed,
 * wrong file — are testable without reading the machine running the tests.
 * `ageMs` is the file's age, reported in the provider pane, because a catalogue
 * that has not been refreshed in a month is worth saying out loud.
 */
export async function loadCatalogue(
  file: string = catalogueFile(),
): Promise<{ catalogue: Catalogue; ageMs: number | null }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { catalogue: EMPTY, ageMs: null };
  }
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - (await stat(file)).mtimeMs;
  } catch {
    /* read it, could not stat it: no age to report, not a failure */
  }
  return { catalogue: parseCatalogue(raw), ageMs };
}

/**
 * One file read: text plus mtime age, or null when there is no file. The two
 * catalogue copies are compared by this, newest wins.
 */
async function readCopy(file: string): Promise<{ raw: string; ageMs: number } | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let ageMs = 0;
  try {
    ageMs = Date.now() - (await stat(file)).mtimeMs;
  } catch {
    /* read it, could not stat it: age zero, newest by default */
  }
  return { raw, ageMs: Math.max(0, ageMs) };
}

/**
 * The catalogue from whichever copy is newer — OpenCode's or `adv`'s own —
 * falling back to the older when the newer parses to nothing. A corrupt new
 * fetch never blanks the rows while yesterday's file still parses.
 */
export async function loadBestCatalogue(
  opencodeFile: string = catalogueFile(),
  advFile: string = advCatalogueFile(),
): Promise<{ catalogue: Catalogue; ageMs: number | null }> {
  const [opencode, adv] = await Promise.all([readCopy(opencodeFile), readCopy(advFile)]);
  const first = adv && (!opencode || adv.ageMs <= opencode.ageMs) ? adv : opencode;
  const second = first === adv ? opencode : adv;
  if (first) {
    const parsed = parseCatalogue(first.raw);
    if (parsed.size > 0) return { catalogue: parsed, ageMs: first.ageMs };
  }
  if (second) {
    const parsed = parseCatalogue(second.raw);
    if (parsed.size > 0) return { catalogue: parsed, ageMs: second.ageMs };
  }
  return { catalogue: EMPTY, ageMs: first?.ageMs ?? second?.ageMs ?? null };
}

/**
 * Fetch models.dev and store it as `adv`'s own copy. Throws on network
 * failure, a non-200, or a payload that parses to nothing — callers report
 * it and keep the old cache, so a bad fetch never blanks the price column.
 */
export async function fetchCatalogue(
  url: string = MODELS_DEV_URL,
  file: string = advCatalogueFile(),
  timeoutMs = 30_000,
): Promise<{ catalogue: Catalogue; at: string; count: number }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "adv-catalogue" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`catalogue fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`catalogue fetch failed: HTTP ${res.status}`);
  const raw = await res.text();
  const catalogue = parseCatalogue(raw);
  if (catalogue.size === 0) throw new Error("catalogue fetch failed: payload parsed to nothing");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw.endsWith("\n") ? raw : `${raw}\n`);
  return { catalogue, at: new Date().toISOString(), count: catalogue.size };
}

const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

/**
 * The row badge. `?` for unknown, deliberately — a catalogue with no cost entry
 * is not a free model, and rendering it as one costs real money at 3am.
 * A tiered price shows the bump magnitude (`+5x`): the base price alone is the
 * number a long session will not pay.
 */
export function formatCost(c: Cost): string {
  if (c.kind === "free") return "free";
  if (c.kind === "unknown") return "?";
  if (!c.tiered) return `${usd(c.input)}/${usd(c.output)}`;
  const ratio = c.tier && c.output > 0 ? c.tier.output / c.output : NaN;
  const mag = Number.isFinite(ratio) && ratio > 1.05 ? `+${ratio >= 9.95 ? Math.round(ratio) : Math.round(ratio * 10) / 10}x` : "+";
  return `${usd(c.input)}/${usd(c.output)}${mag}`;
}

/** Which tier of a tiered price the picker shows and filters on. */
export type PriceBasis = "low" | "high";

/** 100000 prompt tokens reads as "100k", never as six digits in a sentence. */
export const formatTokens = (n: number): string =>
  n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);

/**
 * The price cell on the chosen basis. `low` is the base price with the bump
 * magnitude (`$0.10/$0.50+5x`); `high` is the above-threshold price a long
 * session actually pays (`$0.50/$2.50+`). Untiered prices read the same
 * either way. The `+` always means tiered — the export lists both prices
 * and the threshold, because no 16-wide cell can.
 */
export function formatCostBasis(c: Cost, basis: PriceBasis = "low"): string {
  if (c.kind !== "priced" || basis === "low" || !c.tier) return formatCost(c);
  return `${usd(c.tier.input)}/${usd(c.tier.output)}+`;
}

/**
 * Both prices and the threshold, for the export and the `?` pane — the places
 * with room. The row only carries the magnitude.
 */
export function formatCostFull(c: Cost): string {
  if (c.kind !== "priced" || !c.tier) return formatCost(c);
  return (
    `${usd(c.input)}/${usd(c.output)} to ${formatTokens(c.tier.overTokens)} tokens, ` +
    `then ${usd(c.tier.input)}/${usd(c.tier.output)}`
  );
}

/** `null` when the catalogue has never heard of the model. */
export const costOf = (catalogue: Catalogue, ref: string): Cost => {
  const entry = catalogue.get(ref);
  if (entry) return entry.cost;
  // A missing entry whose name ends in `-free` is a free serving the catalogue
  // has not caught up with: every `-free` ref models.dev lists (68 of them,
  // all providers) is `kind: "free"`, with no priced and no null
  // counterexample. So the name is evidence, and only for a silence — a
  // listed price is never overridden. A bare `free` is a name, not a tier.
  const model = splitRef(ref)?.model ?? ref;
  if (model.endsWith("-free")) return { kind: "free" };
  return { kind: "unknown" };
};

export const toolsOf = (catalogue: Catalogue, ref: string): boolean | undefined =>
  catalogue.get(ref)?.toolCall;

/**
 * Whether the catalogue says this model cannot call tools at all.
 *
 * Only meaningful when the agents have tools, which is repository mode. The
 * answer-mode agents are `DENY_ALL` (`agents.ts:178`), so for a general
 * question such a model is fine — marking it dead there would grey out models
 * that work.
 */
export function cannotUseTools(catalogue: Catalogue, ref: string, subject: "plan" | "answer") {
  if (subject !== "plan") return false;
  return toolsOf(catalogue, ref) === false;
}
