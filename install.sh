#!/bin/bash
# Installs (or reinstalls) Super Face into ~/Applications, then opens it. After this, updates come
# from the menu.
#
#   gh api -H "Accept: application/vnd.github.raw" repos/ainigh/JUST-super-mac-tts-ONLY-service/contents/install.sh | bash
#
# The repository may be private, so everything comes through gh, signed in to GitHub (this sets gh
# up if it's missing). It takes the latest release GitHub built. If there isn't one (or
# SF_FROM_SOURCE=1), it downloads the source of main (SF_BRANCH=name for another branch) and builds
# it here, which needs Node.js 22 or newer.
set -euo pipefail

REPO="ainigh/JUST-super-mac-tts-ONLY-service"
BRANCH="${SF_BRANCH:-main}"
APPS="$HOME/Applications"
NAME="Super Face"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# gh, signed in ------------------------------------------------------------------------------
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [[ -x "$b" ]]; then eval "$("$b" shellenv)"; fi; done
if ! command -v gh >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || die "Needs Homebrew (https://brew.sh), then run this again."
  say "Installing gh (GitHub's command line tool)"
  brew install gh
fi
if ! gh api "repos/$REPO" --silent >/dev/null 2>&1; then
  say "Sign in to GitHub with an account that can see $REPO (a browser window opens)"
  gh auth login --web --git-protocol https -h github.com </dev/tty
  gh api "repos/$REPO" --silent >/dev/null 2>&1 || die "That account can't open $REPO."
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# the app: GitHub's build, else built here -----------------------------------------------------
app=""
if [[ "${SF_FROM_SOURCE:-0}" != 1 && "$BRANCH" == main ]]; then
  say "Downloading the latest release"
  if gh release download --repo "$REPO" --pattern "SuperFace.zip" --dir "$tmp" 2>/dev/null; then
    ditto -x -k "$tmp/SuperFace.zip" "$tmp/unpacked"
    app="$tmp/unpacked/$NAME.app"
  else
    echo "  No release yet: building it here instead."
  fi
fi

if [[ -z "$app" ]]; then
  command -v node >/dev/null 2>&1 || die "Building needs Node.js 22 or newer (brew install node), then this again."
  sha="$(gh api "repos/$REPO/commits/$BRANCH" --jq .sha)" || die "Couldn't find the branch $BRANCH."
  say "Downloading the source ($BRANCH, ${sha:0:7})"
  mkdir -p "$tmp/src"
  gh api "repos/$REPO/tarball/$sha" > "$tmp/src.tar.gz"
  tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components 1
  say "Building (a few minutes)"
  (cd "$tmp/src" && npm ci && npm version "0.1.0-${sha:0:7}" --no-git-tag-version --allow-same-version >/dev/null && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist)
  ditto -x -k "$tmp/src/dist/SuperFace.zip" "$tmp/unpacked"
  app="$tmp/unpacked/$NAME.app"
fi

# install and open -----------------------------------------------------------------------------
# The app that was here is kept until the new one is seen running.
say "Installing into $APPS"
[[ -d "$app" ]] || die "The download didn't hold $NAME.app."
pkill -f "$NAME.app/Contents/MacOS" 2>/dev/null && sleep 1 || true
mkdir -p "$APPS"
previous="$APPS/.$NAME-previous.app"
rm -rf "$previous"
[[ -d "$APPS/$NAME.app" ]] && mv "$APPS/$NAME.app" "$previous"
ditto "$app" "$APPS/$NAME.app"
xattr -dr com.apple.quarantine "$APPS/$NAME.app" 2>/dev/null || true
version="$(defaults read "$APPS/$NAME.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")"
open "$APPS/$NAME.app"

started=0
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  if pgrep -f "$NAME.app/Contents/MacOS" >/dev/null; then started=1; else started=0; fi
done
if [[ "$started" == 1 ]]; then
  rm -rf "$previous"
  say "Done ($version): look for the little person in the menu bar. The API is at http://127.0.0.1:8769."
  echo "  The first time, the voice model downloads (a few hundred MB): the menu shows how far it has got."
  exit 0
fi

if [[ -d "$previous" ]]; then
  rm -rf "$APPS/$NAME.app"
  mv "$previous" "$APPS/$NAME.app"
  open "$APPS/$NAME.app"
  printf '\n\033[31m%s\033[0m\n' "$NAME $version quit as soon as it opened, so the one you had is back and open again." >&2
else
  printf '\n\033[31m%s\033[0m\n' "$NAME $version quit as soon as it opened." >&2
fi
echo "  To see it happen: \"$APPS/$NAME.app/Contents/MacOS/$NAME\"" >&2
exit 1
