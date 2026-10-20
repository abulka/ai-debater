/**
 * Click hit-testing for the picker list.
 *
 * The list measures each selectable row's absolute frame position with Ink 8's
 * `measureElement` (see `tui.tsx`) and hands the rectangles here: this file
 * decides which row, if any, a click landed on. Pure arithmetic, no Ink
 * import — the boundary rule is tested without a terminal.
 */

export interface RowRect {
  /** The item index this rectangle selects. */
  index: number;
  /** Absolute frame row of the rectangle's top, 0-based. */
  top: number;
  /** Rectangle height in rows. Model rows are one row high. */
  height: number;
}

/**
 * The item whose band holds `y` (a 0-based layout row), or null for a gap.
 *
 * Bands are half-open `[top, top + height)`: a click exactly on a shared
 * boundary belongs to the row below it, and a click on a group or provider
 * header — which carries no rectangle — belongs to nothing. First match wins,
 * so overlapping rectangles settle deterministically.
 */
export function rowAt(rects: RowRect[], y: number): number | null {
  for (const r of rects) {
    if (y >= r.top && y < r.top + r.height) return r.index;
  }
  return null;
}
