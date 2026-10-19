# `opencode models` is a catalogue, not an availability check

> **Status.** Recorded 18 Oct 2026. **Not filed upstream** — kept here as the
> evidence behind `adv`'s ping design. Written in the upstream issue format so
> it can be pasted into one verbatim if that ever changes.

`opencode models` lists the models.dev catalogue filtered by *which providers you
hold a credential for*, never by *which models that credential can actually
call*. The result is wrong in **both** directions: models are offered that the
provider rejects with `model_not_found`, and callable models are hidden from the
list entirely.

## Why `adv` cares

`listModels()` (`src/models.ts`) is load-bearing twice over, and the comment on
it claims more than the command delivers:

- `groupModels` **drops** any model `opencode models` does not list, on the
  stated reasoning that it is "a model whose provider is no longer authenticated
  or configured". That reasoning is sound — and it is why this bug is quiet
  rather than loud. The check catches unauthenticated providers and nothing
  else.
- The model picker offers everything listed. So `groq/groq/compound-mini` is
  promoted to the second row of the recents group, under the reader's
  favourites, and fails on first use.

So `opencode models` is a **candidate** list and must never be read as a
**verdict**. Three layers, and only the third is trustworthy:

| layer | source | cost | catches |
| --- | --- | --- | --- |
| 1 | not in `opencode models` | free | provider has no credential |
| 2 | models.dev `tool_call: false` | free | cannot be a drafter/reviewer in repository mode |
| 3 | a real call | one short call | retired, tier-restricted, out of credit, blocked by an account setting |

Layer 2 alone catches `groq/groq/compound` and `groq/groq/compound-mini` — the
catalogue records `tool_call: false` for both, so they are unusable as agents
whatever Groq's entitlement is. Layer 3 is what catches `llama-3.1-8b-instant`
and `llama-3.3-70b-versatile`, which the catalogue describes as perfectly
ordinary tool-calling chat models and which no offline source can disqualify.

## No workaround inside OpenCode

Checked 18 Oct 2026 against opencode v2.0.32, because both were plausible
answers and neither works:

- **`provider.<id>.models` merges, it does not filter.** Per the docs the key
  configures per-model `options` and `variants`; the only documented `disabled`
  flag applies to a variant. Verified: a config listing exactly one groq model
  still yields 12 from `opencode models`.
- **No plugin hook exists.** The documented event list (`command`, `file`,
  `installation`, `lsp`, `message`, `permission`, `server`, `session`, `shell`,
  `tool`, `tui`) contains no model or provider lifecycle event.

So there is no configuration to write and no plugin to write. `adv` carries its
own availability check, which is the ping.

---

## Upstream issue draft

## Summary

`opencode models` lists the models.dev catalogue filtered by *which providers you hold a credential for*, never by *which models that credential can actually call*. The result is wrong in both directions: models are offered that the API rejects with `model_not_found`, and callable models are hidden from the list entirely.

## Environment

- opencode version: 2.0.32 (latest)
- OS: Darwin 27.0.0 (darwin arm64), macOS
- Terminal: TERM_PROGRAM=Apple_Terminal, TERM=xterm-256color, COLORTERM=truecolor
- Shell: /bin/zsh
- Install/channel: latest
- Active plugins: none (no `plugin` key in `~/.config/opencode/opencode.jsonc`, no `plugins/` directory)

## Reproduction

1. Have a valid `GROQ_API_KEY` in the environment for an account with no special tier access.
2. Run `opencode models | grep '^groq/'` — 12 models.
3. Run `curl -s -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models | jq -r '.data[].id'` — 12 models.
4. Compare. The two lists share only 8 entries.

The models.dev catalogue for `groq` has 16 entries, so the local snapshot is not stale — it matches upstream, and the discrepancy is introduced after the catalogue is read.

Listed by `opencode models` but rejected by the API:

```
groq/groq/compound
groq/groq/compound-mini
groq/llama-3.1-8b-instant
groq/llama-3.3-70b-versatile
```

Callable with the same key but absent from `opencode models`:

```
groq/canopylabs/orpheus-arabic-saudi
groq/canopylabs/orpheus-v1-english
groq/whisper-large-v3
groq/whisper-large-v3-turbo
```

Attempting to run any of the first four fails:

```json
{"error":{"message":"The model `groq/compound-mini` does not exist or you do not have access to it.","code":"model_not_found"}}
```

## Expected Behavior

Either `opencode models` should reflect what the configured credential can actually invoke (by querying the provider's model endpoint, the way `opencode auth list` queries credential presence), or the list should be documented as an unfiltered catalogue view so tooling does not treat it as an availability check.

## Actual Behavior

`opencode models` is a catalogue of every model in models.dev for any provider whose credential is present. It does appear to apply *some* filter — 16 catalogue entries become 12 — but the four it drops (`whisper-*`, `canopylabs/orpheus-*`) are exactly the speech and niche-completion models that would be filtered by **modality**, while the four tier-restricted or retired chat models it keeps are filtered by nothing at all. So the filtering is by model type, not by entitlement, and neither pass nor fail correlates with whether a call succeeds.

This matters beyond the TUI: `opencode models` is machine-readable and is the natural way for external tools to discover a working model set. Right now it cannot be used for that.

## Additional Context

**No configuration workaround exists.** `provider.<id>.models` in `opencode.jsonc` merges with the catalogue rather than filtering it. Verified with a config listing exactly one groq model:

```jsonc
{ "provider": { "groq": { "models": { "qwen/qwen3.6-27b": { "name": "qwen/qwen3.6-27b" } } } } }
```

`opencode models | grep '^groq/'` still returns all 12. Per the docs, that key configures per-model `options` and `variants`; the only documented `disabled` flag applies to a variant, not to a whole model.

**No plugin hook exists.** The documented plugin event list (`command`, `file`, `installation`, `lsp`, `message`, `permission`, `server`, `session`, `shell`, `tool`, `tui`) contains no model or provider lifecycle event, so the list cannot be filtered at runtime either.

**Related rendering bug.** models.dev's model id for the compound models already contains the provider namespace, so OpenCode renders the ref as `groq/groq/compound-mini` — a doubled `groq/`. Worth fixing alongside this if both originate in catalogue-id handling.

**Reproducible:** every run, deterministic, no flakiness observed. No workaround found beyond ignoring the command and hardcoding a model list.
