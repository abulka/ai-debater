import type { FilterMode, PickerView } from "./models.ts";

/**
 * What the picker says in place of an empty list.
 *
 * An empty view is not self-explanatory: `taskcost` without an AA key has no
 * measured cost to show, and a ceiling can exclude every row. The reason and
 * the way out belong on the screen, not only behind `?` — the footer and the
 * list are where a reader looks first. This struct is everything needed to
 * tell the three empty cases apart: no data at all (a key or a refresh), data
 * present but filtered out (a ceiling or the text filter), or nothing in the
 * catalogue to begin with.
 */
export interface EmptyPickState {
  view: PickerView;
  /** `D` is on: taskcost reads AI Coding Daily's $/task, not AA's. */
  rankAcd: boolean;
  /** An AA key is stored. Without one, AA task $ is absent from the cache. */
  aaKey: boolean;
  /** Any model carries a measured task cost in the loaded cache, for the active source. */
  hasTaskData: boolean;
  /** Any model carries an output price in the loaded catalogue. */
  hasPriceData: boolean;
  ceiling: number;
  taskCeiling: number;
  filter: string;
  filterMode: FilterMode;
}

/**
 * The one-row warning under an empty model list. Kept short enough to read
 * before a narrow terminal truncates it: the first clause says what is
 * missing, the rest says which key fixes it.
 */
export function emptyPickText(s: EmptyPickState): string {
  const filtered = s.filterMode !== "off" && s.filter.trim() !== "";
  const clear = filtered ? " · clear the filter" : "";
  if (s.view === "taskcost") {
    if (!s.hasTaskData) {
      if (s.rankAcd) {
        return s.aaKey
          ? "no ACD $/task in the cached leaderboard — refresh caches in settings, or D for AA task $"
          : "no ACD $/task in the cached leaderboard — refresh caches in settings";
      }
      return s.aaKey
        ? "no AA task $ in the benchmark cache — refresh caches in settings, or D for ACD $/task"
        : "no AA key — set one in settings → benchmarks, or D for ACD $/task";
    }
    return s.rankAcd
      ? `no ACD $/task at or under $${s.taskCeiling.toFixed(2)} — press > to widen the ceiling${clear}`
      : `no task $ at or under $${s.taskCeiling.toFixed(2)}/task — press > to widen the ceiling${clear}`;
  }
  if (s.view === "value") {
    if (!s.hasPriceData) return "no output prices in the catalogue — refresh caches in settings";
    return `no output price at or under $${s.ceiling.toFixed(2)}/M — press > to widen the ceiling${clear}`;
  }
  if (s.view === "intelligence") {
    return filtered
      ? "no model matches the filter"
      : "no scored models in the benchmark cache — refresh caches in settings";
  }
  return filtered ? "no model matches the filter" : "no models available — check the provider switches (F)";
}

/**
 * What the picker's hint area says. One struct in, one string out — the App
 * computes the wrapped rows for the viewport budget and `Pick` renders them,
 * so the budget and the screen can never disagree about how many rows hints
 * take.
 */
export interface HintState {
  pickMode: "browse" | "select" | "build";
  buildStep: "drafter" | "reviewer" | null;
  view: PickerView;
  rankAcd: boolean;
  rankCost: boolean;
  providerLock: string | null;
  /** Providers switched off on the `F` screen — the hint says how many. */
  disabledCount: number;
  /** AND needs every filter word; OR needs any one; OFF ignores the text. The filter line marks non-defaults. */
  filterMode: FilterMode;
  ceiling: number;
  taskCeiling: number;
  /** Stored highlight patterns — the M hint only shows when one exists to mute. */
  highlightCount: number;
  /** Session mute for the highlight rows. On: rows read in colour. */
  highlightsOn: boolean;
  /** `N`: the list shows only the highlighted rows. */
  highlightsOnly: boolean;
}

/**
 * `<` and `>` glued with a non-breaking space: a wrap never splits the pair.
 * Built from an explicit escape, never a literal — an invisible character in
 * source is exactly the kind of thing this codebase refuses to trust.
 */
const CEIL_KEYS = "<" + "\u00A0" + ">";

/**
 * The full hint text, segments joined with ` · ` in priority order: how to
 * move, what the list is (view, price, ranking), then what acts on it
 * (ceilings, refresh, ping, export). Narrow terminals lose the tail, never
 * the navigation.
 *
 * Only keys that work in this view are named: a hint for a dead key invites
 * a press that does nothing. `D` and `S` are inert in the provider view,
 * which is grouped rather than ranked; `M` and `N` only show when a highlight
 * pattern exists to mute or narrow by. Both name their destination, like `L`
 * does, so a toggle reads both ways. The ceiling hint only shows where its keys work —
 * the value and taskcost views.
 */
export function buildHintText(s: HintState): string {
  const nav =
    s.pickMode === "browse"
      ? "^F/^B page · ^D/^U half · Esc home"
      : s.pickMode === "build"
        ? `building a pair — Enter picks the ${s.buildStep ?? "drafter"} · ^F/^B page · ^D/^U half · Esc cancel`
        : "↑↓ choose · Enter select · ^F/^B page · ^D/^U half · Esc back";
  const costRank = s.rankCost && s.view !== "provider";
  const keys = [
    "V switch view",
    "C price basis",
    "H hide unscored",
    // The mode is named in full three ways, like `L` does: the destination of
    // the next press reads on the key itself. Glued so a wrap never splits it.
    ...(s.highlightCount > 0 ? [s.highlightsOn ? "M highlights off" : "M highlights on"] : []),
    ...(s.highlightCount > 0 ? [s.highlightsOnly ? "N show all" : "N highlighted only"] : []),
    // The mode is named in full three ways, like `L` does: the destination of
    // the next press reads on the key itself. Glued so a wrap never splits it.
    s.filterMode === "and"
      ? "Tab\u00A0filter:\u00A0OR"
      : s.filterMode === "or"
        ? "Tab\u00A0filter:\u00A0OFF"
        : "Tab\u00A0filter:\u00A0AND",
    "R filter history (saves this filter)",
    ...(s.view !== "provider"
      ? [
          s.rankAcd
            ? costRank
              ? "D\u00A0sort\u00A0by\u00A0$/task"
              : "D\u00A0sort\u00A0by\u00A0AA\u00A0intelligence"
            : costRank
              ? "D\u00A0sort\u00A0by\u00A0ACD\u00A0$/task"
              : "D\u00A0sort\u00A0by\u00A0ACD\u00A0intelligence",
        ]
      : []),
    ...(s.view !== "provider"
      ? [
          s.rankCost
            ? s.rankAcd
              ? "S\u00A0sort\u00A0by:\u00A0ACD\u00A0intelligence"
              : "S\u00A0sort\u00A0by:\u00A0AA\u00A0intelligence"
            : s.rankAcd
              ? "S\u00A0sort\u00A0by:\u00A0ACD\u00A0$/task"
              : "S\u00A0sort\u00A0by:\u00A0$/task",
        ]
      : []),
    `L ${s.providerLock ? `unlock (locked to: ${s.providerLock})` : "lock to selected provider"}`,
    `F ${s.disabledCount > 0 ? `providers (${s.disabledCount} off)` : "providers on/off"}`,
  ];
  const ceil =
    s.view === "value"
      ? `${CEIL_KEYS} value ceiling: $${s.ceiling.toFixed(2)}`
      : s.view === "taskcost"
        ? `${CEIL_KEYS} task ceiling: $${s.taskCeiling.toFixed(2)}/task${s.rankAcd ? " (ACD)" : ""}`
        : null;
  const actions = [
    "A ping visible",
    "P ping",
    "T tools ping",
    "Y export table",
    "? help",
  ];
  return [nav, ...keys, ...(ceil ? [ceil] : []), ...actions].join(" · ");
}

/** Hint rows wrap to the model-row width: the full frame minus one spare column. */
export function hintWidth(cols: number = process.stdout.columns ?? 100): number {
  return Math.max(24, cols - 1);
}

/** One run of a hint row: a command key, or the grey around it. */
export interface HintSpan {
  text: string;
  key: boolean;
}

/**
 * A key is a command letter, `Tab`, `?`, the whole `< >` ceiling chord — or
 * navigation (`Enter`, `Esc`, `↑↓`, `^F/^B` chords). Movement is highlighted
 * too: a footer where half the keys glow and half don't reads as broken, not
 * as hierarchy.
 */
const HINT_KEY_HEAD = /^(?:[A-Z]|Tab|\?|Enter|Esc|[↑↓←→]+|\^[A-Z]\/\^[A-Z])$/;
/** The ceiling chord, glued with a non-breaking space like every other pair. */
const CEIL_WORD = "<" + "\u00A0" + ">";

/**
 * One wrapped hint row as key/label spans, for the `Pick` footer.
 *
 * Only the part before a word's first non-breaking space can be a key — that
 * is where `buildHintText` puts the command (the `D` of a `D sort by` pair,
 * the `Tab` of a `Tab filter: OR` pair), while the tail holds lookalikes that
 * must stay grey (`AA`, `OR`). The `< >` chord matches whole instead: splitting it would
 * light `<` and abandon `>`.
 *
 * Concatenating the span texts reproduces the row byte-for-byte: separators
 * pass through as grey spans, so no row gains or loses a character and the
 * viewport's one-element-is-one-row budget is untouched.
 */
export function hintRowSpans(row: string): HintSpan[] {
  const out: HintSpan[] = [];
  for (const part of row.split(/([ ]+)/)) {
    if (!part) continue;
    // A separator run, passed through grey and whole.
    if (/^[ ]+$/.test(part)) {
      out.push({ text: part, key: false });
      continue;
    }
    if (part === CEIL_WORD) {
      out.push({ text: part, key: true });
      continue;
    }
    const nbsp = part.indexOf("\u00A0");
    if (nbsp >= 0) {
      const head = part.slice(0, nbsp);
      if (HINT_KEY_HEAD.test(head)) {
        out.push({ text: head, key: true });
        out.push({ text: part.slice(nbsp), key: false });
      } else {
        out.push({ text: part, key: false });
      }
      continue;
    }
    out.push({ text: part, key: HINT_KEY_HEAD.test(part) });
  }
  return out;
}

/**
 * Greedy word-wrap the hint text to the width. Rows break at spaces, never
 * mid-word; a word longer than the row is sliced rather than overhanging.
 * Uncapped by default — the menu shows everything; pass `maxRows` only when
 * the budget cannot fit the lot, and overflow past the cap truncates the
 * last visible row with `…`, so a cut is always marked.
 */
export function wrapHintLines(
  text: string,
  width: number,
  maxRows: number = Number.POSITIVE_INFINITY,
): string[] {
  const room = Math.max(24, width);
  const cap = Math.max(1, maxRows);
  // Over-long words become slices up front, so the loop only breaks at spaces.
  // Plain spaces only: the `< >` pair is glued with a non-breaking space and
  // must survive as one word.
  const words: string[] = [];
  for (const w of text.split(/ +/).filter(Boolean)) {
    if (w.length <= room) words.push(w);
    else for (let i = 0; i < w.length; i += room) words.push(w.slice(i, i + room));
  }
  const rows: string[] = [];
  let line = "";
  let spilled = false;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= room) {
      line = next;
      continue;
    }
    rows.push(line);
    if (rows.length >= cap) {
      spilled = true;
      line = "";
      break;
    }
    line = w;
  }
  if (!spilled && line) rows.push(line);
  if (spilled) {
    const last = rows[cap - 1] ?? "";
    rows[cap - 1] = `${last.slice(0, Math.max(0, room - 1))}…`;
  }
  return rows.slice(0, cap);
}
