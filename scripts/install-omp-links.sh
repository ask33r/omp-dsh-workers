#!/usr/bin/env bash
# Symlink scheme 0.2: source of artifacts is the repo; live ~/.omp locations get
# only links. Idempotent; `--uninstall` removes exactly what was installed.
#
#   install-omp-links.sh [--dry-run] [--uninstall] [--omp-dir DIR]
#
# Contract rule: the extension and the agent do NOT touch ~/.omp themselves —
# linking is done by this script, run by a human/coordinator.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OMP_DIR="${OMP_DIR:-$HOME/.omp/agent}"
DRY_RUN=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --omp-dir) OMP_DIR="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# src (in the repo) -> dst (in the live location)
LINKS=(
  "$REPO_ROOT/extensions/dsh-task|$OMP_DIR/extensions/dsh-task"
)

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# Migration 0.3: agents/dsh-worker.md (the LLM representative) was removed from
# the repository — we remove only OUR OWN stale symlink to it, left behind by
# script versions that still installed it. Works the same for install and for
# --uninstall. A regular file, someone else's link (not pointing into this
# repository) or a missing path is not our concern; skip silently.
OLD_AGENT_LINK="$OMP_DIR/agents/dsh-worker.md"
OLD_AGENT_SRC="$REPO_ROOT/agents/dsh-worker.md"
if [ -L "$OLD_AGENT_LINK" ]; then
  old_target=$(readlink "$OLD_AGENT_LINK")
  if [ "$old_target" = "$OLD_AGENT_SRC" ]; then
    echo "removing outdated symlink: $OLD_AGENT_LINK (representative dropped from the repo)"
    run rm "$OLD_AGENT_LINK"
  fi
fi

for pair in "${LINKS[@]}"; do
  src="${pair%%|*}"
  dst="${pair##*|}"

  if [ "$UNINSTALL" = 1 ]; then
    if [ -L "$dst" ]; then
      target=$(readlink "$dst")
      if [ "$target" = "$src" ]; then
        echo "removing: $dst"
        run rm "$dst"
      else
        # Someone else's link: not our work, leave it alone.
        echo "SKIP: $dst → $target (not our link)" >&2
      fi
    elif [ -e "$dst" ]; then
      echo "SKIP: $dst exists and is not a symlink" >&2
    fi
    continue
  fi

  [ -e "$src" ] || { echo "source not found: $src" >&2; exit 1; }
  run mkdir -p "$(dirname "$dst")"

  if [ -L "$dst" ]; then
    target=$(readlink "$dst")
    if [ "$target" = "$src" ]; then
      echo "already in place: $dst"
      continue
    fi
    # Re-link only a symlink — never touch a real file.
    echo "relinking: $dst ($target → $src)"
    run rm "$dst"
  elif [ -e "$dst" ]; then
    echo "REFUSING: $dst exists and is not a symlink — resolve manually" >&2
    exit 1
  else
    echo "installing: $dst → $src"
  fi

  run ln -s "$src" "$dst"
done

if [ "$UNINSTALL" = 1 ]; then
  echo "done: links removed (files in the repo untouched)"
else
  echo "done: OMP_DIR=$OMP_DIR"
  echo "verify: ls -l $OMP_DIR/extensions/dsh-task"
fi
