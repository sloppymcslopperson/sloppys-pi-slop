---
project: pi_setup
fallback_removed: true
grilled: true
layout: extensions/questionnaire.ts
license: Unlicense
package_name: "@hot.fish/pi-questions"
completed: "2026-11-08T18:29:40.413Z"
---

Convert pi_questionare into a proper Pi package so setup scripts can install it with `pi install` instead of copying a bare extension file.

### Context

The pi_setup ticket installs questionnaire.ts as a fallback extension until a package exists. The repository is at `~/dev/sin/pi_questionare` and currently contains only `questionnaire.ts` plus FIT files.

### Acceptance criteria

- Add `package.json` with a `pi-package` keyword and an explicit `pi.extensions` entry for the questionnaire source.
- Move or reference the extension from a conventional package location without breaking existing imports.
- Add a short README with install/update instructions and declare host-provided Pi packages as peer dependencies.
- Verify `pi install <local path>` loads the tool, and update pi_setup's detection tests if needed.
- Remove or archive the fallback-copy behavior from the setup scripts once the package path is verified.

### Grilling decisions

- Package name: `@hot.fish/pi-questions`; version `0.1.0`; description `Tabbed multiple-choice questionnaire tool for Pi`; keywords `pi-package`, `pi`, `questionnaire`, `tui`; engine Node `>=22.19.0`.
- License: Unlicense, with a full `UNLICENSE` file and the package field set to `Unlicense`.
- Layout: move `questionnaire.ts` to `extensions/questionnaire.ts` with `git mv`; reference it explicitly from `pi.extensions`. Do not keep a duplicate root copy.
- README: concise install/update and basic usage overview, not a full schema reference.
- Host imports go in `peerDependencies`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`, all with `*`.
- Development checks: `tsconfig.json`, `typecheck`, a minimal load/registration smoke test, and a committed `package-lock.json`.
- Verification: install globally with `pi install`, confirm the questionnaire tool is registered, and keep the package installed. Back up and remove the old `~/.pi/agent/extensions/questionnaire.ts` copy first so the tool does not register twice.
- pi_setup: remove the bare-extension fallback entirely; require the questionnaire repository to be a Pi package; update its validator, README, and tests accordingly.
- Commit pi_questionare and pi_setup in separate focused commits.

### Assumptions

- Add `/node_modules/` to pi_questionare's `.gitignore`; the lockfile is committed.
- Verification can use an RPC-mode Pi session plus a temporary check extension to inspect `pi.getAllTools()` without making an LLM call.

### Implementation

- `pi_questionare` is now the Pi package `@hot.fish/pi-questions` at version `0.1.0`, with `pi.extensions` pointing at `extensions/questionnaire.ts`.
- Moved the extension with `git mv`; added `package.json`, `tsconfig.json`, `README.md`, `UNLICENSE`, a load/registration smoke test, and a committed `package-lock.json`. Added `/node_modules/` to `.gitignore`.
- Declared `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as `*` peer dependencies.
- Updated `pi_setup`: `setup.sh`, `setup.ps1`, the README, and both smoke-test suites now require the questionnaire package manifest and have no bare-extension copy fallback. Old extension copies are still backed up and removed.

### Verification

- `npm run check` in `pi_questionare` passes typecheck and the 2 smoke tests.
- `npm pack --dry-run` includes `README.md`, `UNLICENSE`, `extensions/questionnaire.ts`, and `package.json`.
- Ran `pi_setup/setup.sh --skip-update --verbose`: it installed both FIT_pi and `@hot.fish/pi-questions`, then backed up and removed the old extension copy.
- `pi list` shows both local packages in user settings.
- An RPC-mode Pi session with a temporary check extension confirmed `pi.getAllTools()` contains `questionnaire` (`QUESTIONNAIRE_PRESENT`), without making an LLM call.
- Bash and PowerShell `pi_setup` test suites pass with the package-only behavior.
