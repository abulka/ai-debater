/**
 * Unified diff of two texts, via `git diff --no-index`.
 * Exit code 1 means "files differ", which is the normal case here.
 *
 * The `\ No newline at end of file` marker is dropped: takes and the final
 * answer are written trimmed, so neither ends with a newline and the marker
 * would annotate nearly every hunk without saying anything.
 */
export async function unifiedDiff(a: string, b: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "diff", "--no-index", "--unified=3", "--no-color", a, b],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .filter((line) => line !== "\\ No newline at end of file")
    .join("\n")
    .trim();
}
