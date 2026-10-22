# AGENTS.md — working rules for this repo

Read this before changing anything. It exists because a previous session burned
hours on avoidable waits: **do not block me.**

---

## Hard rules

1. **Never run a full workflow without asking first.**
   `adv run` and `adv continue` call models and can take minutes. Ask, state
   the expected time, and wait for a yes. A question is cheap; fifteen minutes
   of silence is not.

2. **Always pass an explicit timeout to shell commands.** Never leave a command
   unbounded. For anything that calls a model, use **at most 120000 ms**. If it
   times out, that is information — report it, do not retry with a longer
   timeout. The per-model-call timeout in the runner is 180s; that is a safety
   net, not a target.

3. **Use the fast test pair** unless the task is specifically about model
   quality: `anthropic/claude-haiku-5-5` (drafter) + `openrouter/openai/gpt-6-luna`
   (reviewer). Groq's pair is faster still but **more expensive and less smart** —
   it is not free. Use it only when speed is the point.

4. **Clean up after yourself.** Never leave a stray `src/cli.ts`, browser, or
   `CANARY*` file behind. Check with:
   ```
   pgrep -f 'src/cli.ts'; pgrep -f 'ms-playwright-mcp/mcp-chrome'; find . -name 'CANARY*' -not -path './node_modules/*'
   ```
   The permission model is deny-by-default for a reason — an agent blocked on one
   route will reach for another (that is how a real browser once opened).

5. **Do not chase model availability.** Verify a model with a 10-second probe
   before wiring it in. Several models are listed but dead. One probe, then
   move on. `adv ping <model>` settles it; the model table in this file used to
   go stale, so there is no table any more.

6. **Never let an agent write to the repo.** The orchestrator owns every
   artifact. All four agents are read-only.

---

## What this is

`adv` runs a task through two or three different models in parallel: each
writes its own independent take, then the lead synthesises the takes into one
final answer ending with a short "what we learned" note. One pass. Models
debate; a better result comes out.

The technique and the problem it solves are summarised in `README.md`. `ocm`
(`src/models-cli.ts`) is the model picker standalone — same code, same caches,
no debate.

**Non-goals.** Not a multi-agent framework, not a replacement for tests. The
models pick sensible defaults and recommend; the human settles the rest with
follow-ups.

---

## How to run

```sh
bun install
bun run typecheck              # must pass
bun test                       # must pass

ln -s "$PWD/src/cli.ts" ~/.local/bin/adv        # once: on PATH
ln -s "$PWD/src/models-cli.ts" ~/.local/bin/ocm
adv                            # TUI for the current directory
adv --dir /path/to/repo        # TUI for another repo

# CLI (scriptable)
adv init --dir <repo>          # criteria and decisions (optional)
adv run "<task>" --dir <repo> [--general] [--plan] [--strict]
adv continue [<run>] [--instructions "…"] # new run from a finished one
adv status [<run>]
adv ping <model-or-pair>… [--full] [--timeout <ms>]
adv benchmarks [--refresh] [<ref>]
adv rm <run> | --all | --older-than 30d [--yes]
```

Typecheck must stay clean, tests must stay green. Neither calls a model.

`--general` (or Tab in the TUI) switches to answer mode: a general question, no
repository assumed, facts checked against URLs. Nothing is installed and nothing
is written into the directory you started in — answer mode works immediately,
and `adv init` is only needed if you want criteria and settled decisions.

Run artifacts go to `~/.local/share/adv/runs/`. The answer is `final.md`; `x`
shows the diff from take 1 to the final answer. The TUI lists its own keys
behind `?` — do not duplicate that table here.

---

## Models

- **Default pair** (`DEFAULT_CONFIG` in `src/config.ts`, the pair the tool is
  meant to be used in): anthropic drafter + openai-family reviewer through the
  gateway — competent, cross-family, fast. It costs real money per run. For a
  free loop, pass the groq pair explicitly on the command line.
- **`family` is a statement; `familyOf()` is a guess.** The diversity check
  compares the explicit `family` fields. `familyOf` only labels models in the
  picker. The direct OpenAI account has no credit, so the reviewer goes through
  the gateway — do not "fix" that by pairing two `opencode-go` models and
  leaving both families as `opencode-go`.
- **A model choice sticks, globally.** Choosing models writes only
  `~/.config/adv/config.json` — never anything into a repository. There is no
  per-repository override; a flag on the command line is the way to run
  one-off models. Pairs live in `~/.config/adv/pairs.json`, personal to the
  user. The picker inherits OpenCode's favourites read-only and never writes
  them.
- **`opencode models` is a catalogue, not an availability check.**
  `docs/OPENCODE-MODELS.md` has the diff and the reproduction. Three layers sit
  above it: not-listed (no credential, free), the models.dev `tool_call: false`
  flag (cannot be a repository agent, free), and the ping (a real call, and the
  only trustworthy one). Success is never inferred from a model's prose, and
  nothing pings on its own — `P`, `T`, `A` and `adv ping` are the only callers.

---

## Architecture

```
src/
  cli.ts            arg parsing + commands (init, run, continue, status, rm,
                    ping, benchmarks, tui)
  models-cli.ts     `ocm`: the picker standalone (no debate, no pairs)
  tui.tsx           Ink/React TUI: home, start, settings, pick, panels, result
  pipeline.ts       the shared sequence — both front ends drive this:
                    parallel takes, then one synthesis
  runners/
    opencode-run.ts spawns `opencode run`; tool-rejection retry; usage
  contracts.ts      zod schemas (models, run state)
  urls.ts           deterministic URL checks: invisible characters, repair.
                    Tested.
  prompts.ts        take/synthesis prompts; one deliverable per call
  orchestrator.ts   run dirs, state machine, criteria/decisions reads.
                    Tested.
  continue.ts       chained runs: the previous result plus a follow-up,
                    composed into a new task. Tested.
  diff.ts           unified diff of take 1 vs the final answer
  render.ts         the council result as sections, each drawn one way: plain
                    text for a pipe, rendered Markdown for a terminal. Tested.
  markdown.ts       Markdown -> styled, pre-wrapped terminal lines. Styles only,
                    never removal; one line = one row. Tested.
  theme.ts          the palette, as roles, plus the highlight palette;
                    ANSI codes for the CLI. Tested.
  highlight.ts      configurable auto-highlight rows: filter texts with
                    derived colours, matched with the picker's own rule.
                    Tested.
  mouse.ts          wheel reports: enable/disable, decode, and the "is this
                    typed input or a report" test. Tested.
  clipboard.ts      copying the answer out: pbcopy/wl-copy, then OSC 52, then
                    the file path. Tested.
  models.ts         model list, picker ordering, family heuristic for the picker
  catalogue.ts      models.dev's models.json: price, tool-calling, real family.
                    Read-only, never written. Tested.
  probe.ts          the ping: one real model call, classified, cached with a TTL.
                    The only thing in adv that spends a call. Tested.
  providers.ts      what a provider bills to, from `opencode auth list` and the
                    catalogue, plus the dated account notes. Tested.
  pairs.ts          named model pairs: the file, the order, and the rows the
                    pair screen draws. Tested.
  opencode-state.ts OpenCode's model.json, read for its favourites and never
                    written. Tested.
  lineedit.ts       word jump + kill-to-end for every text field: the motions
                    as pure functions, the key shapes as predicates. Tested.
  agents.ts         the four agent definitions (injected per call)
  init.ts           `adv init` scaffolding (criteria + decisions only)
  viewport.ts       fullscreen budgets; scroll clamps. Tested.
fixtures/toy-repo/  the test problem (a deliberate lie in its README)
```

### Things that will bite you if you forget them

- **adv requires OpenCode 2; OpenCode 1 fails in a way that looks like a model
  problem.** v1 does not know `--standalone`, so it prints its help and exits 1;
  the probe used to record the tail of that help as a `failed` verdict. v1 also
  ignores the v2 `agents`/`permissions`/`system` config and silently falls back
  to the default (non-read-only) agent on an unknown `--agent`. The runner
  checks `opencode --version` before spawning and `adv` pings show `✗ needs v2`;
  the remedy is `opencode upgrade --major` (plain `opencode upgrade` stays on
  1.x). Do not "fix" a v1 failure by relaxing the version check.
- **`opencode` resolves the project from `$PWD`, not from the process cwd**, and
  `Bun.spawn({ cwd })` does not set `PWD`. Both `--standalone` and an explicit
  `PWD` are required or the agents silently target the wrong project.
- **Each `--standalone` run has its own session store**, so `--session` cannot
  continue a session across runs. A rejected tool call or a transient provider
  error gets one retry, with the whole prompt re-sent.
- **OpenCode's base policy is `allow *`.** Denying `edit`/`shell` alone is not
  read-only; MCP servers stay reachable. Deny `*` first.
- **The four adv agents are injected, not installed** (`--agent adv-council` /
  `-council-answer`, plus `adv-drafter` / `adv-writer` for the ping,
  definitions in `src/agents.ts`). They arrive in
  `OPENCODE_CONFIG_CONTENT`, which OpenCode **only reads when it starts its own
  server** — so every `opencode run` must pass `--standalone`, and anything that
  strips that variable produces `Agent not found`. Nothing is written to the
  target repo or to `~/.config/opencode`.
- **Each call asks for one thing** — a take, or the synthesis. The council asks
  for prose only; mixing prose with a JSON block made models flaky.
- **Absent metadata is `?`, never `free` — with one suffix-shaped exception.**
  Rendering an unknown cost as "free" bills real money at 3am — but a ref
  missing from the catalogue whose name ends in `-free` reads `free`: every
  `-free` ref models.dev lists is free, with no priced and no null
  counterexample. It fills silences only, never overrides a listed price.
- **The price catalogue refreshes itself.** OpenCode's
  `~/.cache/opencode/models.json` has no refresh owner. Past the reader's window
  (7 days by default, changed in settings) `adv` fetches models.dev into its own
  `~/.local/share/adv/catalogue.json` in the background at picker open and
  reads whichever copy is newer. Never writes OpenCode's file.
- **`model.json` and `models.json` are one character apart and read differently.**
  OpenCode's favourites state is `~/.local/state/opencode/model.json`; the
  catalogue is `~/.cache/opencode/models.json`. `parseCatalogue` rejects the
  state file's shape by name and that rejection is a test.
- **The models.dev `family` is finer-grained than ours and must not replace it.**
  The catalogue family is display-only; the comparison is made prefix-tolerant
  instead. Do not "fix" this by trusting the catalogue.
- **A ping is a real model call and nothing fires one on its own.** `A` arms and
  names the spend, only `y` spends it, refused above 40 targets. The two ping
  depths are the row's job, not the footer's: `P` asks for one word, `T` asks an
  agent to read a file and judges from the event stream, not the words.
  **`loadProbes` must preserve `depth`** — `recordProbe` rewrites the file per
  entry, so a dropped field is erased everywhere.
- **A failure writes `state: "failed"` plus the error.** A run left at
  `created` means the process died before it could record anything.
- **A citation can be broken in a way nobody can see.** A zero-width space
  inside a URL is invisible on screen and fatal when copied. `src/urls.ts`
  removes invisible characters **inside URL spans only** before the takes run.
  Do not ask a model to be the only check on this.
- **Nothing removes Markdown any more.** The answer is shown because it *is*
  Markdown; `src/markdown.ts` turns the syntax into styles and keeps the text. A
  pipe gets the Markdown itself; a terminal gets it rendered.
- **Colour is a palette of roles, in `src/theme.ts`, and it never carries
  meaning on its own.** Every signal keeps its textual marker, so a monochrome
  terminal loses decoration and nothing else. A test asserts every colour the
  palette names has an ANSI code.
- **A pane and the screen it opens over are the same component.** Each screen is
  keyed by what is on it, so every pane starts at the top.
- **There are two task states: `task` (the desk draft) and `runTask` (the run on
  screen).** Opening a past run must never touch `task`. `C` continues
  forcefully with an empty prompt; the parent's result travels in state, never
  in the field.
- **The model resolves "this repo" as the git repo, not the directory.** The
  prompts pin the subject to the working directory ("cite only files under it").
- **The result screen is the answer; the commentary is behind `i`.**
- **The prompt must only ask for what the agent's tools can produce.**
- **Every screen needs a way out, and the text on it has to name a key that
  exists.** When adding a phase, add its handler in the same commit, and
  `src/tui-phase.test.ts` pins every `Phase` member to the render chain.
- **Esc means "back", and back is where you came from.** `n` is the
  unconditional way to the debate screen; quitting is `q`, never a stray Escape.
- **`<Static>` is banned.** The log is a bounded in-frame window over state.
- **In a pane, one element must be one row.** Pre-wrap through the renderer or
  `fitLines`, or the scroll offset stops matching what is on screen.
- **The TUI is fullscreen, and the frame must never exceed the terminal.**
  The budgets live in `src/viewport.ts`; the arithmetic is tested in
  `src/viewport.test.ts`.
- **The mouse has two modes** (pane vs terminal, `Ctrl+T` swaps), printed on
  the bottom line of every screen. Motion is never requested; clicks select,
  never commit, and stay off under `--no-alt-screen`.

---

## Open work

1. The MCP server-level disable. The agent permissions deny by tool name
   (`*` deny first, see `src/agents.ts`), but an MCP server's tools are not yet
   removed per server, so one could still be reached by a route the allowlist
   does not name.

Before anything that calls a model, ask the human.
