# adv — adversarial two-model plan review

`adv` runs a task through two different model families: one drafts, the other
adversarially verifies the draft, the human decides the taste calls at a gate,
and a scoped rebuttal applies those decisions. It returns a revised plan plus a
changelog and a diff.

The rule the whole tool is built around: **models verify, the human decides.**

![adv TUI screenshot](docs/screenshot-ai-debater-01.png)
*Example TUI screenshot of `adv` TUI, showing a corrected result - one LLM correcting another LLM.*

## The problem

The starting point was simple: run a prompt through two different LLM models so
a better answer comes out. The obvious approach — churning the answer back and
forth between the two models a few times — is the wrong one. It costs a lot of
tokens, the models drift, and on questions with no ground truth they just
oscillate between positions instead of converging.

What actually works is narrower and cheaper:

- **Fact-checking settles.** A concrete error — a bad formula, a wrong file
  path, a claim about code — gets caught and fixed in one adversarial pass,
  because evidence resolves it.
- **Preference debates do not settle.** On judgment calls with reasonable
  options on both sides, more model turns do not help. A model *can* tend to
  concede to the last argument it evaluated — a plausible explanation, but one
  drawn from a single model's account of its own session, and unproven. What is
  clear is that the decision belongs to a human with criteria, not to another
  model turn.

The manual version of this loop (two chat windows, copy-paste back and forth)
also fails in predictable ways: unfilled placeholders sent to the reviewer,
judgment calls quietly made by the drafter, a rebuttal prompt open enough to
invite agreement, and no record of what was decided. `adv` makes the loop
repeatable and cheap, and enforces the process rules in code rather than in
prompt wording the models can drift from.

## What it does

One command, and behind it:

- **drafts** a plan with model A,
- **verifies** it with model B from a different family, in a fresh read-only
  session that never sees A's reasoning,
- pauses once at a **gate** for the human to answer judgment calls and triage
  findings,
- **rebuts** only the flagged items and the human's decisions — nothing else,
- returns the revised plan plus a **changelog** and a **diff**, so any edit that
  is not attributable to an item is visible.

There is one review round by default, no churn, and the models never resolve a
judgment call.

**Non-goals.** Not a debate engine, not a multi-agent framework, not a
replacement for tests, and not a code-writing tool — v1 produces plans and
answers, and never edits the repository.

## Quick start

```sh
bun install
bun link                       # once: puts `adv` on PATH
```

There are two front ends over the same pipeline: an interactive **TUI** (bare
`adv`) and a scriptable **CLI** (`adv <command>`). Both drive `src/pipeline.ts`,
so a run started in one can be finished in the other.

Use the tool for unfamiliar codebases, correctness-critical plans and
high-stakes changes; skip it for small or familiar tasks, where the overhead
exceeds the gain.

### CLI mode

The CLI is the scriptable path — everything can run non-interactively and pipe
its output.

```sh
adv init --dir <repo>          # criteria, decisions and config (optional)
adv run "<task>" --dir <repo>  # draft -> review -> stop at the gate
adv decide [<run>]             # answer the gate
adv run --resume [<run>]       # rebut -> diff -> result
adv revise [<run>] [--rewrite] # re-ask the gate prefilled, re-run only the tail
adv status [<run>]             # show the current state
adv rm <run> | --all | --older-than 30d [--yes]   # remove runs from the store
```

Useful flags: `--dir <repo>` to target another repository, `--no-gate` to run
through without stopping, `--drafter` / `--reviewer` to override the models,
`--general` for a general question with no repository, and `--strict` to make a
same-family pair a hard stop. `adv run "<task>" > plan.md` writes the plan as
plain Markdown into a file; `NO_COLOR` turns off the styling.

### TUI mode

Bare `adv` opens the interactive TUI for the current directory (`adv --dir
/path/to/repo` for another). Home first — models browser, new debate, past
runs, settings — then keys.

| Key | Action |
| --- | --- |
| m / n / p / s / q | Home — models browser · new debate · past runs · settings · quit (↑↓ · Enter works too; cursor starts on models browser) |
| models browser | Home's first row: the model list — browse, ping, compare. Enter does nothing; Esc home |
| ↑↓ · Enter | New debate: on **drafter/reviewer preset**, choose a saved preset (creating and deleting live in settings). On **drafter** or **reviewer**, open the model picker in select mode — Enter assigns and returns to the debate screen. Typing always goes to the prompt |
| Tab | New debate: switch subject — **this repository** or a **general question** (also the subject row, Enter toggles) |
| Enter | New debate: on the prompt, run the typed task. A task that reads like a question in repository mode first asks **general question** or **this repository** |
| Ctrl+P | Settings — **edit drafter/reviewer pairs** or the AA benchmark key (from home or the debate screen; Esc home) |
| ↑↓ · Enter | Settings: on **edit drafter/reviewer pairs**, the list — saved pairs last used first, then pairs past runs used, then `new pair…` (pick a drafter, a reviewer, name it), then `save current as…` |
| d | Pairs: delete the highlighted saved pair, after a confirmation that names it |
| r / R | Pairs: rename the highlighted saved pair — `r` edits its name, `R` prefills a name suggested from its models. The name prompt prefills a suggestion for new saves too |
| P · T | Picker: **ping** the highlighted model. `P` asks one word — does this account reach it? `T` asks it to read a file — does it also use tools? The row says which ran |
| A | Picker: ping every match, or with no filter the favourites, recents and current pair (~30 models). Press twice; refused above 40 |
| F | Picker: providers on/off — every provider with a checkbox for whether the picker shows it (space toggles, `a` all on, `o` all off, Esc back). Applies to every view and persists between sessions |
| ? | Picker: what each provider bills to, whether a key is present, and every failure a ping found |
| Tab | Switch subject: **this repository** or a **general question** |
| Enter | Run the typed task. A task that reads like a question in repository mode first asks **general question** or **this repository** |
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
| x | Result: the exact text diff, and what each change was for (Esc back) |
| y | Result: copy the answer as Markdown — the writer's own text, into the clipboard, and to `answer.md` in the run directory |
| Y | Result: copy the whole result as Markdown, commentary included — to `result.md` as well |
| r | Result: revisit the gate — re-ask it with the recorded answers prefilled; if nothing moved, no model calls |
| n | Result/Gate/Runs: back to the debate screen — the draft, subject and models you had are kept |
| Esc | Close a panel and return to the same question. At the gate, leave the run. On the result screen Esc does nothing — `n` is a new debate, `q` quits (the run stays on disk — reopen it with Ctrl+R from home) |
| Ctrl+R | Past runs — open a finished or parked run, from home, the debate screen, the gate, a result or an error |
| Ctrl+U | New debate: clear the prompt |
| ←→ · ⌥←→ · ^A · ^E · ^K | Every text field: step within the line, jump by word, jump to start/end, kill to end of line — prompt, filter, pair name, key. Backspace deletes before, Del under |
| ↑↓ · q | Scroll the result; `q` quits |

Word jump (⌥←/⌥→) needs the terminal to send Option as Meta — in
Terminal.app tick **Use Option as Meta key** (elsewhere it is usually the
default); Ctrl+←/→ works everywhere instead, including Windows and Linux.
⌘ belongs to the terminal, not to `adv`: some terminals translate ⌘A/⌘E into
^A/^E, which then work as ends, but nothing here can bind ⌘ itself.

The first-run screen appears when the directory has no `.adv/`: choose
"Initialise .adv/ here", or "Continue without it" (models then default to the
built-in config). Models are chosen on the debate screen (↑↓ to drafter /
reviewer, Enter opens the picker); the models browser on home is the
read-only way in.

The pair you use most is worth a name: build it from **drafter/reviewer
pairs** (`new pair…` — pick a drafter, a reviewer, name it) or name the current
two with `save current as…`, and it is one keystroke away next time, listed
last-used first. Pairs live in
`~/.config/adv/pairs.json` and follow you between directories; the pairs past
runs used are offered from the run records themselves, so deleting a run
withdraws its pair from that list. The model picker marks the models you have
favourited in OpenCode with `★` and puts them first — `adv` reads OpenCode's
favourites and never writes them.

### Which models will actually work

`opencode models` lists every model in the models.dev catalogue for any provider
you hold a key for. It never asks the provider which of those the key can call,
so it offers models that fail on first use — on this machine it listed four
Groq models Groq answers `model_not_found` for, and hid four it can call.
`docs/OPENCODE-MODELS.md` has the diff, the reproduction, and the two dead ends
(config filtering and plugins, neither of which works).

So `adv` treats that listing as candidates and adds two things the catalogue and
a real call can answer:

- **The picker shows what it knows.** Price (`free`, `$0.10/$0.50`, or `?` when
  upstream has none), and `✗` on models the catalogue records as unable to call
  tools — fatal for a repository drafter, harmless for a general question.
- **`P` settles it.** One real call, classified into what actually happened: no
  credit, no access, blocked, throttled, app-only, or fine. Results are cached
  for a week (a day for failures, since credit can be added at any time) and
  always shown with their age. `T` goes further — it asks the drafter agent to
  read a file and judges from whether a tool call actually happened — which is
  the only thing that catches a model that answers but cannot work as an agent.
  The row shows which ran: `P to test`, `T? try tools`, `✓ 4.2s`, `✓ 7.4s T`.

One verdict is worth knowing about, because it looks like the opposite of a
fault: **`✗ app only`**. OpenCode's free tier refuses calls that come from a
terminal, so models like `opencode/big-pickle` and `opencode/space-bunny-free`
work perfectly in the OpenCode app and cannot be used by `adv` at all. The model
is fine and your account is fine; the ping is reporting that the tool cannot
reach it.

From the shell, `adv ping <model-or-pair>` does the same and exits non-zero if
anything failed. **Nothing pings on its own** — no call is made without a
keypress, and the multi-model sweep asks twice before spending forty calls.

## How it works

A run moves through a small state machine, persisted to disk so it is resumable:

```
drafted -> reviewed -> validated -> gated -> rebutted -> done
```

1. **Draft** — model A writes the plan (or answer) and a structured list of
   verifiable claims and judgment calls.
2. **Review** — model B, a different family in a fresh read-only session, returns
   one verdict per claim with evidence (`file:line` or a URL), plus any findings
   the drafter did not list. It must not propose an alternative plan.
3. **Validate** — the orchestrator schema-checks the output. On invalid output it
   retries once with the validation error; a second failure stops the run and
   shows the raw reply.
4. **Gate** — the human answers judgment calls and accepts or dismisses findings.
   Nothing here is resolved by a model.
5. **Rebuttal** — model A fixes or rebuts exactly the flagged items and applies
   the human's decisions, changing nothing else, and returns a changelog keyed
   to item IDs.
6. **Diff and output** — `plan.v1 -> plan.v2`, cross-referenced against the
   changelog so every hunk maps to an item.

Run artifacts live in one user-level store, in two kinds of bucket:

```
~/.local/share/adv/runs/<repo-name>-<hash>/<timestamp>/   # a repository's runs
~/.local/share/adv/runs/answers/<timestamp>/              # every general question
```

A question belongs to no repository, so it is not filed under one: you can open
it from anywhere, and its directory never names a repository it did not read.

The two modes are the repository and a general question. In repository mode the
draft reads the code and the task decides whether the deliverable is a plan for a
change or an answer about the code; in general-question mode nothing is read and
nothing is written into the directory you started in. Both are the same workflow.

## Docs

- [`AGENTS.md`](AGENTS.md) — working rules, current status, TUI keys, and the
  architecture. Read this before changing anything.
- [`PLAN.md`](PLAN.md) — the design and the locked decisions behind it.
- [`docs/M2-PLAN.md`](docs/M2-PLAN.md) — evidence execution design.
- [`docs/REVISE.md`](docs/REVISE.md) — `adv revise` design.
- [`spike/README.md`](spike/README.md) — M0 feasibility findings.

## License

MIT — see [`LICENSE`](LICENSE).
