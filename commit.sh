#!/usr/bin/env bash
# Commit using the Sloppy McSlopperson identity, then restore this repo's
# normal user.name/user.email even if the commit fails or is interrupted.
#
# Usage: ./commit.sh [git commit arguments]
#   ./commit.sh -m "message"
#   ./commit.sh -a -m "message"

set -euo pipefail

COMMIT_NAME="Sloppy McSlopperson"
COMMIT_EMAIL="thesloppyslopperson@gmail.com"

old_name="$(git config --local --get user.name || true)"
old_email="$(git config --local --get user.email || true)"

restore_identity() {
  if [[ -n "$old_name" ]]; then
    git config --local user.name "$old_name"
  else
    git config --local --unset user.name >/dev/null 2>&1 || true
  fi
  if [[ -n "$old_email" ]]; then
    git config --local user.email "$old_email"
  else
    git config --local --unset user.email >/dev/null 2>&1 || true
  fi
}
trap restore_identity EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git config --local user.name "$COMMIT_NAME"
git config --local user.email "$COMMIT_EMAIL"

git commit "$@"
