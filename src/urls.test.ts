import { describe, expect, test } from "bun:test";
import { invisibleCount, repairUrls, scanUrls } from "./urls.ts";

// The defect from the 17 Oct answer-mode run: a zero-width space at the end of
// "Phleb", invisible on screen, fatal when the URL is copied.
const ZWSP = "\u200B";

describe("repairUrls", () => {
  test("removes an invisible character inside a URL and reports it", () => {
    const text = "| 1 | *Consider Phlebas* | 1987 | 【https://en.wikipedia.org/wiki/Consider_Phleb\u200Bas】 |";
    const { text: fixed, repairs } = repairUrls(text);
    expect(fixed).toContain("https://en.wikipedia.org/wiki/Consider_Phlebas");
    expect(invisibleCount(fixed)).toBe(0);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.after).toBe("https://en.wikipedia.org/wiki/Consider_Phlebas");
  });

  test("leaves the CJK bracket the model wrapped around the link", () => {
    const text = "【https://example.com/x】";
    expect(repairUrls(text).text).toBe(text);
  });

  test("does not touch a zero-width space in prose", () => {
    // Odd, but not broken. Silently editing prose is how a tool hides its work.
    const text = `a${ZWSP}b https://example.com/ok`;
    const { text: fixed, repairs } = repairUrls(text);
    expect(fixed).toBe(text);
    expect(repairs).toHaveLength(0);
  });

  test("does not touch a URL that is already correct", () => {
    const text = "see https://en.wikipedia.org/wiki/Matter_(novel) for the source.";
    expect(repairUrls(text).text).toBe(text);
  });

  test("keeps ASCII parentheses in a path", () => {
    const { repairs } = repairUrls(`https://en.wikipedia.org/wiki/Matter_(novel)${ZWSP}`);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.after).toBe("https://en.wikipedia.org/wiki/Matter_(novel)");
  });

  test("is idempotent", () => {
    const once = repairUrls(`https://example.com/a${ZWSP}b`);
    const twice = repairUrls(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.repairs).toHaveLength(0);
  });

  test("removes bidi controls too, not just zero-width spaces", () => {
    const { text: fixed } = repairUrls("https://example.com/\u202Eevil");
    expect(fixed).toBe("https://example.com/evil");
  });

  test("repairs several URLs in one document", () => {
    const { repairs } = repairUrls(
      `https://a.example/1${ZWSP} and https://b.example/2${ZWSP}`,
    );
    expect(repairs).toHaveLength(2);
  });
});

describe("scanUrls", () => {
  test("counts invisible characters without changing anything", () => {
    const [hit] = scanUrls(`https://example.com/a${ZWSP}b`);
    expect(hit?.invisible).toBe(1);
    expect(hit?.url).toBe("https://example.com/ab");
  });

  test("reports visible non-ASCII but leaves it alone", () => {
    const [hit] = scanUrls("https://example.com/café");
    expect(hit?.nonAscii).toEqual(["é"]);
    expect(repairUrls("https://example.com/café").repairs).toHaveLength(0);
  });

  test("finds nothing in ordinary prose", () => {
    expect(scanUrls("no links here, just text.")).toEqual([]);
  });

  test("does not report a URL as broken because of trailing sentence punctuation", () => {
    const [hit] = scanUrls("");
    expect(hit).toBeUndefined();
  });
});

describe("invisibleCount", () => {
  test("counts zero-width, BOM and controls", () => {
    expect(invisibleCount(`a${ZWSP}b\uFEFFc\u0007`)).toBe(3);
  });

  test("ordinary text is zero", () => {
    expect(invisibleCount("src/http.ts:88")).toBe(0);
  });
});
