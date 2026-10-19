/**
 * The palette, as one table.
 *
 * Colour is the one thing the panes, the CLI and the panels all have to agree
 * about, so it is defined once and imported, never spelled out at a call site.
 * A colour written by hand in one renderer and not in another is a bug nobody
 * sees until the two front ends describe the same run differently.
 *
 * The roles are semantic, not decorative:
 *
 * - `accent` marks *structure* — the rules that separate sections, headings,
 *   pane titles, the current selection, a table's header. It is how a reader
 *   finds their way around a screen.
 * - `code` marks *literals* — a path, a flag, a function name, a whole block of
 *   code. Things you might copy rather than read.
 * - `warn` and `danger` mark *state that needs attention* — never agreement.
 *   The tool does not colour a confirmed claim green: a verdict says a file
 *   matched, and whether that is good is the human's call, which is the whole
 *   point of this tool.
 * - `sort` marks the actively-sorted column header — green, deliberately not
 *   the cyan the structure uses, so the ranking reads apart from the chrome.
 * - `muted` is scaffolding: quotes, hints, counters, the scroll position.
 *
 * Colour never carries meaning on its own. Every signal keeps its textual
 * marker (`!`, `DISAGREES`, `REFUTED`, the counts), so a monochrome terminal or
 * a colourblind reader loses nothing but decoration.
 *
 * Not blue: Apple Terminal's blue is close to unreadable on a dark background,
 * and the links that would want it already carry an underline.
 */
export const THEME = {
  accent: "cyan",
  code: "green",
  /** Confirmations: saved, copied, "this is the answer you gave before". */
  ok: "green",
  /** The actively-sorted column header. Green, not cyan: the ranking is not chrome. */
  sort: "green",
  warn: "yellow",
  danger: "red",
} as const;

export type Role = keyof typeof THEME;
/** A colour the palette names. */
export type Colour = (typeof THEME)[Role];

/**
 * The ANSI code for each colour the palette can name.
 *
 * `toAnsi` is what the CLI prints, and it can only print what is in here: a
 * colour missing from this map is a colour the TUI shows and the CLI silently
 * drops. A test asserts every value in `THEME` has an entry.
 */
export const ANSI_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
};
