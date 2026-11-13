---
git_commands_env: GIT_COMMANDS_SRC
grilled: true
packages: [FIT_pi, pi_questionare, pi-git-commands]
title: Update this to install the refreshed and new plugins in this pi install
completed: "2026-11-13T16:34:51.574Z"
---

Update both setup scripts to manage all three Pi packages: FIT_pi, pi_questionare, and pi-git-commands. Missing local addons fall back to GitHub clones or the vendored questionnaire copy, while existing local checkouts are reused as-is.

### Grilling answers
- Packages: manage all three packages (FIT_pi, pi_questionare, pi-git-commands).
- Precedence: environment override, then auto-discovered local checkout, then fallback.
- Discovery: use the existing `$HOME`, `$HOME/dev`, `$HOME/dev/sin` search, three levels deep.
- Overrides: `FIT_PI_SRC`, `QUESTIONNAIRE_SRC`, and `GIT_COMMANDS_SRC`.
- Validation: pi-git-commands must be named `@svyaddict/pi-git-commands` and have a `"pi"` manifest key.
- Refresh: reinstall every managed package on each run; do not pull existing local checkouts.
- Cleanup: keep only the existing `~/.pi/agent/extensions/questionnaire.ts` backup-and-remove behavior.
- Install order: FIT_pi, questionnaire, then pi-git-commands.
- Missing FIT_pi: clone `git@github.com:Zaphodious/FIT_pi.git` into `$HOME/dev/FIT_pi`.
- Missing pi-git-commands: clone `https://github.com/svyaddict/pi-git-commands.git` into `$HOME/dev/pi-git-commands`.
- Missing pi_questionare: use a full vendored copy at `vendor/pi_questionare`, snapshotted from the current local checkout (package.json, extensions, README, UNLICENSE).

### Acceptance criteria
- `setup.sh` and `setup.ps1` discover, validate, log, dry-run, and install pi-git-commands after the questionnaire package.
- Missing FIT_pi and pi-git-commands are cloned, and missing pi_questionare uses the vendored copy.
- Ambiguous or invalid local checkouts still fail clearly.
- README and help text document all three addons, fallbacks, and environment overrides.
- Bash and PowerShell test suites cover the third install, dry-run output, ordering, cloning, vendoring, invalid packages, and overrides.

### Validation
- `bash test/setup.test.sh` passes.
- PowerShell tests were updated but could not be run because neither `pwsh` nor `powershell` is installed in this environment.

### Assumptions
- No plugins beyond these three packages are in scope.
- The vendored questionnaire should match the current local checkout and be updated manually when that repository changes.
