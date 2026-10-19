# Benchmarks in the picker

The model picker shows Artificial Analysis indices — intelligence, coding,
agentic — beside price and ping status. `adv benchmarks [--refresh] [<ref>]`
prints the same data on the CLI.

## Why this shape

- **Two sources for the same numbers.** Artificial Analysis measures the
  models; OpenRouter copies the three indices into its free public model
  list. `adv` reads AA direct (`GET /api/v2/language/models/free`, keyed)
  when a key is stored, and the OpenRouter relay (`GET /api/v1/models`,
  keyless) fills the gaps AA never heard of — retired models included. No
  key, no second source: the relay alone, exactly as before.
  Never the legacy path: `/api/v2/data/llms/models` returns `410 Gone`
  after 4 Nov 2026.
- **One row, one number.** The column is 14 wide and the two sources usually
  agree; a second column would print the same three numbers twice. Provenance
  lives where there is room: the footer names the split, and `adv
  benchmarks <ref>` names the source per row.
- **A composite beats a single benchmark.** AA's coding index absorbs
  LiveCodeBench, SciCode and Terminal-Bench internally. SWE-bench has no API
  (and Verified was deprecated for contamination), the HF Open LLM
  Leaderboard is retired and open-weights-only, and LMArena is preference
  Elo matched by display name — a worse identity problem than the one solved
  here. Design Arena was checked and dropped: its `codecategories` is
  preference Elo on rendered output, a different question from agentic
  ability.
- **Matching is suffix tiers, and the row would rather be blank.** An `adv`
  ref names where a model is served (`opencode-go/glm-5.3-flash`); OpenRouter
  names what it is (`z-ai/glm-5.3-flash`); AA names it bare (`glm-5.3-flash`).
  The bridge is models.dev's `canonical_model_id`, carried on
  `CatalogueEntry`. Tier 1 is the exact normalised canonical id; tier 2 drops
  one provider namespace; tier 3 runs the same suffix chain down the served
  ref itself, for the refs models.dev knows nothing about; tier 4 is what the
  chain already does past one strip. Every tier is accepted only when the
  resulting key is unique across the index — ambiguity resolves to nothing,
  never to a sibling model's number. A slug match would silently attach one
  model's score to another, the exact `model.json`/`models.json` failure
  mode, so tiers 2–4 mark `≈`, and so does any normalisation.
- **Variants resolve to the reasoning one.** AA publishes `claude-opus-4-5`
  (23.7, non-reasoning) beside `claude-opus-4-5-thinking` (29.1) as separate
  entries. A group that names a reasoning variant resolves to it — `adv`
  picks a drafter and a reviewer, and the reasoning number is what describes
  the model in use — marked `≈`, with the variant's own id as the source so
  it can be checked. A group with no reasoning variant keeps the exact or
  base entry. Entries without names never trigger an override.
- **The key is personal, verified before it is stored.** It lives in
  `~/.config/adv/artificialanalysis.json` (mode 600), never in
  `.adv/config.json` — `saveConfig` stamps the whole `Config` into every
  repository. The settings screen's `benchmarks` row takes it: paste, Enter,
  one verification request. A 401 saves nothing; a 429 proves the key and
  spends the window, so it is saved and the reset is reported instead.

## Measured coverage (2026-10-19, this machine)

650 listed refs, 361 with the relay alone (was 264: tiers 3–4 cover the refs
with no `canonical_model_id`), 373 with AA direct beside it (288 AA + 85
relay). The index holds 756 entries (695 AA + 61 relay-only). Twelve rows
show a number OpenRouter would not have chosen — the reasoning variant where
the relay carries the other one — each marked `≈`.

## Behaviour

- Cache at `~/.local/share/adv/benchmarks.json` (`{at, scores, indexVersion}`),
  beside the probes with its own lifetime. Each row carries its `source`
  (`aa` or relay); `indexVersion` is AA's (`4.3`), which the relay never
  exposes. Caches written before either existed still load: their rows read
  as the relay's. Any parse failure is an empty index.
- Refresh costs one keyless GET, plus four keyed ones when a key is stored
  (AA lists 200/page and caps `page_size`, so a full refresh is four
  requests). Free quota is 100 per 24h window, shared across the key's scope:
  a weekly refresh spends ~0.6/day. On 429 the refresh reports the reset and
  never retries blindly; the old cache stays.
- Auto-refresh in the background when the cache is past 7 days, non-blocking;
  offline keeps the old cache silently. `B` refreshes on demand, and the
  notice says what happened: `373 scored (288 AA + 85 relay) · AA
  Intelligence Index v4.3 · quota 86/100 · fetched 2026-10-19`.
- Views, cycled with `V`: provider groups (the default), intelligence
  (flat, highest first), value (output ≤ ceiling, intelligence-ranked);
  `H` hides the unscored in any view. Unscored rows sort after scored
  ones — findable, never ranked above a measured one.
- The value ceiling defaults to $0.80/M output, lives in
  `~/.config/adv/picker.json`, and moves with `<`/`>` in $0.10 steps.
  Its own file, so `saveConfig` never stamps it into a repo's `.adv/`.
- Providers sort subscribed-first: `opencode-go`, `openrouter`, `deepseek`,
  then alphabetical.
- The date shown is the fetch, not AA's measurement; the version is carried
  alongside it, because the composition changes. Said out loud here, and in
  the refresh notice — not in the row.
- Colour never encodes a score. The number is context; the reader decides.
- Attribution: `artificialanalysis.ai`, in the picker footer and the CLI.
