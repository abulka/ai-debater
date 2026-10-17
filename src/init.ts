import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";

const TEMPLATES = path.join(import.meta.dir, "..", "templates", "agents");

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
 * Create (or refresh) the `.adv/` scaffolding and the two agent definitions.
 *
 * `criteria.md`, `decisions.md` and `config.json` are only written if missing —
 * never overwrite the human's own files. The agent definitions are always
 * refreshed, so an upgrade ships with `adv init`.
 */
export async function initRepo(repo: string): Promise<InitResult> {
  await mkdir(path.join(repo, ".adv"), { recursive: true });
  await mkdir(path.join(repo, ".opencode", "agents"), { recursive: true });

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
  await putIfAbsent(
    path.join(repo, ".adv", "config.json"),
    `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
    ".adv/config.json",
  );

  for (const name of ["adv-drafter.md", "adv-reviewer.md", "adv-writer.md"]) {
    await writeFile(
      path.join(repo, ".opencode", "agents", name),
      await readFile(path.join(TEMPLATES, name), "utf8"),
    );
    created.push(`.opencode/agents/${name}`);
  }

  return { created, kept };
}

export async function hasAdvDir(repo: string): Promise<boolean> {
  try {
    await readFile(path.join(repo, ".adv", "criteria.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}
