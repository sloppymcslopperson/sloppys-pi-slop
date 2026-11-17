---
grilled: true
completed: "2026-11-17T21:29:54.841Z"
---

Moved the existing `freshmaker/` plugin into `plugins/freshmaker` and registered it as a bundled plugin across setup, tests, README, and AGENTS instructions.

### Completed
- Moved the full working tree, including `foo.txt`, to `plugins/freshmaker`.
- Added `FRESHMAKER_SRC` override support and `@hot.fish/pi-freshmaker` validation to both setup scripts.
- Setup now installs freshmaker after the questionnaire and before external pi-git-commands.
- Updated bash and PowerShell setup tests for the bundled freshmaker path and override.
- Updated README plugin table, setup steps, override examples, and AGENTS bundled-plugin list.
- Added a plugin-local `.gitignore` for `fit/` and `node_modules/`.

### Validation
- `bash test/setup.test.sh` passes.
- `node --test test/*.test.ts` in `plugins/freshmaker` passes all 9 tests.
- `./setup.sh --dry-run --skip-update` resolves and plans the freshmaker install.
- `git diff --check` passes.
- PowerShell tests were updated but could not be run because neither `pwsh` nor `powershell` is installed here.

### Follow-up
- The current Pi settings entry still points at the old `pi_setup/freshmaker` path. Run setup or `pi install plugins/freshmaker` after moving to register the new path; the stale old entry may need removal separately.
