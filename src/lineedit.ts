/**
 * Line editing: word jump and kill-to-end, shared by every text field.
 *
 * Each field in the TUI (prompt, filter, pair name, key) used to carry its own
 * copy of the same readline block: arrows step, ^A/^E jump. The word-wise
 * motions live here instead, once, so the four call sites cannot drift apart.
 *
 * What "word" means: whitespace-delimited, which is exactly the unit the
 * picker filter already splits on for AND/OR. Punctuation stays inside the
 * word, so `openai/gpt-6-luna` is one word. This matches readline's
 * `forward-word` closely enough for a filter box; it is not locale word
 * segmentation and does not try to be.
 *
 * Key shapes (decoded by Ink 8, verified against its parser — no raw escape
 * handling here):
 * - `ESC b` / `ESC f` — Option+arrow with "Option as Meta", iTerm2 natural
 *   editing. Arrives as `key.meta` with input `"b"` / `"f"` (Ink strips the
 *   leading ESC before the handler sees it).
 * - `ESC[1;3D` / `ESC[1;3C` — xterm modifyOtherKeys Option+arrow. Arrives as
 *   arrow + `key.meta`, empty input.
 * - `ESC[1;5D` / `ESC[1;5C` — Ctrl+arrow on Linux/Windows, kitty. Arrives as
 *   arrow + `key.ctrl`, empty input.
 *
 * Deliberately not bound: Ctrl+B / Ctrl+F (readline's char step) — both page
 * in the picker, so they stay paging everywhere. Cmd is not bindable at all:
 * the terminal consumes it before any byte reaches the app.
 */

export interface WordKey {
  leftArrow: boolean;
  rightArrow: boolean;
  ctrl: boolean;
  meta: boolean;
}

function clamp(caret: number, len: number): number {
  if (!Number.isFinite(caret)) return 0;
  return Math.max(0, Math.min(Math.floor(caret), len));
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * The start of the word left of the caret: from mid-word to its start, from
 * a word start (or whitespace) back over the gap to the previous word's
 * start. Idempotent at 0.
 */
export function wordLeft(text: string, caret: number): number {
  let c = clamp(caret, text.length);
  while (c > 0 && isSpace(text[c - 1]!)) c--;
  while (c > 0 && !isSpace(text[c - 1]!)) c--;
  return c;
}

/**
 * The start of the next word right of the caret: over the rest of this word,
 * then over the gap. From whitespace, straight to the next word. Idempotent
 * at the end.
 */
export function wordRight(text: string, caret: number): number {
  let c = clamp(caret, text.length);
  const len = text.length;
  while (c < len && !isSpace(text[c]!)) c++;
  while (c < len && isSpace(text[c]!)) c++;
  return c;
}

/** Everything before the caret; Ctrl+K semantics (kill, not delete). */
export function killToEnd(text: string, caret: number): string {
  return text.slice(0, clamp(caret, text.length));
}

/** Option/word-left in any of its three byte shapes. */
export function isWordLeft(key: WordKey, input: string): boolean {
  if (key.leftArrow && (key.ctrl || key.meta)) return true;
  return key.meta && input.toLowerCase() === "b";
}

/** Option/word-right in any of its three byte shapes. */
export function isWordRight(key: WordKey, input: string): boolean {
  if (key.rightArrow && (key.ctrl || key.meta)) return true;
  return key.meta && input.toLowerCase() === "f";
}

/** Ctrl+K kills the rest of the line. Ink reports it as ctrl + "k". */
export function isKillToEnd(key: Pick<WordKey, "ctrl">, input: string): boolean {
  return key.ctrl && input === "k";
}
