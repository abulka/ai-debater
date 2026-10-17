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
- `PLAN.md` — the design and the decisions behind it.
- `spike/README.md` — findings from the feasibility spike, including four bugs
  that would have silently corrupted runs.

**Where we are.** M0 (spike) and M1 (core loop) are done, plus the TUI, which was
pulled forward from M4. There is a working `adv` CLI and an Ink TUI, both driven
by a shared `src/pipeline.ts`. `bun run typecheck` is clean.

**Next task: M2 — evidence execution.** Re-run the reviewer's cited evidence
commands behind an approval prompt (reusing OpenCode's ask flow), write
`audit.json`, re-audit `plan.v2` for regressions in claims that were previously
confirmed, and consider disabling MCP servers at the server level.

**How I want you to work — this is not negotiable:**

1. Do not run any full workflow without asking me first. `adv run`,
   `adv run --resume`, `adv decide`, and the spike's `roundtrip` check all call
   models and can take minutes. Tell me what you plan to run and roughly how
   long, then wait.
2. Put an explicit timeout on every shell command. Cap anything that calls a
   model at 120 seconds. If it times out, report that — do not just retry longer.
3. For testing, use the fast pair already configured in
   `fixtures/toy-repo/.adv/config.json`: `groq/openai/gpt-oss-120b` as drafter and
   `groq/openai/gpt-oss-20b` as reviewer. That runs the whole pipeline in about
   16 seconds. Do not use the `opencode` provider (no credit) and do not use
   `mimo-v2.6-flash` (listed but dead).
4. Keep `bun run typecheck` passing, and do not leave stray processes or files
   behind.

**Start by** reading `AGENTS.md`, `PLAN.md` and `spike/README.md`, then giving me
a short summary of the current state and your proposed first step for M2.
Do not write code or run anything until I agree with the plan.
