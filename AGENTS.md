<!-- fit:begin -->
## FIT tickets

This repository uses FIT: tickets are Markdown files under `fit/open/`,
`fit/in_progress/`, `fit/backlog/`, and `fit/closed/`. The directory is the
ticket status. Filenames are `NN-short-name.md`: a two-digit priority from
`00` to `99` (`00` first) and a short-name identity that must be unique across
the board.

Mode: no `fit/STRICT` marker means Basic (permissive). A `STRICT` file with the
quoted spec version means Strict, which adds naming, priority, uniqueness,
body, archive, and lifecycle rules. Read [AGENT_SPEC.md](AGENT_SPEC.md) before
working a Strict board.

Workflow: use `fit_list` to find an exact ticket id, read only the ticket you
are assigned, move it to `in_progress` while working, and move it to `closed`
when finished. At most one ticket may be in `in_progress` per checkout. Keep a
1-3 sentence summary, then put everything else under level-3 (`###`) headers.
Pass the `expectedRevision` from `fit_show` to mutations. Use `fit_archive`
for closed tickets that should leave the active board; `fit_restore` brings an
archived ticket back.

Tools: `fit_init`, `fit_list`, `fit_show`, `fit_new`, `fit_new_batch`,
`fit_update`, `fit_move`, `fit_cleanup`, `fit_archive`, `fit_restore`, and
`fit_check`.

Guardrails:
- Prefer dedicated tools over direct manipulation when one exists. For FIT
  operations, use the FIT tools rather than ad-hoc shell or editor changes.
- Do not read ticket files or scan ticket bodies unless the task requires it.
- Do not use `write`, `edit`, or shell commands to create, modify, move, or
  delete files under `fit/`; use the FIT tools.
- Do not guess ticket ids or fuzzy-match them in tool calls. Use exact ids
  from `fit_list` or `fit_show`.
- If a ticket changed since you read it, re-read it instead of forcing a
  write.
<!-- fit:end -->

## Committing

Always commit with `./commit.sh` (passing normal `git commit` arguments, e.g.
`./commit.sh -a -m "message"`) instead of running `git commit` directly. The
script temporarily sets the commit identity to
`Sloppy McSlopperson <thesloppyslopperson@gmail.com>` and restores the repo's
configured `user.name`/`user.email` afterwards, even if the commit fails.

## Plugin monorepo

This repository is the canonical home for the Pi plugins made here. Bundled
plugins live under `plugins/<name>` and are independent Pi packages with their
own `package.json`, lockfile, tests, and README. Do not convert them to npm
workspaces or add a plugin to the setup scripts from an external checkout.

Current bundled plugins:

- `plugins/FIT_pi` (`pi-fit`)
- `plugins/pi_questionare` (`@sloppymcslopperson/pi-questions`)
- `plugins/freshmaker` (`@sloppymcslopperson/pi-freshmaker`)

The external `@svyaddict/pi-git-commands` package is installed by the setup
scripts but is not vendored here.

### Making a plugin

When asked to "make a plugin that...", create a complete plugin package under
`plugins/<kebab-case-name>`:

1. Copy `templates/pi-plugin` to the new plugin directory.
2. Replace `__PACKAGE_NAME__`, `__PLUGIN_NAME__`, and `__DESCRIPTION__`.
3. Implement the extension under `extensions/` and add focused tests under
   `test/`.
4. Add the plugin to `setup.sh`, `setup.ps1`, and the plugin table in
   `README.md`.
5. Run the plugin's typecheck and tests.

Plugin rules:

- Keep each plugin independently installable with `pi install <path>`.
- Use a `"pi"` manifest in `package.json` and include the extension entrypoint.
- Keep runtime code in the plugin directory; do not rely on files outside it.
- Do not copy `.git`, `node_modules`, or old `fit/` boards into a plugin.
- Keep setup tests network-free by using fake `pi` and `git` executables.
