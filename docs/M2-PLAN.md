> **Provenance.** Produced by the M3 trial on 17 Oct 2026: `adv run` on this
> repository, drafter `anthropic/claude-sonnet-5-5`, reviewer
> `opencode-go/gpt-6-luna`, gate answered with 12 decisions. Run artifacts:
> `~/.local/share/adv/runs/ai-debater-45afdecb/2026-10-17T06-00-17/`.
> The reviewer refuted one claim (V10, an overbroad "the gate is the only human
> interaction") and raised one finding (E1, the MCP server-level disable missing
> from the slice); both are applied. §3 is the settled design, §6 the build order.
>
> **Changed after the trial (17 Oct, by the human).** Two decisions in §3 were
> revised once the behaviour was described in plain terms:
>
> - **D5** — a check that disagrees with the plan now corrects it automatically.
>   The human is not asked to approve each contradiction; the changelog and the
>   diff still show what changed. A failing test is a fact, not a taste call.
> - **D2** — the split is *quick vs slow*, not tier 1 vs tier 2. Version and git
>   checks run by themselves; `bun test` and `bun run typecheck` ask first.

> **Status (18 Oct).** Implemented: the audit record, exact-argv matcher, executor
> with timeout/cap/scrubbed environment, the quick-versus-slow approval split,
> `audit.json`, merging results into the gate and rebuttal, and the URL/evidence
> checks. **Not implemented:** `adv audit <run>` (Tier 2, deliberately unbuilt) and
> the MCP server-level disable. Do not read §6 as a live roadmap — `AGENTS.md`
> carries the current state.

# M2 plan: evidence execution

## 0. Limits and assumptions

- **Shell access was blocked** (`Permission denied: shell`), so I ran no git commands and no tests. Everything below comes from files I read with the read/grep tools, plus one fetched docs page. Where a claim depends on something I could not run, I mark it **unverified**.
- **I found no trial output.** `AGENTS.md` and `PLAN.md` §0 put M3, the real trial, before M2, and say M2's allowlist should come from the trial's `unverifiable` bucket. I tried to read the run store (`~/.local/share/adv/runs`) and was refused, so I don't know whether a trial has been run.
  - You asked for the M2 design now, so I have written it.
  - Command allowlist membership below is a *shape* with options, not a final list. The human may want to fill it from the trial.
- **Criteria.** The criteria block was empty. I used only the three optimisation targets in the task text: minimal dependencies, solo-maintainability, and shipping this week. I invented no others.
- **Settled decisions.** The task text listed none. `PLAN.md` §2 has a "Locked decisions" table, and I treat it as background. It says "Evidence (v1): file:line or URL only. No command output, no execution" (line 62), which M2 explicitly lifts. It also says "Rounds: one review round by default" (line 67). The human has since settled D1–D6 and related points (§3), and they are applied below as closed.
- **Dependency anomaly.** `src/contracts.ts` imports `zod`, but `package.json` lists only `ink` and `react`, and a search of `bun.lock` for "zod" found nothing. I can't explain this without running `bun install` or `bun pm ls`. It matters to "minimal dependencies" because M2 should add no dependency at all, and the human should confirm how `zod` resolves today.
- As the task instructs, no claims JSON block is included.

## 1. What the code does today

| Fact | Source |
| --- | --- |
| Evidence is a URL or a path-like string. The validator's own comment says command output "could only be inventing it". | `src/contracts.ts:3-24` |
| `confirmed` and `refuted` require `evidence`. `unverifiable` requires only a `note`. | `src/contracts.ts:51-65` |
| The reviewer and drafter share one `READ_ONLY` permission set. It starts with deny-all, then allows `read`, `glob`, `grep`, `webfetch`, `websearch`, and `shell` patterns for `git log/show/diff/status/grep/ls-files/branch *`. | `src/agents.ts:50-66` |
| The reviewer's system prompt says "You cannot run commands, so you can never cite command output." The review prompt repeats it. | `src/agents.ts:107-108`, `src/prompts.ts:18-20` |
| The runner passes `--auto` by default. | `src/runners/opencode-run.ts:128,206` |
| The reviewer's file-evidence check is `existsSync` on the cited path. It never executes anything. | `src/pipeline.ts:60-82` |
| `runHead` ends at state `validated` (`pipeline.ts:84,156`). The gate is the only point where the human answers review items (judgment calls and findings): the CLI paths either collect the gate or pause at it (`cli.ts:254-300`), and the TUI saves the gate answers and then runs `runTail` (`tui.tsx:761-799`). It is not the only human interaction in a run. The TUI start screen also takes the typed task before `runHead` starts (`tui.tsx:256-261`). | `src/pipeline.ts:84-170`, `src/cli.ts:254-300`, `src/tui.tsx:256-261`, `src/tui.tsx:761-799` |
| `runTail` builds the rebuttal scope only from `review.verdicts` that are `refuted`, plus accepted findings and decisions. | `src/pipeline.ts:210-233` |
| There is no `audit` path in `runPaths`, although `PLAN.md` §9 (line 413) lists `audit.json` as an M2 artifact. | `src/orchestrator.ts:51-64` |
| The diff check is a hunk-count heuristic. | `src/diff.ts:26-46` |
| The original spec's audit step ran allowlisted commands and marked a contradicted verdict `disputed`. The current `Verdict` schema has no `disputed`. | spec lines 53, 147; `src/contracts.ts:51-65` |

## 2. Findings that shape the design

1. **`--auto` makes `ask` rules meaningless in the current runner.**
   - `PLAN.md` M2 says to "reuse opencode's ask flow: once/always/reject" (line 522).
   - The opencode permissions docs I fetched say `--auto` "automatically approve[s] permission requests that are not explicitly denied", and only explicit `deny` is still enforced.
   - So an `ask` rule on a reviewer shell command would auto-approve under the runner as written.
   - **Unverified:**
     - That page documents `bash`/`permission`, while this repo uses `shell`/`permissions` (`PLAN.md` appendix, line 655). It may describe a different version from the installed v2.0.32 (`spike/README.md:44`).
     - I don't know what `opencode run` without `--auto` does with an `ask` headlessly. It might block or auto-reject.
2. **The evidence validator is not a command filter.** By my reading of the regex at `contracts.ts:16` (I did not run it), a string such as `./scripts/test.sh --all` matches `PATH_RE`, because a token containing `.` or `/` is enough. Today it only gets flagged afterwards, because `existsSync` fails on the whole string. So the executor must never run anything parsed out of an `evidence` string. Commands need their own structured field.
3. **Existing git runs are unrecorded.** The reviewer already runs allowlisted git commands inside its session. Their output exists only in the NDJSON stream passed to the `onCall` hook. I found no code that persists `events`. So no current evidence has an audit trail.
4. **Allowlist hygiene, independent of M2.**
   - The permissions docs say `*` matches "zero or more of any character".
   - So `git branch *` (`agents.ts:61`) appears to match any arguments, including branch-modifying ones.
   - I did not test this, and I did not check whether `git diff`/`git log` accept an output-file option. Both are worth a check.
5. **A plan does not change the repo.** `PLAN.md` §2 says v1 never edits the repo. So a command re-run against the repo returns the same result for plan.v1 and plan.v2, unless the repo changed in between. This is central to the re-audit question (§5).

## 3. Settled decisions

The human has decided D1–D6 and the related points below. They are closed.

**D1. Who executes a cited command: the orchestrator.**
- The reviewer stays read-only and only *proposes* a check in a structured field. `adv` runs it and writes the record.
- The reviewer's permissions don't change.
- It sidesteps finding 1.
- It needs a new contract field and prompt changes.

**D2. Which commands run without asking (Tier 1): introspection and project checks.**

| Class | Example shape | Status |
| --- | --- | --- |
| Tool version and introspection | `bun --version`, `git rev-parse HEAD` | Tier 1. Runs no project code. |
| Project checks | `bun test`, `bun run typecheck` | Tier 1. Executes repo code and scripts. It may write caches or outputs (see D3). |
| Network fetch | curl-like | Not Tier 1. `webfetch` already covers URL checks (`agents.ts:64`), so this class adds little. Unlisted, so refused (see below). |
| Anything else | | Not executed. The claim stays `unverifiable`. |

- **Matching rule.** An exact match on an argv array, run with `Bun.spawn([...])` and never through a shell. This follows from finding 2 and needs no dependency.
- **Default for unlisted commands.** Refuse.
- The decisions name Tier 1 only. They do not list which argv arrays are Tier 2 (ask). That list is not settled here, and the trial's `unverifiable` bucket is where it comes from.

**D3. Where a command runs: in place in the repo.**
- It is the simplest option.
- Test runners can write into the repo. `AGENTS.md` rule 6 says agents never write to the repo. Here the orchestrator, not an agent, runs the command, but a command's side effects on the tree are still possible. The `tree` field (HEAD plus a dirty flag, §4.2) is recorded for this reason.

**D4. Tier 2 approval: a separate `adv audit <run>` step before `adv decide`.**
- It keeps the gate untouched but adds a command and a state to resume.

**D5. How a command result becomes a verdict: mechanical.**
- The proposal carries an expected exit code or literal substring, and `adv` compares. No extra model call.
- **Related:** an audit-refuted claim enters the rebuttal scope only after the human accepts it. It does not enter automatically the way reviewer-refuted ones do (`pipeline.ts:210-218`). `PLAN.md` §10 says refuted claims go to the rebuttal "regardless" (line 453); that text predates command evidence. The decisions do not say how the human's acceptance is recorded, so that mechanism is not settled here.

**D6. Re-audit of plan.v2: not in M2.** See §5.

**Also settled:**
- **Storage (J10).** `review.json` stays pristine. Audit outcomes go in `audit.json` and are merged in `runTail`.
- **Citation (J11).** A verdict cites command results only through an `audit:<id>` reference, validated against `audit.json` records. Proposals live in a separate structured field.
- **Limits (J12).** Timeout and output cap use conservative small values. The specific numbers are chosen at implementation.

## 4. Design pieces

**4.1 What makes command output evidence rather than invention.** Six properties, each checkable in code:

1. The output was produced by the `adv` process, not typed by a model.
2. The record stores the exact argv, working directory, and source-tree identity (HEAD plus a dirty flag).
3. Output is stored capped, with a truncation flag, total byte length, and a sha256 of the full output. `orchestrator.ts` already uses `node:crypto` (line 1), so there is no new dependency.
4. Approval provenance is recorded: which tier or rule allowed it, or which human response.
5. A verdict may cite a command result only as an `audit:<id>` reference, and the validator rejects any id with no matching record. Raw command text stays invalid in `evidence`. This extends the existing `existsSync` check (`pipeline.ts:70-72`) to a new kind of reference.
6. The gate shows the captured output, so the human can check it.

**4.2 `audit.json` fields.** One entry per proposed check, including ones never run. Otherwise absence is ambiguous, the same problem `AGENTS.md` describes for `created` versus `failed` runs.

| Field | Purpose |
| --- | --- |
| `id` | The `audit:<id>` handle. |
| `claim` | The verdict or finding id the check relates to. |
| `proposedBy` | Model ref, and which call. |
| `argv`, `cwd` | Exactly what ran. |
| `tier` and `decision` | `auto-allowed`, `human-approved`, `human-rejected`, or `refused` (with a reason), plus a timestamp. |
| `status` | `ran`, `timed-out`, `spawn-error`, `not-run`. |
| `exitCode`, `signal`, `startedAt`, `durationMs` | The run itself. |
| `stdout`, `stderr` | Capped, plus `truncated`, `totalBytes`, and a sha256 of the full output. |
| `tree` | HEAD sha and a dirty flag. |
| `env` | Names of passed variables only, never values. |
| `planVersion` and `planSha256` | Which plan text the check was about. This keeps a later re-audit possible without committing to one. |
| `outcome` | Per D5: matched or mismatched against the proposal's expected exit code or substring. |

**4.3 Execution hygiene.** These apply to every command the orchestrator runs.
- Run with a scrubbed environment. The runner currently forwards `...process.env` to opencode (`opencode-run.ts:220`), and the spec says API keys come from the environment (spec line 157).
- Set a timeout and an output cap, at conservative small values (J12).
- Kill the process on timeout and record that.

**4.4 Files likely touched.**
- `contracts.ts`: a proposal field on `unverifiable`, the `audit:` evidence form, and an `Audit` schema.
- `orchestrator.ts`: an `audit` path in `runPaths`.
- A new `src/audit.ts`: matcher, executor, and record writer. Keep it pure and testable without a terminal, like `gate-model.ts`.
- `pipeline.ts`: the hook point. For Tier 1 this is between `reviewed` and `validated`.
- `cli.ts`: the new `adv audit <run>` command (D4) and the state it adds to resume.
- `prompts.ts` and `agents.ts`: reword the lines that say commands are impossible. Loosening them risks re-inviting invented command output, which is why proposals must live in a separate field.
- `render.ts`, `tui.tsx`, and `gate-model.ts`: display. `render.ts` and `gate-model.ts` already count and list the `unverifiable` bucket.
- Review state: keep `review.json` pristine. Put audit outcomes in `audit.json` and merge them in `runTail`.

**4.5 Tests.** All run with no model call:
- matcher accepts and rejects (including "`./run.sh --x` is not runnable");
- executor with a trivial local command, a timeout, and truncation;
- a forged `audit:A9` with no record is rejected.

A live check against the toy repo would call a model, so ask the human first (`AGENTS.md` rule 1). The groq pair takes about 16s (`AGENTS.md`).

## 5. Re-auditing plan.v2 (D6, settled: not in M2)

What I found:

- **Re-running commands tests nothing new.** Under finding 5, the same argv against an unchanged tree gives the same output for v1 and v2. The `tree` field in §4.2 would detect a changed tree.
- **A real regression check is a model call.** It would review the v2 text and ask whether previously confirmed claims still hold.
  - `runTail` produces no claims for v2 (`pipeline.ts:237-282`), so claims would need re-extraction or reuse of v1's.
  - It costs at least one more reviewer call, likely with retries, and adds a state, an artifact, and rendering.
- **Existing mitigations:** the rebuttal is scoped to authorised items, there is a changelog and a diff, and `assessDiff` flags possible out-of-scope edits (heuristic).
- **The repo's own stance.** `AGENTS.md` and `NEXT-SESSION.md` say to consider a second review pass only if the trial leaves residue a human would have caught.

**Decision:** not in M2. Record `planVersion`/`planSha256` in `audit.json` (§4.2) and revisit after the trial.

## 6. Smallest end-to-end slice

This is an ordering of the pieces above:
- the contract field, the `audit:` evidence rule, and the `audit.json` schema;
- the matcher plus executor for Tier 1 (introspection and project checks, exact argv match, in place in the repo);
- the MCP server-level disable, which `AGENTS.md` lists as part of M2's core scope (`AGENTS.md:262-264`) and `spike/README.md:113-114` lists as still open;
- display in the existing verdict panel and the result view.

D1–D6 are settled (§3), so the shapes above no longer depend on an open choice.

## 7. Adjacent items not in this question

- **The `git branch *` and output-file checks** from finding 4.
- **How `zod` resolves** (§0).
