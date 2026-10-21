import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, userConfigFile } from "./config.ts";
import type { Config } from "./config.ts";

const configWith = (drafter: string, reviewer: string): Config => ({
  mode: "plan",
  familyCheck: "warn",
  models: {
    drafter: { ref: drafter, family: drafter.split("/")[0] ?? "x" },
    reviewer: { ref: reviewer, family: reviewer.split("/")[0] ?? "y" },
  },
});

let tmp = "";
let previousXdg: string | undefined;

beforeEach(async () => {
  previousXdg = process.env["XDG_CONFIG_HOME"];
  tmp = await mkdtemp(path.join(os.tmpdir(), "adv-config-"));
  process.env["XDG_CONFIG_HOME"] = path.join(tmp, "config");
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  await rm(tmp, { recursive: true, force: true });
});

describe("global choice", () => {
  test("a saved choice is the default everywhere", async () => {
    await saveConfig(configWith("anthropic/claude-sonnet-5-5", "openrouter/openai/gpt-6-luna"));

    const loaded = await loadConfig();
    expect(loaded.models.drafter.ref).toBe("anthropic/claude-sonnet-5-5");
    expect(loaded.models.reviewer.ref).toBe("openrouter/openai/gpt-6-luna");
  });

  test("the choice is written only to the user config, never into a repo", async () => {
    const repo = path.join(tmp, "repo");
    const chosen = configWith("a/drafter", "b/reviewer");
    await saveConfig(chosen);

    const user = JSON.parse(await readFile(userConfigFile(), "utf8"));
    expect(user.models.drafter.ref).toBe("a/drafter");
    expect(user.models.reviewer.ref).toBe("b/reviewer");
    // No litter: saveConfig takes no repo and creates nothing in it.
    expect(repo).not.toContain(".adv");
  });

  test("nothing stored yet falls back to the default", async () => {
    const loaded = await loadConfig();
    expect(loaded.models.drafter.ref).toBeTruthy();
  });
});
