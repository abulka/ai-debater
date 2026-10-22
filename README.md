# ai-debater

Two tools that work in conjunction with the [OpenCode](https://opencode.ai)
CLI. **`adv`** asks multiple LLMs the same question and synthesises their
answers into one — each model writes its own independent take, then the lead
model reads all the takes and produces a final answer ending with a short
"what we learned" note on what the peers contributed. **`ocm`** is a model
browser showing all models available to OpenCode, ranked by price and
benchmarked AI intelligence, so you can pick the best-value models and get the
best from your OpenCode models.

The rule the whole tool is built around: **models debate, a better result comes out.**

![adv result screenshot](docs/images/adv-result.png)
*A finished debate: the question, the synthesised answer, and sources.*

## Better LLM results through AI debate

Churning an answer back and forth between two models is the wrong loop: it
costs a lot of tokens, the models drift, and with no ground truth they just
oscillate instead of converging. What works is narrower and cheaper:

- **Independent takes stay honest.** Each model answers the same prompt
  without seeing the others, so agreement is real signal and disagreement is
  worth reading — neither is an artefact of who spoke last.
- **One synthesis, no churn.** The lead keeps what was already right, takes
  what the peers did better, and recommends where they genuinely disagreed.
  A single pass, in parallel: wall-clock time is one take, not three.
- **You settle the rest.** The synthesis recommends; judgment calls stay with
  the human, who follows up where the models disagree.

## Requirements

- `git` and `curl`.
- [OpenCode](https://opencode.ai) **2.x** — every model call goes through
  `opencode run`, and `adv` relies on OpenCode 2's `--standalone` flag and v2
  agent configuration. On OpenCode 1, `adv` prints an upgrade instruction
  instead of running. Check with `opencode --version`; upgrade with
  `opencode upgrade --major` (a plain `opencode upgrade` stays on 1.x).
- [Bun](https://bun.sh) — `adv` runs on Bun's runtime (`Bun.spawn`,
  `Bun.file`), not plain Node. The installer adds it if it is missing.

A ping that reports **`✗ needs v2`** means the OpenCode CLI is 1.x, not that
the model or your key is bad. Your credential is fine — OpenCode Go shows up in
`opencode auth list`. Run `opencode upgrade --major` and ping again. The
installer warns when it finds OpenCode 1 for the same reason.

## Install

No npm account, no registry — install straight from GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/abulka/ai-debater/main/install.sh | sh
```

The installer installs Bun if you don't have it, clones the repo into
`~/.local/share/ai-debater`, installs runtime dependencies, puts `adv` and
`ocm` in `~/.local/bin`, and checks that both commands run.

It edits no shell profile. If `~/.local/bin` is not on your PATH, open a new
terminal.

To uninstall, remove `~/.local/bin/adv` and `~/.local/bin/ocm`, then delete
`~/.local/share/ai-debater`. Bun is left alone.

Custom locations, manual setup, and distribution notes: [Advanced
installation](#advanced-installation).

## `adv` — one question, several models, one answer

One command, and behind it:

- **takes** — two or three models answer the same prompt independently and in
  parallel, each read-only, none seeing the others;
- **synthesis** — the lead model reads every take and writes the final answer,
  keeping what was right, taking what the peers did better, and ending with a
  **what we learned** note naming each model by ref.

One pass. The `x` key shows the diff from take 1 to the final answer, so what
the synthesis changed is visible.

![adv new debate screenshot](docs/images/adv-new-debate.png)
*The new-debate desk: preset, models, subject, and the prompt.*

![adv what we learned screenshot](docs/images/adv-what-we-learned.png)
*The `i` panel: what each take contributed, what happened, and the exact changes.*

**Non-goals.** Not a multi-agent framework, not a replacement for tests, and
not a code-writing tool — it produces plans and
answers, and never edits the repository.

There are two front ends over the same pipeline: an interactive **TUI** (bare
`adv`) and a scriptable **CLI** (`adv <command>`).

Use the tool for unfamiliar codebases, correctness-critical plans and
high-stakes questions; skip it for small or familiar tasks, where the overhead
exceeds the gain.

Bare `adv` opens the interactive TUI for the current directory. Home first —
models browser, new debate, past runs, settings — then keys. Every screen
lists its own keys behind `?`; the essentials:

| Key | Action |
| --- | --- |
| ↑↓ · Enter | Choose a model pair or preset; on the prompt, run the typed task |
| Tab | Switch subject — **this repository** or a **general question** |
| y / Y | Copy the answer / the whole result as Markdown |
| x | Diff from take 1 to the final answer |
| i | What we learned |
| C | Continue this debate with a follow-up |

More keys, the full CLI reference, and how runs are stored:
[`docs/USAGE.md`](docs/USAGE.md).

## `ocm` — the model browser

`ocm` shows every model OpenCode knows, with live price, benchmarked
intelligence, measured cost per task, and reachability — ranked so the best
value is easy to spot. Ping a model (`P`) to settle whether your key can
actually call it; results are cached and shown with their age. No run is
started, no question is asked. The same browser is also inside `adv` — home
first, then `m`.

![ocm models browser, provider view](docs/images/ocm-browser-provider.png)
*Provider view: favourites first, with price, benchmarks, measured cost and ping status.*

![ocm models browser, value view](docs/images/ocm-browser-value.png)
*Value view: the same models ranked by measured cost, cheapest first.*

Detail — views, ping depths, and which models will actually work:
[`docs/USAGE.md`](docs/USAGE.md).

## How it works

A run moves through `created -> taking -> synthesizing -> done`, persisted per
run under `~/.local/share/adv/runs/`. Full detail:
[`docs/USAGE.md`](docs/USAGE.md).

## Advanced installation

The installer runs these steps in order and stops before writing anything if a
check fails:

1. **Prerequisites.** `git` and `curl`; `bash` and `unzip` too when Bun must
   come from Bun's own installer. On Ubuntu or Debian:
   `sudo apt install git curl unzip`.
2. **Bun.** Uses the one on PATH. Otherwise `brew install bun` if Homebrew is
   installed. Otherwise Bun's installer, into `~/.bun`, with a link at
   `~/.local/bin/bun`.
3. **Code.** Clones into `~/.local/share/ai-debater`, or fast-forwards an
   existing checkout. A checkout with uncommitted changes is never touched.
4. **Dependencies.** `bun install --frozen-lockfile --production` — runtime
   dependencies only.
5. **Commands.** Symlinks `adv` and `ocm` into `~/.local/bin`.
6. **Check.** Runs `adv --help` and `ocm --help`.

To choose where the code lives, pass `--dir`:

```sh
curl -fsSL https://raw.githubusercontent.com/abulka/ai-debater/main/install.sh \
  | sh -s -- --dir ~/apps/ai-debater
```

Re-running the installer updates an existing install.

Or by hand, without the installer:

```sh
git clone https://github.com/abulka/ai-debater.git
cd ai-debater
bun install --production
ln -s "$PWD/src/cli.ts" ~/.local/bin/adv
ln -s "$PWD/src/models-cli.ts" ~/.local/bin/ocm
```

`bun link` also works, but puts the commands in `~/.bun/bin`, which is only on
PATH if that directory was added. Bun's own installer adds it; Homebrew's does
not.

On Silverblue, `git`, `curl` and `unzip` are in the base image, and none of
this needs `rpm-ostree` layering. See [Silverblue and
containers](#silverblue-and-containers).

## Contributing

Working on ai-debater itself:

```sh
git clone https://github.com/abulka/ai-debater.git ~/Devel/ai-debater
cd ~/Devel/ai-debater
bun install                    # includes the dev dependencies
bun run typecheck
bun test
```

Read [`AGENTS.md`](AGENTS.md) before changing anything: it carries the working
rules, the architecture and the traps. Typecheck and tests are fast and make no
model calls; `adv run` and `adv continue` do, so ask before running one.

Bun notes for contributors:

- **The checkout is live.** `adv` and `ocm` are symlinks to `src/cli.ts` and
  `src/models-cli.ts`, and Bun runs the TypeScript directly, so source edits
  apply on the next run. Dependency changes need one `bun install`.
- **Don't use the installer as your dev setup.** It installs runtime
  dependencies only (`--production`). Use `bun install` here.
- **`bun link` needs `~/.bun/bin` on PATH.** Bun's own installer adds it;
  Homebrew's does not. Symlinking into `~/.local/bin` works with either.
- **The typecheck toolchain is dev-only.** `typescript` and `@types/bun` are
  devDependencies because `tsconfig.json` names `"types": ["bun"]`. Run
  `bun run typecheck`, not `./node_modules/.bin/tsc` — the shim wants `node`,
  which a Silverblue host does not need to have.

### Silverblue and containers

Silverblue has no `dnf install` on the host, so nothing here should be layered
with `rpm-ostree`. `git`, `curl` and `unzip` are in the base image, and Bun
goes into Homebrew or `~/.bun`.

A distrobox or toolbox container shares `$HOME` and, if you use it,
`/home/linuxbrew`. The same checkout, `node_modules`, `adv`/`ocm` symlinks,
Bun, OpenCode and caches are therefore visible on both sides. Develop in
either:

```sh
distrobox enter dev
cd ~/Devel/ai-debater
bun install
bun run typecheck && bun test
```

`adv` runs on Bun inside the container too. A Bun baked into the image (for
example `/usr/local/bin/bun`) may be shadowed by Homebrew's Bun on PATH; that
is harmless.

## Docs

- [`docs/USAGE.md`](docs/USAGE.md) — CLI reference, TUI keys, run storage,
  the model browser.
- [`AGENTS.md`](AGENTS.md) — working rules for contributors and agents.
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — benchmarks in the picker.
- [`docs/OPENCODE-MODELS.md`](docs/OPENCODE-MODELS.md) — why `opencode
  models` is candidates, not availability, with the reproduction.

## License

MIT — see [`LICENSE`](LICENSE).
