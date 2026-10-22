#!/bin/sh
# ai-debater installer: sets up the `adv` and `ocm` commands.
#
#   sh install.sh [--dir <path>]
#
# Steps, each checked before the next:
#   1. prerequisites: git and curl (plus bash and unzip, only if Bun must come
#      from bun.sh)
#   2. Bun: used if already on PATH; else `brew install bun` if Homebrew is on
#      PATH; else bun.sh's installer (into ~/.bun, linked into ~/.local/bin)
#   3. the repository: cloned if absent; fast-forwarded if it is clean
#   4. dependencies: bun install --frozen-lockfile --production (runtime only)
#   5. commands: adv and ocm symlinked into ~/.local/bin
#   6. verification: adv --help and ocm --help must run
#
# Edits no shell profile. Re-running it updates an existing install.
# Remove: rm ~/.local/bin/adv ~/.local/bin/ocm, then delete the checkout.
set -eu

REPO="https://github.com/abulka/ai-debater.git"
DEST="$HOME/.local/share/ai-debater"
BIN_DIR="$HOME/.local/bin"

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
ai-debater installer: sets up the adv and ocm commands.

  sh install.sh [--dir <path>]

  --dir <path>   where the repository lives
                 (default: $HOME/.local/share/ai-debater)
  -h, --help     show this

Edits no shell profile. Re-running it updates an existing install.
EOF
}

os_id() {
  ( [ -r /etc/os-release ] && . /etc/os-release && printf '%s' "${ID:-}" ) 2>/dev/null || true
}

# The installed opencode's major version, or empty when it cannot be read.
# adv needs 2: `--standalone` and the v2 agent config do not exist in 1.x.
opencode_major() {
  raw=$(opencode --version 2>/dev/null | head -n 1) || return 1
  major=$(printf '%s\n' "$raw" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\..*/\1/p')
  [ -n "$major" ] || return 1
  printf '%s' "$major"
}

warn_opencode1() {
  have opencode || return 0
  major=$(opencode_major) || return 0
  [ -n "$major" ] && [ "$major" -lt 2 ] || return 0
  warn "OpenCode $(opencode --version 2>/dev/null | head -n 1) is v1; adv requires OpenCode 2."
  warn "Runs and pings will fail until you upgrade: opencode upgrade --major"
}

# A package-manager hint for the distro in use. Silverblue has no `dnf install`
# on the host, so it gets a pointer to the base image instead.
pkg_hint() {
  case "$(os_id)" in
    ubuntu|debian|linuxmint|pop) echo "sudo apt install $*" ;;
    fedora)
      if [ -e /run/ostree-booted ]; then
        echo "they come with the Silverblue base image (check: rpm -q $*)"
      else
        echo "sudo dnf install $*"
      fi ;;
    arch|manjaro) echo "sudo pacman -S $*" ;;
    *) echo "install $* with your package manager" ;;
  esac
}

# Everything that can refuse is checked here, before anything is written.
preflight() {
  missing=""
  for c in git curl; do have "$c" || missing="$missing $c"; done
  # bun.sh's installer is a bash script that unpacks a zip. Homebrew and an
  # existing bun need neither.
  if ! have bun && ! have brew; then
    for c in bash unzip; do have "$c" || missing="$missing $c"; done
  fi
  if [ -n "$missing" ]; then
    die "missing:$missing. To install: $(pkg_hint $missing)"
  fi

  if [ ! -e "$DEST/.git" ] && [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    die "$DEST exists and is not an ai-debater checkout. Choose another place with --dir."
  fi

  if [ -e "$BIN_DIR" ] && [ ! -d "$BIN_DIR" ]; then
    die "$BIN_DIR exists and is not a directory."
  fi
  names="adv ocm"
  if ! have bun && ! have brew; then names="$names bun"; fi
  for n in $names; do
    f="$BIN_DIR/$n"
    if [ -e "$f" ] && [ ! -L "$f" ]; then
      die "$f exists and is not a symlink, so the installer will not replace it. Move it aside and re-run."
    fi
  done

  # Not fatal: ocm still browses the catalogue on v1. The warning is repeated
  # in the summary because the first one can scroll away.
  warn_opencode1
}

# Symlink into BIN_DIR. Never replaces a regular file (preflight checked that).
link() {
  ln -sfn "$1" "$BIN_DIR/$2"
}

ensure_bun() {
  if have bun; then
    BUN=$(command -v bun)
    BUN_NOTE="already installed: $BUN (left as it is)"
  elif have brew; then
    say "bun: installing with Homebrew"
    brew install bun </dev/null || die "brew install bun failed (output above)"
    BUN="$(brew --prefix)/bin/bun"
    BUN_NOTE="Homebrew: $BUN"
  else
    say "bun: installing from bun.sh into ~/.bun"
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/install.sh" https://bun.sh/install \
      || { rm -rf "$tmp"; die "could not download the bun installer"; }
    # SHELL=sh makes bun's installer skip writing to any shell profile.
    if ! SHELL=sh bash "$tmp/install.sh" >"$tmp/log" 2>&1 </dev/null; then
      cat "$tmp/log" >&2
      rm -rf "$tmp"
      die "the bun installer failed (output above)"
    fi
    rm -rf "$tmp"
    BUN="$HOME/.bun/bin/bun"
    link "$BUN" bun
    BUN_NOTE="bun.sh: $BUN, linked as $BIN_DIR/bun"
  fi
  [ -x "$BUN" ] || die "bun was not found at $BUN after installation"
  # adv starts with `#!/usr/bin/env bun`, so bun must be findable by name.
  PATH="$(dirname "$BUN"):$PATH"
  export PATH
}

get_code() {
  if [ -e "$DEST/.git" ]; then
    if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
      warn "$DEST has uncommitted changes, so it was not updated; installing what is there."
      CODE_NOTE="kept (uncommitted changes)"
    else
      say "code: updating $DEST"
      if git -C "$DEST" pull --ff-only --quiet </dev/null; then
        CODE_NOTE="updated"
      else
        warn "could not fast-forward $DEST (offline, or local commits); installing it as it is."
        CODE_NOTE="kept (update failed)"
      fi
    fi
  else
    say "code: cloning into $DEST"
    mkdir -p "$(dirname "$DEST")"
    git clone --quiet "$REPO" "$DEST" </dev/null || die "git clone failed"
    CODE_NOTE="cloned"
  fi
}

install_deps() {
  say "deps: bun install --frozen-lockfile --production"
  (cd "$DEST" && "$BUN" install --frozen-lockfile --production) </dev/null \
    || die "bun install failed in $DEST (output above)"
}

verify() {
  say "check: adv --help, ocm --help"
  for c in adv ocm; do
    out=$("$BIN_DIR/$c" --help 2>&1 </dev/null) \
      || { printf '%s\n' "$out" >&2; die "$c --help failed (output above)"; }
  done
}

summary() {
  echo
  say "installed"
  printf '  bun   %s\n' "$BUN_NOTE"
  printf '  code  %s (%s)\n' "$DEST" "$CODE_NOTE"
  printf '  adv   %s/adv\n' "$BIN_DIR"
  printf '  ocm   %s/ocm\n' "$BIN_DIR"
  echo
  if ! have opencode; then
    echo "opencode was not found on PATH. Every model call goes through it:"
    echo "get OpenCode 2 from https://opencode.ai, then run: adv --help"
  else
    warn_opencode1
  fi
  if [ "$on_path" = no ]; then
    echo "$BIN_DIR is not on your PATH yet. Open a new terminal (or log in again)."
  fi
  echo "next: cd into a project and run: adv"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ $# -ge 2 ] || die "--dir needs a path"
        DEST="$2"
        shift 2
        ;;
      -h|--help) usage; return 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  case "$DEST" in
    /*) ;;
    *) DEST="$PWD/$DEST" ;;
  esac

  on_path=no
  case ":$PATH:" in *":$BIN_DIR:"*) on_path=yes ;; esac

  preflight
  mkdir -p "$BIN_DIR"
  ensure_bun
  get_code
  install_deps
  link "$DEST/src/cli.ts" adv
  link "$DEST/src/models-cli.ts" ocm
  verify
  summary
}

main "$@"
