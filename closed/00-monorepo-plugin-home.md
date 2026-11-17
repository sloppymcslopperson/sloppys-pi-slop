---
grilled: true
completed: "2026-11-17T21:15:01.951Z"
---

Turn this repository into the canonical monorepo home for the Pi plugins, with FIT_pi and pi_questionare now bundled under `plugins/`. pi-git-commands remains an external package, and the repo includes a plugin template plus agent instructions for future plugin work.

### Completed
- Copied FIT_pi and pi_questionare into `plugins/FIT_pi` and `plugins/pi_questionare`, excluding `.git`, `node_modules`, and old `fit/` boards.
- Removed `vendor/pi_questionare` and the questionnaire vendoring setup path.
- Updated `setup.sh` and `setup.ps1` to install bundled FIT_pi/questionnaire by default, keep `FIT_PI_SRC`/`QUESTIONNAIRE_SRC` overrides, and retain external pi-git-commands discovery plus GitHub cloning.
- Added `templates/pi-plugin` with package manifest, extension source, test, tsconfig, README, license, and gitignore.
- Updated root `README.md` and `AGENTS.md` with the monorepo layout and "make a plugin" workflow.
- Updated bash and PowerShell setup tests for bundled plugin paths and the retained external git-commands behavior.
- Added `ARCHIVED.md` to the old FIT_pi and pi_questionare checkouts.

### Validation
- `bash test/setup.test.sh` passes.
- `./setup.sh --dry-run --skip-update` resolves the bundled plugin paths and the external pi-git-commands checkout.
- PowerShell tests were updated but could not be run because neither `pwsh` nor `powershell` is installed here.
- `git diff --check` passes.

### Notes
- The untracked `freshmaker/` directory was already present during this work and was left untouched.
- The old plugin repositories are marked with `ARCHIVED.md` locally but have not been committed or archived remotely.
