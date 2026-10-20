/**
 * Configurable auto-highlight rows for the model picker.
 *
 * Each entry is a filter text matched with the picker's own rule, and each
 * reads in its own colour. Colours derive from the pattern (a stable hash
 * into `HIGHLIGHT_PALETTE`), so no colour is stored for the common case —
 * but a reader can recolour an entry with `^O`, and that choice is stored
 * beside the patterns. Deleting one entry rarely moves another's.
 *
 * Colour is decoration, like every other colour here: the row still names
 * the model, the cursor still marks selection, and a monochrome terminal
 * loses nothing.
 */

import { matchesFilter, parseFilterTerms } from "./models.ts";
import { HIGHLIGHT_PALETTE } from "./theme.ts";

/** The seeded entry: the old hardwired DeepSeek row, now editable. */
export const DEFAULT_HIGHLIGHTS = ["deepseek flash v4.1"];

/** How many patterns the screen keeps. Twenty lines of text, not a log. */
export const HIGHLIGHT_MAX = 20;

/** One pattern and the colour its rows read in. */
export interface HighlightRule {
  pattern: string;
  colour: string;
}

/** Every colour an entry may read in. Overrides name one of these. */
export const HIGHLIGHT_VALUES: readonly string[] = HIGHLIGHT_PALETTE.map((c) => c.value);

/** FNV-1a over the lowercased pattern: stable across restarts. */
function hashPattern(pattern: string): number {
  let h = 0x811c9dc5;
  for (const c of pattern.toLowerCase()) {
    h ^= c.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether a pattern is worth keeping. A quote-only or separator-only
 * pattern would highlight nothing — or worse, an empty term list matches
 * *everything* — so it is refused before it is stored.
 */
export function isUsablePattern(pattern: string): boolean {
  if (!pattern || !pattern.trim()) return false;
  // Strip quotes, separators and whitespace: nothing alphanumeric left
  // means no term could ever hit.
  const stripped = pattern.replace(/["\-_./\s]/g, "");
  if (!stripped) return false;
  return parseFilterTerms(pattern).length > 0;
}

/**
 * Whether a stored colour override names a real palette colour. Anything
 * else — a hand edit, an older palette — falls back to the derived colour.
 */
export function isPaletteColour(v: unknown): v is string {
  return typeof v === "string" && (HIGHLIGHT_VALUES as readonly string[]).includes(v);
}

/**
 * Clean a raw list: trim, drop the unusable, dedupe case-insensitively
 * (matching is), keep the newest first, cap the length.
 */
export function cleanHighlightPatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text || !isUsablePattern(text)) continue;
    const lower = text.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(text);
    if (out.length >= HIGHLIGHT_MAX) break;
  }
  return out;
}

/**
 * Pair each pattern with its colour: the stored override when one names a
 * palette colour, else the hash-derived one, probing past colours already
 * taken so entries read apart.
 */
export function highlightRules(
  patterns: readonly string[],
  colours: Readonly<Record<string, string>> = {},
): HighlightRule[] {
  const cleaned = cleanHighlightPatterns(patterns);
  const used = new Set<string>();
  return cleaned.map((pattern) => {
    const n = HIGHLIGHT_PALETTE.length;
    const lower = pattern.toLowerCase();
    const override = colours[lower];
    let colour =
      override !== undefined && isPaletteColour(override)
        ? override
        : HIGHLIGHT_PALETTE[hashPattern(pattern) % n]!.value;
    // The override stands even taken — it is explicit. A derived colour
    // probes past what is taken, so hash neighbours still read apart.
    if (override === undefined || !isPaletteColour(override)) {
      for (let i = 0; i < n; i++) {
        const candidate = HIGHLIGHT_PALETTE[(hashPattern(pattern) + i) % n]!.value;
        if (!used.has(candidate)) {
          colour = candidate;
          break;
        }
      }
    }
    used.add(colour);
    return { pattern, colour };
  });
}

/**
 * The palette colour after this entry's own, skipping every colour another
 * entry already reads in — `^O` never steals a colour in use. Colours are
 * compared by value, so an unknown current (a hand edit since overwritten)
 * simply starts the cycle at the palette's head. Null when every other
 * colour is taken, which needs at least as many entries as the palette
 * holds — then there is visibly nowhere to go.
 */
export function nextFreeHighlightColour(
  rules: readonly HighlightRule[],
  pattern: string,
): string | null {
  const lower = pattern.toLowerCase();
  const taken = new Set(
    rules.filter((r) => r.pattern.toLowerCase() !== lower).map((r) => r.colour),
  );
  const at = rules.find((r) => r.pattern.toLowerCase() === lower);
  const start = at ? HIGHLIGHT_PALETTE.findIndex((c) => c.value === at.colour) : -1;
  const n = HIGHLIGHT_PALETTE.length;
  for (let i = 1; i < n; i++) {
    const candidate = HIGHLIGHT_PALETTE[(((start + i) % n) + n) % n]!.value;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** `ansi256(69)` → `blue`: what the recolour notice names. */
export function highlightColourName(value: string): string {
  return HIGHLIGHT_PALETTE.find((c) => c.value === value)?.name ?? value;
}

/**
 * The first rule (newest first) whose pattern matches this ref, using the
 * picker's own AND rule against the ref and the benchmark display name.
 * Null when no rule matches.
 */
export function highlightFor(
  ref: string,
  name: string | null,
  rules: readonly HighlightRule[],
): HighlightRule | null {
  for (const rule of rules) {
    if (matchesFilter(ref, name, rule.pattern, "and")) return rule;
  }
  return null;
}
