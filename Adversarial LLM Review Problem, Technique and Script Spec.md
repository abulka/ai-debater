# Adversarial LLM Review: Problem, Technique and Script Spec

*Draft, 16 October 2026. Scope: agentic coding over a repo using opencode.*

## 1. Problem statement

**Goal.** Get better plans out of LLMs for repo work by having a second model check the first model's output.

**What happens today.** Two models are run in separate chat windows and their outputs are pasted back and forth by hand. This is a real session's experience, not a hypothetical.

- Fact-checking works. Concrete errors (bad formulas, wrong CSS, claims about code) get caught and fixed in one round, because checking settles them.
- Preference debates do not converge. On judgment calls with no ground truth, the models oscillate between positions. A plausible explanation is that a model tends to concede to the last argument it evaluated, but this is one model's account of its own session and is unproven.
- The manual process is costly. It involves a lot of copy-paste, templates with placeholders that get left unfilled (a literal `[yours]` was sent to the reviewer), no record of decisions, and a rebuttal prompt open enough to invite agreement.
- Observed failures in a test run of the technique: the reviewer invented its own criteria; the human never made the judgment calls, so the drafter quietly made them; the reviewer returned a hedged verdict outside the allowed values; the reviser edited things the critique had not flagged; the reviewer's citations were never spot-checked.

**The problem to solve.** Make the draft, verify, rebut, decide loop repeatable and cheap, with the process rules enforced by code rather than by prompt wording that models can drift from.

**Non-goals.**

- Not a debate engine, and not a system where models resolve taste questions.
- Not a replacement for tests. Where a claim is runnable, run it.
- Not a general multi-agent framework. One workflow, one repo, one human.

## 2. Workflow technique

**Core rule: models verify, the human decides.**

Two kinds of content need different handling:

- **Verifiable claims** are statements about code, APIs, library behaviour or math that can be checked. Resolve them with evidence.
- **Judgment calls** are decisions where reasonable options exist. Models list options and trade-offs against the human's criteria. They do not recommend.

### Setup (once per task)

1. Write `criteria.md`: the human's criteria for judgment calls (for example: minimal dependencies, solo-maintainable, fast to ship). Without it the reviewer invents criteria.
2. Create an empty `decisions.md`. It will hold settled decisions, injected into every later prompt as fixed constraints.

### Rounds

| Step | Actor | Input | Output |
| --- | --- | --- | --- |
| 1. Draft | Model A (drafter) | Task, `criteria.md`, `decisions.md`, repo | `plan.md`, plus a structured list of verifiable claims and judgment calls |
| 2. Review | Model B (different family, fresh session, read-only) | `plan.md` and the repo. **Not** A's reasoning, to avoid anchoring | One verdict per claim with evidence; trade-offs per judgment call; no alternative plan |
| 3. Rebuttal | Model A | Only the refuted items | Fix the plan, or rebut with evidence. Opinions do not count. Change nothing not flagged |
| 4. Decide | Human | Judgment calls and trade-offs | Entries appended to `decisions.md` |
| 5. Stop |  |  | No round three by default |

### Rules the tooling enforces

- The reviewer must not propose an alternative plan.
- Verdicts must be exactly one of `confirmed`, `refuted`, `unverifiable`. Hedged or missing verdicts are rejected and retried.
- Every verdict needs evidence: `file:line`, command output, or a docs URL.
- Evidence that is a runnable command is run by the tool, not trusted.
- The rebuttal may only touch flagged items; edits elsewhere are flagged to the human.
- Judgment calls are never resolved by a model. Only the human adds to `decisions.md`.

### When to use it

Use it for unfamiliar codebases, correctness-critical plans and high-stakes changes. Skip it for small or familiar tasks, where the overhead exceeds the gain. For safety-critical work, allow a second reviewer pass on the revised plan, because the one-round limit is a real tradeoff there.

### Known limits

- Reviewers hallucinate evidence as readily as drafters do. Spot-check citations, and prefer runnable evidence.
- Using different model families reduces shared blind spots but does not remove them.
- A reviewer cannot verify what neither it nor the tools can inspect; those items should come back `unverifiable`, not guessed.

## 3. Spec: the script

### Approach

Build a script, not an app. It orchestrates opencode sessions over HTTP and owns the process rules. Use the harness where work needs the repo (drafting, reviewing with read-only tools, running evidence). Use plain code for sequencing, templating, validation, diffing and decision tracking.

### Verified facts about opencode (from its docs; re-check before building)

- `opencode serve` runs a headless HTTP server that exposes an OpenAPI 3.1 spec.
- A JS/TS SDK, `@opencode-ai/sdk`, provides a typed client (`createOpencodeClient`) and can start a server programmatically (`createOpencodeServer`).
- Sessions are independent; a message is sent with `POST /session/:id/message`; `GET /event` is a server-sent events stream.
- `opencode run "prompt"` runs one-shot headless.
- Agents can be defined as files under `.opencode/agent/`.
- A third-party project reported that SDK versions can lag the production API. Pin the opencode version and the SDK version.

### Unverified; check early (see milestone 0)

- Whether the model can be chosen per agent or per message in the current version.
- How to restrict an agent to read-only tools plus an allow-listed set of shell commands.
- How to get reliably structured output from a session (prompted JSON versus a file the agent writes).
- Whether the SDK matches the running server's API.

### Layout

```
.adv/
  criteria.md        # human's judgment criteria
  decisions.md       # settled decisions, append-only
  config.json        # models, agent names, limits
  runs/<timestamp>/
    task.md
    plan.v1.md
    claims.json      # drafter's sorted claims and judgment calls
    review.json      # reviewer verdicts
    rebuttal.md
    plan.v2.md
    audit.json       # evidence re-run results, out-of-scope edits
.opencode/agent/
  drafter.md         # plan-oriented agent
  reviewer.md        # read-only agent
```

### Data contracts

`claims.json` (written by the drafter):

```json
{
  "verifiable": [{ "id": "V1", "text": "..." }],
  "judgment": [{ "id": "J1", "text": "...", "options": ["...", "..."] }]
}
```

`review.json` (written by the reviewer):

```json
{
  "verdicts": [
    { "id": "V1", "verdict": "confirmed|refuted|unverifiable", "evidence": "file:line | command | url" }
  ],
  "tradeoffs": [
    { "id": "J1", "per_option": { "option text": ["trade-off against criterion"] } }
  ]
}
```

The script validates both against a schema. Invalid output triggers one retry with the validation error; a second failure stops the run and shows the human the raw output.

### CLI

- `adv init`: create `.adv/` with template `criteria.md` and empty `decisions.md`.
- `adv run <task.md>`: run steps 1 to 3, then pause at the human gate.
- `adv decide <run>`: show judgment calls and trade-offs, prompt for choices, append to `decisions.md`.
- `adv status <run>`: show current step and artifacts.
- Flags: `--rounds N` (default 1), `--reviewer-model`, `--drafter-model`, `--no-exec` (do not re-run evidence commands).

### Step behaviour

1. **Draft.** Open a drafter session. Prompt = task + `criteria.md` + `decisions.md` marked "settled, do not reopen" + the instruction to sort output into verifiable claims and judgment calls. Collect `plan.v1.md` and `claims.json`.
2. **Review.** Open a fresh reviewer session on the configured reviewer model. Prompt = `plan.v1.md` + the claim list + `criteria.md` + the format rules. No drafter reasoning. Collect `review.json`; validate; retry once on failure.
3. **Audit.** For each verdict whose evidence is a command on the allow-list, run it and record the result in `audit.json`. If the output contradicts the verdict, mark the verdict `disputed` for the human.
4. **Rebuttal.** Send the drafter only the refuted items. Instruction: fix the plan or rebut with evidence; change nothing else. Collect `plan.v2.md`.
5. **Diff check.** Diff `plan.v1.md` against `plan.v2.md`. Map changes to refuted items; report any change not attributable to one as an out-of-scope edit.
6. **Human gate.** Print refuted items and outcomes, disputed verdicts, out-of-scope edits, and judgment calls with trade-offs. The human edits `decisions.md` via `adv decide`. The run stops.

### Safety and constraints

- The reviewer agent is read-only except for an allow-listed set of commands (tests, `git log`, `git grep`). It has no write access to the repo.
- The drafter produces plans, not code changes, in this workflow.
- The server runs on localhost with `OPENCODE_SERVER_PASSWORD` set.
- API keys come from the environment, never from the repo.

### Out of scope for v1

- A web UI, parallel reviewers, and automatic round three.
- Any model-made resolution of judgment calls.

## 4. Plan

**Milestone 0: feasibility spike (about half a day).** Using the SDK against a local `opencode serve`:

- Create a session, send a message, read the reply.
- Confirm per-agent or per-message model selection.
- Confirm a read-only agent definition works and cannot write.
- Choose a structured-output method and test it with both of your intended models.
- Pin the opencode and SDK versions.

Exit criterion: one drafter and one reviewer on different models complete a round trip on a toy prompt. If model selection or read-only enforcement does not work, decide whether to drive `opencode run` per step instead.

**Milestone 1: the core loop.** `adv init`, `adv run` steps 1 to 4, schema validation with retry, and run artifacts written to disk.

**Milestone 2: enforcement.** The audit step (re-running evidence commands), the diff check, and `adv decide` with `decisions.md` injection.

**Milestone 3: real trial.** Run it on one genuinely uncertain plan in a real repo. Record the results below.

**Milestone 4: revise.** Adjust prompts, allow-lists and the claim format based on the trial; decide whether a second review pass, a UI, or neither is worth adding.

### Success measures

- Fewer manual copy-paste steps than the current process (target: none between draft and human gate).
- Every reviewer verdict is schema-valid, with evidence.
- No unflagged plan edits pass silently.
- At least one real error caught in the trial that the drafter alone missed; if none, record that the technique was not worth it for that task type.
- Every judgment call ends in a human entry in `decisions.md`, never a model choice.

### Risks

| Risk | Mitigation |
| --- | --- |
| SDK or API drift across opencode versions | Pin versions; run the spike first; keep a thin client wrapper |
| Models fail to follow the output schema | Validate, retry once with the error, then stop |
| Reviewer fabricates evidence | Re-run runnable evidence; human spot-checks the rest |
| Local model reliability for the harness | Use hosted models for the first trial; try local models afterwards |
| Overhead exceeds benefit on small tasks | Do not run it on small tasks; track cost per run in the trial |

### Open questions

- Which model pairing for the first trial (drafter and reviewer must be different families)?
- Which commands go on the reviewer's allow-list for the target repo?
- Is one rebuttal round enough for the plans you care about?
