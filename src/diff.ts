import type { Changelog } from "./contracts.ts";

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
  return out.trim();
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
