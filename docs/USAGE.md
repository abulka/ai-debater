# Usage

Technical detail for `adv` and `ocm`. The [README](../README.md) is the pitch;
this is the manual.

`adv` requires **OpenCode 2.x**. It passes `--standalone` and injects agents
using the v2 config shape; OpenCode 1 treats the flag as unknown, prints its
help, and exits. A ping on v1 shows `✗ needs v2` (a client problem, not a model
or credential one). Fix it with `opencode upgrade --major`; a plain
`opencode upgrade` stays on 1.x.

## `adv` CLI

```sh
adv init --dir <repo>          # criteria and decisions (optional)
adv run "<task>" --dir <repo> [--general] [--plan] [--strict]
                               [--drafter <model> --drafter-family <f>]
                               [--reviewer <model> --reviewer-family <f>]
                               [--peer <model> --peer-family <f> | --peer none]
adv continue [<run>] [--instructions "…"]   # new run from a finished one
adv status [<run>]             # show the current state
adv ping <model-or-pair>… [--full] [--timeout <ms>]
adv benchmarks [--refresh] [<ref>]
adv rm <run> | --all | --older-than 30d [--yes]   # remove runs from the store
```

Useful flags: `--dir <repo>` to target another repository, `--general` for a
general question with no repository, `--plan` to force repository mode,
`--peer none` for two models instead of three, `--drafter` / `--reviewer` /
`--peer` (each needs its `--*-family`: the provider is not the family — a
gateway serves several families under one provider) to override the saved
models, and `--strict` to make a same-family pair a hard stop.
`adv run "<task>" > plan.md` writes the answer as plain Markdown into a file;
`NO_COLOR` turns the styling off.

There are two front ends over the same pipeline: an interactive **TUI** (bare
`adv`) and a scriptable **CLI** (`adv <command>`). Both drive `src/pipeline.ts`.

## `adv` TUI

Bare `adv` opens the interactive TUI for the current directory (`adv --dir
/path/to/repo` for another). Home first — models browser, new debate, past
runs, settings — then keys. Every screen lists its own keys behind `?`; the
full table:

| Key | Action |
| --- | --- |
| m / n / p / s / q | Home — models browser · new debate · past runs · settings · quit |
| ↑↓ · Enter | Choose a model pair or preset; on the prompt, run the typed task |
| Tab | Switch subject — **this repository** or a **general question** |
| P · T | Ping the highlighted model (one word / read-a-file); `A` pings every row shown |
| y / Y | Copy the answer / the whole result as Markdown |
| x | Diff from take 1 to the final answer |
| 1 / d · 2 / R · 3 | Each model's original take, unedited |
| i | What we learned — peers, what happened, the run log |
| C | Continue this debate with a follow-up |
| Ctrl+R | Past runs — open a finished run |
| space · d / D | Runs: tag rows · delete tagged / every run listed |
| Ctrl+T | Mouse: hand it to the terminal to select text, and take it back |

Your models, subject and thresholds follow you between directories: choosing
them writes only the global `~/.config/adv/config.json` — never anything into
a repository. The pair you use most is worth a name; pairs live in
`~/.config/adv/pairs.json`. The model picker marks the models you have
favourited in OpenCode with `★` and puts them first — `adv` reads OpenCode's
favourites and never writes them.

`adv init` is the one thing that writes into a repository, and only when you
ask: it creates `.adv/criteria.md` and `.adv/decisions.md` (both read on
every plan-mode run, both hand-edited afterwards). There is no setup screen
and no per-repository config — a directory with no `.adv/` just runs with a
fallback.

## How a run works

A run moves through a small state machine, persisted to disk:

```
created -> taking -> synthesizing -> done
```

(a failure at any point records `failed` plus the error instead). Two model
calls' worth of wall-clock: the takes run concurrently, then one synthesis.

1. **Takes** — each model answers the same prompt independently: the task,
   the criteria from `.adv/criteria.md` (plan mode), and the settled
   decisions from `.adv/decisions.md` (plan mode). Read-only, no tools
   beyond reading files and the web. In answer mode there is no repository:
   the run starts from a neutral directory and nothing is read or written
   where you launched it.
2. **Synthesis** — the lead (take 1's model) reads every take and writes the
   final answer: what was already right, what the peers caught or explained
   better, fixed errors, and a `## What we learned` note naming each model.

Run artifacts live in one user-level store, in two kinds of bucket:

```
~/.local/share/adv/runs/<repo-name>-<hash>/<timestamp>/   # a repository's runs
~/.local/share/adv/runs/answers/<timestamp>/              # every general question
```

Each run holds `task.md`, `take.1.md`, `take.2.md` (optional `take.3.md`),
`final.md`, `diff.patch`, `log.md`, and `state.json`. `answer.md` (the
answer) and `result.md` (the answer plus the commentary) appear when the TUI
copies them out. A question belongs to no repository, so it is not filed
under one: you can open it from anywhere, and its directory never names a
repository it did not read.

The two modes are the repository and a general question. In repository mode
the takes read the code and the task decides whether the deliverable is a
plan for a change or an answer about the code; in general-question mode
nothing is read and nothing is written into the directory you started in.
Both are the same workflow.

`adv continue [<run>] [--instructions "…"]` starts a new run from a finished
one: the previous final answer plus your follow-up becomes the new task. The
new run is otherwise normal — fresh takes, fresh synthesis — and it keeps the
parent's mode, so a continued question does not start reading a repository.
The same continuation is on the result screen behind `C`, and `Ctrl+L`
re-reads the parent result while composing the follow-up.

## `ocm` model browser

`ocm` is the picker from `adv`, standalone:

```sh
ocm [--dir <repo>] [--no-alt-screen]
```

Browse every model OpenCode knows, ping one, compare benchmarks and prices.
No run is started, no question is asked. The same browser is also inside
`adv` — home first, then `m`.

Settings are included (benchmarks key, highlights, cache window); pair
settings are not — there is no debate here. It shares all caches and
preferences with `adv`: favourites, probes, benchmarks, highlights and
prices are the same files.

## Which models will actually work

`opencode models` lists every model in the models.dev catalogue for any
provider you hold a key for. It never asks the provider which of those the
key can call, so it offers models that fail on first use. `OPENCODE-MODELS.md`
has the diff, the reproduction, and the two dead ends (config filtering and
plugins, neither of which works).

So `adv` treats that listing as candidates and adds two things the catalogue
and a real call can answer:

- **The picker shows what it knows.** Price (`free`, `$0.10/$0.50`, or `?`
  when upstream has none), and `✗` on models the catalogue records as unable
  to call tools — fatal for a repository take, harmless for a general
  question.
- **`P` settles it.** One real call, classified into what actually happened:
  no credit, no access, blocked, throttled, app-only, or fine. Results are
  cached for a week (a day for failures, since credit can be added at any
  time) and always shown with their age. `T` goes further — it asks an agent
  to read a file and judges from whether a tool call actually happened —
  which is the only thing that catches a model that answers but cannot work
  as an agent. The row shows which ran: `P to test`, `T? try tools`, `✓ 4.2s`,
  `✓ 7.4s T`.

One verdict is worth knowing about, because it looks like the opposite of a
fault: **`✗ app only`**. OpenCode's free tier refuses calls that come from a
terminal, so those models work perfectly in the OpenCode app and cannot be
used by `adv` at all. The model is fine and your account is fine; the ping is
reporting that the tool cannot reach it.

From the shell, `adv ping <model-or-pair>` does the same and exits non-zero
if anything failed. **Nothing pings on its own** — no call is made without a
keypress, and the multi-model sweep asks twice before spending forty calls.
