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
 * - `sort` marks the actively-sorted column header — purple, deliberately
 *   neither the cyan the structure uses nor the yellow of warnings, so the
 *   ranking reads apart from both.
 * - `muted` is scaffolding: quotes, hints, counters, the scroll position.
 *
 * Highlight rows (the picker's auto-highlight patterns) live outside these
 * roles: they are decoration, never a signal, so they take their colours
 * from `HIGHLIGHT_PALETTE` below rather than from a role. Nothing here is
 * cyan (selection), green (`key`/`ok`), yellow (`warn`) or red (`danger`).
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
  /**
   * Pressable command keys in every footer (`V`, `Tab`, `?`, `Enter`, `Esc`).
   * Green, not the cyan that `accent` uses everywhere else on a screen:
   * selection, headers and the view mode are all cyan, so cyan keys would
   * dissolve into the chrome instead of reading as "press me". `ok` is the
   * same green, but the two never share a screen — confirmations live on
   * committed screens, keys on choosing ones.
   */
  key: "green",
  /** The actively-sorted column header. Purple: neither chrome nor warning. */
  sort: "magenta",
  warn: "yellow",
  danger: "red",
} as const;

/**
 * One colour per auto-highlight pattern: a spread across the spectrum —
 * gold, blue, indigo, violet, orange, pink, coral, red, sand, mauve, grey,
 * amber, sky — every one mid-bright and readable on a black background
 * (no deep colours like the old violet, which sank into it). None of them
 * is a role colour or near one: no cyan or teal (selection and chrome), no
 * green (footer keys and confirmations — green stays reserved for those),
 * no magenta (the sort column), no yellow (warnings). Red appears in no
 * picker row, only on confirm screens, so a red highlight cannot read as
 * danger. Orange sits at the index the seeded DeepSeek pattern hashes to,
 * so the default row keeps the colour it always had — keep it there when
 * extending the palette, or the seed moves with it.
 */
export const HIGHLIGHT_PALETTE = [
  { value: "ansi256(221)", name: "gold" },
  { value: "ansi256(69)", name: "blue" },
  { value: "ansi256(63)", name: "indigo" },
  { value: "ansi256(135)", name: "violet" },
  { value: "ansi256(208)", name: "orange" },
  { value: "ansi256(211)", name: "pink" },
  { value: "ansi256(203)", name: "coral" },
  { value: "ansi256(196)", name: "red" },
  { value: "ansi256(180)", name: "sand" },
  { value: "ansi256(139)", name: "mauve" },
  { value: "ansi256(250)", name: "grey" },
  { value: "ansi256(172)", name: "amber" },
  { value: "ansi256(111)", name: "sky" },
] as const;

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
