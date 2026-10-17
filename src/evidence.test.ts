import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectEvidenceIssues } from "./pipeline.ts";
import type { AuditRecord, Review } from "./contracts.ts";

const reviewWith = (evidence: string): Review => ({
  verdicts: [{ id: "V1", verdict: "confirmed", evidence }],
  tradeoffs: [],
  extra_findings: [],
});

const repoWith = async (files: string[]) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "adv-evidence-"));
  for (const file of files) {
    const abs = path.join(repo, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "x\n");
  }
  return repo;
};

describe("collectEvidenceIssues", () => {
  test("a verdict citing two files is checked per file, not as one long name", async () => {
    // The 17 Oct run cited "README.md:8-9; src/rateLimit.ts:3-4" and was
    // reported as citing a file that does not exist — both files do exist.
    const repo = await repoWith(["README.md", "src/rateLimit.ts"]);
    try {
      const issues = collectEvidenceIssues(
        repo,
        reviewWith("README.md:8-9; src/rateLimit.ts:3-4"),
        [],
      );
      expect(issues).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a comma-separated line list is still one file", async () => {
    // "src/rateLimit.ts:3-4,6-16" was reported as a missing file on 17 Oct.
    const repo = await repoWith(["src/rateLimit.ts"]);
    try {
      expect(collectEvidenceIssues(repo, reviewWith("src/rateLimit.ts:3-4,6-16"), [])).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("reports only the part that is missing", async () => {
    const repo = await repoWith(["README.md"]);
    try {
      const issues = collectEvidenceIssues(
        repo,
        reviewWith("README.md:8-9; src/invented.ts:3-4"),
        [],
      );
      expect(issues).toEqual([{ id: "V1", evidence: "src/invented.ts:3-4", reason: "missing" }]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("an audit reference with no record is unresolved, not missing", async () => {
    const repo = await repoWith([]);
    try {
      const issues = collectEvidenceIssues(repo, reviewWith("audit:A9"), []);
      expect(issues).toEqual([{ id: "V1", evidence: "audit:A9", reason: "unresolved" }]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("an audit reference that resolves is accepted", async () => {
    const repo = await repoWith([]);
    const record = { id: "A1" } as AuditRecord;
    try {
      expect(collectEvidenceIssues(repo, reviewWith("audit:A1"), [record])).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a URL is not existence-checked", async () => {
    const repo = await repoWith([]);
    try {
      expect(
        collectEvidenceIssues(repo, reviewWith("https://en.wikipedia.org/wiki/Excession"), []),
      ).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("an invisible character is still a defect, whatever else the string says", async () => {
    const repo = await repoWith([]);
    try {
      const issues = collectEvidenceIssues(repo, reviewWith("src/rat\u200BeLimit.ts:3"), []);
      expect(issues[0]?.reason).toBe("invisible");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
