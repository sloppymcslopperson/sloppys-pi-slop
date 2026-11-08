# pi_setup

Set up [Pi](https://pi.dev) with the local addons kept in this workspace.

The setup scripts install or update Pi, install the `FIT_pi` package, and
install the questionnaire addon. They are safe to re-run: files are only
replaced when their contents changed, and old versions get a timestamped
backup first.

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

1. Finds the local `FIT_pi` and `pi_questionare` repositories.
2. Installs Pi from [pi.dev](https://pi.dev) when `pi` is not already present.
3. Runs `pi update` and `pi update --extensions` (unless update is skipped).
4. Runs `pi install <FIT_pi>`.
5. Installs the questionnaire:
   - as a Pi package with `pi install <pi_questionare>` when that repository
     has a Pi package manifest (`"pi"` in `package.json`), or
   - by copying `questionnaire.ts` into `~/.pi/agent/extensions/` until the
     package conversion is finished.
6. When switching to the package form, backs up and removes an older
   `~/.pi/agent/extensions/questionnaire.ts` copy so the tool does not register
   twice.

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
- a directory named `pi_questionare` containing `questionnaire.ts` or a Pi
  package manifest

A missing or ambiguous match is an error, with candidate paths when there is
more than one. Override discovery explicitly when your repositories live
elsewhere:

```bash
FIT_PI_SRC=/path/to/FIT_pi QUESTIONNAIRE_SRC=/path/to/pi_questionare ./setup.sh
```

```powershell
$env:FIT_PI_SRC = 'C:\path\to\FIT_pi'
$env:QUESTIONNAIRE_SRC = 'C:\path\to\pi_questionare'
.\setup.ps1
```

The search is skipped for an addon whose environment variable is set.

## Requirements

- Bash and `curl` or `wget` for `setup.sh`; PowerShell 5.1+ for `setup.ps1`.
- Network access when Pi must be installed or updated.
- Node.js 22.19 or newer, as required by Pi. The official Pi installer can
  install Node when it is missing.
- Local checkouts of `FIT_pi` and `pi_questionare`.

The questionnaire currently lives in `pi_questionare`, which is not yet a Pi
package. A separate backlog ticket tracks that conversion; once it lands, the
setup scripts switch to `pi install` automatically.

## Tests

Run both suites:

```bash
./test/run-tests.sh
```

The runner always executes the bash tests and runs the PowerShell tests when
`pwsh` or `powershell` is available, skipping them with a clear message
otherwise. The tests use a temporary home directory, fake local repositories,
and a fake `pi` executable, so they do not touch real Pi configuration or the
network.

Individual suites:

```bash
bash test/setup.test.sh
pwsh -NoProfile -File test/setup.tests.ps1
```

## Safety notes

- The scripts run the official Pi installer only when `pi` is missing.
- Package installation and updates stop immediately on failure.
- Existing extension files are backed up before replacement.
- Re-running with no source changes does not create backups or rewrite the
  questionnaire extension.
