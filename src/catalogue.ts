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

import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** What a model costs. `unknown` is a real answer and is never rendered "free". */
export type Cost =
  | { kind: "free" }
  | { kind: "priced"; input: number; output: number; tiered: boolean }
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
  return {
    kind: "priced",
    input: c.input,
    output: c.output,
    // Long inputs bill at a higher rate. A run that crosses the threshold costs
    // more than the number on the row, so the row says so.
    tiered: Array.isArray(c.tiers) && c.tiers.length > 0,
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
      };
      const ref = `${provider}/${model}`;
      out.set(ref, {
        ...(typeof e.family === "string" && e.family.trim() ? { family: e.family.trim() } : {}),
        ...(typeof e.tool_call === "boolean" ? { toolCall: e.tool_call } : {}),
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

const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

/**
 * The row badge. `?` for unknown, deliberately — a catalogue with no cost entry
 * is not a free model, and rendering it as one costs real money at 3am.
 */
export function formatCost(c: Cost): string {
  if (c.kind === "free") return "free";
  if (c.kind === "unknown") return "?";
  return `${usd(c.input)}/${usd(c.output)}${c.tiered ? "+" : ""}`;
}

/** `null` when the catalogue has never heard of the model. */
export const costOf = (catalogue: Catalogue, ref: string): Cost =>
  catalogue.get(ref)?.cost ?? { kind: "unknown" };

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
