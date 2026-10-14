#!/bin/sh
# ============================================================
#  vncode shell launcher - macOS / Linux.
#
#  The POSIX half of `scripts\run-desktop.bat`: the same Rust shell,
#  built and run on this host. The shell is a control panel - it opens
#  idle, starts the pinned harness when you press Start, shows it in
#  your browser, and ends the whole instance when you press Stop.
#
#  WHERE IT RUNS FROM, AND WHY THAT IS CHECKED FIRST
#  ------------------------------------------------
#  A DISTRIBUTION has the built shell in the folder ABOVE this one, so
#  it runs that and needs nothing else - not even Rust. A SOURCE
#  CHECKOUT has no built shell, so it builds one with cargo (a no-op
#  while it is current, because cargo's own freshness check IS the
#  cache). Both kinds of folder have an `app/`, so "is there a
#  Cargo.toml?" cannot tell them apart; only the built executable can,
#  and building inside a distribution would demand a Rust toolchain from
#  somebody who was only ever asked to run a program.
#
#  POSIX shell only, and no PowerShell anywhere on this path: this needs
#  the Rust toolchain (https://rustup.rs) in a checkout, and Node.js >=
#  22 for the harness it starts.
#
#  Usage:
#    ./scripts/run-desktop.sh [-Port <n>] [-DshHome <dir>] [-DshVersion <version>]
#                             [-Mode <panel|chrome|headless>] [-NoBuild]
# ============================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
# This script lives in scripts/, so the repository root is its PARENT folder.
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

# The console contract - colour only on a terminal, NO_COLOR honoured, and the
# same words the Windows half prints - is defined ONCE for every POSIX entry
# point: console/theme.sh, the twin of console/theme.ps1.
. "$script_dir/console/theme.sh"

# -NoPause means never hold the window open. The Windows half reads the same
# convention (VNCODE_PAUSE=0), so the flag behaves identically on both hosts.
case " $* " in *" -NoPause "*) VNCODE_PAUSE=0 ;; esac

no_build=0
for argument in "$@"; do
  case "$argument" in
    -NoBuild|--no-build) no_build=1 ;;
  esac
done

usage() {
  printf '%s\n' \
    'Usage: sh scripts/run-desktop.sh [-Port <n>] [-DshHome <dir>] [-DshVersion <version>]' \
    '                                [-Mode <panel|chrome|headless>] [-NoBuild]' \
    '' \
    '  -Port <n>          listen on this port instead of a free one' \
    '  -DshHome <dir>     use this harness home (default: the one the app chose;' \
    '                     a leading ~ is expanded here)' \
    '  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json' \
    '  -Mode <mode>       chrome (the harness UI in a browser - the default),' \
    '                     panel (open idle and start nothing) or headless (no' \
    '                     window; stop/quit/install/uninstall on stdin)' \
    '  -NoBuild           never run cargo; use the binary already built' \
    '  -NoPause           never hold this window open' \
    '  -Help / -h / --help   print this help' \
    '' \
    'Opens on a control panel: nothing is started until Start, and Stop ends the' \
    'instance and frees its port. It draws no web view: the harness UI opens in a' \
    'browser the app found (Chrome first). Install and Uninstall there run' \
    'scripts/setup/install.sh and scripts/setup/uninstall.sh.' \
    ''
}

case "$*" in
  *-Help*|*--help*|*" -h "*|*" -h"|" -h "*)
    usage
    exit 0
    ;;
esac

# A distribution: the built shell sits in the folder above scripts/.
built="$repo_root/vncode"
if [ -x "$built" ]; then
  exec "$built" "$@"
fi

if [ "$no_build" = "1" ]; then
  echo "[vncode] -NoBuild was given but there is no built shell at $built" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[vncode] cargo was not found on PATH, so the shell cannot be built." >&2
  echo "  Install the Rust toolchain from https://rustup.rs and run this again -" >&2
  echo "  or run ./scripts/run-web.sh, which needs only Node.js." >&2
  exit 2
fi

echo "[vncode] Building app/ (cargo does nothing when it is current)..."
if ! (cd "$repo_root/app" && cargo build --release); then
  echo "[vncode] cargo build failed - see the errors above." >&2
  # THE SHELL IT IS REPLACING MAY STILL BE RUNNING. Unix lets a build replace a
  # running program's file, so this cannot fail the way Windows does - but a
  # build that failed for another reason may still have left a usable binary.
  if [ ! -x "$repo_root/app/target/release/vncode" ]; then
    exit 1
  fi
  echo "[vncode] A shell is already built at app/target/release/vncode - running that one." >&2
fi

exec "$repo_root/app/target/release/vncode" "$@"
