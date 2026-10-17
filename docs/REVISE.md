# M4: revise

> **Status.** Implemented 18 Oct 2026. `adv revise [<run>] [--rewrite]` re-asks
> the gate with the recorded answers prefilled and re-runs only the tail
> (rebuttal + changelog). The gate comparison and the `decisions.md` rules are
> tested in `src/gate-model.test.ts` and `src/orchestrator.test.ts`.

## 1. The problem

The loop closed behind `done`. A run ends with a result, a changelog, a diff,
and a gate frozen in `gate.json` — and then there is no door back in. Two cases
fall through:

1. **The "later" bucket.** A finding answered *later* is recorded as
   `untriaged` and listed at the result ("N left for later"). Deciding it
   afterwards meant re-running the whole pipeline: two model calls for the head
   (draft, review), a new run directory, and the gate re-asked from scratch.
   `--no-gate` runs land the same way: everything open or untriaged, with no
   gate to come back to.
2. **A changed mind.** The human reads the result, disagrees with a call made
   at the gate, and the only lever is a fresh run of the whole task.

Both are wrong. In either case the head is unchanged: the claims were already
verified, the reviewer already spoke, the checks already ran. What needs
redoing is only the tail — a scoped rewrite that applies the new answers.

## 2. What revise does

`adv revise [<run>]` — a bare run name, or the latest run for the repository
when none is given:

1. Re-asks the gate. Every question carries its recorded answer; **Enter keeps
   it**, a letter changes it. The CLI asks the same yes/no/later the TUI asks —
   the old accept/dismiss wording is retired, with `a`/`d` still honoured as
   aliases.
2. Compares the new gate with the recorded one, item by item, and prints what
   moved. **Identical answers: no model call, no state change** — the run
   stands as it is. `--rewrite` forces the tail anyway.
3. Rotates `gate.json` to `gate.prev.json`, then writes the new answers.
4. Re-runs the tail with the **models recorded in `state.json`** — the original
   drafter rewrites its own plan. An explicit `--drafter`/`--reviewer` still
   wins and is reported, exactly as with `run --resume`.
5. Renders the result as usual: the revised text, the changelog, the diff,
   what changed, and the decisions still open.

The cost is two model calls (rebuttal, changelog) or zero. `plan.v1`,
`claims.json`, `review.json` and `audit.json` are never touched.

## 3. States

| Before | After a successful tail | If the tail fails |
| --- | --- | --- |
| `done` | `done` | `gated`, with the error recorded |
| `gated` | `done` | `gated`, with the error recorded |

`revise` refuses everything else and names the state it found: `failed` runs
have no completed review to revise, and `created`/`drafted`/`reviewed`/
`validated` runs never reached a gate to re-ask. A run parked at the gate with
an empty gate (a CLI `adv run` without a terminal) is one step from done, so
revise treats it as such: the gate is asked fresh and the tail runs.

A tail that fails parks the run back at `gated` rather than `failed`. That is
a deliberate divergence from the head's rule, and it is the opposite of a bug:
the head's artifacts are all intact, the answers just given are in
`gate.json`, and the run is *in fact* parked at its gate — so `adv run
--resume` (or another `adv revise`) is a working retry. `failed` would be a
dead end, because decide, resume and revise all refuse it. The error is kept
in `state.json` either way, so `adv status` still says what broke.

## 4. decisions.md — append-only, last entry wins

`decisions.md` stays append-only: revise never rewrites or deletes a line. But
an append-only file re-read whole is a moving target — a second entry for `J1`
contradicts the first, and the draft prompt tells the model every entry is a
closed question. Two rules settle it:

- **When written.** A judgment call whose settled answer moved gets a new entry
  with a marker: `… -> **in-process** (supersedes the earlier entry for J1)`.
  Re-opening a call appends `… -> **reopened** (the earlier entry for J1 no
  longer stands)`. A call that was open and stays open appends nothing.
- **When read.** `readDecisions` feeds the draft the **last entry per id**:
  superseded lines stay on disk (the file is the human's history) but leave
  the feed, and a `reopened` marker un-settles the id entirely, so the next
  draft may argue it again. Non-entry lines — the header, prose a human
  appended — pass through untouched; only lines in the tool's own format are
  the tool's to deduplicate.

Answer mode never writes `decisions.md`, same as `run`: a general question has
no repository to settle decisions in.

## 5. What revise does not do (v1)

- **The TUI door is the same revise, with one less flag.** `r` on the result
  screen and the past-runs picker (Ctrl+R) drive the shared logic above: the
  gate re-asked with its recorded answers prefilled, identical answers spend
  nothing, a change re-runs only the tail. The TUI does not expose `--rewrite`
  — there, "nothing moved" always stops at the result rather than forcing a
  rewrite; the CLI flag remains for that. (v1 was CLI only; the door landed 18
  Oct. The `r` hint is always on the result screen, because a change of mind
  about a *settled* call is exactly what the door is for.)
- **One level of history.** `gate.prev.json` keeps the previous generation of
  answers; a third revision overwrites the second's backup. Deeper history is a
  run-store problem, not a gate problem.
- **Checks are not re-run.** The audit records are facts about `plan.v1`,
  settled at review time, and the merged review view — the one the gate and the
  rebuttal see — is rebuilt from `audit.json` on load, so it stays consistent.
  Re-running checks against a revised plan is the parked `adv audit <run>`
  (M2, plan §6 item 3), not revise.

## 6. Why the gate, and not a second review

Revise is the gate asked a second time, not a new review. The reviewer's
verdicts cannot change: it reviewed `plan.v1`, which is immutable, and its
claims, trade-offs and findings are on disk. Asking it again would spend a
cross-family call to re-derive what `review.json` and `audit.json` already
record. The only new input in the system is the human's changed answers, and
the rebuttal's scope line — refuted, accepted, decided — is built from them
exactly as on the first pass, so the "the rebuttal touches nothing else" claim
holds unchanged.
