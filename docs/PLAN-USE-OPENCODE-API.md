# Using OpenCode's API instead of spawning `opencode run`

> **Status.** Proposed 19 Oct 2026. **Not started, not scheduled.** Every claim
> in §3 is a probe against a live `opencode` v2.0.32 on 18–19 Oct 2026, and the
> probe commands are in §11 so they can be re-run. The API surface the design
> depends on is documented **experimental** (§6), so treat §3 as dated
> observations, not guarantees — the same rule `AGENTS.md` applies to the model
> table.

## 1. The question

`adv` calls OpenCode by spawning the CLI. Every model call is a new
`opencode run --standalone --format json …` process, whose stdout `adv` parses
as NDJSON. OpenCode also exposes a long-running server and an HTTP API, with a
generated TypeScript client. Is the API a better way to make those calls?

The narrower question underneath it: **is this worth doing at all**, given that
it changes nothing a user sees?

## 2. What `adv` does today

`src/runners/opencode-run.ts` spawns the CLI for each of the five calls in a run
(draft-plan, claims, review, rebut-plan, changelog). Around that spawn sit
several workarounds, each of which is documented in `AGENTS.md` because it bit
someone:

| Workaround | Why it exists |
| --- | --- |
| `PWD` set by hand | `opencode` resolves the project from `$PWD`, and `Bun.spawn({ cwd })` does not update it |
| `--standalone` on every call | `OPENCODE_CONFIG_CONTENT` is only read when OpenCode starts its own server |
| `OPENCODE_CONFIG_CONTENT` | the five agents are injected, not installed (see `src/agents.ts`) |
| an `Agent not found` error path | the symptom of the two above going wrong |
| `parseNdjson` + a `lastMessageID` heuristic | the reply is a hand-modelled event stream, not a typed result |
| `step-finish` scraping for tokens and cost | the only place usage appears |
| a process timer and `proc.kill()` | there is no other way to stop a call |
| a tmpdir for answer mode | OpenCode loads `AGENTS.md` from the working directory |

`src/runner.ts` already defines a `Runner` interface, and `src/pipeline.ts`
constructs `new OpencodeRunRunner(...)` in exactly two places (lines 129 and
305). The seam exists.

## 3. What the API offers — probe results

Probed against `opencode` v2.0.32, service already running at
`http://127.0.0.1:49374`.

**Agent registration does not exist over HTTP.** `GET /api/agent` on the shared
server returns `build`, `general`, `explore`, `compaction`, `title`, `summary`,
`plan` — no `adv-*`. The API has `GET /api/agent` and `GET /api/agent/{id}` and
no route to register one; that is plugin-only (`ctx.agent.transform`). This was
expected, and it was the presumed blocker.

**Session-scoped instruction entries clear the blocker.** `PUT
/api/experimental/session/{id}/instructions/entries/{key}` with
`{"value": "…"}` reaches the model's instructions. A probe set the instruction
"you must end every reply with the exact token ZQPROBE" and asked for the single
word `hello`; the reply was `hello ZQPROBE`. So each agent's `system` string can
be carried **per session** — no config injection, no `--standalone`, no private
service, no plugin, and nothing installed into anyone's directories.

**Session-scoped permissions work, and are enforced by removing tools.** A
session was created as `build` — an agent that can normally edit — with
`permissions` set to exactly the `READ_ONLY` array `src/agents.ts` already
defines (`deny *`, then `allow read/glob/grep`). Asked to create a file, the
agent reported it had "no file-writing tool in this session (only read, grep,
and glob)", and the file did not exist afterwards. Note this is *tool removal*,
not a permission prompt — stronger than an `ask` that something must answer.

**`location.directory` is a per-session request parameter.** The probe read a
`README.md` from a scratch directory passed as `{ location: { directory } }`.

**Cost and tokens are typed and real.** The assistant message carries
`cost` and `tokens { input, output, reasoning, cache { read, write } }`, and the
session carries an aggregate `cost`/`tokens` plus an `outcome`
(`succeeded`).

**The gateway reports cost over the API.** `openrouter/openai/gpt-6-luna` — the
reviewer in the trial pair — returned `cost: 0.00075105`. The CLI path is the
reason `Usage.costKnown` exists and `AGENTS.md` says a gateway "leaves this
false". Over the API it is reported. See §6.

**The model catalogue is identical.** `GET /api/model` returned 651 models; the
set difference against `opencode models` is empty in both directions. The API
entries are richer (`enabled`, `status`, `capabilities`, `compatibility`,
`family`, tiered `cost`), but they add **no availability signal** — which is the
whole point of `docs/OPENCODE-MODELS.md`.

**A ref with a slash in its id splits on the first slash only.**
`openrouter/openai/gpt-6-luna` → `{ providerID: "openrouter", id:
"openai/gpt-6-luna" }`. That is what `providerOf` in `src/models.ts` already
does, and the probe exercises it.

**Message order in the response is not chronological.** The first probe returned
the `finish: "stop"` message *before* the `finish: "tool-calls"` one. The
current CLI path takes the last message by stream order; over the API the text
must be selected by sorting on `time.created`, or the wrong turn is returned.

**Two smaller observations.** The server fills `variant: "default"` on the model
ref when it is omitted, and `/api/model` cost tiers are ragged (536 entries with
1 tier, 109 with 2, 2 with 3, and 4 with **no** cost at all — the `?` state
`AGENTS.md` insists on preserving).

## 4. What the swap buys

Maintainability, almost entirely. The workarounds in §2 are retired rather than
documented better.

Two of them are more than cosmetic:

- **Drift becomes a typecheck failure.** `@opencode/client`'s types are
  generated from the same contract as the API reference. Today a change to
  `--format json` is a silent behaviour change in a hand-modelled
  `RunEvent`. The repo already runs on "typecheck must stay clean", so this fits
  the grain.
- **Cost is actually reported** for the gateway, which improves the per-step
  accounting the CLI and TUI both display.

A third, unmeasured: `--standalone` starts a server per call, so the API should
also be faster on wall-clock. **This was not measured and is not claimed.** §8
proposes the measurement.

## 5. What it does not buy

**Nothing a user sees.** The gate, the run store, the state machine, the diff
and the changelog are untouched — that is the point of keeping `adv` a separate
tool, and it is also the reason to be suspicious of the effort. It is a rewrite
of the plumbing that leaves the product identical.

**It does not help the model-reliability work.** `probe.ts`, `catalogue.ts` and
`providers.ts` landed 18 Oct and are orthogonal. `GET /api/model` returning the
same 651 models means the API adds no availability signal, so the ping remains
the only trustworthy check. Do not fold "use the API" into that work; it would be
a distraction dressed up as cleanup.

## 6. The honest case against

- **Every route this needs is under `/api/experimental/`** — `generate`,
  `instructions/entries`, `wait`, `event`. The docs' own header says
  "Experimental HttpApi surface". This is the largest single risk, bigger than
  everything the swap removes.
- **The ping's classification is untested over the API, and this is the
  deciding unknown.** `src/probe.ts` deliberately runs through
  `OpencodeRunRunner.call()` — the same path a real run uses — so that a passing
  ping predicts a working run. If the runner moves, the ping must move with it,
  and `classify` folds `model_not_found` and `provider.no-route` into
  `no-access`. **What a failure looks like over the API was never probed.** If
  those strings do not survive, the tool's only availability oracle regresses in
  exchange for a refactor with no feature gain. §8 is the probe that settles it.
- **A new daemon dependency.** `adv` would depend on a background server it does
  not own. `Service.discover()` finds a healthy one without starting a process;
  `Service.ensure()` starts one if needed, and may leave it running. That choice
  is a policy decision with side effects on the user's machine, and it echoes the
  existing worry about two programs writing `model.json`.
- **`costKnown` changes meaning.** It is derived from
  `step-finish.part.cost !== undefined`, it is tested, and it has an `AGENTS.md`
  rule ("`$0` is an absence, not a number"). Over the API the field is always
  present and, for the gateway, real. The distinction must be preserved
  defensively — an unreported cost must still read as absent — and the rule
  revisited.
- **The message-order trap** in §3. `lastMessageID` must become a sort on
  `time.created`, or a run silently uses the wrong turn.
- **Layering on the chosen agent's persona is unverified.** The instruction
  entry is *additive* to the agent's own system prompt, not a replacement. The
  read-only probe behaved correctly on top of `build`, but whether the
  reviewer's "never propose an alternative plan" discipline survives layering on
  a coding-agent persona is an empirical question — one A/B run, not a blocker.
- **The current path works.** Every hack in §2 was empirically debugged by
  someone getting bitten. Trading known-ugly for unknown-experimental is only a
  good trade if it can be walked back.

## 7. The design, if it is done

One new `Runner`, behind the existing seam, with the CLI runner kept as a
fallback:

1. `POST /api/session` with `{ location: { directory }, agent, model,
   permissions }` — `permissions` is the `READ_ONLY` array from `src/agents.ts`
   verbatim, since `Permission.Rule` is already `{ action, resource, effect }`.
2. `PUT /api/experimental/session/{id}/instructions/entries/{key}` with the
   agent's `system` text.
3. `POST /api/session/{id}/prompt`.
4. `POST /api/experimental/session/{id}/wait` (the 180s per-call timeout becomes
   an `AbortSignal` here).
5. `GET /api/session/{id}/message`, selecting the last assistant message by
   `time.created`, reading `content[type == "text"]` for the reply and
   `cost`/`tokens` for usage.
6. `DELETE /api/session/{id}`.

The two no-tool steps (claims, changelog) can instead use
`POST /api/experimental/generate { prompt, model }`, which creates no session and
invokes no tools. **Caveat:** `GenerateTextResponse` is `{ text }` only, so those
steps would report "cost not reported". Routing them through a session keeps the
accounting.

`src/agents.ts` shrinks to `{ system, permissions }` data: `agentsConfigJson()`,
the `OPENCODE_CONFIG_CONTENT` merge and the `--standalone` requirement all
retire.

## 8. The two probes that would settle it

Neither has been run. Both spend a model call.

1. **Failure shapes over the API** *(deciding)*. Create a session with a known-dead
   model (`opencode-go/mimo-v2.6-flash` → `model_coming_soon`, or a Groq model
   from the `model_not_found` set in `AGENTS.md`) and check whether the error
   reaches the client in a form `classify` can still read. If it does not, the
   ping regresses, and the answer becomes **no**.
2. **Timing.** One `opencode run --standalone` call versus one API call on the
   same model, to put a number on the §4 speed claim.

## 9. Verdict

**Worth doing as a maintenance refactor, behind the `Runner` seam, with the CLI
runner kept as a fallback — not as a big-bang replacement.** Land it
incrementally so the tool always works, and treat the CLI path as the fallback
until the API path has run real trials.

**Not worth doing at all if** the §8.1 failure-shape probe fails, or if it would
have to be finished before the tool worked again. The current path is ugly and
working; the API path is clean and experimental.

## 10. Files this would touch

| File | Change |
| --- | --- |
| `src/runners/opencode-client.ts` | **new** — the API `Runner` |
| `src/pipeline.ts` | one `makeRunner()` factory replacing the two `new OpencodeRunRunner` sites (129, 305) — a small cleanup either way |
| `src/agents.ts` | shrinks to `{ system, permissions }` data |
| `src/probe.ts` | the ping's call site moves with the runner, and its `classify` must be revalidated against §8.1 |
| `src/runners/opencode-run.ts` | kept, as the fallback |
| `spike/m0.ts` | unchanged — it is the M0 record and uses `parseNdjson` directly |
| `src/models.ts`, `providers.ts`, `catalogue.ts` | unchanged |

`src/runner.ts` needs no change: the interface is already the seam.

`AGENTS.md` bullets that would need rewriting: "`opencode` resolves the project
from `$PWD`", "each `--standalone` run has its own session store", "the three
`adv` agents are injected", "OpenCode's base policy is `allow *`" (now session
permissions), and the `$0`-is-an-absence rule (see §6).

## 11. The probes, reproduced

```sh
opencode --version                      # v2.0.32
opencode service status                 # http://127.0.0.1:49374
opencode api get /api/agent             # no adv-* agents
opencode api get /api/model > /tmp/models.json   # 651, == `opencode models`
opencode api post /api/session --data '{
  "agent": "build",
  "model": {"providerID":"anthropic","id":"claude-haiku-5-5"},
  "location": {"directory":"/tmp/scratch"},
  "permissions": [
    {"action":"*","resource":"*","effect":"deny"},
    {"action":"read","resource":"*","effect":"allow"}
  ]}'
opencode api put /api/experimental/session/<id>/instructions/entries/probe \
  --data '{"value":"end every reply with ZQPROBE"}'
opencode api post /api/session/<id>/prompt --data '{"text":"Reply: hello."}'
opencode api post /api/experimental/session/<id>/wait
opencode api get  /api/session/<id>/message
opencode api delete /api/session/<id>
```

**One gotcha for whoever re-runs these:** piping `opencode api get /api/model`
truncates the response at 256 KiB. Redirect to a file instead — the full body is
504013 bytes.

Sessions created by these probes were deleted, and the scratch directory was
removed.
