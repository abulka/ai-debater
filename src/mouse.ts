/**
 * Mouse wheel scrolling.
 *
 * A terminal app only receives the wheel if it asks for mouse reporting, and
 * once it has, the terminal stops scrolling its own scrollback and sends the
 * events instead. That is exactly what a reader wants here — the wheel should
 * move the pane, not the window — and it is why the app asks for it explicitly
 * rather than relying on the terminal.
 *
 * Two consequences to know about:
 *
 * - **Selecting text needs a modifier while reporting is on.** Apple Terminal
 *   uses Option-drag, most others Shift-drag. `y`/`Y` copy the answer without
 *   selecting anything, which is the workflow intended here.
 * - **The reports arrive as raw bytes on stdin**, alongside the keys Ink parses.
 *   Nothing guarantees Ink treats them as "not a key", so anything that inserts
 *   typed text into a field has to refuse them: see `isMouseSequence`.
 *
 * Reporting has to be turned off again on the way out, or the reader's terminal
 * is left sending mouse reports to a shell that does not understand them.
 */

/**
 * Button events, in SGR form.
 *
 * 1000 is the wheel: a notch is reported as a button press with a code of its
 * own. 1006 says the coordinates are the extended kind, which is what every
 * terminal in use sends. Nothing here asks for motion: this app does not track
 * a drag, it just wants the wheel — text selection is the terminal's job, which
 * is what Ctrl+T hands back to it.
 */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";

/** Rows a wheel notch moves. A terminal sends one report per notch. */
export const WHEEL_STEP = 3;

/**
 * Whether the app is currently taking wheel reports.
 *
 * The terminal is told to stop sending them when the mouse is handed over, but
 * a report already in flight — or a terminal that ignores the request — must not
 * scroll the pane out from under somebody selecting text. The app decides, not
 * the terminal: this is the app's own answer to "did I ask for the mouse".
 */
let accepting = true;
export const setMouseAccepting = (on: boolean) => {
  accepting = on;
};
export const mouseAccepting = () => accepting;

export interface MouseEvent {
  /** The protocol's bitfield: 64 and 65 are the wheel, the rest are the buttons. */
  button: number;
  x: number;
  y: number;
  /** True for a press report (`M`), false for a release (`m`). */
  press: boolean;
}

/** Wheel notches: up is -1, down is 1, anything else 0. */
export const wheelDirection = (event: MouseEvent): number => {
  if (event.button === 64) return -1;
  if (event.button === 65) return 1;
  return 0;
};

/**
 * Every SGR mouse report in a chunk of stdin.
 *
 * The format is `ESC [ < button ; column ; row M|m`. Terminals batch reports
 * with keystrokes in one read, so this takes a whole chunk and returns what it
 * finds rather than requiring the chunk to be exactly one event.
 */
export function decodeMouse(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  const pattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of data.matchAll(pattern)) {
    events.push({
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      press: match[4] === "M",
    });
  }
  return events;
}

/** Rows to move for a chunk of stdin: negative up, positive down, 0 for none. */
export function wheelRows(data: string): number {
  let rows = 0;
  for (const event of decodeMouse(data)) rows += wheelDirection(event) * WHEEL_STEP;
  return rows;
}

/*
 * There is deliberately nothing here to filter mouse reports out of typed text.
 * Ink already refuses them: a CSI sequence that maps to no key "is not printable
 * text", so a prompt cannot fill up with `[<64;10;5M`. The harness pins that
 * behaviour rather than a guard of our own.
 */
