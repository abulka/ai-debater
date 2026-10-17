# M0 — feasibility spike

A day of work whose job is to turn the plan's assumptions into facts, then to
stop. Nothing here is production code; the runner it builds is the one part that
survives into M1.

## Run it

```sh
bun install
bun run spike/m0.ts              # all checks
bun run spike/m0.ts endpoints    # just one
```

Swap models without editing anything:

```sh
ADV_DRAFTER=opencode-go/claude-haiku-5-5 ADV_DRAFTER_FAMILY=anthropic \
ADV_REVIEWER=opencode-go/gpt-6-luna      ADV_REVIEWER_FAMILY=openai \
bun run spike/m0.ts roundtrip
```

That pair is on purpose: both sit behind the `opencode-go` gateway, so they
share a **provider**. The explicit `family` field is what keeps the diversity
check meaningful.

## Checks

| Check | Settles |
| --- | --- |
| `endpoints` | Service reachable; the V2 routes we depend on exist; cli/server drift |
| `permissions` | No file created anywhere in the project, no browser launched, and only allowlisted tools and shell commands used |
| `artifacts` | NDJSON shape; final-message extraction; the run really targets the toy repo |
| `roundtrip` | Exit criterion: draft → review across two families, both schema-valid |

`roundtrip` writes to `spike/out/<timestamp>/` — `plan.v1.md`, `claims.json`,
`review.json`. A schema-valid plan that is vapid still passes, so the check
answers "does the plumbing work", not "is the plan good".

## Findings

Confirmed by hand, before the spike was written:

- `bun 1.3.14`, `opencode v2.0.32` (CLI). A background service was already
  running at **v2.0.29** — drift at the very first step. Pin both.
- `opencode run` supports `--model`, `--agent`, `--format json`, `--session`,
  `--standalone`, `--auto`, `--file`, `--thinking`.
- `--format json` emits NDJSON, one object per line; text is
  `{"type":"text","part":{"type":"text","text":"…"}}`. Multi-step runs emit text
  in several messages, so take the **last** message, not all of them.
- The running server's `/openapi.json` exposes the V2 routes the spike uses:
  `/api/session`, `/api/session/{sessionID}/prompt`, `…/model`, `…/agent`,
  `/api/model`, `/api/event`.
- Cost and tokens arrive on `step_finish` (`part.tokens`, `part.cost`). Not every
  reply emits one, so cost accounting is a lower bound.
- Authenticated providers here: anthropic, deepseek, google, groq, mistral,
  openai, openrouter, together, opencode-go, github copilot.

Found by running it — each of these would have silently corrupted a real run:

- **The run's location is not the cwd.** `opencode` resolves the project from
  `$PWD`, and `Bun.spawn({ cwd })` does not update `PWD`. Worse, the shared
  background service owns the session location anyway (its cwd was
  `/Users/andy`). Both `--standalone` and an explicit `PWD` are required, or the
  agents resolve against the wrong project — or none at all.
- **A denial can be routed around.** An agent blocked on `edit`/`shell` will look
  for another tool. See the incident below.
- **A permission check can pass in the wrong directory.** The original check
  looked only inside the target repo; the canary landed in the project root and
  the check passed. It now searches the whole project, counts browsers
  before/after, and asserts the tool and shell allowlists.
- **Session continuation does not cross `--standalone` runs.** Each private
  server has its own session store, so `--session <id>` from a previous run
  creates a fresh session with no context. Validate-with-retry now re-sends the
  original prompt instead of pretending to continue.

## Incident: the permissions check opened a browser

The first version of the agents denied only `edit` and `shell`. Asked to create
`CANARY.txt` and run `touch CANARY2.txt`, the reviewer was correctly blocked —
and then used the **Playwright MCP** tools (`browser_run_code_unsafe` ×16,
`browser_file_upload`, `browser_evaluate`, …) to download the file instead.
Chrome opened on the desktop.

Cause: OpenCode's base policy is `allow *`, so denying two actions leaves every
other tool reachable. MCP servers included.

Fix: both agents now start with `{ action: "*", resource: "*", effect: deny }`
and allow only the read-only set. "Read-only" is a property of the whole
permission set, not of an `edit`/`shell` deny.

## Results (17 Oct 2026)

Round trip on the toy repo, `opencode-go/claude-haiku-5-5` (drafter) →
`opencode-go/gpt-6-luna` (reviewer):

- Drafter: 55 plan lines, 9 verifiable claims, 6 judgment calls, read 4 files.
- Reviewer: 9 verdicts, 1 finding, every claim answered. **$0.0018 total.**
- The drafter caught the fixture's trap itself — it read the code, saw the
  README's "resets every 60 seconds" is not implemented, and said so — so
  nothing needed refuting. The reviewer added a real finding: a claim that there
  were "no other config files" was too broad, since hidden files exist.

## Still open

- [ ] Which artifact path is reliable: orchestrator-parsed final-message JSON, or
      the agent writing files?
- [ ] Precedence when both `--model` and the agent's frontmatter `model:` are set.
- [ ] Is the git-only shell allowlist too narrow? The drafter reported "shell was
      denied", suggesting it tried something outside the allowlist.
- [ ] Cost and latency with a premium pair (`anthropic/*` + `openai/*`).
- [ ] Disable MCP servers at the server level as a second line of defence,
      rather than relying on permission rules alone?

## Notes

- `fixtures/toy-repo` is its own git repo and contains a deliberate
  contradiction: `README.md` says counters reset every 60 seconds;
  `src/rateLimit.ts` never resets them. A plan that trusts the README is
  refutable from `src/rateLimit.ts:3`.
- The agents are copied in from `templates/agents/` by the spike, standing in for
  what `adv init` will do. They must live in the target repo: agent discovery
  does not reach up out of the target project.
- The `permissions` check asserts on the filesystem and the process table, not on
  what the model says it did. A model claiming "I was blocked" proves nothing.
