#!/usr/bin/env bash
#
# Run a command while holding a machine-wide lock.
#
# `tsc` over Pi's type definitions and the node test runner both take a few
# hundred megabytes. On a small host shared by several agent sandboxes, two of
# those at once pushed the kernel into direct reclaim (load spikes while the CPU
# sits idle, then the OOM killer picks a victim).
#
# The lock file lives in the git common dir, so every checkout of this repo —
# master, its worktrees, and the mount namespaces each sandbox uses — contends
# for the same inode. It never appears in the working tree and is never
# committed.
#
# Usage: scripts/with-lock.sh <command> [args...]

set -euo pipefail

if ! command -v flock >/dev/null 2>&1; then
	echo "with-lock: flock not found; running without a lock" >&2
	exec "$@"
fi

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
	common=$(git rev-parse --git-common-dir) ||
	{
		echo "with-lock: not in a git checkout; running without a lock" >&2
		exec "$@"
	}

exec flock -w 900 "$common/pi-questions-work.lock" "$@"
