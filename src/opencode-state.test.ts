import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openCodeStateDirs, parseOpenCodeModels, readOpenCodeModels } from "./opencode-state.ts";

let tmp = "";
let previousXdg: string | undefined;

/** The real state dir is never a candidate: the machine running this has favourites. */
const only = (...dirs: string[]) => dirs;

const stateDir = () => path.join(tmp, "opencode");

const withStateFile = async (contents: string) => {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(path.join(stateDir(), "model.json"), contents);
};

beforeEach(async () => {
  previousXdg = process.env["XDG_STATE_HOME"];
  tmp = await mkdtemp(path.join(os.tmpdir(), "adv-oc-state-"));
  process.env["XDG_STATE_HOME"] = tmp;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = previousXdg;
  await rm(tmp, { recursive: true, force: true });
});

describe("reading OpenCode's model state", () => {
  test("favourites and recents become provider/model refs, in order", async () => {
    await withStateFile(
      JSON.stringify({
        recent: [{ providerID: "groq", modelID: "openai/gpt-oss-120b" }],
        favorite: [
          { providerID: "opencode-go", modelID: "claude-haiku-5-5" },
          { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
        ],
        variant: { "groq/openai/gpt-oss-120b": "medium" },
      }),
    );

    const models = await readOpenCodeModels(only(stateDir()));
    expect(models.favourites).toEqual([
      "opencode-go/claude-haiku-5-5",
      "openrouter/z-ai/glm-5.3-flash",
    ]);
    expect(models.recents).toEqual(["groq/openai/gpt-oss-120b"]);
  });

  test("a model is listed once however many times it appears", async () => {
    const parsed = parseOpenCodeModels(
      JSON.stringify({
        favorite: [
          { providerID: "splash", modelID: "qwen3.8-27b" },
          { providerID: "splash", modelID: "qwen3.8-27b" },
        ],
      }),
    );
    expect(parsed.favourites).toEqual(["splash/qwen3.8-27b"]);
  });

  test("no file, a broken file and a reshaped file are all empty lists", async () => {
    expect(await readOpenCodeModels(only(stateDir()))).toEqual({ favourites: [], recents: [] });

    await withStateFile("{not json");
    expect(await readOpenCodeModels(only(stateDir()))).toEqual({ favourites: [], recents: [] });

    // Every shape OpenCode might leave behind that is not the one it writes.
    for (const body of [
      JSON.stringify({ favorite: "everything" }),
      JSON.stringify({ favourite: [{ providerID: "a", modelID: "b" }] }),
      JSON.stringify([{ providerID: "a", modelID: "b" }]),
      JSON.stringify(null),
      JSON.stringify(""),
    ]) {
      await withStateFile(body);
      expect(await readOpenCodeModels(only(stateDir()))).toEqual({ favourites: [], recents: [] });
    }
  });

  test("a half-written entry is dropped, not rendered as a broken ref", () => {
    const parsed = parseOpenCodeModels(
      JSON.stringify({
        favorite: [
          { providerID: "groq" },
          { modelID: "openai/gpt-oss-120b" },
          null,
          { providerID: "  ", modelID: "x" },
        ],
      }),
    );
    expect(parsed.favourites).toEqual([]);
  });

  test("the state directory list honours XDG_STATE_HOME and has no duplicates", () => {
    const dirs = openCodeStateDirs();
    expect(dirs[0]).toBe(path.join(tmp, "opencode"));
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
