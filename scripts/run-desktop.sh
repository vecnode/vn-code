#!/bin/sh
# ============================================================
#  vncode shell launcher - macOS / Linux.
#
#  The POSIX half of `scripts\run-desktop.bat`: the same Rust shell,
#  built and run on this host. The shell is a control panel - it opens
#  idle, starts the pinned harness when you press Start, shows it in
#  your browser, and ends the whole instance when you press Stop.
#
#  THE PANE IS OPT-IN HERE. On Windows the launcher builds the shell WITH
#  the pane, so the window has two tabs ("control panel" and "harness");
#  on this host that build compiles (given libwebkit2gtk) but wry's child
#  view still needs a GTK loop pumped beside winit's, which is not
#  written yet - so the default is the panel-only build and `-Pane` asks
#  for the other one. A plain `cargo build --release` in app/ still
#  builds no engine at all; the feature is chosen by THIS script, not by
#  the crate's default.
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
#                             [-Mode <panel|chrome|headless>] [-NoBuild] [-Pane]
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
pane=0
# THE LAUNCHER'S OWN FLAGS ARE REMOVED HERE, not merely read: this script execs the
# shell with its arguments, and the shell refuses a flag it does not know by name.
# The loop rotates the list - shift one off the front, append it at the back unless
# it is ours - so a flag's value (-Port 3099) stays beside it and a path with a
# space survives untouched.
count=$#
index=0
while [ "$index" -lt "$count" ]; do
  argument=$1
  shift
  case "$argument" in
    -NoBuild|--no-build) no_build=1 ;;
    # -NoPause was READ above, to set VNCODE_PAUSE for the console layer; it is
    # dropped here so it cannot reach the shell, which refuses flags it does not know.
    -NoPause) ;;
    *) set -- "$@" "$argument" ;;
  esac
  index=$((index + 1))
done

usage() {
  printf '%s\n' \
    'Usage: sh scripts/run-desktop.sh [command] [-Port <n>] [-DshHome <dir>] [-DshVersion <v>]' \
    '                                [-NoBuild]' \
    '' \
    '  start              install the pack if this home lacks it, ask for the key if' \
    '                     there is none, then start the harness and open it (the' \
    '                     default when no command is given)' \
    '  install            run scripts/setup/install.sh against the home in use' \
    '  uninstall          run scripts/setup/uninstall.sh against it' \
    '  status             print the pin, the home, the pack, the key and the launcher' \
    '  key                ask for the DeepSeek key and write it into <home>/.env' \
    '' \
    '  -Port <n>          hand this port to the web launcher' \
    '  -DshHome <dir>     use this harness home (default: the one the app chose;' \
    '                     a leading ~ is expanded here)' \
    '  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json' \
    '  -NoBuild           never run cargo; use the binary already built' \
    '  -NoPause           never hold this window open' \
    '  -Help / -h / --help   print this help' \
    '  -Version           print the version' \
    '' \
    'vncode is a front door, not a second harness: it decides the root, the key and' \
    'the pack, and then runs scripts/run-web.sh - the same file you would run by' \
    'hand - in this console. There is no window and no embedded web view: the' \
    'interface is a web application and it opens in the browser the launcher found.' \
    '' \
    'Launching only the web needs none of this: scripts/run-web.sh works on its own,' \
    'and so does every script under scripts/setup.' \
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
if ! (cd "$repo_root/app" && cargo build --release -p vn-shell); then
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
