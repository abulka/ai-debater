/**
 * Deterministic defects in URLs, because a reviewer cannot be relied on to see
 * them and a human cannot see them at all.
 *
 * The 17 Oct answer-mode run cited
 * `https://en.wikipedia.org/wiki/Consider_Phleb<U+200B>as` — a zero-width space
 * between two letters — and the reviewer returned 10 confirmed, 0 refuted. The
 * link breaks when copied and looks perfect on screen. That is not a judgment
 * call and it is not something a second model should be asked to notice: it is a
 * character-class check.
 *
 * The repair is deliberately narrow. Only characters that cannot be meant inside
 * a URL are removed (zero-width, bidi controls, BOM, C0/C1 controls). Anything
 * else non-ASCII — an IDN, an accented path — is reported and left alone, because
 * removing it would change the address rather than fix it.
 */

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, "g");

/**
 * A URL span. Stops at whitespace and at the brackets models actually put around
 * links (CJK 【】（） and quotes), so the bracket is not treated as part of the
 * address. ASCII parentheses stay inside the span on purpose: Wikipedia's
 * `Matter_(novel)` is a real path.
 */
const URL_SPAN = /https?:\/\/[^\s【】（）<>"'`]+/g;

/** Sentence punctuation glued to the end of a URL is not part of it. */
const TRAILING_PUNCT = /[.,;:!?]+$/;

export interface ScannedUrl {
  /** The address as shown, without trailing sentence punctuation. */
  url: string;
  /** Invisible characters found inside it — always a defect. */
  invisible: number;
  /** Visible non-ASCII characters, deduplicated. Reported, never removed. */
  nonAscii: string[];
}

const trimUrl = (url: string): string => url.replace(TRAILING_PUNCT, "");

export function scanUrls(text: string): ScannedUrl[] {
  const found: ScannedUrl[] = [];
  for (const match of text.matchAll(URL_SPAN)) {
    const raw = match[0];
    const invisible = raw.match(INVISIBLE_ALL)?.length ?? 0;
    const visible = raw.replace(INVISIBLE_ALL, "");
    const nonAscii = [
      ...new Set(
        [...visible].filter((ch) => (ch.codePointAt(0) ?? 0) > 126 && !INVISIBLE_CHARS.test(ch)),
      ),
    ];
    if (invisible || nonAscii.length) {
      // Report the address as it reads on screen: an invisible character is not
      // visible in a warning message either.
      found.push({ url: trimUrl(visible), invisible, nonAscii });
    }
  }
  return found;
}

export interface UrlRepair {
  before: string;
  after: string;
}

/**
 * Remove invisible characters from URL spans only, and report what changed.
 * Everything outside a URL is left exactly as the model wrote it: a zero-width
 * space in prose is odd, not broken, and silently editing prose is how a tool
 * starts hiding what it did.
 */
export function repairUrls(text: string): { text: string; repairs: UrlRepair[] } {
  const repairs: UrlRepair[] = [];
  const repaired = text.replace(URL_SPAN, (raw) => {
    if (!INVISIBLE_CHARS.test(raw)) return raw;
    const cleaned = raw.replace(INVISIBLE_ALL, "");
    repairs.push({ before: trimUrl(raw), after: trimUrl(cleaned) });
    return cleaned;
  });
  return { text: repaired, repairs };
}

/** Any invisible character anywhere — for evidence strings, which are short. */
export function invisibleCount(text: string): number {
  return text.match(INVISIBLE_ALL)?.length ?? 0;
}
