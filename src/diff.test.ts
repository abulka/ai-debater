import { describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assessDiff, relabelDraftToFinal, unifiedDiff } from "./diff.ts";
import type { Changelog } from "./contracts.ts";

const HEADER = [
  "diff --git a/Users/andy/.local/share/adv/runs/toy-repo-18a03be1/2026-10-18T01-46-53/plan.v1.md b/Users/andy/.local/share/adv/runs/toy-repo-18a03be1/2026-10-18T01-46-53/plan.v2.md",
  "index 96076b5..ad9802a 100644",
  "--- a/Users/andy/.local/share/adv/runs/toy-repo-18a03be1/2026-10-18T01-46-53/plan.v1.md",
  "+++ b/Users/andy/.local/share/adv/runs/toy-repo-18a03be1/2026-10-18T01-46-53/plan.v2.md",
].join("\n");

const BODY = ["@@ -4,9 +4,9 @@", " context", "-old line", "+new line"].join("\n");

describe("relabelDraftToFinal", () => {
  test("the two sides are named for what they are", () => {
    const out = relabelDraftToFinal(`${HEADER}\n${BODY}`);
    expect(out.split("\n").slice(0, 3)).toEqual([
      "diff --git a/draft b/final",
      "--- a/draft",
      "+++ b/final",
    ]);
    // The blob hashes named two files that exist only for this comparison.
    expect(out).not.toContain("index 96076b5");
    // The run directory no longer appears anywhere.
    expect(out).not.toContain("/runs/");
  });

  test("a removed line that looks like a header is left alone", () => {
    // `-- old heading` in the text renders as `--- old heading` inside a hunk,
    // which is byte-for-byte a file header. Only the header before the first
    // hunk may be rewritten, or the patch is corrupted.
    const patch = [
      "diff --git a/x/plan.v1.md b/x/plan.v2.md",
      "--- a/x/plan.v1.md",
      "+++ b/x/plan.v2.md",
      "@@ -1,3 +1,3 @@",
      "--- keep this hyphenated heading",
      "+++ and this one",
      " context",
    ].join("\n");
    const out = relabelDraftToFinal(patch).split("\n");
    expect(out[1]).toBe("--- a/draft");
    expect(out[2]).toBe("+++ b/final");
    expect(out[4]).toBe("--- keep this hyphenated heading");
    expect(out[5]).toBe("+++ and this one");
  });

  test("the hunks survive, so the changelog cross-check is unaffected", () => {
    const before = assessDiff(BODY, { changes: [] } as unknown as Changelog);
    const after = assessDiff(relabelDraftToFinal(`${HEADER}\n${BODY}`), {
      changes: [],
    } as unknown as Changelog);
    expect(after).toEqual(before);
    expect(after.hunks).toBe(1);
    expect(after.outOfScope).toBe(true);
  });

  test("an unchanged text is an empty patch, not a header with no hunks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "adv-diff-"));
    try {
      const a = path.join(dir, "plan.v1.md");
      const b = path.join(dir, "plan.v2.md");
      await writeFile(a, "same\n");
      await writeFile(b, "same\n");
      expect(await unifiedDiff(a, b)).toBe("");
      await writeFile(b, "different\n");
      const patch = await unifiedDiff(a, b);
      expect(patch.startsWith("diff --git a/draft b/final")).toBe(true);
      expect(patch).toContain("--- a/draft");
      expect(patch).toContain("+++ b/final");
      expect(await readFile(b, "utf8")).toBe("different\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
