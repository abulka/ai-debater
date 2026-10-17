# Prompt for a new session

Open a fresh OpenCode session **in this directory**
(`/Users/andy/Devel/ai/ai-debater`) and paste the block below.

---

We are building `adv`, a tool that runs a task through two different model
families — one drafts, the other adversarially verifies, a human decides the
taste calls at a gate, and a scoped rebuttal applies those decisions. It returns
a revised plan plus a changelog and a diff. Models verify; the human decides.

**Read these before doing anything:**
- `AGENTS.md` — the working rules. This is the most important file in the repo.
- `PLAN.md` — the design and the decisions behind it. §14 lists what is still
  open. It has uncommitted edits in the working tree; read it from disk.
- `spike/README.md` — findings from the feasibility spike, including four bugs
  that would have silently corrupted runs.

**Where we are.** M0 (spike), M1 (core loop) and the TUI are done. The CLI and
the Ink TUI both drive `src/pipeline.ts`, `bun run typecheck` is clean, and
`bun test` covers the gate mapping, the resume-model choice and the failed-state
write. Since the last handover:

- **The agent definitions are injected, not installed.** They live in
  `src/agents.ts` and travel in `OPENCODE_CONFIG_CONTENT` on every call: no files
  in the target repo, none in `~/.config/opencode`, no setup command. `adv`
  works in a directory that was never initialised. `templates/agents/*.md` and
  `adv init --global` are gone; `adv init` now only scaffolds `.adv/`.
- **Runs live in one user-level store** at
  `~/.local/share/adv/runs/<repo>-<hash>/<stamp>/` (honours `XDG_DATA_HOME`), for
  plan and answer mode alike. `adv decide`, `adv run --resume` and `adv status`
  take a bare run name. `fixtures/toy-repo/.adv/runs/` is a stale leftover from
  the old layout and can be deleted.
- A provider-rejected turn now gets **one stateless retry** with a corrective
  note, and the answer prompt no longer tells the drafter to browse.
- **The gate is readable.** `d` opens the draft a judgment call is about, `v`
  opens every verdict with its evidence, `e` opens a finding's cited file at the
  cited line. The review's state (counts, warnings, refuted) is on every gate
  screen rather than only the first. The progress log is sentences now
  ("reviewing — 12 claims sent to …", "rebutting — 1 refuted · 2 decisions",
  "in scope: V2 fix, J1 → in-process"), and the result leads with what the
  review actually caught.
- **Three silent bugs fixed.** `run --resume` uses the models recorded in
  `state.json` (a run started with `--drafter` no longer resumes with the config
  default); a failed step persists `state: "failed"` with the error; and the
  family check is displayed, with `familyCheck: "require"` / `--strict` to make
  it a hard stop for the trial and the eval.
- **The default pair is the trial pair** (`anthropic/claude-sonnet-5-5` →
  `opencode-go/gpt-6-luna`): cross-family, fast, and paid. Free test runs pass
  the groq pair by flag (see `AGENTS.md`). The old defaults were
  `deepseek-v4.1-flash` + `glm-5.3-flash`, which took 38.8s just to draft and
  blew a 120s cap in review.
- **URLs are checked deterministically.** A zero-width space inside a citation
  is invisible on screen and fatal when copied; a reviewer confirmed a plan
  containing one. `src/urls.ts` repairs invisible characters inside URL spans
  before the review, records the repair, and flags them in evidence.
- `PLAN.md` §6 and §9 were rewritten to match the above; §8 and §10 now describe
  `familyCheck` and the gate panels.

**Next task: M2 — evidence execution**, per `docs/M2-PLAN.md`. The M3 trial is
done: 30 claims, 29 confirmed, one real refutation (an overbroad claim about the
gate being the only human interaction), one genuine finding (the MCP disable was
missing from the slice), 12 decisions settled, 14 changes, $0.48, ~7 minutes.

Slice 1 has landed — the contract (`proposes` on `unverifiable`, `audit:<id>`
evidence, `AuditRecord`), the exact-argv matcher, and the executor (no shell,
timeout, output cap, scrubbed env, validated record) in `src/audit.ts`, with 30
tests. Nothing calls it yet.

The next slice, in the plan's §6 order:

1. a pipeline hook between `reviewed` and `validated` for Tier 1, writing
   `audit.json`;
2. merge audit outcomes into the gate and result views — an `audit:<id>` that
   does not resolve is an evidence defect;
3. `adv audit <run>` for Tier 2 — the Tier 2 list is empty on purpose, because
   the trial produced no `unverifiable` claims to build it from;
4. the MCP server-level disable (still open from the spike).

Settle with me before writing code:

- When a proposed check contradicts a claim mechanically, does that claim enter
  the rebuttal as refuted, or only after the human accepts it at the gate? (The
  plan settles it: only after acceptance. Confirm the recording mechanism.)
- Do we run Tier 1 checks *before* the gate (so the human sees outcomes) or only
  on request? The plan's §4.4 puts the hook between `reviewed` and `validated`.

**Landmines this repo has already been bitten by** (details in AGENTS.md):

- `OPENCODE_CONFIG_CONTENT` is only read when opencode starts its own server, so
  every `opencode run` here must pass `--standalone`. Strip it and every run dies
  with `Agent not found`.
- `opencode` resolves the project from `$PWD`, and `Bun.spawn({ cwd })` does not
  set it. Both `--standalone` and an explicit `PWD` are required.
- opencode's base policy is `allow *`. Deny `*` first: denying only
  `edit`/`shell` left the reviewer free to route around it with the Playwright
  MCP tools and open a real browser to download the file.
- There is no tool named `search`. gpt-oss invents it and the provider rejects
  the whole turn. `opencode debug agents` and `GET /api/agent` both list hidden
  agents, so neither is a test of visibility.

**How I want you to work — this is not negotiable:**

1. Do not run any full workflow without asking me first. `adv run`,
   `adv run --resume`, `adv decide`, and the spike's `roundtrip` and
   `permissions` checks all call models. Tell me what you plan to run and roughly
   how long, then wait.
2. Put an explicit timeout on every shell command. Cap anything that calls a
   model at 120 seconds. If it times out, report that — do not retry longer.
3. For testing use the fast pair: `groq/openai/gpt-oss-120b` as **drafter** and
   `groq/openai/gpt-oss-20b` as **reviewer**. The whole pipeline is ~16s. They
   are easy to swap by accident, and the 20b is a poor drafter — 3× slower, and
   it invents tool names. Do not use the `opencode` provider (separate account,
   no credit) or `mimo-v2.6-flash` (listed but dead).
4. Keep `bun run typecheck` and `bun test` passing, and leave nothing behind:
   `pgrep -f 'src/cli.ts'; pgrep -f 'ms-playwright-mcp/mcp-chrome';
   find . -name 'CANARY*' -not -path './node_modules/*'`.

**Start by** reading `AGENTS.md`, `PLAN.md` and `spike/README.md`, then giving me
a short summary of the current state and your proposed first step for the trial.
Do not write code or run anything until I agree with the plan.
