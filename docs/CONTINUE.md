# Continuing a debate

> **Status.** Implemented 20 Oct 2026. `adv continue [<run>] [--instructions "…"]`
> starts a new run from a finished one; `Enter` on the result screen does the
> same through the debate screen. The composer is pure and tested in
> `src/continue.test.ts`.

## 1. The problem

The loop closed behind `done` twice over. `revise` re-opens the gate, but the
gate only ever sees `plan.v1` and the recorded answers — there is no way to say
"the reviewer was wrong about V3, and here is the case it missed" and have both
models hear it. A finished run's only future was a hand-copied follow-up typed
as a brand-new task, with the previous result re-pasted by hand or lost.

## 2. What continue does

`adv continue [<run>] [--instructions "…"]` — a bare run name, or the latest
run, resolved exactly as `decide`/`revise` resolve one:

1. Loads the parent's result: `plan.v2` for a finished run, `plan.v1` for a run
   still parked at the gate (said out loud). Failed runs are refused — there is
   no result to continue from — as are runs with no draft at all.
2. Requires the follow-up: `--instructions`, or the trailing positional words.
   Without the human's words this is a rerun, not a continuation, so it refuses
   rather than guessing.
3. Composes the new task (`composeContinuation`): a header naming the parent
   run, the previous result whole, then the follow-up. Self-describing even
   without provenance — the task reads complete on its own.
4. Runs the normal fresh-run path: criteria, decisions, draft, review, gate,
   tail. The mode comes from the parent (a continued question stays a
   question); the models come from the config default, with the usual explicit
   overrides. `--no-gate` and `--strict` pass through.

The cost is a normal run (two or more model calls), always explicitly
initiated. The parent's `state.json` records nothing new; the child's records
`parent: {name, dir}`, and the past-runs list marks it `↳`.

The TUI door is the same continuation with one less flag. `Enter` on the result
screen does not run anything: it lands on the debate screen with the composed
task prefilled and a `FOLLOW-UP` marker to edit, and the debate screen's Enter
is what starts the run — so a slipped key costs nothing. A non-empty desk draft
arms first (Enter again replaces), because opening anything must never silently
eat a prompt being typed.

## 3. Why a new run, and not a second review

Sessions cannot chain: each `--standalone` run owns its session store, so any
continuation is by content, not by session. And a new run is what "continuing
the debate" means here — a fresh draft that has heard the follow-up, a fresh
cross-family review of it, the human deciding at the gate again. A same-run
round 2 (review `plan.v2` into `plan.v3`) would need artifact generations, a
wider state machine, and revise interplay, for the same effect inside a more
complex shape. That door stays parked.

## 4. What continue does not do

- **It does not overrule refutations.** Every refuted claim still enters the
  rebuttal scope unconditionally; if the reviewer is wrong, the lever is a new
  run that re-argues the point, not a gate item that dismisses the verdict.
  That lever is a separate decision.
- **Provenance is display-only.** `state.parent` marks the chain in the runs
  list and `status`; nothing reads it back. Deleting the parent deletes nothing
  else, and decisions settled in the parent stay settled only via
  `decisions.md`, not via the chain.
