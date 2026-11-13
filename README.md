# pi_setup

Set up [Pi](https://pi.dev) with the local addons kept in this workspace.

The setup scripts install or update Pi, install the `FIT_pi` package, the
questionnaire package, and the `pi-git-commands` package. They are safe to
re-run: local packages are reinstalled so refreshed sources are picked up, and
old versions get a timestamped backup before they are removed.

## Quick start

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

## What it does

1. Finds the local `FIT_pi`, `pi_questionare`, and `pi-git-commands`
   repositories, cloning or using a vendored fallback when one is missing.
2. Installs Pi from [pi.dev](https://pi.dev) when `pi` is not already present.
3. Runs `pi update` and `pi update --extensions` (unless update is skipped).
4. Runs `pi install <FIT_pi>`.
5. Installs the questionnaire package with `pi install <pi_questionare>`.
   If no local checkout exists, the vendored copy in
   `vendor/pi_questionare` is used.
6. Installs the git commands package with `pi install <pi-git-commands>`.
   The repository must be named `@svyaddict/pi-git-commands` and have a Pi
   package manifest.
7. Backs up and removes an older `~/.pi/agent/extensions/questionnaire.ts`
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

## Finding the addons

The scripts search these roots, in order:

1. `$HOME`
2. `$HOME/dev`
3. `$HOME/dev/sin`

Within each root they look up to three directories deep for:

- a directory named `FIT_pi` containing a Pi package manifest
- a directory named `pi_questionare` containing a Pi package manifest
- a directory named `pi-git-commands` containing a Pi package manifest

A missing local checkout falls back instead of failing:

- `FIT_pi` is cloned from `git@github.com:Zaphodious/FIT_pi.git` into
  `$HOME/dev/FIT_pi`.
- `pi-git-commands` is cloned from
  `https://github.com/svyaddict/pi-git-commands.git` into
  `$HOME/dev/pi-git-commands`.
- `pi_questionare` uses the vendored copy at `vendor/pi_questionare`.

Existing local checkouts are reused as-is; the scripts do not pull them. An
ambiguous match is still an error, with candidate paths. Override discovery
explicitly when your repositories live elsewhere:

```bash
FIT_PI_SRC=/path/to/FIT_pi \
QUESTIONNAIRE_SRC=/path/to/pi_questionare \
GIT_COMMANDS_SRC=/path/to/pi-git-commands \
./setup.sh
```

```powershell
$env:FIT_PI_SRC = 'C:\path\to\FIT_pi'
$env:QUESTIONNAIRE_SRC = 'C:\path\to\pi_questionare'
$env:GIT_COMMANDS_SRC = 'C:\path\to\pi-git-commands'
.\setup.ps1
```

The search is skipped for an addon whose environment variable is set.

## Requirements

- Bash and `curl` or `wget` for `setup.sh`; PowerShell 5.1+ for `setup.ps1`.
- Network access when Pi must be installed or updated, or when a missing
  addon must be cloned from GitHub.
- `git` on `PATH` when an addon must be cloned.
- Node.js 22.19 or newer, as required by Pi. The official Pi installer can
  install Node when it is missing.
- Optional local checkouts of `FIT_pi`, `pi_questionare`, and
  `pi-git-commands`; missing addons use the GitHub or vendored fallbacks.

The questionnaire is packaged by the `pi_questionare` repository and vendored
here for fallback. The git commands package is packaged by the
`pi-git-commands` repository. The setup scripts fail clearly if a discovered
checkout does not contain the expected package.

## Tests

Run both suites:

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

## Safety notes

- The scripts run the official Pi installer only when `pi` is missing.
- Package installation and updates stop immediately on failure.
- Existing extension files are backed up before removal.
- Re-running the scripts does not create duplicate package entries.
