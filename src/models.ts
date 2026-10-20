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
 * The pool the picker draws from: the listing minus disabled providers,
 * then narrowed to the lock when one is set. Both are AND filters — a lock
 * on a disabled provider is an empty list — so the order is irrelevant, but
 * one helper keeps the two list builders from disagreeing about it.
 */
function providerPool(
  all: string[],
  providerLock: string | undefined,
  disabled: ReadonlySet<string> | undefined,
): string[] {
  return all.filter(
    (m) => !(disabled?.has(providerOf(m)) ?? false) && (!providerLock || providerOf(m) === providerLock),
  );
}

/**
 * Favourites and recents minus disabled providers. A favourite on a provider
 * the reader switched off is not "dropped" — it is still listed, still
 * reachable, just hidden by choice — so it is removed before grouping rather
 * than reported as unavailable.
 */
function enabledOnly(refs: string[], disabled: ReadonlySet<string> | undefined): string[] {
  if (!disabled || disabled.size === 0) return refs;
  return refs.filter((r) => !disabled.has(providerOf(r)));
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
 * One shared filter rule for every list: all whitespace-separated tokens must
 * match, each against the ref or (when the row resolved one) the benchmark
 * display name. Separators are ignored on both sides, so `muse 1.3`,
 * `spark-1.3` and `spark 13` all land on `muse-spark-1.3` — and on
 * `Muse Spark 1.3 (Max)` by its AA name. A phrase needs its words in order
 * with gaps allowed — `"deep 4.1"` lands on `deepseek-v4.1-flash` — against
 * one haystack, never split across ref and name. An empty filter matches
 * everything; an all-separator token matches nothing, never everything (in
 * OR it must not become a match-all). `mode` picks AND (every token, the
 * default) or OR (any token).
 */
/** AND needs every filter term; OR needs any one; OFF ignores the text. */
export type FilterMode = "and" | "or" | "off";

/**
 * The filter's terms: bare words, and `"…"` pairs as one phrase term. A quote
 * pair groups its words so the mode logic treats them as a unit — `"deep 4.1"`
 * in OR mode is phrase-rows plus the rest, not bare-`deep` rows. An
 * unterminated quote takes the rest of the string, the search-UI convention;
 * an empty pair and stray quote chars contribute nothing.
 */
export interface FilterTerm {
  /** The term's words, lowercased, in order. */
  words: string[];
  /** True for a `"…"` phrase: ordered, gaps allowed. False for a bare word. */
  phrase: boolean;
}

export function parseFilterTerms(filter: string): FilterTerm[] {
  const terms: FilterTerm[] = [];
  const lower = filter.toLowerCase();
  let i = 0;
  const pushWords = (text: string) => {
    for (const w of text.split(/\s+/).filter(Boolean)) terms.push({ words: [w], phrase: false });
  };
  while (i < lower.length) {
    const open = lower.indexOf('"', i);
    if (open === -1) {
      pushWords(lower.slice(i));
      break;
    }
    pushWords(lower.slice(i, open));
    const close = lower.indexOf('"', open + 1);
    const body = close === -1 ? lower.slice(open + 1) : lower.slice(open + 1, close);
    const words = body.split(/\s+/).filter(Boolean);
    if (words.length > 0) terms.push({ words, phrase: true });
    if (close === -1) break;
    i = close + 1;
  }
  return terms;
}

export function matchesFilter(
  ref: string,
  name: string | null,
  filter: string,
  mode: FilterMode = "and",
): boolean {
  const terms = parseFilterTerms(filter);
  if (terms.length === 0) return true;
  const hay = [ref.toLowerCase(), ...(name ? [name.toLowerCase()] : [])];
  const flat = hay.map((h) => h.replace(/[-_./ ]/g, ""));
  const wordHit = (t: string): boolean => {
    if (hay.some((h) => h.includes(t))) return true;
    const ft = t.replace(/[-_./]/g, "");
    return ft.length > 0 && flat.some((f) => f.includes(ft));
  };
  // Word spans with separators ignored: find each word in turn past the last,
  // so `"deep flash"` skips `deepseek-v4.1-` and still lands. A word that is
  // all separators contributes nothing — it would otherwise be a free hit.
  const phraseHit = (words: string[]): boolean => {
    const cleaned = words
      .map((w) => w.replace(/[-_./]/g, ""))
      .filter((w) => w.length > 0);
    if (cleaned.length === 0) return false;
    return flat.some((f) => {
      let from = 0;
      return cleaned.every((w) => {
        const at = f.indexOf(w, from);
        if (at === -1) return false;
        from = at + w.length;
        return true;
      });
    });
  };
  const hit = (term: FilterTerm): boolean =>
    term.phrase ? phraseHit(term.words) : wordHit(term.words[0]!);
  // AND needs every term; OR needs any one, so `muse mimo` is the union —
  // and a quoted phrase is one term, not its words apart.
  return mode === "or" ? terms.some(hit) : terms.every(hit);
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
 *
 * `providerLock` narrows the pool before anything else — favourites, recents,
 * filter and scores all apply inside it, so it composes with every other layer
 * instead of replacing one. `disabled` removes providers the same way, and a
 * favourite on a removed provider vanishes silently: hidden by choice, not
 * unavailable, so it never lands in `dropped`.
 */
export function orderedModels(
  all: string[],
  favourites: string[],
  recents: string[],
  filter = "",
  opts: {
    hideUnscored?: boolean;
    scoreOf?: (ref: string) => ModelScore;
    /** Benchmark display name for the filter (`Muse Spark 1.3 (Max)`). Null when the row resolved none. */
    nameOf?: (ref: string) => string | null;
    providerLock?: string;
    /** Providers the reader switched off on the `F` screen. Composes with the lock. */
    disabled?: ReadonlySet<string>;
    /** `or` needs any filter term to match; the default `and` needs every one. `off` ignores the text. */
    filterMode?: FilterMode;
    /** Show only the refs this accepts — the `N` screen. Composes with everything else. */
    keep?: (ref: string) => boolean;
  } = {},
): ModelList {
  const pool = providerPool(all, opts.providerLock, opts.disabled);
  const enabledFavs = enabledOnly(favourites, opts.disabled);
  const enabledRecents = enabledOnly(recents, opts.disabled);
  const grouped = keepRows(
    opts.hideUnscored && opts.scoreOf
      ? hideUnscoredRows(groupModels(pool, enabledFavs, enabledRecents), opts.scoreOf)
      : groupModels(pool, enabledFavs, enabledRecents),
    opts.keep,
  );
  const nameOf = opts.nameOf ?? (() => null);

  const rows: ModelRow[] = [];
  const items: { row: number; ref: string }[] = [];
  const push = (ref: string) => {
    items.push({ row: rows.length, ref });
    rows.push({ kind: "model", ref });
  };

  if (opts.filterMode !== "off" && filter.trim()) {
    const seen = new Set<string>();
    for (const ref of [...grouped.favourites, ...grouped.recents, ...grouped.rest]) {
      if (seen.has(ref) || !matchesFilter(ref, nameOf(ref), filter, opts.filterMode)) continue;
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
      label: `★ favourites OpenCode marks (${grouped.favourites.length} of ${enabledFavs.length} reachable)`,
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
  /** Measured $/task ceiling for the taskcost view. `Infinity` filters nothing. */
  taskCeiling?: number;
  favourites?: string[];
  /** Show only this provider. Composes with the filter, the ceiling and the views. */
  providerLock?: string;
  /** Providers the reader switched off on the `F` screen. Composes with the lock. */
  disabled?: ReadonlySet<string>;
  scoreOf: (ref: string) => ModelScore;
  /** Benchmark display name for the filter. Null when the row resolved none. */
  nameOf?: (ref: string) => string | null;
  /** Output $/M, `undefined` when the catalogue is silent. Not "free": free is 0. */
  outputOf: (ref: string) => number | undefined;
  /** Measured $/task, `undefined` when AA never measured it. The taskcost view filters on this. */
  taskCostOf?: (ref: string) => number | undefined;
  /**
   * What decides the order. `score` ranks by intelligence, highest first;
   * `cost` ranks by measured $/task, cheapest first — the `S` toggle. Both
   * put unmeasured rows last, alphabetically; the views still decide the
   * filter. Defaults to `score`.
   */
  rankBy?: "score" | "cost";
  /** `or` needs any filter token to match; the default `and` needs every one. `off` ignores the text. */
  filterMode?: FilterMode;
  /** Show only the refs this accepts — the `N` screen. Composes with the filter and the views. */
  keep?: (ref: string) => boolean;
}

const scoredOnly = (scoreOf: (ref: string) => ModelScore, refs: string[]): string[] =>
  refs.filter((ref) => scoreOf(ref) !== null);

/**
 * Apply the text filter and the unscored toggle to a flat ref list.
 *
 * The filter is the same token rule `orderedModels` uses, so typing in
 * one view never means something different in another.
 */
function visibleRefs(
  refs: string[],
  filter: string,
  hideUnscored: boolean,
  scoreOf: (ref: string) => ModelScore,
  nameOf: (ref: string) => string | null = () => null,
  filterMode: FilterMode = "and",
): string[] {
  const matching =
    filterMode !== "off" && filter.trim()
      ? refs.filter((ref) => matchesFilter(ref, nameOf(ref), filter, filterMode))
      : [...refs];
  return hideUnscored ? scoredOnly(scoreOf, matching) : matching;
}

const byIntelligenceDesc =
  (scoreOf: (ref: string) => ModelScore) =>
  (a: string, b: string): number =>
    (scoreOf(b)?.intelligence ?? Number.NEGATIVE_INFINITY) -
      (scoreOf(a)?.intelligence ?? Number.NEGATIVE_INFINITY) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Cheapest measured task first. Unmeasured rows never reach this comparator —
 * the caller filters them into the trailing alphabetical tail — so there is
 * no `undefined` branch to get wrong.
 */
const byTaskCostAsc =
  (taskCostOf: (ref: string) => number | undefined) =>
  (a: string, b: string): number =>
    taskCostOf(a)! - taskCostOf(b)! || (a < b ? -1 : a > b ? 1 : 0);

/**
 * What the picker lists, and in what order. `provider` is the grouped list
 * the picker has always shown; the flat views rank by benchmark instead.
 * `value` is cheap per token (output $/M under a ceiling); `taskcost` is
 * cheap per measured task. Two different cheapnesses — a terse model at a
 * high per-token price can win the second while losing the first — so they
 * are two views, and `V` toggles between them, rather than one view with a
 * hidden sort state.
 */
export type PickerView = "provider" | "intelligence" | "value" | "taskcost";

/**
 * A flat, ordered list for the intelligence, value and taskcost views.
 *
 * Score order ranks by intelligence, highest first; cost order ranks by
 * measured $/task, cheapest first. Unranked rows follow alphabetically —
 * findable, never ranked above a measured one. The views differ only in what
 * they filter on: value keeps models with a known output cost at or under
 * the ceiling, taskcost keeps models with a measured task at or under
 * theirs. In both, an unknown cost cannot be called cheap, so unmeasured
 * rows are excluded rather than trailing last — the `?` pane says where the
 * measurement comes from when the view is empty for it.
 * Ties break alphabetically, so the order is stable between refreshes.
 */
export function rankModels(
  refs: string[],
  view: "intelligence" | "value" | "taskcost",
  opts: RankOptions,
): ModelList {
  const {
    filter = "",
    hideUnscored = false,
    ceiling = 0.8,
    taskCeiling = Number.POSITIVE_INFINITY,
    favourites = [],
    providerLock,
    disabled,
    scoreOf,
    outputOf,
    taskCostOf = () => undefined,
    rankBy = "score",
    nameOf = () => null,
    filterMode = "and",
    keep = () => true,
  } = opts;
  const pool = providerPool(refs, providerLock, disabled);
  const visible = visibleRefs(pool, filter, hideUnscored, scoreOf, nameOf, filterMode).filter((ref) => keep(ref));
  // Each flat view filters on its own cheapness: output $/M under a ceiling,
  // or measured $/task under one. An unknown cost cannot be called cheap, so
  // unmeasured rows never pass a ceiling — the same rule in both views.
  const inView =
    view === "value"
      ? visible.filter((ref) => {
          const out = outputOf(ref);
          return out !== undefined && out <= ceiling;
        })
      : view === "taskcost"
        ? visible.filter((ref) => {
            const t = taskCostOf(ref);
            return t !== undefined && t <= taskCeiling;
          })
        : visible;
  // Cost order ranks on the same measurement the taskcost view filters on —
  // `D` swaps its source with the score's, so the two switch together. Score
  // order ranks on intelligence; both leave the unmeasurable trailing,
  // alphabetical, and `H` keeps meaning "has a score" either way.
  const ranked =
    rankBy === "cost"
      ? inView.filter((ref) => taskCostOf(ref) !== undefined).sort(byTaskCostAsc(taskCostOf))
      : inView.filter((ref) => scoreOf(ref) !== null).sort(byIntelligenceDesc(scoreOf));
  const unranked = hideUnscored
    ? []
    : rankBy === "cost"
      ? inView.filter((ref) => taskCostOf(ref) === undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : inView.filter((ref) => scoreOf(ref) === null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ordered = [...ranked, ...unranked];

  const rows: ModelRow[] = [];
  const items: { row: number; ref: string }[] = [];
  for (const ref of ordered) {
    items.push({ row: rows.length, ref });
    rows.push({ kind: "model", ref });
  }
  const listed = new Set(refs);
  return { rows, items, favourite: new Set(favourites.filter((f) => listed.has(f))), dropped: [] };
}

/** Keep only the refs `keep` accepts, from an already-built provider list. */
function keepRows(
  grouped: { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] },
  keep: ((ref: string) => boolean) | undefined,
): { favourites: string[]; recents: string[]; rest: string[]; dropped: string[] } {
  if (!keep) return grouped;
  return {
    favourites: grouped.favourites.filter((r) => keep(r)),
    recents: grouped.recents.filter((r) => keep(r)),
    rest: grouped.rest.filter((r) => keep(r)),
    dropped: grouped.dropped,
  };
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
