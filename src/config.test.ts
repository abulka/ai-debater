import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadUserConfig, saveConfig, userConfigFile } from "./config.ts";
import type { Config } from "./config.ts";
import { initRepo } from "./init.ts";

const configWith = (drafter: string, reviewer: string): Config => ({
  gate: true,
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

describe("model choice", () => {
  test("a choice made in one directory is the default in another", async () => {
    // The complaint this fixes: pick models in the TUI, run somewhere else, and
    // get the built-in pair back.
    const first = path.join(tmp, "first");
    await mkdir(first, { recursive: true });
    await saveConfig(first, configWith("anthropic/claude-sonnet-5-5", "openrouter/openai/gpt-6-luna"));

    const elsewhere = path.join(tmp, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const loaded = await loadConfig(elsewhere);
    expect(loaded.models.drafter.ref).toBe("anthropic/claude-sonnet-5-5");
    expect(loaded.models.reviewer.ref).toBe("openrouter/openai/gpt-6-luna");
  });

  test("the choice is written to both the repository and the user config", async () => {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    const chosen = configWith("a/drafter", "b/reviewer");
    await saveConfig(repo, chosen);

    const local = JSON.parse(await readFile(path.join(repo, ".adv", "config.json"), "utf8"));
    const user = JSON.parse(await readFile(userConfigFile(), "utf8"));
    expect(local.models.drafter.ref).toBe("a/drafter");
    expect(user.models.drafter.ref).toBe("a/drafter");
  });

  test("a repository config still overrides the user default, field by field", async () => {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    await saveConfig(repo, configWith("user/drafter", "user/reviewer"));
    await writeFile(
      path.join(repo, ".adv", "config.json"),
      JSON.stringify({ models: { drafter: { ref: "repo/drafter", family: "repo" } } }),
    );

    const loaded = await loadConfig(repo);
    expect(loaded.models.drafter.ref).toBe("repo/drafter");
    // The missing half falls back to the user's choice, not to the built-in default.
    expect(loaded.models.reviewer.ref).toBe("user/reviewer");
  });

  test("the mode is personal: the user's last choice beats a repository's file", async () => {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    await saveConfig(repo, { ...configWith("a/d", "b/r"), mode: "plan" });

    const other = path.join(tmp, "other");
    await mkdir(other, { recursive: true });
    await saveConfig(other, { ...configWith("a/d", "b/r"), mode: "answer" });

    expect((await loadConfig(repo)).mode).toBe("answer");
  });

  test("nothing stored yet means no user config", async () => {
    expect(await loadUserConfig()).toBeNull();
  });

  test("a new .adv/ is seeded with the last choice, not the built-in pair", async () => {
    const first = path.join(tmp, "first");
    await mkdir(first, { recursive: true });
    await saveConfig(first, configWith("chosen/drafter", "chosen/reviewer"));

    const fresh = path.join(tmp, "fresh");
    await mkdir(fresh, { recursive: true });
    await initRepo(fresh);
    const seeded = JSON.parse(await readFile(path.join(fresh, ".adv", "config.json"), "utf8"));
    expect(seeded.models.drafter.ref).toBe("chosen/drafter");
  });
});
