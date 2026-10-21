# ai-debater

`adv` runs a task through two or three different models in parallel. Each
writes its own independent take; then the lead model reads all the takes and
synthesises one final answer, ending with a short "what we learned" note on
what the peers contributed.

The rule the whole tool is built around: **models answer, the human judges.**

![adv TUI screenshot](docs/screenshot-ai-debater-01.png)
*Example `adv` TUI screenshot.*

## The problem

The starting point was simple: run a prompt through two different LLM models so
a better answer comes out. The obvious approach — churning the answer back and
forth between the two models a few times — is the wrong one. It costs a lot of
tokens, the models drift, and on questions with no ground truth they just
oscillate between positions instead of converging.

What actually works is narrower and cheaper:

- **Independent takes stay honest.** Each model answers from the same prompt
  without seeing the others, so agreement between takes is real signal and
  disagreement is worth reading — neither is an artefact of who spoke last.
- **One synthesis, no churn.** The lead keeps what was already right in its
  take, takes what the peers caught or explained better, and fixes its errors.
  A single pass, in parallel: wall-clock time is one take, not three.
- **Preference debates do not settle.** On judgment calls with reasonable
  options on both sides, more model turns do not help. What is clear is that
  the decision belongs to a human with criteria, not to another model turn —
  so the models pick sensible defaults and recommend, and the human follows up
  where they disagree.

The manual version of this loop (two chat windows, copy-paste back and forth)
also fails in predictable ways: takes that converge because one model saw the
other, no record of which model said what, and no single answer to keep.
`adv` makes the loop repeatable and cheap, and enforces the independence in
code rather than in prompt wording the models can drift from.

## Requirements

- [Bun](https://bun.sh) — `adv` runs on Bun's runtime (`Bun.spawn`,
  `Bun.file`), not plain Node.
- [OpenCode](https://opencode.ai) — every model call goes through
  `opencode run`, so nothing works without it.

## Install

No npm account, no registry — install straight from GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/abulka/ai-debater/main/install.sh | sh
```

The script installs Bun if it is missing, warns if `opencode` is missing,
clones (or updates) the repo into `~/.local/share/ai-debater`, runs
`bun install`, and symlinks `adv` and `ocm` into `~/.local/bin`. Re-running it
updates an existing install. It takes `--repo`, `--dir` and `--bin` flags —
run it with `--help` to see them.

Or by hand:

```sh
git clone https://github.com/abulka/ai-debater.git
cd ai-debater
bun install
bun link                       # once: puts `adv` and `ocm` on PATH
```

## What it does

One command, and behind it:

- **takes** — two or three models answer the same prompt independently and in
  parallel (`take.1.md`, `take.2.md`, optional `take.3.md`), each read-only,
  none seeing the others;
- **synthesis** — the lead model reads every take and writes the final answer
  (`final.md`), keeping what was right, taking what the peers did better, and
  ending with a **what we learned** note naming each model by ref.

One pass. The `x` key shows the diff from take 1 to the final answer, so what
the synthesis changed is visible.

**Non-goals.** Not a multi-agent framework, not a replacement for tests, and
not a code-writing tool — it produces plans and
answers, and never edits the repository.

There are two front ends over the same pipeline: an interactive **TUI** (bare
`adv`) and a scriptable **CLI** (`adv <command>`). Both drive `src/pipeline.ts`.

Use the tool for unfamiliar codebases, correctness-critical plans and
high-stakes questions; skip it for small or familiar tasks, where the overhead
exceeds the gain.

### CLI mode

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

### TUI mode

Bare `adv` opens the interactive TUI for the current directory (`adv --dir
/path/to/repo` for another). Home first — models browser, new debate, past
runs, settings — then keys. Every screen lists its own keys behind `?`; the
essentials:

| Key | Action |
| --- | --- |
| m / n / p / s / q | Home — models browser · new debate · past runs · settings · quit |
| ↑↓ · Enter | Choose a model pair or preset; on the prompt, run the typed task |
| Tab | Switch subject — **this repository** or a **general question** |
| P · T | Ping the highlighted model (one word / read-a-file); `A` pings every row shown |
| y / Y | Copy the answer / the whole result as Markdown |
| x | Diff from take 1 to the final answer |
| 1 / d · 2 / R · 3 | Each model's original take, unedited |
| i | What we learned |
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

### ocm — the model browser without the debate

`ocm` is the picker from `adv`, standalone: browse every model OpenCode
knows, ping one, compare benchmarks and prices. No run is started, no
question is asked.

```sh
ocm [--dir <repo>] [--no-alt-screen]
```

Settings are included (benchmarks key, highlights, cache window); pair
settings are not — there is no debate here. It shares all caches and
preferences with `adv`: favourites, probes, benchmarks, highlights and
prices are the same files.

### Which models will actually work

`opencode models` lists every model in the models.dev catalogue for any
provider you hold a key for. It never asks the provider which of those the
key can call, so it offers models that fail on first use. `docs/OPENCODE-MODELS.md`
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

## How it works

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
`final.md`, `diff.patch`, and `state.json`. `answer.md` (the answer) and
`result.md` (the answer plus the commentary) appear when the TUI copies them
out. A question belongs to no repository, so it is not filed under one: you
can open it from anywhere, and its directory never names a repository it did
not read.

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

## Docs

- [`AGENTS.md`](AGENTS.md) — working rules for contributors and agents.
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — benchmarks in the picker.
- [`docs/OPENCODE-MODELS.md`](docs/OPENCODE-MODELS.md) — why `opencode
  models` is candidates, not availability, with the reproduction.

## License

MIT — see [`LICENSE`](LICENSE).
