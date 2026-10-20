import type { PickerView } from "./models.ts";

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
  /** AND needs every filter word; OR needs any one. The filter line marks OR. */
  filterMode: "and" | "or";
  ceiling: number;
  taskCeiling: number;
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
 * which is grouped rather than ranked; both name their destination, like `L`
 * does, so a toggle reads both ways. The ceiling hint only shows where its
 * keys work — the value and taskcost views.
 */
export function buildHintText(s: HintState): string {
  const nav =
    s.pickMode === "browse"
      ? "browsing — choose a model on the debate screen · ^F/^B page · ^D/^U half · Esc home"
      : s.pickMode === "build"
        ? `building a pair — Enter picks the ${s.buildStep ?? "drafter"} · ^F/^B page · ^D/^U half · Esc cancel`
        : "↑↓ choose · Enter select · ^F/^B page · ^D/^U half · Esc back";
  const costRank = s.rankCost && s.view !== "provider";
  const keys = [
    "V switch view",
    "C price basis",
    "H hide unscored",
    // The mode is named in full both ways, like `L` does: the destination of
    // the next press reads on the key itself. Glued so a wrap never splits it.
    s.filterMode === "or" ? "Tab\u00A0filter:\u00A0AND" : "Tab\u00A0filter:\u00A0OR",
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
    "B refresh benchmarks",
    "A ping visible",
    "P ping",
    "T tools ping",
    "Y export table",
    "? providers",
  ];
  return [nav, ...keys, ...(ceil ? [ceil] : []), ...actions].join(" · ");
}

/** Hint rows wrap to the model-row width: the full frame minus one spare column. */
export function hintWidth(cols: number = process.stdout.columns ?? 100): number {
  return Math.max(24, cols - 1);
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
