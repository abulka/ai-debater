# Benchmarks in the picker

The model picker shows Artificial Analysis indices — intelligence, coding,
agentic — beside price and ping status, relayed keyless via OpenRouter.
`adv benchmarks [--refresh] [<ref>]` prints the same data on the CLI.

## Why this shape

- **Source: OpenRouter, not AA directly.** AA's own API needs a signup key
  (`401 API key is required`, verified October 2026). OpenRouter relays the
  same three indices under `benchmarks.artificial_analysis` on its keyless
  `GET /api/v1/models`: no auth, one request, ~470 models. The keyed API
  stays unwired until the relay proves too thin.
- **A composite beats a single benchmark.** AA's coding index absorbs
  LiveCodeBench, SciCode and Terminal-Bench internally. SWE-bench has no API
  (and Verified was deprecated for contamination), the HF Open LLM
  Leaderboard is retired and open-weights-only, and LMArena is preference
  Elo matched by display name — a worse identity problem than the one solved
  here. Design Arena was checked and dropped: its `codecategories` is
  preference Elo on rendered output, a different question from agentic
  ability.
- **Matching is canonical-id, two tiers.** An `adv` ref names where a model
  is served (`opencode-go/glm-5.3-flash`); OpenRouter names what it is
  (`z-ai/glm-5.3-flash`). The bridge is models.dev's `canonical_model_id`,
  carried on `CatalogueEntry`. Tier 1 is the exact normalised canonical id;
  tier 2 drops the provider namespace and matches the bare model part, only
  when unique across the whole index (measured zero collisions, so the check
  costs nothing and is insurance). A slug match would silently attach one
  model's score to another — the `model.json`/`models.json` failure mode —
  so ambiguity resolves to blank. Both tiers mark normalisation `≈`, and the
  CLI prints the matched OpenRouter id so a guess can be checked. Provider-
  namespace drift (`zhipuai/…` vs `z-ai/…`, `xai` vs `x-ai`) is exactly what
  tier 2 exists for.

## Measured coverage (2026-10-19, this machine)

671 reachable models, 388 with a canonical id, 305 resolving after the
relaxed matcher (was 230: 34% → 45%). One row in three still shows nothing;
blank is honest — never a 0, never a sibling model's number, the same rule
`costOf` keeps.

## Behaviour

- Cache at `~/.local/share/adv/benchmarks.json` (`{at, scores}`), beside the
  probes with its own lifetime. Any parse failure is an empty index.
- Auto-refresh in the background when the cache is past 7 days, non-blocking;
  offline keeps the old cache silently. `B` refreshes on demand — one
  keyless GET, free, so it asks nothing twice.
- Views, cycled with `V`: provider groups (the default), intelligence
  (flat, highest first), value (output ≤ ceiling, intelligence-ranked;
  `H` hides the unscored in any view. Unscored rows sort after scored
  ones — findable, never ranked above a measured one.
- The value ceiling defaults to $0.80/M output, lives in
  `~/.config/adv/picker.json`, and moves with `<`/`>` in $0.10 steps.
  Its own file, so `saveConfig` never stamps it into a repo's `.adv/`.
- Providers sort subscribed-first: `opencode-go`, `openrouter`, `deepseek`,
  then alphabetical.
- The date shown is OpenRouter's fetch, not AA's measurement: OpenRouter
  does not expose which index version a number came from, and the index
  composition changes. Said out loud here, not in the row.
- Colour never encodes a score. The number is context; the reader decides.
- Attribution: `artificialanalysis.ai`, in the picker footer and the CLI.
