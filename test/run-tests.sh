#!/usr/bin/env bash
#
# Run the bash smoke tests, then the PowerShell smoke tests when a PowerShell
# host is available.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

printf '== bash ==\n'
bash "$ROOT/test/setup.test.sh"

PS_TEST="$ROOT/test/setup.tests.ps1"
if command -v cygpath >/dev/null 2>&1; then
	PS_TEST=$(cygpath -w "$PS_TEST")
fi

if command -v pwsh >/dev/null 2>&1; then
	printf '\n== powershell (pwsh) ==\n'
	pwsh -NoProfile -File "$PS_TEST"
elif command -v powershell >/dev/null 2>&1; then
	printf '\n== powershell (Windows PowerShell) ==\n'
	powershell -NoProfile -ExecutionPolicy Bypass -File "$PS_TEST"
else
	printf '\nskip - no pwsh or powershell found; PowerShell setup tests not run\n'
fi
