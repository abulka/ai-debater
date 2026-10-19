# AGENTS.md — working rules for this repo

Read this first. It exists because a previous session burned hours on avoidable
waits, and the person you are working with has said plainly: **do not block me.**

---

## Hard rules

1. **Never run a full workflow without asking first.**
   `adv run`, `adv run --resume`, `adv decide`, and the spike's `roundtrip`
   check all call models and can take minutes. Ask, state the expected time, and
   wait for a yes. A question is cheap; fifteen minutes of silence is not.

2. **Always pass an explicit timeout to shell commands.** Never leave a command
   unbounded. For anything that calls a model, use **at most 120000 ms**. If it
   times out, that is information — report it, do not retry with a longer
   timeout. The per-model-call timeout in the runner is 180s; that is a safety
   net, not a target.

3. **Use the fast test pair** unless the task is specifically about model
   quality: `anthropic/claude-haiku-5-5` (drafter) + `openrouter/openai/gpt-6-luna`
   (reviewer). The toy repo (`fixtures/toy-repo/.adv/config.json`) is configured
   this way. Groq's pair is faster still but **more expensive and less smart** —
   18 Oct correction: it is *not* free. Use it only when speed is the point.

4. **Clean up after yourself.** Never leave a stray `src/cli.ts`, browser, or
   `CANARY*` file behind. Check with:
   ```
   pgrep -f 'src/cli.ts'; pgrep -f 'ms-playwright-mcp/mcp-chrome'; find . -name 'CANARY*' -not -path './node_modules/*'
   ```
   The permission model is deny-by-default for a reason — an agent blocked on one
   route will reach for another (that is how a real browser once opened).

5. **Do not chase model availability.** Verify a model with a 10-second probe
   before wiring it in. Several models are listed but dead (see below). One
   probe, then move on.

6. **Never let an agent write to the repo.** The orchestrator owns every
   artifact. The drafter and reviewer are read-only.

---

## What this is

`adv` runs a task through two different model families: one drafts, the other
adversarially verifies, the human decides the taste calls at a gate, and a scoped
rebuttal applies the decisions. It returns a revised plan plus a changelog and a
diff. Models verify; the human decides.

The technique and the problem it solves are summarised in `README.md`; the
design and decisions are in `PLAN.md`; M0's findings are in `spike/README.md`.

**Non-goals.** Not a debate engine, not a multi-agent framework, not a
replacement for tests. The models never resolve judgment calls.

---

## Status

| Milestone | State |
| --- | --- |
| M0 feasibility spike | **done** — `spike/README.md` |
| M1 core loop | **done** — `adv init`, `run`, `decide`, `run --resume` |
| TUI | **done early** (was scheduled for M4) — bare `adv` |
| Visibility batch | **done 17 Oct** — gate panels, readable progress, resume/family/failed fixes |
| M3 real trial | **done 17 Oct** — spec in `docs/M2-PLAN.md` |
| M2 evidence execution | **done 17–18 Oct** — both slices: contract, matcher, executor, approval split, merged view (`src/audit.ts`). Parked: `adv audit <run>`, MCP disable |
| M4 revise | **done 18 Oct** — `adv revise [<run>] [--rewrite]`; spec in `docs/REVISE.md` |
| Model pairs + favourites | **done 18 Oct** — named pairs, OpenCode's favourites inherited read-only |
| Model ping | **done 18 Oct** — `p`/`P`/`A` in the picker, `adv ping` on the CLI, price and tool-calling badges, the provider pane. Findings in `docs/OPENCODE-MODELS.md` |
| TUI revise door | **done 18 Oct** — the same revise, reachable from the TUI: `r` on the result screen, past-runs picker (Ctrl+R) |

Typecheck must stay clean: `bun run typecheck`. Tests must stay green:
`bun test` (the gate mapping, resume-model choice and failed-state write are
covered there; the TUI layout itself is not).

---

## How to run

```sh
bun install
bun run typecheck              # must pass
bun test                       # must pass

bun link                       # once: puts `adv` on PATH
adv                            # TUI for the current directory
adv --dir /path/to/repo        # TUI for another repo

# CLI (scriptable)
adv init --dir <repo>          # criteria, decisions and config (optional)
adv run "<task>" --dir <repo> [--no-gate] [--general] [--plan] [--strict]
adv decide [<run>]
adv run --resume [<run>]
adv revise [<run>] [--rewrite] # re-ask the gate (prefilled), re-run only the tail
adv status [<run>]
adv ping <model-or-pair>… [--full] [--timeout <ms>]

# spike
bun run spike/m0.ts endpoints permissions artifacts   # cheap, no model calls for endpoints
```

`--general` (or Tab in the TUI) switches to answer mode: a general question, no
repository assumed, facts checked against URLs. Nothing is installed and nothing
is written into the directory you started in — answer mode works immediately,
and `adv init` is only needed if you want criteria and settled decisions.

Run artifacts go to `~/.local/share/adv/runs/`: a repository's runs under
`<repo-name>-<hash>/<timestamp>/`, and every general question under
`answers/<timestamp>/` — a question belongs to no repository, so it is filed
where it can be found from anywhere. The past-runs list shows both, each labelled
`task` or `question`, and a run carries its own directory, so opening a row
cannot open a same-stamped run from the other bucket. `adv decide`/`run
--resume`/`revise`/`status` take a bare run name and search both buckets (a
repository's own run wins the only ambiguous case: the same second in both).
Runs recorded before this stay where they were; they are records, and they are
still found by name. `adv run --resume` with no name takes the newest of either.

`adv rm <run> | --all | --older-than 30d [--yes]` removes runs, and the TUI's
runs screen does the same with `d`/`D`. Deleting removes only run directories
under the store: never a repository, never `.adv/`, never `~/.config/adv`. It
also does not un-settle anything — decisions already appended to a repo's
`.adv/decisions.md` stay there, which is why this is "delete the run", not
"undo". Nothing is deleted on one keystroke: the TUI confirms with the count,
the split (this repository's runs versus questions from any directory) and each
run by name, and the CLI prints the same and asks, refusing without a terminal
unless `--yes` is passed.

The answer is `plan.v2.md`; `answer.md` (the answer) and `result.md` (the answer
plus the commentary) appear when the TUI copies them out.

The CLI's final report is rendered Markdown on a terminal and plain Markdown in a
pipe, so `adv run "…" > plan.md` writes a plan rather than a plan with its
headings and emphasis scraped off. `NO_COLOR` turns the styling off.

`adv revise` is the door back into a finished run: it re-asks the gate with the
recorded answers (Enter keeps one), and if anything moved it re-runs only the
rewrite — two model calls, never the draft and the review. Identical answers
spend nothing. `docs/REVISE.md` has the state rules and the `decisions.md`
supersede rule.

### TUI keys

| Key | Action |
| --- | --- |
| m / n / p / s / q | Home — models browser · new debate · past runs · settings · quit (↑↓ · Enter works too; cursor starts on models browser) |
| Ctrl+P | Settings — a saved **pair** or the benchmarks key (from home or the debate screen; Esc home) |
| ↑↓ · Enter | Settings: on **pair**, open the pair list — saved pairs last used first, then pairs past runs used, then `save current as…` |
| d | Pairs: delete the highlighted saved pair, after a confirmation that names it (settings only — inert from the debate screen). A pair that belongs to a run is not stored here and goes when the run does |
| ↑↓ · Enter | New debate: on **pair**, choose a preset (saving and deleting live in settings). On **drafter** or **reviewer**, open the model picker in select mode — Enter assigns and returns to the debate screen. Typing always goes to the prompt and snaps the cursor back to it |
| models browser | Home's first row: the same model list — Enter does nothing, Esc home. Everything else (filter, views, ping, export) works as in the picker |
| P · T | Picker: **ping** the highlighted model. `P` asks it one word — *does this account reach it at all?* `T` asks it to read a file — *does it also reach for a tool?* The row says which ran: `P to test`, `T? try tools`, `✓ 4.2s`, `✓ 7.4s T` |
| A | Picker: ping every model shown — the list after the filter, the lock, the view and H. **Press A, then y** — the first press arms and names the models and the call count, `y` spends it, `n`/`Esc`/anything else stands down. Refused above 40 shown, and it says how to narrow |
| B | Picker: refresh the benchmark cache — OpenRouter plus Artificial Analysis direct when a key is stored, merged Artificial-Analysis-first, and the notice says which of those it got. Auto-refreshes in the background past 7 days |
| V | Picker: cycle the view — provider groups, intelligence-ranked, value (cheap per output token under the ceiling), taskcost (cheap per measured task under its own ceiling). Both cheap views rank by intelligence |
| C | Picker: toggle the price basis — base price or the above-threshold price a long session pays. Cells and the value-view ceiling move together; the count line says `price: high tier` when high |
| H | Picker: hide models with no benchmark, in every view |
| L | Picker: lock to the selected provider — the view, the filter and H all still apply inside it, and so does A. Press again to clear |
| ^F ^B | Picker: page the list; ^D ^U half a page, matching the results view |
| < > | Cheap views: move the active ceiling — value in $0.10 steps, taskcost geometrically (×1.5 / ÷1.5). Capped at the dearest measured cost, so `>` past everything is a no-op. Saved to `~/.config/adv/picker.json` |
| ? | Picker: what each provider bills to, whether a key is present, what the ★ ✓ ✗ marks mean, and every failure a ping has found |
| Y | Picker: export the visible list as a Markdown table with a legend — for a second opinion in another LLM — to the clipboard and `~/.local/share/adv/models.md` (overwritten each time) |
| Tab | New debate: switch subject — **this repository** or a **general question** (also the subject row, Enter toggles) |
| Enter | New debate: on the prompt, run the typed task. A task that reads like a question in repository mode first asks **general question** or **this repository** |
| ↑↓ · Enter | Answer the gate. Findings offer **yes / no / later**; a judgment call offers the draft's options plus "leave it open" |
| s | Skip the current question (finding: untriaged; judgment: open) |
| o | Gate: leave a judgment call open |
| d | Gate: the answer/plan text these questions are about, rendered. Result: the draft the review saw, before the gate |
| v | Gate/Result: every verdict, with its evidence |
| e | Gate: the cited source — the file around the line, or the URL |
| w | Gate: the current item's whole text, unclipped |
| i | Gate/Result: the review summary — warnings, checks, refuted claims |
| l | Gate/Result: the full run log |
| c | Result: the claims the drafter declared, and the options each judgment call offered |
| R | Result: the reviewer's raw reply, before the tool merged a check result into it |
| ? | Result: the keys that work on this screen |
| x | Result: the exact text diff and what each change was for, as a pane — neither fits below the fold |
| y | Result: copy the answer as Markdown — the writer's own text, into the clipboard, and to `answer.md` in the run directory |
| Y | Result: copy the whole result as Markdown, commentary included — to `result.md` as well |
| r | Result: revisit the gate — re-ask it with the recorded answers prefilled; if nothing moved, no model calls |
| n | Result/Gate/Runs: back to the debate screen — the draft, subject and models you had are kept |
| Esc | Back, one level: home is the root (debate · runs · settings → home; pick browse → home, pick select → debate; pairs → settings). A panel closes; a result or gate opened from the past-runs list returns to that list (tags, scroll and all). `n` is the unconditional way to the debate screen, `q` quits |
| n · Esc · q | Error: the same rule — Esc back where you came from, n to the debate screen, q quits. This screen had no handler at all, which is how a reader got stuck on it |
| Ctrl+R | Past runs — open a finished or parked run, from home, the debate screen, the gate, a result or an error |
| space | Runs: tag the highlighted run (`●`), and move on — tag several in a row |
| a / A | Runs: tag all listed / clear the tags |
| d | Runs: delete the tagged runs, or the highlighted one when none are tagged |
| D | Runs: delete every run listed, questions included — the confirmation states the split |
| Ctrl+U | New debate: clear the prompt |
| ↑↓ · j/k | Scroll a line |
| space · f | Page down (both do the same; `space` is what a reader tries first) |
| b · u · Ctrl+D · Ctrl+U | Page up · half up · half down · half up |
| g / G | Top / end of the pane |
| wheel | Scrolls the pane (the app asks the terminal for mouse reports) |
| Ctrl+T | Mouse: hand it to the terminal to select text, and take it back. The mode is on the bottom line of every screen |
| ↑↓ · q | Scroll the result; `q` quits |

The gate shows the review's state on every screen — counts, warnings, what was
refuted — and the three panels are how the human gets the context to decide
rather than deciding blind.

The first-run screen appears when the directory has no `.adv/`. Choose
"Initialise .adv/ here", or "Continue without it" (models then default to
`DEFAULT_CONFIG`). Models are chosen on the debate screen (↑↓ to drafter /
reviewer, Enter opens the picker); the models browser on home is the
read-only way in.

---

## Models — verified 17 Oct 2026

| Model | Verdict |
| --- | --- |
| `groq/openai/gpt-oss-120b` + `-20b` | fast but **more expensive and less smart** — not free; speed-only use |
| `anthropic/claude-haiku-5-5` + `openrouter/openai/gpt-6-luna` | **use for testing** — fast, cross-family, cheaper than sonnet; the toy repo is configured this way |
| `anthropic/claude-sonnet-5-5` | works, instant plain reply — **trial drafter** |
| `opencode-go/gpt-6-luna` | works, fast — **trial reviewer** (family openai) |
| `opencode-go/deepseek-v4.1-flash` | works, ~86s per agent step |
| `opencode-go/glm-5.3-flash` | works, ~130s per agent step |
| `opencode-go/qwen3.8-flash` | 7.6s for a plain reply, slow with tool use |
| `openai/gpt-5.2` | **no credit** — `credit_balance_exhausted` on the direct OpenAI account |
| `opencode-go/mimo-v2.6-flash` | **dead** — `model_coming_soon` |
| `opencode-go/muse-spark-1.3-contributor` | **blocked** — trains on request data; the workspace privacy opt-in is not in the desktop app |
| `opencode/*` (incl. `big-pickle`, `muse-spark-1.3`) | **no credit** — separate account, `402` |
| `opencode/big-pickle`, `opencode/space-bunny-free`, `opencode/mimo-v2.6-flash-free` | **app only** — they work in the OpenCode app; `FreeTierError` 403 refuses any terminal call. Not a fault, and not fixable from here |
| `groq/groq/compound-mini`, `groq/groq/compound` | **listed but unusable** — `model_not_found`. Also `tool_call: false`, so the catalogue catches them for free |
| `opencode-go/space-bunny-free` | **listed but unroutable** — `provider.no-route`. The Console one, `opencode/space-bunny-free`, is separate |
| `opencode-go/*-free` (5 models) | free on the subscription; only `beam-free` and `longcat-2.5-preview-free` are in `opencode models` |

The `opencode` provider is *not* the `opencode-go` subscription. Do not use it.

**Three failure shapes arrived with the ping**, and only two of them are faults.

- `provider.no-route` ("Model unavailable") is OpenCode refusing before the
  provider is reached. Same answer as `model_not_found`, so `classify` folds it
  into `no-access` rather than leaving it as an unrecognised `failed`.
- `FreeTierError` 403 — "OpenCode's free tier can only be used from within
  OpenCode" — is its own verdict, **`app-only`**, and it is not a fault at all.
  Those models work in the OpenCode app; the human has used them there and says
  so; they are simply unreachable from a terminal, which is the only way `adv`
  can call anything. It is separate from `blocked` because the remedy is
  opposite: nothing about the model or the account is wrong and no setting the
  reader can reach will change it. Treating it as a fault is what made
  `opencode/big-pickle` look broken for an afternoon.
- A **tool-less reply to `T`** is `no-tools`, and it is decided from the event
  stream rather than the words. A model that answers from memory without calling
  `read` passes any prose check and then fails the first real run.

**Success is never inferred from the model's prose.** The first `classify`
sniffed for the literal word "ok", which is right for `Reply with exactly: ok`
and wrong for everything else: a full ping that had genuinely read `README.md`
and answered `# adv — adversarial two-model plan review` was reported **failed**,
quoting its own good output as the reason. The caller decides success now, and
`classify` only ever classifies failures.

**Verify with `adv ping <model>`, not by reading the table.** The table is dated
and these rows are observations. One call is a few seconds and settles it; the
table costs nothing and might be wrong.

The trial pair is anthropic + openai **families** on two different providers: the
direct OpenAI account has no credit, so the reviewer goes through the gateway.
Do not "fix" that by pairing two `opencode-go` models and leaving both families
as `opencode-go` — the check compares the explicit `family` field.

**`DEFAULT_CONFIG` is now this pair**, because it is the configuration the tool is
meant to be used in: competent, cross-family, fast. It costs real money per run.
For a free loop, pass the groq pair explicitly:

```sh
adv run "…" --drafter groq/openai/gpt-oss-120b --drafter-family gpt \
            --reviewer groq/openai/gpt-oss-20b --reviewer-family gpt
```

**A model choice sticks.** Choosing models writes the repository's
`.adv/config.json` **and** `~/.config/adv/config.json` (honours
`XDG_CONFIG_HOME`). A directory with no `.adv/` — including every answer-mode
run — uses the last choice rather than `DEFAULT_CONFIG`, and `adv init` seeds a
new repository from it. A repository's own file still wins, field by field.

**Pairs are named pairs of models, and they are personal.** `~/.config/adv/pairs.json` holds
`{name, drafter, reviewer, savedAt, lastUsedAt}` — its own file
because `saveConfig` writes the whole config to both the user file *and* the
repository's, so a pair list on `Config` would be stamped into every `.adv/` the
moment a model was chosen. The settings screen's **pair** row names the pair the
current two models are, matched by model rather than by name. Pairs sort by
`lastUsedAt`, so the pair you used last is first. Pairs a past run used are
derived from `state.json` and not stored anywhere: **deleting a run deletes its
entry**, which is the one thing to know about that list. A saved pair is never
dropped for being stale — a pair whose models now share a family, or that
`opencode models` no longer lists, is shown and marked `!`.

**The picker inherits OpenCode's favourites, read-only.** `adv` reads
`~/.local/state/opencode/model.json` (`XDG_STATE_HOME`, then
`~/.local/state/opencode`, then `~/.cache/opencode`) and marks those models `★`
at the top of the model list, then OpenCode's recents, then everything else. It
never writes that file: OpenCode rewrites it wholesale on any change and has
reshaped it before (#8375 wiped favourites), so two programs writing it would
risk losing the reader's list. A missing or broken file is an empty list, not an
error — which is why there is no star key in `adv`.

**The subject is personal.** It starts as a **general question** (no repository
read); Tab switches to **this repository**, which reads the code and lets the task
decide the deliverable — a plan for a change, or an answer about the code. The
choice is saved like the models and applies in every directory; a repository
cannot pin it. One workflow either way: draft, have another family check it,
settle the calls.

Probe a model before relying on it:

```sh
cd fixtures/toy-repo && opencode run --standalone --format json \
  --model <provider/model> --auto "Reply with exactly: ok"
```

---

## Architecture

```
src/
  cli.ts            arg parsing + commands (init, run, decide, status, tui)
  tui.tsx           Ink/React TUI: setup, start, settings, pick, gate, panels,
                    result
  pipeline.ts       the shared sequence — both front ends drive this
  runners/
    opencode-run.ts spawns `opencode run`; validate-with-retry; usage
  contracts.ts      zod schemas (claims, review, changelog, gate, state)
  gate-model.ts     the gate as data: items, answers->gate.json, verdict counts,
                    scrolling, evidence lookup. Tested.
  urls.ts           deterministic URL checks: invisible characters, repair,
                    evidence flags. Tested.
  audit.ts          M2 evidence execution: exact-argv allowlist, spawn with no
                    shell + timeout + cap + scrubbed env, audit records.
                    Tested, not yet wired into the pipeline.
  prompts.ts        plan/answer prompts; one deliverable per call
  orchestrator.ts   run dirs, state machine, decisions.md
  gate.ts           the CLI gate (interactive or piped)
  diff.ts           unified diff + changelog cross-check (a heuristic)
  render.ts         the result as sections, each drawn one way: plain text for
                    a pipe, rendered Markdown for a terminal. Tested.
  markdown.ts       Markdown -> styled, pre-wrapped terminal lines. Styles only,
                    never removal; one line = one row. Tested.
  theme.ts          the palette, as roles; ANSI codes for the CLI. Tested.
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
  agents.ts         the three agent definitions (injected per call)
  init.ts           `adv init` scaffolding
fixtures/toy-repo/  the test problem (a deliberate lie in its README)
spike/              M0
```

### Things that will bite you if you forget them

- **`opencode` resolves the project from `$PWD`, not from the process cwd**, and
  `Bun.spawn({ cwd })` does not set `PWD`. Both `--standalone` and an explicit
  `PWD` are required or the agents silently target the wrong project.
- **Each `--standalone` run has its own session store**, so `--session` cannot
  continue a session across runs. Validate-with-retry re-sends the whole prompt.
- **OpenCode's base policy is `allow *`.** Denying `edit`/`shell` alone is not
  read-only; MCP servers stay reachable. Deny `*` first.
- **The three adv agents are injected, not installed** (`--agent adv-drafter` /
  `-reviewer` / `-writer`, definitions in `src/agents.ts`). They arrive in
  `OPENCODE_CONFIG_CONTENT`, which OpenCode **only reads when it starts its own
  server** — so every `opencode run` must pass `--standalone`, and anything that
  strips that variable produces `Agent not found`. The old file-based install,
  the markdown templates and `adv init --global` are gone; nothing is written to
  the target repo or to `~/.config/opencode`. They are `hidden: true`, but
  `opencode debug agents` lists hidden agents too — it is not a visibility test.
- **Each call asks for one thing** — prose, or one JSON block. Merging them is
  where models get flaky.
- **A run's model identity lives in `state.json`, not in the config.**
  `adv run --resume` uses the recorded pair (`resumedModels`), because the
  rebuttal is written by the drafter: resuming with the config default lets a
  model rewrite a plan it did not write. An explicit `--drafter`/`--reviewer`
  still wins, and is reported as an override.
- **`family` is a statement; `familyOf()` is a guess.** The diversity check
  compares the explicit `family` fields. `familyOf` only labels models in the
  picker. Do not use it to decide whether a pair is diverse.
- **`opencode models` is a catalogue, not an availability check.** It lists every
  models.dev model for any provider holding a credential and never asks the
  provider which of those the key can call. On this machine it offered four Groq
  models Groq answers `model_not_found` for and hid four it can call —
  `docs/OPENCODE-MODELS.md` has the diff and the reproduction. So the listing is
  **candidates**, and three layers sit above it: not-listed (no credential, free),
  the models.dev `tool_call: false` flag (cannot be a repository agent, free), and
  the ping (a real call, and the only trustworthy one). Do not let anything above
  the ping claim a model works.
- **Absent metadata is `?`, never `free`.** 77 of the 651 listed models have no
  cost upstream — including `opencode-go/beam-free`, whose catalogue entry is
  literally `null`. Rendering an unknown cost as "free" bills real money at 3am,
  so `costOf` has a third state and every renderer must keep it.
- **`model.json` and `models.json` are one character apart and read differently.**
  OpenCode's favourites state is `~/.local/state/opencode/model.json`; the
  catalogue is `~/.cache/opencode/models.json`. Reading the wrong one does not
  fail — the state file parses as JSON, every lookup misses, and every row renders
  `?` with nothing reporting an error. `parseCatalogue` rejects the state file's
  shape by name and that rejection is a test. `openCodeStateDirs()` also lists
  `~/.cache/opencode` as a candidate for the singular file, which is how the two
  get confused in the first place.
- **The models.dev `family` is finer-grained than ours and must not replace it.**
  It says `claude-haiku`, `gpt-luna`, `deepseek-flash` where `familyOf` says
  `claude`, `gpt`, `deepseek`. Substituting it would make `familyClash` *miss* a
  `deepseek` drafter against a `deepseek-flash` reviewer under
  `familyCheck: "require"` — measuring "an extra pass" while claiming
  cross-family review. The catalogue family is display-only; the comparison is
  made prefix-tolerant instead. Do not "fix" this by trusting the catalogue.
- **A ping is a real model call and nothing fires one on its own.** `P`, `T`, `A`
  and `adv ping` are the only callers. There is deliberately no background ping
  on launch: an earlier draft proposed one and it was dropped, because a tool
  that spends calls the reader did not ask for is a different tool. `A` arms and
  names the spend, only `y` spends it, and it is refused above 40 targets by name,
  because a single keypress cannot tell a deliberate `A` from a slipped Shift
  and forty calls is real money.
  The command keys are uppercase (`P`, `T`, `A`) so lowercase `p` still types
  into the filter — `p` as a ping key made a letter untypeable for no gain, since
  every one of the 651 refs is lowercase anyway.
- **The two ping depths are the row's job, not the footer's.** `P` asks for one
  word; `T` asks the drafter agent to read a file, and the verdict comes from
  whether the event stream shows a tool call — not from what the model said. The
  badge therefore carries which depth answered (`✓ 4.2s` vs `✓ 7.4s T`), an
  untested row says `P to test`, and a cheaply-tested one says `T? try tools`. A
  footer can say "ping+tools" once; it cannot say, per row, that the stronger
  question is still open on this one. **`loadProbes` must preserve `depth`** —
  `recordProbe` reads the whole file and writes one entry back, so a field the
  reader drops is a field every subsequent write erases. That bug silently
  un-marked every `T`.
- **A model row must never exceed the terminal's real width.** The picker lays
  out marks + ref + price + status, and every part is truncated rather than
  allowed to wrap, because the window counts lines. Two bugs lived here: a
  `Math.max(60, columns - 2)` floor made every row 60 wide on a narrower
  terminal, so rows that fitted at 100 columns wrapped into two visual rows at
  58 and the list looked double-spaced — and it looked *fine* on re-entering the
  screen, because Ink re-measures on the next render rather than on resize. And
  the price and status columns must yield before the ref does: held at 14 and 16
  on a 44-column terminal they left nine characters of model name.
- **The whole row lights up, not just the ref.** The price and status sit in
  fixed columns 60 characters to the right; a cursor on the ref alone left the
  reader guessing which price belonged to which model.
- **A failure writes `state: "failed"` plus the error.** A run left at
  `created` means the process died before it could record anything — that is
  different from a run parked at the gate, and used to be indistinguishable.
- **A citation can be broken in a way nobody can see.** A zero-width space
  inside a URL is invisible on screen and fatal when copied; a 20B reviewer
  returned "10 confirmed, 0 refuted" on a plan containing one. `src/urls.ts`
  removes invisible characters **inside URL spans only** before the review sees
  the plan, records the repair in `state.json`, and flags invisible characters
  in evidence. It deliberately leaves prose alone and leaves visible non-ASCII
  (an IDN, an accented path) alone: removing those would change the address
  rather than fix it. Do not ask a model to be the only check on this.
- **One verdict may cite more than one place.** `README.md:8-9; src/rateLimit.ts:3-4`
  is a legitimate evidence string. The existence check splits on `;` first;
  checking the combined string as a path reports both files as missing. A run
  did exactly that on 17 Oct before the split was added.
- **Reviewers propose shell pipelines.** `sh -c '… | grep …'` is a reasonable way
  to prove a file is absent, and it is precisely what the allowlist must refuse.
  The prompt says argv only, no shell; the executor has no shell, so a pipeline
  can never run. If a check cannot be expressed as one command, the claim stays
  `unverifiable` — and the reviewer is told to say so.
- **Nothing removes Markdown any more.** The answer is shown because it *is*
  Markdown: `src/markdown.ts` turns the syntax into styles and keeps the text.
  The old path stripped `#`, `*`, backticks and reformatted tables before the
  human saw it, which both read worse and quietly destroyed the text they were
  trying to copy. The one rewrite left is `【url】` → `[n]` plus a source list,
  because that is a citation syntax no terminal can show and the URL has to
  survive. A pipe gets the Markdown itself; a terminal gets it rendered.
- **Models nest emphasis, and a parser that refuses it mangles the sentence.**
  `**Original *Law & Order* ranks first**` is one bold sentence with an italic
  title in it. The first version of `inline()` would not let a `*` appear inside
  a `**` run, so the bold failed, the single-star rule then matched across the
  middle of the sentence, and a stray `*` appeared at each end — a real run's
  first paragraph, seen by the human and missed by every test. Emphasis content
  is now parsed again (`styled()`), the closing delimiter may not be part of a
  longer run, and a marker run that opens nothing is emitted whole rather than
  split. A `<br>` outside a fence is a line break, which is what the model meant
  by it; inside a fence it stays code. Table cells are parsed for emphasis too,
  so `**hits**` in a cell is bold rather than four literal characters.
- **Columns wrap under themselves, not back to the margin.** The commentary
  sections are rows of fields (`  V14  fixed     <summary>`), so `fitLines`
  takes a hanging indent and the changelog and decision sections compute theirs
  from the widest id in them. It wraps at spaces and keeps the spacing as
  written — `toWords` is for Markdown, where runs of spaces mean nothing, and
  using it here collapsed the columns.
- **Colour is a palette of roles, in `src/theme.ts`, and it never carries
  meaning on its own.** `accent` marks structure (section rules, headings, pane
  titles, the selected option), `code` marks literals, `warn`/`danger` mark state
  that wants attention, `dim` is scaffolding. Every signal keeps its textual
  marker — `!`, `DISAGREES`, `REFUTED`, the counts — so a monochrome terminal
  loses decoration and nothing else. The tool deliberately does **not** colour a
  confirmed claim green: a file agreeing with a sentence is not a verdict on the
  sentence, and deciding that is the human's job. A test asserts every colour the
  palette names has an ANSI code, because `toAnsi` silently drops the ones it
  does not know — which would be the TUI and the CLI describing one run two ways.
  Colour costs no width, so the row invariant above is untouched by any of it.
- **The commentary is built as spans and printed as text.** `resultSections`
  returns styled lines; `renderResult` joins their text for anything that is not
  a terminal. That is why `adv run > plan.md` is unchanged by a colour change:
  there is one layout and two deliveries, and the pipe simply drops the styles.
- **The diff names its two sides `draft` and `final`, and only a header may be
  rewritten.** `git diff --no-index` labels files with the paths it is handed,
  which here are the absolute paths of `plan.v1.md` and `plan.v2.md` inside the
  run directory — so a question asked in answer mode read as a change to
  whatever repository the session happened to start in. `relabelDraftToFinal`
  rewrites the header **before the first hunk only**: a removed line whose text
  begins with `--` also renders as `--- something`, and rewriting that corrupts
  the patch. Runs recorded before this keep their old labels — `diff.patch` is a
  record and the pane shows what is in it.
- **The "what it was changed for" pane joins by item id, never by hunk.**
  `assessDiff` counts hunks against changelog entries and cannot map one to the
  other, so the pane says which items were authorised, what the writer reported
  doing about each, and shows two absences that matter: a change to an item that
  was never authorised, and an authorised item the changelog says nothing about.
  Do not "improve" it into a hunk-to-item mapping: there is no such mapping.
- **A pane and the screen it opens over are the same component.** React reuses
  the `Scroller` instance when only the panel toggles, so its scroll offset
  carries over — and a pane opened after scrolling another renders past its own
  end, which is a blank pane with no error. Each screen is keyed by what is on
  it, so every pane starts at the top.
- **There are two task states, and the TUI is not allowed to trap you in a
  run.** `task` is the draft on the question desk: the debate screen owns it, and
  opening a past run must never touch it (it briefly did — `openRun` wrote the
  run's task into the same state, so Ctrl+R ate the prompt you were typing).
  `runTask` is the task of the run on screen, set from the draft by `beginRun`
  and from the record by `openRun`; `runHead`/`runTail` and the head effect read
  it. `n` is the way back to the debate screen from a result, a gate or the runs
  list, and Ctrl+R opens the list from any settled screen. Esc is inert on the
  result on purpose — quitting is `q`, never a stray Escape. The `Scroller`
  swallows Ctrl/meta combos so Ctrl+R cannot also read as `r` (revisit) or
  Ctrl+Y as `y` (copy).
- **Every screen needs a way out, and the text on it has to name a key that
  exists.** The error phase had no input handler: its own words said "Esc for the
  other runs" while the only key that worked was Ctrl+C, so a reader who opened a
  failed run from the past-runs list was stuck. When adding a phase, add its
  handler in the same commit, and make the hint line name the keys the handler
  answers to.
- **Esc means "back", and back is where you came from.** `openedFrom` records
  whether the run on screen came from the past-runs list or from the debate screen, and
  `goBack()` is the only thing that reads it: the result, the gate and the error
  screen all call it. Returning to the list does not reload it — the list is a
  snapshot and keeps its tags and its scroll — which is why `goBack` sets the
  phase and nothing else. `n` stays the unconditional way to the debate screen for when
  "back" is not where you want to be. Note the corollary: Ctrl+R does nothing
  while the list is already open, because it opens the list rather than
  refreshing it; leave the list and come back to see a run created meanwhile.
- **A Mac terminal keeps PageUp and PageDown for its own scrollback.** They
  never reach the app, so `space`/`f`/`b`/`u` are the paging keys that work, with
  `pageUp`/`pageDown` still handled for terminals that do send them.
- **The mouse is the platform's boundary, not an Ink feature, and it has two
  modes.** Ink 8 exports no mouse API: `useCursor` only *sets* the cursor (for
  IMEs), and the only mouse-aware thing in Ink is that `App.js` refuses mouse
  reports as printable input — which is why no field here has to guard its text,
  and why a harness check pins that behaviour rather than a guard of our own.
  What Ink *does* offer is the hand-off its `measureElement` docs describe, and
  the defaults it does not change are the right ones: **the wheel is asked for**
  (`1000h` + `1006h`, decoded in `src/mouse.ts`), and **motion is not** (`1002`),
  because motion is what would take text selection away from the terminal.
  - **The two modes are the point.** With the mouse reported, the wheel scrolls
    the pane but the terminal will not drag-select; without it, drag-selection is
    native and precise but the wheel scrolls the scrollback. `Ctrl+T` swaps them,
    and the mode is printed on the bottom line of *every* screen (`◌ mouse: the
    pane` / `◉ mouse: the terminal's`) — a mode you cannot see is a mouse that
    works at random. That line is truncated, not wrapped, so it is always exactly
    one row.
  - An earlier version implemented drag-selection *in the app* (1002 + hit-testing
    + copy on release). It was removed: it needed the app to know its own screen
    origin — which is not row 1, because the shell's prompt is above it — and it
    fought the wheel while dragging. The terminal does selection better than we
    did. Do not rebuild it without solving the origin first.
  - `startTui` turns reporting off again on the way out (`finally` plus
    `process.once("exit")`), or the reader's shell is left sending reports. There
    is no package to borrow: `ink-mouse` and `ink-mouse-events` do not exist, and
    `ink-scroll-box` is a scroll container with no events.
- **In a pane, one element must be one row.** The result and gate panes scroll
  by line offset (`clampOffset`/`maxOffset` in `gate-model.ts`), so if a line is
  wider than the pane, Ink wraps it, the count stops matching what is on screen,
  and the scroll jumps. That is why `renderMarkdownLines` pre-wraps, why a long
  URL or code line is split rather than allowed to overflow, and why the section
  headers are re-fitted to the width. Any new line put into a pane has to go
  through the renderer or `fitLines`.
- **The TUI is fullscreen, and the frame must never exceed the terminal.**
  Ink renders into the alternate screen (`render(node, {alternateScreen})`),
  the root is `<Box height={termRows}>`, the log sits on top, the screen fills
  the middle (`flexGrow` + `overflow="hidden"`), and the mouse line is pinned
  last. The budgets live in `src/viewport.ts` and every screen subtracts only
  its own chrome — the arithmetic is tested in `src/viewport.test.ts`, next to
  the gate-model rule. A screen that miscounts clips instead of corrupting the
  redraw, but none should have to: the invariant is log + spinner + content +
  mouse ≤ rows.
- **`<Static>` is banned.** It is designed for inline rendering; on the
  alternate screen Ink replays the whole accumulated static output on any full
  clear (a resize, leaving a fullscreen frame), pushing the live frame off the
  screen. The log is a bounded in-frame window over state instead, and `l`
  shows it whole in a pane. Do not reintroduce `Static` without leaving the
  alternate screen first.
- **The log is a window, not a history.** While a screen is up it shows the
  last rows that leave the content its minimum (`MIN_CONTENT_ROWS`, at most
  `LOG_MAX_ROWS`); while running it fills. The full log stays in state for the
  session, and the exit recap (state, run dir, plan path) is printed after Ink
  restores the shell — the alt screen leaves with everything else. The escape
  hatch is `--no-alt-screen` / `ADV_NO_ALT_SCREEN=1`, for terminals that
  misbehave with the alternate screen.
- **On the alternate screen there is no scrollback.** The handed-over mouse mode
  promises selection only — "wheel scrolls back" is false there and the line
  must not say it. The current wording is "drag to select text · Ctrl+T takes
  it back".
- The diff check is a **heuristic** (hunk count vs changelog entries). It flags
  possible out-of-scope edits; it cannot prove one, and a legitimately unclaimed
  consequence of a decision will be flagged as readily as a real edit.

---

## Next task

**M2 (evidence execution) and M4 (`adv revise`) are done.** M2's two slices are
in and tested: the contract, exact-argv matcher, executor, the quick-vs-slow
approval split, `audit.json`, the merged review view, and the URL/evidence
checks. M4 is `adv revise`: the gate asked again, prefilled, with only the
rewrite re-run — spec in `docs/REVISE.md` — and its TUI door: `r` on the result
screen and the past-runs picker (Ctrl+R) drive the same shared revise logic, so
the two front ends cannot drift. The 12 settled decisions in
`docs/M2-PLAN.md` §3 stand; do not reopen them without saying why.

Not yet done (parked, not lost):

1. `adv audit <run>` for re-running checks later — the plan's §6 item 3. There is
   no data to build a Tier 2 list from, so it is deliberately unbuilt;
2. the MCP server-level disable (plan §6; still open from the spike);
3. the §12 eval, which needs a body of runs first: 5–10 completed runs across
   pairs before any measurement is worth reading.

Before anything that calls a model, ask the human.
