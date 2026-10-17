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
   quality: `groq/openai/gpt-oss-120b` (drafter) + `groq/openai/gpt-oss-20b`
   (reviewer). The whole pipeline runs in **~16s**. The toy repo
   (`fixtures/toy-repo/.adv/config.json`) is already configured this way.

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

The technique is specified in
`Adversarial LLM Review Problem, Technique and Script Spec.md`; the design and
decisions are in `PLAN.md`; M0's findings are in `spike/README.md`.

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
| M3 real trial | **next** |
| M2 evidence execution | after the trial — its scope comes from the trial's `unverifiable` bucket |
| M4 revise | not started |

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
adv run "<task>" --dir <repo> [--no-gate] [--general] [--strict]
adv decide [<run>]
adv run --resume [<run>]
adv status [<run>]

# spike
bun run spike/m0.ts endpoints permissions artifacts   # cheap, no model calls for endpoints
```

`--general` (or Tab in the TUI) switches to answer mode: a general question, no
repository assumed, facts checked against URLs. Nothing is installed and nothing
is written into the directory you started in — answer mode works immediately,
and `adv init` is only needed if you want criteria and settled decisions.

Run artifacts go to `~/.local/share/adv/runs/<repo-name>-<hash>/<timestamp>/`,
for both modes. `adv decide`/`run --resume`/`status` take a bare run name.

### TUI keys

| Key | Action |
| --- | --- |
| Ctrl+P | Settings — choose drafter/reviewer, switch mode |
| Tab | Toggle plan / answer mode |
| Enter | Run the typed task |
| ↑↓ Enter | Answer the gate |
| l | Gate: leave a judgment call open (a real disposition, not a skip) |
| d | Gate: open the draft the current call is about, scrollable |
| v | Gate: open every verdict with its evidence |
| e | Gate: open the cited file at the cited line (findings only) |
| Esc | Close a panel and return to the same question |
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
| `groq/openai/gpt-oss-120b` + `-20b` | **use for testing** — whole pipeline in ~16s |
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
  prompts.ts        plan/answer prompts; one deliverable per call
  orchestrator.ts   run dirs, state machine, decisions.md
  gate.ts           the CLI gate (interactive or piped)
  diff.ts           unified diff + changelog cross-check (a heuristic)
  render.ts         plan + changelog + diff + open decisions
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
- The diff check is a **heuristic** (hunk count vs changelog entries). It flags
  possible out-of-scope edits; it cannot prove one, and a legitimately unclaimed
  consequence of a decision will be flagged as readily as a real edit.

---

## Next task

**M3 — the real trial, before M2.** One genuinely uncertain plan in a real repo,
a different-family pair, `familyCheck: "require"`, with outcome and cost
recorded.

The order matters: M2's value proposition is shrinking the `unverifiable`
bucket, so building it first would confound cross-family review with command
evidence. Let the trial's own `unverifiable` bucket write M2's spec.

Before the trial:

- pick the pair with a 10-second probe — PLAN's original anthropic/openai pair if
  the account has credit, otherwise a deepseek drafter with a strong (not 20B)
  reviewer;
- set `familyCheck: "require"` in that repo's `.adv/config.json` (or pass
  `--strict`), so the run cannot silently measure an extra pass instead of
  cross-family review;
- run it through the TUI: the gate panels are what make the catch — or its
  absence — visible enough to judge.

M2 then keeps its valuable core: approval-based execution of cited evidence,
`audit.json`, and the MCP server-level disable. Its allowlist comes from what
the trial actually returned `unverifiable`.

Before anything that calls a model, ask the human.
