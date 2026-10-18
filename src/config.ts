import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelRef, Mode } from "./runner.ts";

/**
 * `warn` is the day-to-day default: the fast test pair shares a family on
 * purpose, and refusing to run would be worse than saying so.
 *
 * `require` is for anything whose result is evidence — the M3 trial and the
 * §12 eval. There, a same-family pair would silently measure "an extra pass"
 * while claiming to measure "cross-family review", which is the one experiment
 * in this project expensive enough that it must not be able to go wrong quietly.
 */
export type FamilyCheck = "warn" | "require";

export interface Config {
  models: { drafter: ModelRef; reviewer: ModelRef };
  gate: boolean;
  mode: Mode;
  familyCheck: FamilyCheck;
}

export const DEFAULT_CONFIG: Config = {
  models: {
    // The trial pair: two families, two providers, both verified live, both fast
    // enough to use in anger. This costs real money per run — for cheap test
    // runs pass the haiku pair explicitly (see AGENTS.md, rule 3).
    drafter: { ref: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    // Gateway, not the direct OpenAI account: that account has no credit.
    reviewer: { ref: "opencode-go/gpt-6-luna", family: "openai" },
  },
  gate: true,
  // The default subject is a general question. A repository task is one Tab away;
  // the tool is one workflow (draft, have another family check it, decide) applied
  // to either a plan for a codebase or an opinion about a question.
  mode: "answer",
  familyCheck: "warn",
};

/**
 * The user's last choice, at `~/.config/adv/config.json` (or under
 * `XDG_CONFIG_HOME`).
 *
 * Model choice used to live only in `<repo>/.adv/config.json`, so the same choice
 * had to be made again in every directory, and answer mode — where there is no
 * repository at all — fell back to the built-in default. The human's last choice
 * should stick.
 */
export const userConfigFile = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "adv", "config.json");
};

const localConfigFile = (repo: string) => path.join(repo, ".adv", "config.json");

const readPartial = async (file: string): Promise<Partial<Config>> => {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" ? (raw as Partial<Config>) : {};
  } catch {
    return {};
  }
};

/** Merge in order: repository, then the user's last choice, then the default. */
export async function loadConfig(repo: string): Promise<Config> {
  const user = await readPartial(userConfigFile());
  const local = await readPartial(localConfigFile(repo));

  const familyCheck = local.familyCheck ?? user.familyCheck;
  return {
    gate: local.gate ?? user.gate ?? DEFAULT_CONFIG.gate,
    // The mode is where *you* are working, not what the repository is. The user's
    // last choice wins so Tab sticks everywhere, including in a repo with its own
    // config file.
    mode: user.mode ?? local.mode ?? DEFAULT_CONFIG.mode,
    familyCheck: familyCheck === "require" ? "require" : "warn",
    models: {
      drafter: local.models?.drafter ?? user.models?.drafter ?? DEFAULT_CONFIG.models.drafter,
      reviewer: local.models?.reviewer ?? user.models?.reviewer ?? DEFAULT_CONFIG.models.reviewer,
    },
  };
}

/** The last choice, for seeding a new `.adv/` — null when nothing is stored yet. */
export async function loadUserConfig(): Promise<Config | null> {
  const user = await readPartial(userConfigFile());
  if (!user.models?.drafter && !user.models?.reviewer) return null;
  return {
    gate: user.gate ?? DEFAULT_CONFIG.gate,
    mode: user.mode ?? DEFAULT_CONFIG.mode,
    familyCheck: user.familyCheck === "require" ? "require" : "warn",
    models: {
      drafter: user.models?.drafter ?? DEFAULT_CONFIG.models.drafter,
      reviewer: user.models?.reviewer ?? DEFAULT_CONFIG.models.reviewer,
    },
  };
}

/**
 * Write the choice to the repository **and** to the user's config. A repository
 * that wants different models on purpose can still say so in its own file; the
 * user-level copy is what makes the choice follow you between directories.
 */
export async function saveConfig(repo: string, cfg: Config): Promise<void> {
  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  await mkdir(path.join(repo, ".adv"), { recursive: true });
  await writeFile(localConfigFile(repo), json);
  await mkdir(path.dirname(userConfigFile()), { recursive: true });
  await writeFile(userConfigFile(), json);
}
