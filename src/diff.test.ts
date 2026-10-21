import { describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unifiedDiff } from "./diff.ts";

describe("unifiedDiff", () => {
  test("an unchanged text is an empty patch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "adv-diff-"));
    try {
      const a = path.join(dir, "a.md");
      const b = path.join(dir, "b.md");
      await writeFile(a, "same\n");
      await writeFile(b, "same\n");
      expect(await unifiedDiff(a, b)).toBe("");
      await writeFile(b, "different\n");
      const patch = await unifiedDiff(a, b);
      expect(patch).toContain("--- ");
      expect(patch).toContain("+++ ");
      expect(await readFile(b, "utf8")).toBe("different\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
