/**
 * Viewport budgets: how many rows each screen may use.
 *
 * The TUI is fullscreen — Ink renders into the alternate screen, so the frame
 * must never be taller than the terminal. Every list screen therefore takes an
 * explicit height derived from `process.stdout.rows`, and the arithmetic lives
 * here so "the list will not move" stays one bug, tested once, like the scroll
 * arithmetic in gate-model.ts.
 *
 * The invariant: log window + spinner + content + mouse line <= terminal rows.
 * `contentRows` subtracts the pinned mouse line; `logWindow` caps the log so
 * the content always keeps its minimum; each screen then subtracts only its own
 * chrome. A screen that miscounts clips inside `overflow="hidden"` instead of
 * corrupting the redraw — but the point of this file is that none has to.
 *
 * Why the log is a window: `<Static>` is designed for inline rendering, where
 * settled lines accumulate in the shell's scrollback. On the alternate screen
 * there is no scrollback, and Ink replays the whole accumulated static output
 * on any full clear (a resize, leaving a fullscreen frame), pushing the live
 * frame off the screen. So the log shows the last N rows in-frame, and the
 * full history stays reachable with `l`.
 */
export const MOUSE_ROWS = 1;

/** Content below this starves: the gate's options, the picker's hints. */
export const MIN_CONTENT_ROWS = 8;

/** Log rows shown while a screen is up. Without a screen, the log fills. */
export const LOG_MAX_ROWS = 8;

/** The frame minus the pinned mouse line. Never below the content minimum. */
export function contentRows(termRows: number): number {
  const rows = Number.isFinite(termRows) ? termRows : 24;
  return Math.max(MIN_CONTENT_ROWS, rows - MOUSE_ROWS);
}

/**
 * Whether to use the alternate screen.
 *
 * On unless `--no-alt-screen` is passed or `ADV_NO_ALT_SCREEN` says so
 * (`1`, `true`, `yes`). Ink itself falls back to inline rendering when stdout
 * is not a TTY, so a pipe keeps today's behaviour either way.
 */
export function altScreenEnabled(noAltFlag: boolean, env?: string): boolean {
  if (noAltFlag) return false;
  const v = (env ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes");
}

/**
 * How many log lines to show in-frame.
 *
 * `usable` is the frame minus the mouse line; the content keeps `minContent`
 * rows plus one for the spinner when it is showing, and the window never
 * exceeds `maxLog`. Callers pass `MIN_CONTENT_ROWS`/`LOG_MAX_ROWS` while a
 * screen is up, and `0`/`usable` while running, when the log is the screen.
 */
export function logWindow(
  total: number,
  usable: number,
  opts: { label: boolean; minContent: number; maxLog: number },
): number {
  const reserve = opts.minContent + (opts.label ? 1 : 0);
  return Math.max(0, Math.min(total, opts.maxLog, usable - reserve));
}

/**
 * Scroller chrome: header (2) + position line (2) + footer (1).
 * The notice, when one is showing, takes one more row of its own.
 */
export function scrollerHeight(contentH: number, notice: boolean): number {
  return Math.max(1, contentH - 5 - (notice ? 1 : 0));
}

/**
 * Picker chrome: header (2) + filter (1) + column labels (1) + list margin (1)
 * + count (2) + hints. The notice takes two rows (margin + line).
 *
 * Hint rows are variable: the hints wrap to the terminal width (see
 * `hints.ts`), so a narrow terminal spends more rows on them. The menu shows
 * everything — the budget yields in the opposite direction instead: the log
 * window shrinks first (`pickContentWants`), then the list toward
 * `PICK_LIST_MIN_ROWS`, and only past that does the menu itself crop (with
 * a `…` marker from `wrapHintLines`).
 */
export function pickChromeRows(notice: boolean): number {
  return 7 + (notice ? 2 : 0);
}

/** The list keeps this many rows whenever the terminal allows it. */
export const PICK_LIST_MIN_ROWS = 3;

/**
 * Content rows the picker wants for the full menu with a 3-row list. The App
 * clamps the log window to what is left after this before touching anything
 * else, so a narrow terminal spends log rows on hints, never hint rows on
 * nothing.
 */
export function pickContentWants(hintRows: number, notice: boolean): number {
  return pickChromeRows(notice) + Math.max(0, hintRows) + PICK_LIST_MIN_ROWS;
}

/**
 * Hint rows the budget allows inside this content height: the list keeps
 * `PICK_LIST_MIN_ROWS` when possible, one row at minimum. The caller passes
 * the result as `maxRows` to `wrapHintLines`, so a cut always carries `…`.
 */
export function pickHintAllowed(contentH: number, notice: boolean, wanted: number): number {
  const room = contentH - pickChromeRows(notice);
  return Math.max(1, Math.min(Math.max(0, wanted), room - PICK_LIST_MIN_ROWS));
}

export function pickListHeight(contentH: number, notice: boolean, hintRows = 2): number {
  return Math.max(1, contentH - pickChromeRows(notice) - Math.max(0, hintRows));
}

/**
 * Pairs chrome: header (2) + subtitle (1) + current line (1) + list margin (1) + hints (2).
 * Warnings, when the selected pair has them, take a row each; the notice
 * takes two rows (margin + line).
 */
export function pairsListHeight(contentH: number, warnings: number, notice: boolean): number {
  return Math.max(1, contentH - 7 - Math.max(0, warnings) - (notice ? 2 : 0));
}

/**
 * Runs chrome: header (2) + subtitle (1) + list margin (1) + count (2) +
 * hints (1).
 */
export function runsListHeight(contentH: number): number {
  return Math.max(1, contentH - 7);
}

/**
 * Provider-filter chrome: header (2) + subtitle (1) + list margin (1) +
 * hints (2). The notice takes two rows (margin + line). No current line, no
 * warnings — every row is one provider, and the list is a dozen rows, so
 * even a short terminal shows it whole.
 */
export function providerFilterListHeight(contentH: number, notice: boolean): number {
  return Math.max(1, contentH - 6 - (notice ? 2 : 0));
}

/**
 * Gate detail rows: everything on the gate screen that is not the finding's
 * own text. Header, counts, status (3) + intro (2) + title + question (2) +
 * options + hints (2) = 9 + titleRows + optionRows, plus one each when the
 * extras line and the revisit line are showing.
 */
export function gateDetailBudget(
  contentH: number,
  opts: { titleRows: number; optionRows: number; extras: boolean; revisit: boolean },
): number {
  const fixed =
    9 + opts.titleRows + opts.optionRows + (opts.extras ? 1 : 0) + (opts.revisit ? 1 : 0);
  return Math.max(0, contentH - fixed);
}

/** A capped dump (delete confirmation, saved names): content minus its chrome. */
export function cappedLines(contentH: number, chrome: number): number {
  return Math.max(0, contentH - chrome);
}
