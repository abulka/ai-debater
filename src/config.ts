import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRef, Mode } from "./runner.ts";

export interface Config {
  models: { drafter: ModelRef; reviewer: ModelRef };
  gate: boolean;
  mode: Mode;
}

export const DEFAULT_CONFIG: Config = {
  models: {
    drafter: { ref: "opencode-go/deepseek-v4.1-flash", family: "deepseek" },
    // Cheap on the Go plan and verified to work. Notes from testing, so the
    // next person does not repeat it:
    //   mimo-v2.6-flash        -> "model coming soon" (listed, not live)
    //   glm-5.3-flash          -> works, but ~130s per agent step
    //   deepseek-v4.1-flash    -> works, ~86s per agent step
    //   qwen3.8-flash          -> fast for a plain reply, slow with tool use
    //   opencode/muse-* , big-pickle -> the `opencode` provider, billed
    //                           separately; errors if that account has no credit
    // For a fast loop use groq: `groq/openai/gpt-oss-120b` + `gpt-oss-20b`
    // runs the whole pipeline in ~16s.
    reviewer: { ref: "opencode-go/glm-5.3-flash", family: "glm" },
  },
  gate: true,
  mode: "plan",
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
    mode: raw.mode ?? DEFAULT_CONFIG.mode,
    models: {
      drafter: raw.models?.drafter ?? DEFAULT_CONFIG.models.drafter,
      reviewer: raw.models?.reviewer ?? DEFAULT_CONFIG.models.reviewer,
    },
  };
}

/** Write the model choice and mode back to `.adv/config.json`. */
export async function saveConfig(repo: string, cfg: Config): Promise<void> {
  const dir = path.join(repo, ".adv");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}
