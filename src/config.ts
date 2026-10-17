import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    // The trial pair, and now the default: two families, two providers, both
    // verified live, both fast enough to use in anger. This costs real money —
    // pass the groq pair explicitly for free test runs:
    //   --drafter groq/openai/gpt-oss-120b --drafter-family gpt \
    //   --reviewer groq/openai/gpt-oss-20b --reviewer-family gpt
    drafter: { ref: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    // Gateway, not the direct OpenAI account: that account has no credit.
    // Notes from testing, so the next person does not repeat it:
    //   mimo-v2.6-flash        -> "model coming soon" (listed, not live)
    //   glm-5.3-flash          -> works, but ~130s per agent step
    //   deepseek-v4.1-flash    -> works, ~86s per agent step
    //   qwen3.8-flash          -> fast for a plain reply, slow with tool use
    //   opencode/muse-* , big-pickle -> the `opencode` provider, billed
    //                           separately; errors if that account has no credit
    reviewer: { ref: "opencode-go/gpt-6-luna", family: "openai" },
  },
  gate: true,
  mode: "plan",
  familyCheck: "warn",
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
    familyCheck: raw.familyCheck === "require" ? "require" : "warn",
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
