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
| M2 evidence execution | **next** |
| M3 real trial | not started |
| M4 revise | not started |

Typecheck must stay clean: `bun run typecheck`.

---

## How to run

```sh
bun install
bun run typecheck              # must pass

bun link                       # once: puts `adv` on PATH
adv                            # TUI for the current directory
adv --dir /path/to/repo        # TUI for another repo

# CLI (scriptable)
adv init --dir <repo>
adv run "<task>" --dir <repo> [--no-gate] [--general]
adv decide [<run>]
adv run --resume [<run>]
adv status [<run>]

# spike
bun run spike/m0.ts endpoints permissions artifacts   # cheap, no model calls for endpoints
```

`--general` (or Tab in the TUI) switches to answer mode: a general question, no
repository assumed, facts checked against URLs.

### TUI keys

| Key | Action |
| --- | --- |
| Ctrl+P | Settings — choose drafter/reviewer, switch mode |
| Tab | Toggle plan / answer mode |
| Enter | Run the typed task |
| ↑↓ Enter | Answer the gate |
| ↑↓ · q | Scroll the result |

The first-run screen appears when the directory has no `.adv/`. Choose
"Initialise .adv/ here", or "Continue without it" (models then default to
`DEFAULT_CONFIG`). Models can always be changed afterwards with Ctrl+P.

---

## Models — verified 17 Oct 2026

| Model | Verdict |
| --- | --- |
| `groq/openai/gpt-oss-120b` + `-20b` | **use for testing** — whole pipeline in ~16s |
| `opencode-go/deepseek-v4.1-flash` | works, ~86s per agent step |
| `opencode-go/glm-5.3-flash` | works, ~130s per agent step |
| `opencode-go/qwen3.8-flash` | 7.6s for a plain reply, slow with tool use |
| `opencode-go/mimo-v2.6-flash` | **dead** — `model_coming_soon` |
| `opencode-go/muse-spark-1.3-contributor` | **blocked** — trains on request data; the workspace privacy opt-in is not in the desktop app |
| `opencode/*` (incl. `big-pickle`, `muse-spark-1.3`) | **no credit** — separate account, `402` |

The `opencode` provider is *not* the `opencode-go` subscription. Do not use it.

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
  tui.tsx           Ink/React TUI: setup, start, settings, pick, gate, result
  pipeline.ts       the shared sequence — both front ends drive this
  runners/
    opencode-run.ts spawns `opencode run`; validate-with-retry; usage
  contracts.ts      zod schemas (claims, review, changelog, gate, state)
  prompts.ts        plan/answer prompts; one deliverable per call
  orchestrator.ts   run dirs, state machine, decisions.md
  gate.ts           the CLI gate (interactive or piped)
  diff.ts           unified diff + changelog cross-check (a heuristic)
  render.ts         plan + changelog + diff + open decisions
  models.ts         model list + family heuristic for the picker
  init.ts           `adv init` scaffolding
templates/agents/   adv-drafter.md, adv-reviewer.md, adv-writer.md
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
- **Each call asks for one thing** — prose, or one JSON block. Merging them is
  where models get flaky.
- The diff check is a **heuristic** (hunk count vs changelog entries). It flags
  possible out-of-scope edits; it cannot prove one.

---

## Next task

**M2 — evidence execution.** Re-run reviewer evidence commands behind an approval
prompt (reusing OpenCode's ask flow), write `audit.json`, re-audit `plan.v2` for
regressions in previously confirmed claims, and disable MCP servers at the server
level as a second line of defence.

Open questions to resolve first:

- Which commands belong on the evidence allowlist?
- Is one rebuttal round enough, or is a correctness-critical adaptive second pass
  needed?
- Which model pairing for the M3 trial (must be different families)?

Before starting M2, ask the human whether to run anything that calls a model.
