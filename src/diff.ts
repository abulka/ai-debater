import type { Changelog } from "./contracts.ts";

/**
 * Name the two sides for what they are.
 *
 * `git diff --no-index` labels the files with the paths it was handed, which
 * here are the absolute paths of `plan.v1.md` and `plan.v2.md` inside the run
 * directory — so the header read as a change to a repository that had nothing
 * to do with this run, and a question asked in answer mode appeared to touch
 * the toy repo. It is a diff of one text against another, and it says so now.
 *
 * Only the header before the first hunk is rewritten. A removed line whose
 * content begins with `--` also renders as `--- something`, and rewriting that
 * would corrupt the patch.
 */
export function relabelDraftToFinal(patch: string): string {
  const out: string[] = [];
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunks = true;
    if (!inHunks) {
      if (line.startsWith("diff --git ")) {
        out.push("diff --git a/draft b/final");
        continue;
      }
      if (line.startsWith("--- ")) {
        out.push("--- a/draft");
        continue;
      }
      if (line.startsWith("+++ ")) {
        out.push("+++ b/final");
        continue;
      }
      // Blob hashes of two files that exist only for this comparison.
      if (line.startsWith("index ")) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Unified diff of the two plan revisions, via `git diff --no-index`.
 * Exit code 1 means "files differ", which is the normal case here.
 */
export async function unifiedDiff(a: string, b: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "diff", "--no-index", "--unified=3", "--no-color", a, b],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return relabelDraftToFinal(out.trim());
}

export interface DiffAssessment {
  hunks: number;
  claimedChanges: number;
  /** Hunks the changelog does not account for. */
  unexplained: number;
  /** The plan changed but the changelog claims nothing. */
  outOfScope: boolean;
}

/**
 * Cross-reference the diff against the changelog.
 *
 * This is a heuristic, and deliberately a conservative one: it counts hunks and
 * compares them to the number of changelog entries that claim an edit. It cannot
 * map a hunk to a specific item — that needs semantic comparison — so it flags a
 * *possible* out-of-scope edit rather than proving one. Better to over-flag and
 * let the human look than to stay silent.
 */
export function assessDiff(patch: string, changelog: Changelog): DiffAssessment {
  const hunks = (patch.match(/^@@/gm) ?? []).length;
  const claimedChanges = changelog.changes.filter(
    (c) => c.disposition === "fixed" || c.disposition === "applied",
  ).length;
  return {
    hunks,
    claimedChanges,
    unexplained: Math.max(0, hunks - claimedChanges),
    outOfScope: hunks > 0 && claimedChanges === 0,
  };
}
