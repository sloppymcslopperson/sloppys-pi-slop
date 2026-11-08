---
project: pi_setup
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
