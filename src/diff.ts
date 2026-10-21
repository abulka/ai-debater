/**
 * Unified diff of two texts, via `git diff --no-index`.
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
