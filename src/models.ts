/**
 * Model discovery and the picker's order.
 *
 * `opencode models` prints one `provider/model` per line and needs no API call,
 * which keeps the picker instant and free.
 *
 * **But it is a catalogue, not an availability check.** It lists every model in
 * models.dev for any provider holding a credential, and never asks the provider
 * which of those the credential can call — it offers models Groq answers
 * `model_not_found` for. `docs/OPENCODE-MODELS.md` has the diff. So this module
 * treats the listing as *candidates*: `catalogue.ts` adds what is knowable
 * offline, and `probe.ts` settles the rest. Nothing here decides a model works.
 */

export async function listModels(repo: string): Promise<string[]> {
  const proc = Bun.spawn(["opencode", "models"], {
    cwd: repo,
    // opencode resolves the project from $PWD; see OpencodeRunRunner.call.
    env: { ...process.env, PWD: repo },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[^\s/]+\/\S+$/.test(line));
}

/** The provider half of a ref — `opencode-go`, `openrouter`, `local`. */
export const providerOf = (ref: string): string => ref.split("/")[0] ?? ref;

/**
 * Providers the reader subscribed to sort first, then the long tail.
 *
 * `opencode-go` is the subscription thirty models live behind;
 * `openrouter` is the gateway with three hundred. Alphabetical would bury
 * both under `302ai`. Anything unlisted sorts after, alphabetically.
 */
const PROVIDER_RANK = ["opencode-go", "openrouter", "deepseek"];

export function providerRank(provider: string): number {
  const at = PROVIDER_RANK.indexOf(provider);
  return at < 0 ? PROVIDER_RANK.length : at;
}

const byProviderRank = (a: string, b: string): number =>
  providerRank(a) - providerRank(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * A coarse family label, used only to name a model's family in the picker and
 * to label models in the settings screen.
 *
 * The first token after the provider, lowercased: `opencode-go/muse-spark-1.3`
 * -> "muse", `groq/openai/gpt-oss-120b` -> "openai".
 *
 * This is a guess where `familyClash` below is a statement: the explicit
 * `family` field in `.adv/config.json` is what the diversity check compares,
 * because a gateway serves many families under one provider. Do not use it to
 * decide whether a pair is diverse.
 */
export function familyOf(ref: string): string {
  const model = ref.split("/").slice(1).join("/").toLowerCase();
  return model.split(/[-_./]/).filter(Boolean)[0] ?? model;
}

/**
 * The diversity check. Compares the **explicit** `family` fields, not the refs:
 * a gateway serves several families under one provider, and the ref is a guess
 * where the family is a statement.
 *
 * **Prefix-tolerant**, because the two sources disagree on granularity and a
 * strict equality misses the case the check exists to catch. `familyOf` says
 * `deepseek` for `opencode-go/deepseek-v4.1-flash`; the models.dev catalogue
 * says `deepseek-flash`. A drafter labelled `deepseek` and a reviewer labelled
 * `deepseek-flash` are the same family, and under `familyCheck: "require"` that
 * pair must not be allowed to start a trial and measure "an extra pass" while
 * claiming to measure cross-family review.
 *
 * Note what this is *not* allowed to become: the catalogue's own family labels
 * are not a drop-in replacement. They are finer-grained (`claude-haiku`,
 * `gpt-luna`), so swapping them in would reintroduce exactly the miss above
 * under a different spelling. They are shown in the picker and nowhere else.
 *
 * Returns the human-facing sentence, or null when the pair is diverse.
 */
export function familyClash(models: {
  drafter: { ref: string; family: string };
  reviewer: { ref: string; family: string };
}): string | null {
  const a = models.drafter.family.trim().toLowerCase();
  const b = models.reviewer.family.trim().toLowerCase();
  if (!a || !b) return null;
  if (a !== b && !a.startsWith(b) && !b.startsWith(a)) return null;
  return (
    `drafter and reviewer share family "${models.drafter.family}" — ` +
    `the review adds less than a cross-family one would`
  );
}

/**
 * The picker, ordered: favourites, then recent models, then everything else.
 *
 * There are many models and two slots to fill, so the list a human scans is the
 * wrong one — it is the whole provider catalogue, and the models that are
 * actually used are somewhere inside it. OpenCode already knows which ones those
 * are (see `opencode-state.ts`), so the order follows its list rather than a
 * second judgement made here.
 *
 * A favourite that `opencode models` does not list is dropped: that is a model
 * whose provider is no longer authenticated or configured, and offering it would
 * offer a run that cannot happen. A model goes missing from the *picker*, never
 * from the pair list — there a stale pair is shown and marked `!`. The dropped
 * refs are returned, because dropping them silently is how four of twenty
 * favourites once vanished with nothing to say why.
 */
export function groupModels(
  all: string[],
  favourites: string[],
  recents: string[],
): { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] } {
  const listed = new Set(all);
  const dropped = favourites.filter((m) => !listed.has(m));
  const favs = favourites.filter((m) => listed.has(m));
  const inFavourites = new Set(favs);
  const recs = recents.filter((m) => listed.has(m) && !inFavourites.has(m));
  const grouped = new Set([...favs, ...recs]);
  const rest = [...all].sort().filter((m) => !grouped.has(m));
  return { favourites: favs, recents: recs, rest, dropped };
}

/**
 * One line of the picker. Only `model` rows are selectable.
 *
 * `group` and `provider` rows exist so the list can say what the rows under it
 * are. They are never cursor targets, which keeps the index arithmetic over
 * models alone — see `items`.
 */
export type ModelRow =
  | { kind: "group"; label: string; note?: string }
  | { kind: "provider"; provider: string; count: number }
  | { kind: "model"; ref: string };

export interface ModelList {
  rows: ModelRow[];
  /** Where each selectable row sits, in order. Headers are not in here. */
  items: { row: number; ref: string }[];
  favourite: Set<string>;
  /** Favourites OpenCode marked that `opencode models` no longer lists. */
  dropped: string[];
}

/**
 * The rows the picker draws, in that order, filtered and deduplicated.
 *
 * With a filter typed the groups are flattened into one list with no headers:
 * three headings compete with a short result set, and the order still says what
 * is what — a favourite matching the filter comes first. First occurrence wins,
 * so a model that is both recent and in the rest is listed once.
 *
 * Unfiltered, the "rest" is the group that needs help: 390 openrouter models
 * alphabetically bury the 29 opencode-go ones a reader subscribed to. So it is
 * split by provider, each under its own header. Favourites and recents are a
 * person's own twenty and ten rows, and stay flat.
 *
 * **No row cap.** There used to be one at 500, and it was two bugs: the footer
 * counted the truncated list and so reported a number that was not the number of
 * matches, and the keyboard handler computed its own untruncated list, so the
 * cursor could walk past the end of what was drawn and leave a blank screen. The
 * list is already in memory and the window already scrolls, so there was nothing
 * to buy.
 */
export function orderedModels(
  all: string[],
  favourites: string[],
  recents: string[],
  filter = "",
  opts: { hideUnscored?: boolean; scoreOf?: (ref: string) => ModelScore } = {},
): ModelList {
  const grouped =
    opts.hideUnscored && opts.scoreOf
      ? hideUnscoredRows(groupModels(all, favourites, recents), opts.scoreOf)
      : groupModels(all, favourites, recents);
  const needle = filter.trim().toLowerCase();

  const rows: ModelRow[] = [];
  const items: { row: number; ref: string }[] = [];
  const push = (ref: string) => {
    items.push({ row: rows.length, ref });
    rows.push({ kind: "model", ref });
  };

  if (needle) {
    const seen = new Set<string>();
    for (const ref of [...grouped.favourites, ...grouped.recents, ...grouped.rest]) {
      if (seen.has(ref) || !ref.toLowerCase().includes(needle)) continue;
      seen.add(ref);
      push(ref);
    }
    return finish(grouped, rows, items);
  }

  // The counts are on the header because a header that silently drops rows is
  // how a list loses a fifth of itself without anyone noticing — and "six of
  // twenty" needs saying out loud, because those six are OpenCode's own
  // favourites and their absence from its picker is the reader's puzzle.
  if (grouped.favourites.length > 0) {
    rows.push({
      kind: "group",
      label: `★ favourites OpenCode marks (${grouped.favourites.length} of ${favourites.length} reachable)`,
      ...(grouped.dropped.length
        ? { note: `${grouped.dropped.length} not available — ? to see which` }
        : {}),
    });
    grouped.favourites.forEach(push);
  }
  if (grouped.recents.length > 0) {
    rows.push({ kind: "group", label: "recent models" });
    grouped.recents.forEach(push);
  }

  const byProvider = new Map<string, string[]>();
  for (const ref of grouped.rest) {
    const p = providerOf(ref);
    const bucket = byProvider.get(p);
    if (bucket) bucket.push(ref);
    else byProvider.set(p, [ref]);
  }
  for (const provider of [...byProvider.keys()].sort(byProviderRank)) {
    const bucket = byProvider.get(provider)!;
    rows.push({ kind: "provider", provider, count: bucket.length });
    bucket.forEach(push);
  }

  return finish(grouped, rows, items);
}

/**
 * What a row needs to know about a score. `null` is unscored — never a 0.
 * Structural on purpose: the picker adapts `scoresFor` to this, and this
 * module stays ignorant of catalogues and caches.
 */
export type ModelScore = { intelligence?: number } | null;

export interface RankOptions {
  filter?: string;
  /** Drop refs with no benchmark. Off by default: unscored rows sort last. */
  hideUnscored?: boolean;
  /** Output $/M ceiling for the value view. `prefs.ts` owns the default. */
  ceiling?: number;
  favourites?: string[];
  scoreOf: (ref: string) => ModelScore;
  /** Output $/M, `undefined` when the catalogue is silent. Not "free": free is 0. */
  outputOf: (ref: string) => number | undefined;
}

const scoredOnly = (scoreOf: (ref: string) => ModelScore, refs: string[]): string[] =>
  refs.filter((ref) => scoreOf(ref) !== null);

/**
 * Apply the text filter and the unscored toggle to a flat ref list.
 *
 * The filter is the same substring rule `orderedModels` uses, so typing in
 * one view never means something different in another.
 */
function visibleRefs(
  refs: string[],
  filter: string,
  hideUnscored: boolean,
  scoreOf: (ref: string) => ModelScore,
): string[] {
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? refs.filter((ref) => ref.toLowerCase().includes(needle))
    : [...refs];
  return hideUnscored ? scoredOnly(scoreOf, matching) : matching;
}

const byIntelligenceDesc =
  (scoreOf: (ref: string) => ModelScore) =>
  (a: string, b: string): number =>
    (scoreOf(b)?.intelligence ?? Number.NEGATIVE_INFINITY) -
      (scoreOf(a)?.intelligence ?? Number.NEGATIVE_INFINITY) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * What the picker lists, and in what order. `provider` is the grouped list
 * the picker has always shown; the flat views rank by benchmark instead.
 */
export type PickerView = "provider" | "intelligence" | "value";

/**
 * A flat, score-ordered list for the intelligence and value views.
 *
 * Scored rows come first, highest intelligence first; unscored rows follow
 * alphabetically — findable, never ranked above a measured one. The value
 * view keeps only models with a known output cost at or under the ceiling:
 * an unknown cost cannot be called cheap. Ties break alphabetically, so the
 * order is stable between refreshes.
 */
export function rankModels(
  refs: string[],
  view: "intelligence" | "value",
  opts: RankOptions,
): ModelList {
  const {
    filter = "",
    hideUnscored = false,
    ceiling = 0.8,
    favourites = [],
    scoreOf,
    outputOf,
  } = opts;
  const visible = visibleRefs(refs, filter, hideUnscored, scoreOf);
  const inView =
    view === "value"
      ? visible.filter((ref) => {
          const out = outputOf(ref);
          return out !== undefined && out <= ceiling;
        })
      : visible;
  const scored = inView.filter((ref) => scoreOf(ref) !== null).sort(byIntelligenceDesc(scoreOf));
  const unscored = hideUnscored
    ? []
    : inView.filter((ref) => scoreOf(ref) === null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ordered = [...scored, ...unscored];

  const rows: ModelRow[] = [];
  const items: { row: number; ref: string }[] = [];
  for (const ref of ordered) {
    items.push({ row: rows.length, ref });
    rows.push({ kind: "model", ref });
  }
  const listed = new Set(refs);
  return { rows, items, favourite: new Set(favourites.filter((f) => listed.has(f))), dropped: [] };
}

/** Hide refs without a benchmark from an already-built provider list. */
function hideUnscoredRows(
  grouped: { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] },
  scoreOf: (ref: string) => ModelScore,
): { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] } {
  return {
    favourites: scoredOnly(scoreOf, grouped.favourites),
    recents: scoredOnly(scoreOf, grouped.recents),
    rest: scoredOnly(scoreOf, grouped.rest),
    dropped: grouped.dropped,
  };
}

/** Shared tail: no row cap, first occurrence wins — see `orderedModels`. */
function finish(
  grouped: { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] },
  rows: ModelRow[],
  items: { row: number; ref: string }[],
): ModelList {
  return { rows, items, favourite: new Set(grouped.favourites), dropped: grouped.dropped };
}
