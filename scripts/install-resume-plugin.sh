#!/usr/bin/env bash
# Wires the resume plugin into DSH's headless profile (or removes it).
#
# The profile is live configuration outside git, so the script is idempotent,
# makes a backup before every edit, and verifies the result: success means only
# the `--resume` option appearing in `dsh --profile headless --help`.
#
#   scripts/install-resume-plugin.sh            install
#   scripts/install-resume-plugin.sh --uninstall remove
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/dsh-headless-resume" && pwd)"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/headless"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MARKER="headless-resume-runner"
DSH_MODULES="${DSH_MODULES:-/opt/agent-tools/dsh/current/node_modules}"

die() { echo "install-resume-plugin: $*" >&2; exit 1; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }

command -v dsh >/dev/null || die "dsh not found in PATH"
[ -d "$PROFILE_DIR" ] || die "headless profile not found: $PROFILE_DIR"
[ -f "$PLUGIN_DIR/package.json" ] || die "plugin not found: $PLUGIN_DIR"

verify() {
  # The single honest check: the CLI knows about --resume only if the plugin's
  # entry actually mounted. A load error shows up right here.
  # Without the pipe: `grep -q` would close it on the first match, dsh would
  # get SIGPIPE, and pipefail would declare a successful check a failure.
  local out
  out="$(dsh --profile headless --help 2>&1 || true)"
  case "$out" in
    *--resume*) echo "OK: dsh --profile headless knows --resume" ;;
    *) printf '%s\n' "$out" >&2; die "check failed: --resume did not appear" ;;
  esac
}

if [ "${1:-}" = "--uninstall" ]; then
  grep -q "$MARKER" "$PATCH" || die "plugin not connected — $MARKER not found in the patch"
  cp -a "$PATCH" "$PATCH.bak-pre-uninstall-$(stamp)"
  # The section is added whole as one block and starts with this header.
  python3 - "$PATCH" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
head = "\n# Resume + Envelope v1 for headless runs"
i = s.find(head)
if i == -1:
    raise SystemExit("section header not found — remove the entries manually")
p.write_text(s[:i].rstrip() + "\n", encoding="utf-8")
PY
  dsh plugin --profile headless remove dsh-headless-resume >/dev/null 2>&1 || true
  echo "removed; profile: $PATCH"
  exit 0
fi

# 1. The package must resolve its bare imports itself: Node looks them up from
#    the module's REAL path, not from the symlink's location, and a worktree
#    layout is no help here.
[ -d "$DSH_MODULES/@deepseek-ai" ] || die "DSH modules not found: $DSH_MODULES"
mkdir -p "$PLUGIN_DIR/node_modules"
ln -sfn "$DSH_MODULES/@deepseek-ai" "$PLUGIN_DIR/node_modules/@deepseek-ai"
ln -sfn "$DSH_MODULES/commander" "$PLUGIN_DIR/node_modules/commander"

# 2. The profile's link:-dependency. The warning about a missing dsh.bundle is
#    expected: the plugin should not be a profile layer; it is mounted - insert.
cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-pre-resume-$(stamp)"
dsh plugin --profile headless add "link:$PLUGIN_DIR"

# 3. The profile patch.
if grep -q "$MARKER" "$PATCH"; then
  echo "patch already contains $MARKER — skipping"
else
  cp -a "$PATCH" "$PATCH.bak-pre-resume-plugin-$(stamp)"
  cat >> "$PATCH" <<'PATCHBLOCK'

# Resume + Envelope v1 for headless runs. The stock pair
# headless-startup/headless-runner is replaced wholesale: both lines own the
# argv grammar (positional task, --help), and leaving them enabled means two
# parsers and two passes per run.
- id: headless-startup
  disabled: true

- id: headless-runner
  disabled: true

- insert:
    - id: headless-resume-startup
      name: 'dsh-headless-resume/startup'

    # runId and the steer channel path come via the environment from the bridge
    # (DSH_RUN_ID, DSH_STEER_FILE) — the profile patch is static and cannot
    # know them.
    - id: headless-resume-runner
      name: 'dsh-headless-resume'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
        resumeSessionId: !!js ctx.headlessStartup.resumeSessionId
PATCHBLOCK
fi

verify
