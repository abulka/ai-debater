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
| TUI revise door | **done 18 Oct** — the same revise, reachable from the TUI: `r` on the result screen, past-runs picker on the start screen (Ctrl+R) |

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

# spike
bun run spike/m0.ts endpoints permissions artifacts   # cheap, no model calls for endpoints
```

`--general` (or Tab in the TUI) switches to answer mode: a general question, no
repository assumed, facts checked against URLs. Nothing is installed and nothing
is written into the directory you started in — answer mode works immediately,
and `adv init` is only needed if you want criteria and settled decisions.

Run artifacts go to `~/.local/share/adv/runs/<repo-name>-<hash>/<timestamp>/`,
for both modes. `adv decide`/`run --resume`/`revise`/`status` take a bare run
name. The answer is `plan.v2.md`; `answer.md` (the answer) and `result.md` (the
answer plus the commentary) appear when the TUI copies them out.

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
| Ctrl+P | Settings — choose drafter/reviewer, switch mode |
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
| x | Result: the exact text diff and what each change was for, as a pane — neither fits below the fold |
| y | Result: copy the answer as Markdown — the writer's own text, into the clipboard, and to `answer.md` in the run directory |
| Y | Result: copy the whole result as Markdown, commentary included — to `result.md` as well |
| r | Result: revisit the gate — re-ask it with the recorded answers prefilled; if nothing moved, no model calls |
| Esc | Close a panel and return to the same question. At the gate, leave the run. On the result screen Esc does nothing — `q` is the key that quits (the run stays on disk — reopen it with Ctrl+R) |
| Ctrl+R | Start: past runs — open a finished or parked run |
| ↑↓ · q | Scroll the result; `q` quits |

The gate shows the review's state on every screen — counts, warnings, what was
refuted — and the three panels are how the human gets the context to decide
rather than deciding blind.

The first-run screen appears when the directory has no `.adv/`. Choose
"Initialise .adv/ here", or "Continue without it" (models then default to
`DEFAULT_CONFIG`). Models can always be changed afterwards with Ctrl+P.

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

The `opencode` provider is *not* the `opencode-go` subscription. Do not use it.

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
  clipboard.ts      copying the answer out: pbcopy/wl-copy, then OSC 52, then
                    the file path. Tested.
  models.ts         model list + family heuristic for the picker
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
- **In a pane, one element must be one row.** The result and gate panes scroll
  by line offset (`clampOffset`/`maxOffset` in `gate-model.ts`), so if a line is
  wider than the pane, Ink wraps it, the count stops matching what is on screen,
  and the scroll jumps. That is why `renderMarkdownLines` pre-wraps, why a long
  URL or code line is split rather than allowed to overflow, and why the section
  headers are re-fitted to the width. Any new line put into a pane has to go
  through the renderer or `fitLines`.
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
