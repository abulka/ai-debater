/**
 * What a provider actually is, on this machine.
 *
 * The picker lists 651 models across 13 providers and nothing marks which bill a
 * given row lands on. That is not a hypothetical confusion: `opencode-go` is the
 * subscription and `opencode` is OpenCode Console, a *different account* that
 * bills per token, and this machine's Console account had no credit on 18 Oct
 * 2026. Two of the twenty OpenCode favourites were on it.
 *
 * Most of what follows is derived — `opencode auth list` says which credentials
 * exist, the catalogue says which models are free, and the listing says how many
 * there are. **What is not derived is account state**, and that is the small
 * dated table at the bottom. Those are observations, they expire, and a date on
 * one is honest where no date would be a lie waiting to happen.
 */

import { loadCatalogue, type Catalogue } from "./catalogue.ts";
import { providerOf } from "./models.ts";

/**
 * Which providers hold a credential, and how it is present.
 *
 * Parsed from `opencode auth list`, which costs nothing. The display names do not
 * match the provider ids — "OpenCode Go" is `opencode-go`, "OpenCode Console" is
 * `opencode`, "Together AI" is `togetherai` — so the match is on the alphanumeric
 * form, longest provider id first. Without "longest first", "OpenCode Go"
 * prefix-matches `opencode` and the subscription is reported as the account
 * that has no credit, which is the exact confusion this file exists to remove.
 */
export async function authedProviders(listing: string[]): Promise<Map<string, "env" | "stored">> {
  const proc = Bun.spawn(["opencode", "auth", "list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  // The provider ids come from the listing, not from a table here: `adv` only
  // ever offers models that listing named, so a provider absent from it cannot
  // appear in the picker and has nothing to report.
  return parseAuthList(out, [...new Set(listing.map(providerOf))]);
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `<Display Name>  <method>  <environment|stored>` per line. */
export function parseAuthList(out: string, providers: string[]): Map<string, "env" | "stored"> {
  const keys = providers.map((p) => ({ id: p, key: alnum(p) })).sort((a, b) => b.key.length - a.key.length);
  const found = new Map<string, "env" | "stored">();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s{2,}|\t/);
    if (parts.length < 2) continue;
    const name = alnum(parts[0] ?? "");
    if (!name) continue;
    const source = /stored/i.test(line) ? "stored" : "env";
    const match = keys.find((k) => name.startsWith(k.key));
    // First credential wins for a provider; "stored" beats "env" because a saved
    // login is the one a reader will have just used.
    const existing = match ? found.get(match.id) : undefined;
    if (match && (!existing || source === "stored")) found.set(match.id, source);
  }
  return found;
}

/**
 * Account facts no command on this machine can report.
 *
 * Everything here is an observation made on a date, and every one of them can
 * stop being true: credit gets added, a privacy opt-in gets exposed in the
 * desktop app, a subscription lapses. A ping re-derives the first kind of fact
 * in three seconds; these exist so the picker can explain itself *before* anyone
 * spends a call finding out.
 */
export const PROVIDER_NOTES: Record<string, string> = {
  "opencode-go":
    "your Go subscription — metered by the plan. Models ending -free cost nothing.",
  opencode:
    "OpenCode Console — a different account from Go, and metered per token. " +
    "This machine's Console account answered 402 no credit. (18 Oct 2026)",
  groq: "GROQ_API_KEY. Its /models endpoint is the one place this machine's listing is provably wrong. (18 Oct 2026)",
};

/** Notes that attach to a model by its id rather than to a provider. */
export const MODEL_NOTES: { match: string; text: string }[] = [
  {
    match: "contributor",
    text:
      "trains on request data — your prompts and completions may train the " +
      "provider's models (Gemini → Google, Muse Spark → Meta). Not a price tier: " +
      "Muse is heavily discounted, Argon is full price. Only a -free name costs nothing.",
  },
  {
    match: "free",
    text: "free tier. Free does not mean reachable — a Console account with no credit refuses its free models too.",
  },
];

/** The note that applies to a model, if any. Model notes win: they are specific. */
export function noteForModel(ref: string): string | undefined {
  const id = ref.split("/").slice(1).join("/").toLowerCase();
  return MODEL_NOTES.find((n) => id.includes(n.match))?.text;
}

export interface ProviderBill {
  provider: string;
  /** How many of the listing are on this provider. */
  listed: number;
  free: number;
  priced: number;
  /** No cost recorded upstream — rendered `?`, never assumed free. */
  unknown: number;
  /** Catalogue says these cannot call tools, so they cannot be a repo agent. */
  noTools: number;
  keyed: "env" | "stored" | null;
  billing: "free only" | "metered" | "unknown";
  note?: string;
}

/**
 * One row of the `?` pane. Pure, so the counts are tested rather than drawn.
 *
 * `billing` is derived rather than declared, because a table of "which provider
 * is which" is a table that goes stale silently. It says "metered" whenever any
 * model on the provider costs something, "free only" when every listed model is
 * free, and "unknown" when the catalogue has heard of none of them — which is a
 * real state, not an edge case: 77 of the 651 rows have no cost upstream.
 */
export function providerBill(
  provider: string,
  models: string[],
  catalogue: Catalogue,
  keyed: "env" | "stored" | null,
): ProviderBill {
  let free = 0;
  let priced = 0;
  let unknown = 0;
  let noTools = 0;
  for (const ref of models) {
    const entry = catalogue.get(ref);
    switch (entry?.cost.kind) {
      case "free":
        free += 1;
        break;
      case "priced":
        priced += 1;
        break;
      default:
        unknown += 1;
    }
    if (entry?.toolCall === false) noTools += 1;
  }
  return {
    provider,
    listed: models.length,
    free,
    priced,
    unknown,
    noTools,
    keyed,
    billing: priced > 0 ? "metered" : free > 0 ? "free only" : "unknown",
    ...(PROVIDER_NOTES[provider] ? { note: PROVIDER_NOTES[provider] } : {}),
  };
}

/** Every provider in the listing, with its bill. Sorted by name. */
export function allProviderBills(
  listing: string[],
  catalogue: Catalogue,
  authed: Map<string, "env" | "stored">,
): ProviderBill[] {
  const byProvider = new Map<string, string[]>();
  for (const ref of listing) {
    const p = providerOf(ref);
    const bucket = byProvider.get(p);
    if (bucket) bucket.push(ref);
    else byProvider.set(p, [ref]);
  }
  return [...byProvider.keys()]
    .sort()
    .map((p) => providerBill(p, byProvider.get(p) ?? [], catalogue, authed.get(p) ?? null));
}

export { loadCatalogue };
