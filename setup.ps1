#!/usr/bin/env pwsh
#
# Install/update Pi and the addons kept in this workspace.
#
# Usage: ./setup.ps1 [-DryRun] [-SkipUpdate] [-Verbose] [-Yes]
#
param(
	[Alias('dry-run')][switch]$DryRun,
	[Alias('skip-update')][switch]$SkipUpdate,
	[switch]$Verbose,
	[switch]$Yes,
	[switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
	$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$onWindows = ([Environment]::GetEnvironmentVariable('OS') -eq 'Windows_NT')
$userProfile = [Environment]::GetEnvironmentVariable('USERPROFILE')
$homeEnv = [Environment]::GetEnvironmentVariable('HOME')

$HomeDir = ''
if ($onWindows -and $userProfile) {
	$HomeDir = $userProfile
} elseif ($homeEnv) {
	$HomeDir = $homeEnv
} else {
	$HomeDir = $HOME
}

function Write-Info {
	param([string]$Message)
	Write-Host $Message
}

function Write-VerboseInfo {
	param([string]$Message)
	if ($Verbose) {
		Write-Host "  $Message"
	}
}

function Fail {
	param([string]$Message)
	throw "error: $Message"
}

function Show-Usage {
	@'
setup.ps1 - set up Pi with the local addons

Usage:
  ./setup.ps1 [-DryRun] [-SkipUpdate] [-Verbose] [-Yes]
  ./setup.ps1 [--dry-run] [--skip-update] [--verbose] [--yes]

Options:
  -DryRun       Show what would happen without changing anything
  -SkipUpdate   Do not run "pi update" or "pi update --extensions"
  -Verbose      Show extra command detail
  -Yes          Non-interactive mode (accepted for convenience)
  -Help         Show this help

Environment:
  FIT_PI_SRC          Path to the FIT_pi package
  QUESTIONNAIRE_SRC   Path to the pi_questionare repository
  GIT_COMMANDS_SRC    Path to the pi-git-commands package

Without overrides, the script searches $HOME, $HOME/dev, then
$HOME/dev/sin for directories named FIT_pi, pi_questionare, and
pi-git-commands. Ambiguous matches are an error.

If FIT_pi or pi-git-commands is missing, it is cloned into $HOME/dev.
If pi_questionare is missing, the vendored copy in vendor/pi_questionare
is used. Local checkouts are reused as-is; they are not pulled.

The questionnaire and pi-git-commands repositories must be Pi packages
with manifests under their "pi" keys. They are installed with pi install.
An older bare extension copy in $HOME/.pi/agent/extensions/ is backed up
and removed.
'@ | Write-Host
}

function Find-NamedDirs {
	param(
		[string]$Name,
		[int]$MaxDepth = 3
	)

	$roots = @(
		$HomeDir,
		(Join-Path $HomeDir 'dev'),
		(Join-Path $HomeDir 'dev/sin')
	)
	$seen = @{}
	$results = New-Object System.Collections.Generic.List[string]

	foreach ($root in $roots) {
		if (-not (Test-Path -LiteralPath $root -PathType Container)) {
			continue
		}

		$resolvedRoot = (Resolve-Path -LiteralPath $root).Path
		$queue = New-Object System.Collections.Generic.Queue[object]
		$queue.Enqueue([pscustomobject]@{ Path = $resolvedRoot; Depth = 0 })

		while ($queue.Count -gt 0) {
			$current = $queue.Dequeue()
			$leaf = Split-Path -Leaf $current.Path

			if ($leaf -eq $Name) {
				$key = $current.Path.ToLowerInvariant()
				if (-not $seen.ContainsKey($key)) {
					$seen[$key] = $true
					[void]$results.Add($current.Path)
				}
			}

			if ($current.Depth -ge $MaxDepth) {
				continue
			}

			$children = @(Get-ChildItem -LiteralPath $current.Path -Directory -ErrorAction SilentlyContinue)
			foreach ($child in $children) {
				if ($child.FullName -eq (Join-Path $ScriptDir 'vendor')) {
					continue
				}
				if ($child.Name -in @('.git', 'node_modules', '.pi', '.cache', '.local')) {
					continue
				}
				if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
					continue
				}
				$queue.Enqueue([pscustomobject]@{ Path = $child.FullName; Depth = $current.Depth + 1 })
			}
		}
	}

	return @($results | Sort-Object -Unique)
}

function Test-FitPi {
	param([string]$Dir)
	$packageJson = Join-Path $Dir 'package.json'
	if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
		return $false
	}
	$text = Get-Content -LiteralPath $packageJson -Raw
	return ($text -match '"name"\s*:\s*"pi-fit"' -or $text -match '"pi"\s*:')
}

function Test-QuestionnairePackage {
	param([string]$Dir)
	$packageJson = Join-Path $Dir 'package.json'
	if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
		return $false
	}
	$text = Get-Content -LiteralPath $packageJson -Raw
	return ($text -match '"pi"\s*:')
}

function Test-Questionnaire {
	param([string]$Dir)
	return Test-QuestionnairePackage -Dir $Dir
}

function Test-GitCommands {
	param([string]$Dir)
	$packageJson = Join-Path $Dir 'package.json'
	if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
		return $false
	}
	$text = Get-Content -LiteralPath $packageJson -Raw
	return ($text -match '"name"\s*:\s*"@svyaddict/pi-git-commands"' -and $text -match '"pi"\s*:')
}

function Clone-Addon {
	param(
		[string]$Label,
		[string]$DirName,
		[string]$Url
	)

	$target = Join-Path (Join-Path $HomeDir 'dev') $DirName
	if (Test-Path -LiteralPath $target) {
		Fail "$Label checkout already exists but is not valid: $target"
	}

	if ($DryRun) {
		Write-Info "[dry-run] would clone $Url -> $target"
		return $target
	}

	$git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if (-not $git) {
		Fail "need git to clone $Label from $Url"
	}

	New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
	Write-Info "Cloning $Label from $Url..."
	Invoke-External -FilePath $git.Path -Arguments @('clone', $Url, $target)
	return $target
}

function Resolve-Addon {
	param(
		[string]$EnvName,
		[string]$Label,
		[string]$DirName,
		[string]$Override,
		[scriptblock]$Validator,
		[string]$FallbackKind = '',
		[string]$FallbackValue = ''
	)

	$candidate = $Override
	if (-not $candidate) {
		$candidate = [Environment]::GetEnvironmentVariable($EnvName)
	}

	if ($candidate) {
		if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
			Fail "$EnvName is not a directory: $candidate"
		}
		$resolved = (Resolve-Path -LiteralPath $candidate).Path
		if (-not (& $Validator $resolved)) {
			Fail "$EnvName does not look like $Label`: $candidate"
		}
		return $resolved
	}

	$found = @(Find-NamedDirs -Name $DirName)
	if ($found.Count -eq 0) {
		if ($FallbackKind -eq 'clone') {
			$resolved = Clone-Addon -Label $Label -DirName $DirName -Url $FallbackValue
			if ((Test-Path -LiteralPath $resolved) -and -not (& $Validator $resolved)) {
				Fail "cloned $Label but it does not look valid: $resolved"
			}
			return $resolved
		}
		if ($FallbackKind -eq 'vendor') {
			if (-not (Test-Path -LiteralPath $FallbackValue -PathType Container)) {
				Fail "could not find $Label and the vendored copy is missing: $FallbackValue"
			}
			$resolved = (Resolve-Path -LiteralPath $FallbackValue).Path
			if (-not (& $Validator $resolved)) {
				Fail "vendored $Label does not look valid: $resolved"
			}
			return $resolved
		}
		Fail "could not find $Label. Set $EnvName to its directory."
	}
	if ($found.Count -gt 1) {
		$candidateList = ($found | ForEach-Object { "  $_" }) -join [Environment]::NewLine
		Fail "found multiple $Label candidates:$([Environment]::NewLine)$candidateList$([Environment]::NewLine)Set $EnvName to choose one."
	}

	$resolved = $found[0]
	if (-not (& $Validator $resolved)) {
		Fail "found $Label but it does not look valid: $resolved"
	}
	return $resolved
}

function Resolve-Pi {
	$command = Get-Command pi -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($command) {
		return $command.Path
	}

	foreach ($name in @('pi', 'pi.exe', 'pi.cmd', 'pi.ps1')) {
		$candidate = Join-Path $HomeDir ".pi/agent/bin/$name"
		if (Test-Path -LiteralPath $candidate -PathType Leaf) {
			return $candidate
		}
	}

	return $null
}

function Install-Pi {
	if ($DryRun) {
		Write-Info "[dry-run] would install Pi from https://pi.dev/install.ps1"
		return
	}

	Write-VerboseInfo 'installing Pi from pi.dev'
	$installer = Invoke-RestMethod -Uri 'https://pi.dev/install.ps1' -UseBasicParsing
	Invoke-Expression $installer
}

function Invoke-External {
	param(
		[string]$FilePath,
		[string[]]$Arguments
	)

	$display = "$FilePath $($Arguments -join ' ')"
	if ($DryRun) {
		Write-Info "[dry-run] would run: $display"
		return
	}

	Write-VerboseInfo "running: $display"
	$global:LASTEXITCODE = 0
	& $FilePath @Arguments
	if ($LASTEXITCODE -ne 0) {
		Fail "command failed with exit code $LASTEXITCODE`: $display"
	}
}

function Backup-File {
	param([string]$Target)

	if (-not (Test-Path -LiteralPath $Target)) {
		return
	}

	$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
	$backup = "$Target.bak-$stamp"
	$n = 1
	while (Test-Path -LiteralPath $backup) {
		$backup = "$Target.bak-$stamp-$n"
		$n++
	}

	if ($DryRun) {
		Write-Info "[dry-run] would back up $Target -> $backup"
		return
	}

	Copy-Item -LiteralPath $Target -Destination $backup -Force
	Write-VerboseInfo "backed up $Target -> $backup"
}

if ($Help) {
	Show-Usage
	return
}

$fitPiOverride = [Environment]::GetEnvironmentVariable('FIT_PI_SRC')
$questionnaireOverride = [Environment]::GetEnvironmentVariable('QUESTIONNAIRE_SRC')
$gitCommandsOverride = [Environment]::GetEnvironmentVariable('GIT_COMMANDS_SRC')

$fitPiSrc = Resolve-Addon `
	-EnvName 'FIT_PI_SRC' `
	-Label 'FIT_pi package' `
	-DirName 'FIT_pi' `
	-Override $fitPiOverride `
	-Validator ${function:Test-FitPi} `
	-FallbackKind 'clone' `
	-FallbackValue 'git@github.com:Zaphodious/FIT_pi.git'

$questionnaireSrc = Resolve-Addon `
	-EnvName 'QUESTIONNAIRE_SRC' `
	-Label 'pi_questionare package' `
	-DirName 'pi_questionare' `
	-Override $questionnaireOverride `
	-Validator ${function:Test-Questionnaire} `
	-FallbackKind 'vendor' `
	-FallbackValue (Join-Path (Join-Path $ScriptDir 'vendor') 'pi_questionare')

$gitCommandsSrc = Resolve-Addon `
	-EnvName 'GIT_COMMANDS_SRC' `
	-Label 'pi-git-commands package' `
	-DirName 'pi-git-commands' `
	-Override $gitCommandsOverride `
	-Validator ${function:Test-GitCommands} `
	-FallbackKind 'clone' `
	-FallbackValue 'https://github.com/svyaddict/pi-git-commands.git'

Write-Info "FIT_pi: $fitPiSrc"
Write-Info "Questionnaire: $questionnaireSrc"
Write-Info "pi-git-commands: $gitCommandsSrc"

$piBinary = Resolve-Pi
if (-not $piBinary) {
	if ($DryRun) {
		Write-Info '[dry-run] Pi is not installed; would install it'
	} else {
		Write-Info 'Pi not found; installing...'
		Install-Pi
		$piBinary = Resolve-Pi
		if (-not $piBinary) {
			Fail 'Pi installation finished but pi was not found'
		}
	}
} else {
	Write-Info "Pi: $piBinary"
}

if (-not $SkipUpdate) {
	if ($piBinary) {
		Write-Info 'Updating Pi...'
		Invoke-External -FilePath $piBinary -Arguments @('update')
		Write-Info 'Updating Pi packages...'
		Invoke-External -FilePath $piBinary -Arguments @('update', '--extensions')
	} else {
		Write-Info '[dry-run] would run: pi update'
		Write-Info '[dry-run] would run: pi update --extensions'
	}
} else {
	Write-Info 'Skipping Pi update (-SkipUpdate)'
}

Write-Info 'Installing FIT_pi package...'
if ($piBinary) {
	Invoke-External -FilePath $piBinary -Arguments @('install', $fitPiSrc)
} else {
	Write-Info "[dry-run] would run: pi install `"$fitPiSrc`""
}

Write-Info 'Installing questionnaire package...'
if ($piBinary) {
	Invoke-External -FilePath $piBinary -Arguments @('install', $questionnaireSrc)
} else {
	Write-Info "[dry-run] would run: pi install `"$questionnaireSrc`""
}

Write-Info 'Installing pi-git-commands package...'
if ($piBinary) {
	Invoke-External -FilePath $piBinary -Arguments @('install', $gitCommandsSrc)
} else {
	Write-Info "[dry-run] would run: pi install `"$gitCommandsSrc`""
}

$oldExtension = Join-Path $HomeDir '.pi/agent/extensions/questionnaire.ts'
if (Test-Path -LiteralPath $oldExtension) {
	Write-Info 'Removing old questionnaire extension copy to avoid duplicate registration...'
	Backup-File -Target $oldExtension
	if ($DryRun) {
		Write-Info "[dry-run] would remove $oldExtension"
	} else {
		Remove-Item -LiteralPath $oldExtension -Force
		Write-VerboseInfo "removed $oldExtension"
	}
}

$piDisplay = $piBinary
if (-not $piDisplay) {
	$piDisplay = 'pi'
}
Write-Info "Pi setup complete. Run: $piDisplay"
