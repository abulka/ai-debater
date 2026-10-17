# PLAN: `adv` — adversarial two-model plan review

*Draft, 17 October 2026 (revision 2). Build target: OpenCode V2, TypeScript on Bun.*

This is the build plan for a tool that runs a task through two different LLM
families, has one adversarially verify the other's plan, and **aims to** return
a better plan than a single pass would. That claim is a hypothesis, not a
premise — §12 defines how it gets tested. The technique is defined in
`Adversarial LLM Review Problem, Technique and Script Spec.md`; this document is
the implementation plan. Where the two disagree, the locked decisions below win.

---

## 0. Status

| Milestone | State |
| --- | --- |
| M0 feasibility spike | **done** — see `spike/README.md` |
| M1 core loop | **done** — `adv init`, `run`, `decide`, `run --resume` |
| TUI | **done early** (was M4) — bare `adv`; settings and model picker on Ctrl+P |
| M2 evidence execution | **next** |
| M3 real trial | not started |
| M4 revise | not started |

Working rules for anyone picking this up — especially "do not run a full
workflow without asking first" — are in `AGENTS.md`.

---

## 1. What it is

A single command that behaves like today's one-prompt flow, but behind it:

- drafts a plan with model A,
- verifies it with model B from a different family,
- pauses once for the human to make the taste calls (and to triage findings),
- revises the plan to apply the human's decisions, and
- returns the revised plan plus a short appendix and a proved changelog.

No churn. The reviewer does not rewrite the plan, the models never resolve
judgment calls, and there is no round three by default. The human decides; the
models verify.

**Non-goals.** Not a debate engine, not a multi-agent framework, not a
replacement for tests, and not a code-writing tool. v1 produces plans and never
edits the repo.

---

## 2. Locked decisions

| Area | Decision |
| --- | --- |
| Language / runtime | TypeScript on Bun |
| Invocation (v1) | `adv` CLI only, with a library seam for the future UI |
| Criteria input | Optional sticky `.adv/criteria.md`, auto-detected; overridable by flag |
| Model choice | `.adv/config.json` defaults + explicit `family` check; flags override |
| Pipeline | draft → review → validate → **gate** → rebuttal → diff/output |
| Human gate | Resumable commands: `adv run`, `adv decide <run>`, `adv run --resume <run>` |
| Rebuttal scope | Refuted claims + human-accepted findings + human decisions. Nothing else. |
| Evidence (v1) | `file:line` or URL only. No command output, no execution. |
| Artifacts | Orchestrator writes them by default; agents return JSON in their final message and need no write permission. M0 confirms. |
| Diff check | In M1, not M2. Changelog keyed to item IDs shown beside the diff. |
| Output | `plan.v2` + appendix + changelog; artifacts in the run dir |
| Scope | Plans only; v1 never edits the repo |
| Rounds | One review round by default |

---

## 3. User experience

The user does what they do today — states a task — with one optional sticky file.

```
$ adv init                     # once per repo: scaffold .adv/
$ adv run "Add rate limiting to the public API"
  drafting…… ok (12s)
  reviewing…… 4 verdicts, 1 finding (9s)
  validating……
  ── gate ─────────────────────────────────────────────
  2 judgment calls need you:
   J1  Where to store the counters
       in-process:   no new deps, resets on restart
       redis:        survives restarts, new dependency
   J2  Limit scope
       global:       simple, coarse
       per-key:      fairer, more state
  refuted: V2 (offset math), V4 (header name)
  finding: E1 (no retry path for 429) [accept/dismiss]
  → run `adv decide <run>` to answer, then `adv run --resume <run>`
```

```
$ adv decide .adv/runs/2026-10-17T10-22
$ adv run --resume .adv/runs/2026-10-17T10-22
  rebutting…… ok (7s)
  ── plan.v2 ──────────────────────────────────────────
  <the plan, now reflecting J1 -> in-process, J2 -> per-key>
  ── changes ──────────────────────────────────────────
  V2  fixed     offset math corrected
  V4  rebutted  header name already correct in v1 (evidence: src/http.ts:88)
  E1  applied   retry path added
  J1  applied   counters in-process
  J2  applied   per-key scope
  (3 hunks not attributable to an item -> none)
  ── appendix ─────────────────────────────────────────
  still unverified: V7 (no file or URL evidence)
  open decisions:   none
```

Simplicity here means **few fields before you start**, not zero interaction.
The run is one command; the gate is one screen.

`--no-gate` never resolves judgment calls. It runs without the stop, and
unresolved calls are listed as **open items** in the output; the plan presents
their options rather than picking one. Resolving them later is a future
`adv revise` command, not v1.

---

## 4. Pipeline

States persisted in the run dir so the flow is resumable:
`drafted → reviewed → validated → gated → rebutted → done` (or `failed`).

1. **Resolve.** Load config, verify criteria/decisions files, resolve the two
   models, and fail fast if their `family` values match.
2. **Draft** — model A. Prompt = task + `criteria.md` + `decisions.md`
   (marked *settled, do not reopen*) + instruction to sort output into
   verifiable claims and judgment calls. Returns `plan.v1` + `claims` JSON.
3. **Review** — model B, fresh session, **not** given A's reasoning. Prompt =
   `plan.v1` + `claims` + `criteria.md` + format rules. Verifies each claim,
   adds unlisted findings, must not propose an alternative plan.
4. **Validate.** Schema-check `claims` and `review`. One retry with the
   validation error; a second failure stops the run and shows raw output.
   v1 executes nothing and rejects command-like evidence (see §7).
5. **Gate.** Show each judgment call with options and trade-offs, each refuted
   claim, and each extra finding. The human: answers judgment calls, and
   accepts or dismisses findings. Recorded to `decisions.md` and `gate.json`.
   Nothing here is resolved by a model.
6. **Rebuttal** — model A. Input is exactly: refuted claims, accepted findings,
   and the human's decisions — nothing else. It fixes or rebuts each with
   evidence, applies each decision, changes nothing else, and returns a
   changelog keyed to item IDs.
7. **Diff and output.** Unified diff `plan.v1 → plan.v2`, cross-referenced
   against the changelog so every hunk maps to an item ID. Unattributable
   changes are reported as out-of-scope edits. Emit plan + changelog + appendix.

The changelog + diff pair is what makes the silent-edit failure mode visible,
and it is why the diff check moves into M1: it is pure text processing and
needs no execution.

---

## 5. Architecture

```
adv (CLI: parse args, drive the state machine, render output)
  ├── Orchestrator      state machine + run-dir I/O (pure code)
  ├── Runner (seam)     the only thing that talks to models
  ├── Contracts         zod schemas + validate-with-retry
  ├── Gate              interactive prompts -> decisions.md + gate.json
  └── Render            plan + changelog + diff + appendix
```

### Runner seam

```ts
export interface Runner {
  draft(input: DraftInput): Promise<{ plan: string; claims: Claims }>
  review(input: ReviewInput): Promise<Review>
  rebut(input: RebutInput): Promise<{ plan: string; changelog: Changelog }>
}
```

**Build one in M0: `OpencodeRunRunner`** (shells out to
`opencode run --model <M>` per step; per-run model selection comes free; least
API surface). Keep `ClientRunner` (`@opencode/client`: sessions, per-session
model switch, `GET /api/event`) as a seam only — deferred until the UI needs it.
M0 picks and pins the runner; nothing else may import an implementation.

Two things this runner must do, learned in M0 and easy to get wrong:

- Pass `--standalone`. The shared background service owns the session location,
  and its cwd has nothing to do with the target repo. Without a private server,
  the agents resolve against the wrong project — or fail to find the agents.
- Set `PWD` in the child environment. `opencode` resolves the project from
  `$PWD`, and `Bun.spawn({ cwd })` does not update it.

Validate-with-retry must **re-send the original prompt**, not continue the
session: each `--standalone` run has its own session store, so `--session` from
a prior run would resume nothing.

### Who writes the artifacts

**Settled in M1: the orchestrator writes every artifact.** Agents return
`claims` / `review` / `changelog` as JSON in their final message; the
orchestrator parses, validates, and writes every file. Both agents are therefore
fully read-only, and there is no path by which the reviewer could overwrite
`plan.v1` or `claims`. The M0 open question about agents writing their own files
is closed — the final-message path is what ran, repeatedly.

Each agent call asks for **one** thing: prose, or a single JSON block. The draft
is two calls (plan, then claims); the rebuttal is two calls (revised plan, then
changelog). Asking for prose and JSON in one reply is where models get flaky —
in testing a drafter wrote a good plan and omitted the claims block twice.

---

## 6. Agents and permissions

The three definitions live in `src/agents.ts` and are **injected** into each
`opencode run` through `OPENCODE_CONFIG_CONTENT`, not installed as files. There
is no `model:` per agent — the corpus passes `--model` per call.

Injection replaced file-based agents because files have to be installed before
the first run, into the target repo or the global config directory; otherwise
`opencode` fails with `Agent not found`. That meant `adv` did not work until the
human ran a setup command, and in answer mode it meant writing into whatever
directory they happened to be standing in. Injection removes the step, the
failure and the writes. It merges with the user's own configuration rather than
replacing it, so their providers, MCP servers and credentials still apply.

The catch, and the reason the runner always passes `--standalone`:
`OPENCODE_CONFIG_CONTENT` is only read when `opencode` starts its own server. A
run against the shared background service never sees it.

Default posture for both read-only agents: **deny-by-default, then allow only
what is needed.**

```jsonc
// src/agents.ts — the reviewer's posture
{ action: "*",        resource: "*", effect: "deny" },   // must come first
{ action: "read",     resource: "*", effect: "allow" },
{ action: "glob",     resource: "*", effect: "allow" },
{ action: "grep",     resource: "*", effect: "allow" },
{ action: "webfetch", resource: "*", effect: "allow" },
```

The leading `*` deny is load-bearing. OpenCode's base policy is `allow *`, so
listing only `edit`/`shell` denies leaves **every other tool reachable** —
including MCP servers. Denying `edit` and `shell` alone does not make an agent
read-only.

This was learned the hard way: the first version of these agents denied only
`edit` and `shell`. In the M0 permissions check, the reviewer — asked to create
a file — was correctly blocked, then routed around the block using the
Playwright MCP tools (`browser_run_code_unsafe` among them) and opened a real
browser to download the file instead. See §13.

The reviewer gets `file:line` evidence from read/grep directly, so no shell is
needed. `webfetch`/`websearch` are allowed on both read-only agents so a cited
URL can actually be checked; the writer has no tools at all.

Narrower than it looks: the drafter has the web tools, but the answer prompt
tells it **not** to browse — for a broad question with no repository it answers
from knowledge and marks what it is unsure of, and the reviewer does the
checking. That is the design ("models verify; the human decides") and it removes
the invitation to [invent a tool](§14) that the earlier wording created.

The agents are `hidden: true`, so they stay out of the agent list of the user's
ordinary sessions. Whether the interactive picker honours that is unverified —
`opencode debug agents` and `GET /api/agent` both list hidden agents, so neither
is a visibility test.

Note (V2): agent-level `request.body` (e.g. temperature) is accepted but not yet
sent by the session runner. Set temperature on the provider/model/variant if
stance diversity is wanted.

---

## 7. Data contracts

`claims.json` (drafter):

```json
{
  "verifiable": [{ "id": "V1", "text": "..." }],
  "judgment":   [{ "id": "J1", "text": "...", "options": ["...", "..."] }]
}
```

`review.json` (reviewer):

```json
{
  "verdicts": [
    { "id": "V1", "verdict": "confirmed|refuted|unverifiable", "evidence": "src/http.ts:88 | https://..." }
  ],
  "tradeoffs": [
    { "id": "J1", "per_option": { "option text": ["trade-off against a criterion"] } }
  ],
  "extra_findings": [
    { "id": "E1", "text": "...", "kind": "verifiable|judgment", "evidence": "src/http.ts:88 | https://..." }
  ]
}
```

**Evidence is `file:line` or URL only in v1.** Schema validation rejects
anything command-like. A claim that can only be settled by running something
comes back `unverifiable` in v1 — the honest answer. Executing evidence is M2.

`extra_findings` exists so the reviewer is not bounded by the drafter's
self-report. Findings are *not* auto-fixed: the human accepts or dismisses each
at the gate.

`gate.json` (orchestrator, from the gate):

```json
{
  "decisions":  [{ "id": "J1", "choice": "in-process" }],
  "findings":   [{ "id": "E1", "disposition": "accepted|dismissed" }]
}
```

`changelog.json` (drafter, at rebuttal):

```json
{
  "changes": [
    { "item": "V2", "disposition": "fixed",    "summary": "offset math corrected" },
    { "item": "V4", "disposition": "rebutted", "summary": "...", "evidence": "src/http.ts:88" },
    { "item": "E1", "disposition": "applied",  "summary": "retry path added" },
    { "item": "J1", "disposition": "applied",  "summary": "counters in-process" }
  ]
}
```

`state.json` (orchestrator):

```json
{ "state": "gated", "createdAt": "...", "models": { "drafter": "...", "reviewer": "..." } }
```

Validation: one retry with the validation error; a second failure stops the run
and prints raw output.

---

## 8. Config

`.adv/config.json`:

```json
{
  "models": {
    "drafter":  { "ref": "provider/model#variant", "family": "anthropic" },
    "reviewer": { "ref": "provider/model#variant", "family": "openai" }
  },
  "rounds": 1,
  "gate": true,
  "runDir": ".adv/runs",
  "timeouts": { "draft": 600, "review": 600, "rebut": 600 }
}
```

`family` is explicit and required. The check compares `family` values, **not
providers**, because routing through a gateway puts every model under one
provider ID and would make a provider-based check useless.

---

## 9. Layout

```
adv/                            # new project in this directory
  package.json                  # bun
  AGENTS.md                     # working rules for whoever (or whatever) is here
  NEXT-SESSION.md               # handover prompt
  src/
    cli.ts                      # arg parsing + commands, incl. the TUI entry
    tui.tsx                     # Ink/React TUI: setup, start, settings, pick,
                                #   gate, result
    pipeline.ts                 # the shared sequence; both front ends drive it
    runner.ts                   # Runner interface + types
    runners/opencode-run.ts     # spawns `opencode run`, validate-with-retry
    contracts.ts                # zod schemas
    prompts.ts                  # plan/answer prompts, one deliverable per call
    orchestrator.ts             # run dirs, state machine, decisions.md
    gate.ts                     # the CLI gate (interactive or piped)
    diff.ts                     # unified diff + changelog cross-check
    render.ts                   # plan + changelog + diff + open decisions
    models.ts                   # model list + family heuristic for the picker
    agents.ts                   # the three agent definitions, injected per call
    init.ts                     # `adv init` scaffolding
  .adv/                         # created by `adv init` in the target repo
    criteria.md
    decisions.md
    config.json
  ~/.local/share/adv/runs/      # run artifacts, keyed by repository
    <repo-name>-<hash>/
      <timestamp>/
        task.md
        plan.v1.md
        claims.json
        review.json
        gate.json
        changelog.json
        plan.v2.md
        diff.patch
        state.json
        audit.json              # M2: evidence execution results
  fixtures/toy-repo/            # the test problem
  spike/                        # M0
```

Run artifacts are deliberately **not** under the target repo. In answer mode
there is no repository, so a repo-local `.adv/runs/` would mean dropping a
directory into whatever the human happened to be standing in. One store for both
modes is also one rule to remember. `XDG_DATA_HOME` is honoured; the repository
key is its directory name plus a short hash of the absolute path, so two
checkouts of the same name never collide.

---

## 10. CLI

| Command | Purpose |
| --- | --- |
| `adv init` | Create `.adv/` with template `criteria.md`, empty `decisions.md`, default `config.json`, and the two agent files. |
| `adv run "<task>"` | Draft → review → validate, then stop at the gate. Flags: `--drafter`, `--reviewer`, `--no-gate`, `--dir`. |
| `adv decide <run>` | Show judgment calls + trade-offs + findings; record choices to `decisions.md` and `gate.json`. |
| `adv run --resume <run>` | Rebuttal → diff check → emit plan + changelog + appendix. |
| `adv status [<run>]` | Show current state and artifacts. |

`--no-gate`: run through rebuttal without stopping. Judgment calls are not
resolved by any model; they appear as open items in the output and the plan
presents options rather than choosing.

### The TUI

Bare `adv` opens a TUI (Ink + React) built on the same `pipeline.ts` the CLI
uses, so there is one pipeline and two front ends. Nothing in the TUI decides
anything: it is simply the easiest way to answer the same gate.

1. **Start** — one text box, for the task. Models and criteria come from `.adv/`
   and are *shown, not asked for*, so there is nothing to remember and no run
   path to type.
2. **Working** — each pipeline step with its time and cost, streamed from the
   `onStep` hook.
3. **Gate** — arrow keys over the options, `l` to leave a call open, findings as
   accept/dismiss. Refuted claims are listed first, since they go to the
   rebuttal regardless. Warnings for missing verdicts and for evidence citing a
   file that does not exist are shown at the top.
4. **Result** — the same rendering as the CLI, scrollable, with the run
   directory in the footer.

The CLI commands stay for scripting and for the M3 eval. On a non-TTY, bare
`adv` refuses with a pointer to `adv run` rather than hanging.

---

## 11. Milestones

**M0 — feasibility spike (~half a day).** **Status: done.** See
`spike/README.md`. Ran against a local server / `opencode run`:

- Confirm the V2 endpoints and permission syntax against the running server's
  `/v2/openapi.json` (the appendix reflects V2 docs as of this date, but
  installed-version drift is real).
- Confirm per-step model selection (agent `model:` and/or `opencode run
  --model`, and the session `/model` switch).
- Confirm the read-only posture actually blocks writes and shell.
- **Test both artifact paths** with both intended models: orchestrator-parsed
  final-message JSON, and agent file-write to distinct paths. Pick the reliable
  one.
- Prove validate-with-retry on invalid output.
- Pin opencode and dependency versions; build `OpencodeRunRunner` only.

*Exit:* one drafter and one reviewer on different families complete a round trip
on a toy prompt, with schema-valid artifacts and enforced permissions.

**M1 — core loop.** **Status: done.** `adv init`, `adv run`, `adv decide`,
`adv run --resume`; schema validation with retry; the changelog + diff check;
artifacts and `state.json`; plan + appendix rendering.

Two things landed here that weren't in the original M1:

- **The TUI**, pulled forward from M4 because the CLI was too hard to use in
  practice. Bare `adv` opens it; Ctrl+P opens settings, where the drafter and
  reviewer are chosen from a searchable list of every model opencode knows
  about. Both front ends drive the same `pipeline.ts`.
- **A third agent, `adv-writer`**, with every tool denied. The claims and
  changelog steps are pure text→JSON transforms and need no tools; a model that
  reaches for one there is hallucinating (gpt-oss called a "search" tool that
  does not exist and the provider rejected the request).

One design change from the earlier draft: **each agent call asks for one thing.**
The draft is two calls — the plan as prose, then the claims as a JSON-only reply.
The same for the rebuttal: the revised plan, then the changelog. Asking for prose
*and* JSON in a single reply is where models get flaky: in testing, a drafter
wrote a good plan and simply omitted the claims block, twice, and the retry did
not help. Splitting made it reliable. The cost is a small extra call whose input
is the plan text.

**M2 — enforcement.** Approval-based execution of cited evidence commands
(reuse opencode's ask flow: once/always/reject), `audit.json`, and re-audit of
`plan.v2` for regressions in previously confirmed claims.

**M3 — real trial.** Run it on one genuinely uncertain plan in a real repo;
record outcome and cost.

**M4 — revise.** Adjust prompts, allowlists, and the claim format from the
trial; decide whether a second review pass, `adv revise`, or a slash-command
wrapper is worth adding. The **TUI landed early**, before M2, because the CLI was
too hard to use in practice — that reordering was deliberate, and it is built on
the `render`/library seam.

---

## 12. Success measures and the eval

Process measures:

- No manual copy-paste between draft and the gate.
- Every verdict is schema-valid and cites `file:line` or a URL.
- Every hunk in `plan.v2` maps to a changelog item; nothing unattributed.
- Every judgment call ends in a human entry, never a model choice.
- In the trial, at least one concrete error caught that the drafter alone
  missed. If none, record that the technique was not worth it for that task.

**The eval.** "Better than a single plan" must be tested, not assumed. Arms,
blind-judged, on 5–10 past tasks:

| Arm | Composition | Tests |
| --- | --- | --- |
| A | single draft | baseline |
| B | draft + **same-model** self-review + rebuttal | does an extra pass help? |
| C | the tool: draft + **different-family** review + rebuttal | does cross-family help? |
| D | two independent drafts, human picks | does diversity alone help? |

Match total token budget across arms as closely as practical; report tokens and
wall-clock per run. C vs B separates "different family" from "extra pass"; D
separates "diversity" from "the whole loop".

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Runner/API drift across opencode versions | Pin versions; M0 confirms against `/v2/openapi.json`; `Runner` seam |
| Models fail the output schema | Validate, retry once with the error, then stop |
| Reviewer fabricates evidence | v1 accepts only `file:line`/URL; command-like evidence rejected; M2 runs runnable evidence |
| **Agent routes around a deny using another tool** | Deny-by-default permissions (`*` deny first), never deny `edit`/`shell` alone; the permissions check asserts the agent used only allowlisted tools and no MCP server |
| Reviewer quietly invents criteria | `criteria.md` when present; warn + minimal default when absent |
| Reviewer bounded by drafter's claims | `extra_findings` channel, human-triaged at the gate |
| Human decisions never reach the plan | Rebuttal scope includes decisions; changelog proves application |
| Drafter over-edits during rebuttal | Rebut only authorized items; M1 diff check flags the rest |
| Gateway collapses model identity | Explicit `family` field, not provider-based — now a **warning**, not a block, since the user picks models in the TUI |
| Overhead exceeds benefit on small tasks | Don't run it on small tasks; the §12 eval decides |
| Executing model-chosen commands (M2) | Approval prompts; narrow allowlist |
| **A model is listed but dead, or slow enough to stall a run** | Probe once before wiring it in; use the groq pair for a fast loop; per-model-call timeout of 180s |

---

## 14. Open questions

- Which model pairing for the first trial (must be different families)?
- Which commands, if any, go on the M2 evidence allowlist?
- Is one rebuttal round enough, or is a correctness-critical adaptive second
  pass needed?
- Does resolving judgment calls after a `--no-gate` run justify `adv revise`?
- Where does the OpenCode Go workspace privacy opt-in for contributor models
  actually live? It is not the desktop model picker and is not documented.

### Decided 17 Oct (were open the same day)

- **How do the agent definitions reach OpenCode?** Resolved: injected per call in
  `OPENCODE_CONFIG_CONTENT` from `src/agents.ts`. Verified that it **merges** with
  the user's global config — a provider defined only in
  `~/.config/opencode/opencode.jsonc` still resolved — and that it works under
  `--standalone`, which the runner already used. The file-based install, the
  markdown templates and `adv init --global` are gone. Still to re-verify: the
  permission rules, with one model call through the M0 permissions check.
- **Where do runs live?** Resolved: one user-level store under
  `~/.local/share/adv/runs/<repo-name>-<hash>/<timestamp>/`, for plan and answer
  mode alike. Nothing is written into a directory `adv` was merely started in.
  `adv decide`/`run --resume`/`status` accept a bare run name.

### Still open

- **`gpt-oss` invents a `search` tool — mitigated, not solved.** The model emits
  a tool call for a name that was never offered (OpenCode's catalog is `read`,
  `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`,
  `question`, `skill`, `subagent`, `execute`; nothing is called `search`). The
  provider validates the name against `request.tools` and rejects the whole turn
  with `tool_use_failed`. It is model behaviour, not a permission or prompt bug:
  it happens in the writer agent too, which has **no tools at all**. Two
  mitigations are in: the answer prompt no longer tells the drafter to browse
  (the reviewer checks facts), and a rejected turn gets exactly one stateless
  retry with a "do not invent tools" note. Still unverified: the retry has not
  been observed firing against a real occurrence — the classification is tested
  against the recorded error, and the retry path against a stubbed call, but no
  live run has triggered it yet.
- **`hasAdvDir` is narrower than its name.** It tests `.adv/criteria.md`, so a
  directory holding only `.adv/config.json` (what Ctrl+P writes) reports "No
  `.adv/` in …" though `.adv/` exists. Re-prompting for criteria is right; the
  wording is not.
- **`hidden: true` is set on the agents, but is it honoured by the picker?**
  Not verified: `opencode debug agents` and `GET /api/agent` both list hidden
  agents (`title`, `summary`, `compaction` are hidden builtins and all appear),
  so neither is a visibility test. The interactive picker is the only test.
- **`adv --help` does not print usage.** With no subcommand it falls through to
  the TUI and fails with "the TUI needs a terminal". `--help` is parsed as a flag
  but never acted on.

---

## Appendix: OpenCode V2 API notes

*Sourced from the live V2 docs on 17 Oct 2026; M0 confirms against the running
server's `/v2/openapi.json`.*

| V1 (older spec) | V2 |
| --- | --- |
| `@opencode-ai/sdk`, `createOpencodeClient` / `createOpencodeServer` | `@opencode/client` → `OpenCode.make({ baseUrl })` (network); `@opencode/sdk` → `OpenCode.create()` (embedded, no listener) |
| `POST /session/:id/message` | `POST /api/session/{sessionID}/prompt` |
| `GET /event` | `GET /api/event` |
| `.opencode/agent/<name>.md` | `.opencode/agents/<name>.md` |
| `permission` / `bash` / `task` | `permissions` / `shell` / `subagent` |

Useful: `opencode api get /api/info` (health check),
`POST /api/session/{id}/model` and `.../agent` (switch mid-session),
`GET /api/model`, `GET /api/event` (SSE),
`opencode run --model <provider/model#variant>`.

Permission rules are ordered, last match wins; wildcards are whole-value; a
`shell` pattern ending in ` *` also matches the bare command. Model selectors:
`provider/model#variant` (provider ID stops at the first `/`, variant follows
`#`).
