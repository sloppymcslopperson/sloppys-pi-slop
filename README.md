# pi_setup

Canonical home for the Pi plugins made here, plus scripts that install Pi and
the current plugin set.

## Plugins

| Path | Package | Description |
| --- | --- | --- |
| `plugins/FIT_pi` | `pi-fit` | Deterministic FIT ticket tools and the human `/fit` command |
| `plugins/pi_questionare` | `@sloppymcslopperson/pi-questions` | Tabbed multiple-choice questionnaire tool |
| `plugins/freshmaker` | `@sloppymcslopperson/pi-freshmaker` | Tracks changes to files loaded into Pi context |
| external | `@svyaddict/pi-git-commands` | Git commands and footer package, installed from its own repository |

Each bundled plugin is an independent Pi package with its own `package.json`,
lockfile, tests, and README. The repository does not use npm workspaces.

## Creating a plugin

Agents working in this repository should read [AGENTS.md](AGENTS.md). In short:

1. Copy `templates/pi-plugin` to `plugins/<kebab-case-name>`.
2. Replace the template placeholders and implement the extension or tool.
3. Add tests and run the plugin's `npm test`, `npm run typecheck`, or
   `npm run check`.
4. Register the new plugin in `setup.sh`, `setup.ps1`, and this README.
5. Keep the plugin installable with `pi install <path>`.

Do not copy `.git`, `node_modules`, or old FIT boards into a plugin directory.

## Setup

The setup scripts install or update Pi, install the bundled `FIT_pi`,
questionnaire, and freshmaker plugins from `plugins/`, and install the external
`pi-git-commands` package. They are safe to re-run: every managed package is
reinstalled so refreshed sources are picked up, and old extension files are
backed up before removal.

Linux, macOS, and WSL:

```bash
./setup.sh
```

Native Windows (PowerShell 5.1 or PowerShell 7+):

```powershell
.\setup.ps1
```

Preview the changes first:

```bash
./setup.sh --dry-run
```

```powershell
.\setup.ps1 -DryRun
```

## What setup does

1. Resolves the bundled `plugins/FIT_pi`, `plugins/pi_questionare`, and
   `plugins/freshmaker` packages.
2. Installs Pi from [pi.dev](https://pi.dev) when `pi` is not already present.
3. Runs `pi update` and `pi update --extensions` (unless update is skipped).
4. Runs `pi install <FIT_pi>`, `pi install <pi_questionare>`, and
   `pi install <pi-freshmaker>`.
5. Finds the external `pi-git-commands` checkout, cloning it from GitHub into
   `$HOME/dev/pi-git-commands` when missing, then runs `pi install`.
6. Backs up and removes an older `~/.pi/agent/extensions/questionnaire.ts`
   copy so the tool does not register twice.

Unrelated Pi settings such as provider, model, theme, and other packages are
left alone. The scripts do not edit `settings.json` directly; `pi install` and
`pi update` manage their own entries.

## Options

| `setup.sh` | `setup.ps1` | Meaning |
| --- | --- | --- |
| `--dry-run` | `-DryRun` | Show planned actions without changing anything |
| `--skip-update` | `-SkipUpdate` | Skip `pi update` and `pi update --extensions` |
| `--verbose`, `-v` | `-Verbose` | Show extra command detail |
| `--yes`, `-y` | `-Yes` | Non-interactive mode (accepted for convenience) |
| `--help`, `-h` | `-Help` | Show usage |

PowerShell also accepts the GNU-style long options (`--dry-run`,
`--skip-update`, `--verbose`, `--yes`, and `--help`) for parity with
`setup.sh`.

## Overrides

The bundled plugins are used by default. Point an environment variable at a
development checkout to install that instead:

```bash
FIT_PI_SRC=/path/to/FIT_pi \
QUESTIONNAIRE_SRC=/path/to/pi_questionare \
FRESHMAKER_SRC=/path/to/pi-freshmaker \
./setup.sh
```

```powershell
$env:FIT_PI_SRC = 'C:\path\to\FIT_pi'
$env:QUESTIONNAIRE_SRC = 'C:\path\to\pi_questionare'
$env:FRESHMAKER_SRC = 'C:\path\to\pi-freshmaker'
.\setup.ps1
```

`pi-git-commands` is external. Without `GIT_COMMANDS_SRC`, setup searches
`$HOME`, `$HOME/dev`, then `$HOME/dev/sin` up to three directories deep for a
`pi-git-commands` package. Missing checkouts are cloned from
`https://github.com/svyaddict/pi-git-commands.git` into
`$HOME/dev/pi-git-commands`. Ambiguous matches are an error.

```bash
GIT_COMMANDS_SRC=/path/to/pi-git-commands ./setup.sh
```

## Requirements

- Bash and `curl` or `wget` for `setup.sh`; PowerShell 5.1+ for `setup.ps1`.
- Network access when Pi must be installed or updated, or when
  `pi-git-commands` must be cloned from GitHub.
- `git` on `PATH` when `pi-git-commands` must be cloned.
- Node.js 22.19 or newer, as required by Pi. The official Pi installer can
  install Node when it is missing.

## Tests

Run the setup suites:

```bash
./test/run-tests.sh
```

The runner always executes the bash tests and runs the PowerShell tests when
`pwsh` or `powershell` is available, skipping them with a clear message
otherwise. The tests use a temporary home directory, fake local repositories,
a fake `pi` executable, and a fake `git` executable, so they do not touch real
Pi configuration, real repositories, or the network.

Individual suites:

```bash
bash test/setup.test.sh
pwsh -NoProfile -File test/setup.tests.ps1
```

Each plugin keeps its own tests. For example:

```bash
cd plugins/FIT_pi && npm test
cd plugins/pi_questionare && npm test
cd plugins/freshmaker && npm test
```

## Safety notes

- The scripts run the official Pi installer only when `pi` is missing.
- Package installation and updates stop immediately on failure.
- Existing extension files are backed up before removal.
- Re-running the scripts does not create duplicate package entries.
- Bundled plugins are copied from this repository; missing `pi-git-commands`
  checkouts are the only addon fetched from GitHub.
