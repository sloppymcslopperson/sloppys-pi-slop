---
addons: [FIT_pi, pi_questionare]
grilled: true
platforms: [linux, macos, windows, wsl]
completed: "2026-11-08T17:18:26.640Z"
---

Set up this repository with a script that sets up Pi using the current addons. Repositories for several plugins are in ~/dev/sin, and ~/dev/FIT_pi.

### Grilling decisions

- Addons: FIT_pi (Pi package) and pi_questionare (questionnaire extension/package). run_agent.sh is unrelated and excluded.
- Pi binary: install with the official installer when missing; otherwise run `pi update` and `pi update --extensions` on every setup run.
- Scripts: `setup.sh` and `setup.ps1` at the repository root with full parity.
- Platforms: Linux, macOS, native Windows, and WSL.
- Discovery: search `~`, `~/dev`, then `~/dev/sin`; allow `FIT_PI_SRC` and `QUESTIONNAIRE_SRC` overrides. Fail on missing or ambiguous matches.
- Questionnaire: use `pi install` when it is a real Pi package; otherwise copy `questionnaire.ts` to `~/.pi/agent/extensions/` with a warning. If the package exists and an old extension copy exists, back up and remove the old copy to avoid double registration.
- Settings: preserve unrelated Pi settings and packages. Only add/update managed addons.
- Backups: timestamped backups only when a file actually changes.
- Failures: exit non-zero immediately on Pi update or package-install failure.
- Flags: `--dry-run`, `--help`, `--skip-update`, `--verbose`, `--yes`. PowerShell also accepts the GNU-style long forms.
- Docs/tests: README with usage, plus smoke tests for both bash and PowerShell, skipping the PowerShell suite when no PowerShell host is available.

### Implementation

- Added `setup.sh` and `setup.ps1` with discovery, Pi install/update, FIT_pi install, questionnaire package-or-extension handling, timestamped backups, dry-run, skip-update, verbose, and help.
- Added `README.md` documenting usage, discovery, environment overrides, flags, tests, and safety behavior.
- Added `test/setup.test.sh`, `test/setup.tests.ps1`, and `test/run-tests.sh`. Tests use a temporary home, fake repositories, and a fake `pi`, and skip PowerShell only when neither `pwsh` nor `powershell` is available.
- Verified both suites pass locally, including with portable PowerShell 7.6.9, and verified dry-run discovery against the real `~/dev/FIT_pi` and `~/dev/sin/pi_questionare` paths.

### Follow-up

- Conversion of pi_questionare into a real Pi package is tracked in `backlog/01-package-pi-questionare.md`.
