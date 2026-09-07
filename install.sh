#!/usr/bin/env bash
#
# context-find installer.
# Clones (or updates) the repo, builds it, and puts `context-find` and `cfind`
# on your PATH. Re-run any time to pull and rebuild the latest.
#
#   curl -fsSL https://raw.githubusercontent.com/ayush-gzip/context-find/main/install.sh | bash
#
# ponytail: bash/zsh only; add a fish block if anyone needs it.
set -euo pipefail

REPO="https://github.com/ayush-gzip/context-find"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/context-find"
BIN="$HOME/.local/bin"

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "context-find: '$tool' is required, install it first." >&2; exit 1; }
done

# 1. Clone once; pull --ff-only on every later run so a rebuild is one command.
if [ -d "$APP/.git" ]; then
  echo "context-find: updating $APP"
  git -C "$APP" pull --ff-only
else
  echo "context-find: cloning into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone "$REPO" "$APP"
fi

# 2. Build the latest (tsc + copy store.py into dist/).
( cd "$APP/ts" && npm install && npm run build )

# 3. Symlink both command names onto PATH. Absolute target so it survives cwd.
mkdir -p "$BIN"
chmod +x "$APP/ts/dist/cli.js"
ln -sf "$APP/ts/dist/cli.js" "$BIN/context-find"
ln -sf "$APP/ts/dist/cli.js" "$BIN/cfind"

# 4. Put ~/.local/bin on PATH in the shells that exist. Idempotent via a marker.
added=""
add_path_to() {
  local rc="$1"
  grep -qF "context-find installer" "$rc" 2>/dev/null && return
  printf '\n# context-find installer\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
  echo "context-find: added $BIN to PATH in $rc"
  added="yes"
}
[ -e "$HOME/.bashrc" ] && add_path_to "$HOME/.bashrc"
[ -e "$HOME/.zshrc" ]  && add_path_to "$HOME/.zshrc"
# Fresh machine with neither rc: create the one matching the login shell.
if [ -z "$added" ]; then
  case "${SHELL:-}" in
    *zsh) add_path_to "$HOME/.zshrc" ;;
    *)    add_path_to "$HOME/.bashrc" ;;
  esac
fi

echo "context-find: done. Open a new shell (or run: export PATH=\"$BIN:\$PATH\"), then: context-find --help"
