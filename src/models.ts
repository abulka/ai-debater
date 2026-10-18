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
 * The picker, ordered: favourites, then recent models, then everything else.
 *
 * There are many models and two slots to fill, so the list a human scans is the
 * wrong one — it is the whole provider catalogue, and the models that are
 * actually used are somewhere inside it. OpenCode already knows which ones those
 * are (see `opencode-state.ts`), so the order follows its list rather than a
 * second judgement made here.
 *
 * A favourite that `opencode models` does not list is dropped: that is a model
 * whose provider is no longer authenticated or configured, and offering it would
 * offer a run that cannot happen. A model goes missing from the *picker*, never
 * from the pair list — there a stale pair is shown and marked `!`.
 */
export function groupModels(
  all: string[],
  favourites: string[],
  recents: string[],
): { favourites: string[]; recents: string[]; rest: string[] } {
  const listed = new Set(all);
  const favs = favourites.filter((m) => listed.has(m));
  const inFavourites = new Set(favs);
  const recs = recents.filter((m) => listed.has(m) && !inFavourites.has(m));
  const grouped = new Set([...favs, ...recs]);
  const rest = [...all].sort().filter((m) => !grouped.has(m));
  return { favourites: favs, recents: recs, rest };
}

/**
 * The rows the picker draws, in that order, filtered and deduplicated.
 *
 * With a filter typed the groups are flattened into one list rather than three
 * headed sections: three headings compete with a short result set, and the order
 * still says what is what — a favourite matching the filter comes first. First
 * occurrence wins, so a model that is both recent and in the rest is listed once.
 */
export function orderedModels(
  all: string[],
  favourites: string[],
  recents: string[],
  filter = "",
  limit = 500,
): { rows: string[]; favourite: Set<string> } {
  const grouped = groupModels(all, favourites, recents);
  const needle = filter.trim().toLowerCase();
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const ref of [...grouped.favourites, ...grouped.recents, ...grouped.rest]) {
    if (seen.has(ref)) continue;
    if (needle && !ref.toLowerCase().includes(needle)) continue;
    seen.add(ref);
    rows.push(ref);
    if (rows.length >= limit) break;
  }
  return { rows, favourite: new Set(grouped.favourites) };
}

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
