import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRef } from "./runner.ts";

export interface Config {
  models: { drafter: ModelRef; reviewer: ModelRef };
  gate: boolean;
}

export const DEFAULT_CONFIG: Config = {
  models: {
    drafter: { ref: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    reviewer: { ref: "openai/gpt-5.2", family: "openai" },
  },
  gate: true,
};

export async function loadConfig(repo: string): Promise<Config> {
  const file = path.join(repo, ".adv/config.json");
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as Partial<Config>;
  } catch {
    // No config yet: fall back to the defaults.
  }
  return {
    gate: raw.gate ?? DEFAULT_CONFIG.gate,
    models: {
      drafter: raw.models?.drafter ?? DEFAULT_CONFIG.models.drafter,
      reviewer: raw.models?.reviewer ?? DEFAULT_CONFIG.models.reviewer,
    },
  };
}
