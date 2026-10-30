#!/bin/sh
# toli installer: clones a tagged toli release into a directory you choose.
#
#   curl -fsSL https://raw.githubusercontent.com/yuyudhan/toli/main/install.sh | sh
#   sh install.sh [--dir <path>] [--version vX.Y.Z] [--yes]
#
# The release repository is TOLI_REPO_URL (environment) or the public repository below. Answers are read from
# /dev/tty, so the piped form still asks.
set -eu

TOLI_REPO_URL="${TOLI_REPO_URL:-https://github.com/yuyudhan/toli}"

usage() {
    cat <<'EOF'
usage: install.sh [--dir <path>] [--version vX.Y.Z] [--yes] [--help]

Clones a tagged toli release (default: the latest vX.Y.Z) into a new directory.

  --dir <path>        install here (default: ./toli under the current directory)
  --version vX.Y.Z    install this release instead of the latest
  --yes               no questions: accept the defaults and do not open a shell
  --help              show this help

Environment:
  TOLI_REPO_URL       the git URL to install from (current: see below)
EOF
    printf '  (TOLI_REPO_URL is %s)\n' "$TOLI_REPO_URL"
}

say() { printf '%s\n' "$*"; }
die() {
    printf 'toli install: %s\n' "$*" >&2
    exit 1
}

dir=""
version=""
yes=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dir)
            [ "$#" -ge 2 ] || die "--dir needs a path"
            dir="$2"
            shift 2
            ;;
        --dir=*)
            dir="${1#--dir=}"
            shift
            ;;
        --version)
            [ "$#" -ge 2 ] || die "--version needs a tag like v0.1.0"
            version="$2"
            shift 2
            ;;
        --version=*)
            version="${1#--version=}"
            shift
            ;;
        --yes | -y)
            yes=1
            shift
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

# Interactive when not --yes and a terminal can be opened (true even under `curl ... | sh`).
interactive=0
if [ "$yes" -eq 0 ] && (: </dev/tty) 2>/dev/null; then
    interactive=1
fi
if [ "$yes" -eq 0 ] && [ "$interactive" -eq 0 ]; then
    die "no terminal to ask on; rerun with --yes (and --dir <path> to choose the location)"
fi

ask() { # <prompt> <default>; prints the answer (the default on an empty line)
    printf '%s' "$1" >/dev/tty
    answer=""
    IFS= read -r answer </dev/tty || answer=""
    if [ -z "$answer" ]; then answer="$2"; fi
    printf '%s\n' "$answer"
}

yes_no() { # <prompt> <default y|n>; succeeds on yes
    reply="$(ask "$1" "$2")"
    case "$reply" in
        [Yy] | [Yy][Ee][Ss]) return 0 ;;
        *) return 1 ;;
    esac
}

command -v git >/dev/null 2>&1 || die "git is required: install it first (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git)"

# Release tags, newest first: vX.Y.Z only (pre-releases install only when named with --version).
tags="$(git ls-remote --tags --refs "$TOLI_REPO_URL")" || die "cannot list tags at $TOLI_REPO_URL"
tags="$(printf '%s\n' "$tags" | sed -n 's|.*refs/tags/||p')"
if [ -n "$version" ]; then
    printf '%s\n' "$tags" | grep -qxF -- "$version" || die "no tag $version at $TOLI_REPO_URL"
    tag="$version"
else
    tag="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' \
        | sort -t . -k1,1n -k2,2n -k3,3n | tail -n 1)"
    [ -n "$tag" ] || die "no release tags (vX.Y.Z) at $TOLI_REPO_URL"
    tag="v$tag"
fi

if [ -z "$dir" ]; then
    if [ "$interactive" -eq 1 ]; then
        say "Installing toli $tag from $TOLI_REPO_URL"
        dir="$(ask "Install toli where? [./toli]: " "./toli")"
    else
        dir="./toli"
    fi
fi
case "$dir" in
    \~) dir="$HOME" ;;
    \~/*) dir="$HOME/${dir#\~/}" ;;
    /*) ;;
    *) dir="$PWD/${dir#./}" ;;
esac
dir="${dir%/}"

if [ -e "$dir" ] && [ ! -d "$dir" ]; then die "$dir exists and is not a directory"; fi
if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then die "$dir is not empty; choose a new or empty directory"; fi

if [ "$interactive" -eq 1 ]; then
    yes_no "Install toli $tag into $dir? [Y/n]: " y || die "cancelled; nothing was installed"
fi

say "Cloning toli $tag into $dir"
# git warns "refs/tags/vX is not a commit!" for a shallow clone of an annotated tag; show its output only on failure.
if ! clone_log="$(git -c advice.detachedHead=false clone --quiet --branch "$tag" --depth 1 "$TOLI_REPO_URL" "$dir" 2>&1)"; then
    printf '%s\n' "$clone_log" >&2
    die "git clone failed"
fi
dir="$(cd "$dir" && pwd)" # a typed path like ~/a/../b reads as the real directory from here on

if command -v bun >/dev/null 2>&1; then
    say "Checking the install (bin/toli version, bin/toli doctor)"
    (cd "$dir" && bin/toli version) || die "bin/toli does not run; see the error above"
    if (cd "$dir" && bin/toli doctor); then
        say "doctor: all checks passed"
    else
        say "doctor: items marked fail above are first-run setup; your agent does them when you say \"set up toli\""
    fi
else
    say ""
    say "bun is not installed; toli needs it. Install it, then run: cd \"$dir\" && bin/toli doctor"
    say "  curl -fsSL https://bun.sh/install | bash      (or: brew install oven-sh/bun/bun)"
fi

say ""
say "toli $tag is installed in $dir"
say "Next:"
say "  cd \"$dir\""
say "  open your favourite agent here (omp / claude / codex / cursor-agent / grok / pi) and say: set up toli"
say "  (or run /setup); the agent finishes first-run setup with you. Details: docs/setup.md"

if [ "$interactive" -eq 1 ] && yes_no "Open a shell in $dir now? [Y/n]: " y; then
    cd "$dir"
    say "Starting ${SHELL:-sh} in $dir (exit returns to where you were)"
    exec "${SHELL:-sh}" </dev/tty
fi
