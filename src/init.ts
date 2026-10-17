import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG, loadUserConfig } from "./config.ts";

const CRITERIA_TEMPLATE = `# Criteria

Fixed. Models may not add to or change this list.

- Minimal dependencies: prefer the standard library.
- Solo-maintainable: nothing that needs its own on-call.
- Fast to ship: working today beats elegant next month.
`;

const DECISIONS_TEMPLATE = `# Settled decisions

Append-only. Only the human adds entries here. Models treat every entry as a
closed question.
`;

export interface InitResult {
  created: string[];
  kept: string[];
}

/**
 * Create (or refresh) the `.adv/` scaffolding.
 *
 * `criteria.md`, `decisions.md` and `config.json` are only written if missing —
 * never overwrite the human's own files.
 *
 * The agent definitions used to be installed here too. They are now injected
 * into each model call from `src/agents.ts`, so `adv` works in a directory that
 * was never initialised and writes nothing outside `.adv/`.
 */
export async function initRepo(repo: string): Promise<InitResult> {
  await mkdir(path.join(repo, ".adv"), { recursive: true });

  const created: string[] = [];
  const kept: string[] = [];

  const putIfAbsent = async (file: string, content: string, label: string) => {
    try {
      await writeFile(file, content, { flag: "wx" });
      created.push(label);
    } catch {
      kept.push(label);
    }
  };

  await putIfAbsent(path.join(repo, ".adv", "criteria.md"), CRITERIA_TEMPLATE, ".adv/criteria.md");
  await putIfAbsent(
    path.join(repo, ".adv", "decisions.md"),
    DECISIONS_TEMPLATE,
    ".adv/decisions.md",
  );
  // Seed with the models the human last chose, not the built-in default: a new
  // repository should not silently reset a choice made in the TUI.
  const seed = (await loadUserConfig()) ?? DEFAULT_CONFIG;
  await putIfAbsent(
    path.join(repo, ".adv", "config.json"),
    `${JSON.stringify(seed, null, 2)}\n`,
    ".adv/config.json",
  );

  return { created, kept };
}

/**
 * What `.adv/` actually contains. These are two different questions, and the
 * TUI used to conflate them: it tested only `criteria.md`, so a directory with
 * `.adv/config.json` (which Ctrl+P writes) reported "no .adv/ here" while
 * `.adv/` was sitting there, and a run with config but no criteria was told
 * nothing about the missing criteria.
 */
export interface AdvState {
  dir: boolean;
  criteria: boolean;
}

export async function advState(repo: string): Promise<AdvState> {
  const dir = await stat(path.join(repo, ".adv"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  const criteria = await readFile(path.join(repo, ".adv", "criteria.md"), "utf8")
    .then(() => true)
    .catch(() => false);
  return { dir, criteria };
}
