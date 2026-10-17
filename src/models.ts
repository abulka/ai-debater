/**
 * Model discovery for the TUI picker.
 *
 * `opencode models` prints one `provider/model` per line and needs no API call,
 * which keeps the picker instant and free.
 */

export async function listModels(repo: string): Promise<string[]> {
  const proc = Bun.spawn(["opencode", "models"], {
    cwd: repo,
    // opencode resolves the project from $PWD; see OpencodeRunRunner.call.
    env: { ...process.env, PWD: repo },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[^\s/]+\/\S+$/.test(line));
}

/**
 * A coarse family label, used only to name a model's family in the picker and
 * to label models in the settings screen.
 *
 * The first token after the provider, lowercased: `opencode-go/muse-spark-1.3`
 * -> "muse", `groq/openai/gpt-oss-120b` -> "openai".
 *
 * This is a guess where `familyClash` below is a statement: the explicit
 * `family` field in `.adv/config.json` is what the diversity check compares,
 * because a gateway serves many families under one provider.
 */
export function familyOf(ref: string): string {
  const model = ref.split("/").slice(1).join("/").toLowerCase();
  return model.split(/[-_./]/).filter(Boolean)[0] ?? model;
}

/**
 * The diversity check. Compares the **explicit** `family` fields, not the refs:
 * a gateway serves several families under one provider, and the ref is a guess
 * where the family is a statement.
 *
 * Returns the human-facing sentence, or null when the pair is diverse.
 */
export function familyClash(models: {
  drafter: { ref: string; family: string };
  reviewer: { ref: string; family: string };
}): string | null {
  const a = models.drafter.family.trim().toLowerCase();
  const b = models.reviewer.family.trim().toLowerCase();
  if (a !== b) return null;
  return (
    `drafter and reviewer share family "${models.drafter.family}" — ` +
    `the review adds less than a cross-family one would`
  );
}
