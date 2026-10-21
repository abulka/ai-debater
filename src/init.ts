import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
 * Create (or refresh) the `.adv/` scaffolding. Opt-in only: `adv init`.
 *
 * `criteria.md` and `decisions.md` are only written if missing — never
 * overwrite the human's own files. Model choice lives in the global user
 * config, never here, so this writes no `config.json`.
 *
 * Agents are injected per model call from `src/agents.ts`, so `adv` works in
 * a directory that was never initialised and writes nothing unless asked.
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

  return { created, kept };
}
