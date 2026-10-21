import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelRef, Mode } from "./runner.ts";
export type FamilyCheck = "warn" | "require";

export interface Config {
  models: { drafter: ModelRef; reviewer: ModelRef; peer?: ModelRef | null };
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
  // The default subject is a general question. A repository task is one Tab away.
  mode: "answer",
  familyCheck: "warn",
};

/**
 * The user's last choice, at `~/.config/adv/config.json` (or under
 * `XDG_CONFIG_HOME`). Personal and global: model choice, subject and
 * thresholds follow you between directories. Nothing is ever written into a
 * repository — no `.adv/config.json`, no litter.
 */
export const configDir = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
};

export const userConfigFile = (): string => path.join(configDir(), "adv", "config.json");

const readPartial = async (file: string): Promise<Partial<Config>> => {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" ? (raw as Partial<Config>) : {};
  } catch {
    return {};
  }
};

/** The user's global choice, then the default. No per-repository override. */
export async function loadConfig(): Promise<Config> {
  const user = await readPartial(userConfigFile());

  return {
    // The mode is where *you* are working, not what the repository is.
    mode: user.mode ?? DEFAULT_CONFIG.mode,
    familyCheck: user.familyCheck === "require" ? "require" : "warn",
    models: {
      drafter: user.models?.drafter ?? DEFAULT_CONFIG.models.drafter,
      reviewer: user.models?.reviewer ?? DEFAULT_CONFIG.models.reviewer,
      ...(user.models?.peer ? { peer: user.models.peer } : {}),
    },
  };
};

/** Write the choice to the user's global config only. Never into a repository. */
export async function saveConfig(cfg: Config): Promise<void> {
  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  await mkdir(path.dirname(userConfigFile()), { recursive: true });
  await writeFile(userConfigFile(), json);
}
