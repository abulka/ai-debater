#!/bin/sh
# ai-debater installer — installs the `adv` and `ocm` commands without npm.
#
# Usage:
#   ./install.sh [--repo <git-url>] [--dir <dest>] [--bin <bin-dir>]
#
# Defaults:
#   --repo  $AI_DEBATER_REPO, or https://github.com/<you>/ai-debater.git
#   --dir   $AI_DEBATER_DIR, or ~/.local/share/ai-debater
#   --bin   $AI_DEBATER_BIN, or ~/.local/bin
#
# What it does:
#   1. installs Bun (https://bun.sh) if it is missing — `adv` runs on Bun;
#   2. warns if the `opencode` CLI is missing (needed for every model call);
#   3. clones the repo, or `git pull`s it if it is already there;
#   4. runs `bun install`;
#   5. symlinks `adv` and `ocm` into the bin dir.
# Re-running it updates an existing install.
set -eu

REPO="${AI_DEBATER_REPO:-https://github.com/abulka/ai-debater.git}"
DEST="${AI_DEBATER_DIR:-$HOME/.local/share/ai-debater}"
BIN_DIR="${AI_DEBATER_BIN:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dir) DEST="$2"; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown flag $1 (see --help)" >&2; exit 1 ;;
  esac
done

case "$REPO" in
  *"<you>"*)
    echo "install.sh: set the repo first — pass --repo <git-url> or export AI_DEBATER_REPO" >&2
    exit 1
    ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "install.sh: Bun not found — installing via https://bun.sh …"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "install.sh: warning: no \`opencode\` on PATH. Install it (https://opencode.ai)" >&2
  echo "install.sh: warning: every model call goes through \`opencode run\`, so nothing works without it." >&2
fi

if [ -d "$DEST/.git" ]; then
  echo "install.sh: updating $DEST …"
  git -C "$DEST" pull --ff-only
else
  echo "install.sh: cloning into $DEST …"
  git clone "$REPO" "$DEST"
fi

echo "install.sh: installing dependencies …"
bun install --cwd "$DEST" --frozen-lockfile

mkdir -p "$BIN_DIR"
ln -sf "$DEST/src/cli.ts" "$BIN_DIR/adv"
ln -sf "$DEST/src/models-cli.ts" "$BIN_DIR/ocm"
chmod +x "$DEST/src/cli.ts" "$DEST/src/models-cli.ts"

echo "installed: adv, ocm -> $BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "install.sh: note: $BIN_DIR is not on PATH — add it to your shell profile." >&2 ;;
esac
