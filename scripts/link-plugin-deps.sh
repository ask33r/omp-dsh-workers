#!/usr/bin/env bash
# Links the resume plugin's dependencies to the installed DSH.
#
# Node resolves bare imports from the module's REAL path, so the dependencies
# must live next to the package itself, not at the repo root or in a worktree.
# Idempotent; the symlinks are not in git (node_modules/ is ignored), so this
# step is needed in every fresh clone — it's invoked by `npm run test:resume`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/dsh-headless-resume"
DSH_MODULES="${DSH_MODULES:-/opt/agent-tools/dsh/current/node_modules}"

[ -d "$PLUGIN_DIR" ] || { echo "link-plugin-deps: plugin not found: $PLUGIN_DIR" >&2; exit 1; }
[ -d "$DSH_MODULES/@deepseek-ai" ] || {
  echo "link-plugin-deps: installed DSH not found in $DSH_MODULES" >&2
  echo "  set DSH_MODULES=<path to the DSH release's node_modules>" >&2
  exit 1
}

mkdir -p "$PLUGIN_DIR/node_modules"
ln -sfn "$DSH_MODULES/@deepseek-ai" "$PLUGIN_DIR/node_modules/@deepseek-ai"
ln -sfn "$DSH_MODULES/commander" "$PLUGIN_DIR/node_modules/commander"
