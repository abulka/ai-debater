#!/usr/bin/env bun
/**
 * ocm — standalone model browser.
 *
 * The model picker from adv, without the debate: browse, ping, compare,
 * benchmarks, highlights and prices. No run is started, no question is asked.
 * Shares every cache, preference and probe with adv — same code, no duplication.
 */

import path from "node:path";

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith("--")) continue;
  const name = arg.slice(2);
  if (name === "no-alt-screen" || name === "help") {
    flags.set(name, true);
    continue;
  }
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(name, next);
    i++;
  } else {
    flags.set(name, true);
  }
}

if (flags.has("help")) {
  console.log(`ocm — standalone model browser

  ocm [--dir <repo>] [--no-alt-screen]

  Browse every model opencode knows, ping one, compare benchmarks and prices.
  Settings are included (benchmarks key, highlights, cache window); pair
  settings are not — there is no debate here.

  Shares all caches and preferences with adv: favourites, probes, benchmarks,
  highlights and prices are the same files.`);
  process.exit(0);
}

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  console.error("ocm needs a terminal. Run it interactively.");
  process.exit(1);
}

const dirFlag = flags.get("dir");
const repo = path.resolve(typeof dirFlag === "string" ? dirFlag : process.cwd());

const { startTui } = await import("./tui.tsx");
const { altScreenEnabled } = await import("./viewport.ts");
await startTui({
  repo,
  altScreen: altScreenEnabled(flags.has("no-alt-screen"), process.env.ADV_NO_ALT_SCREEN),
  initial: "browser",
  standalone: true,
});
