#!/usr/bin/env pwsh
#
# Smoke tests for setup.ps1. They use a temporary HOME and a fake pi binary,
# so they never touch the real Pi configuration or network.
#
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$Setup = Join-Path $Root 'setup.ps1'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("pi-setup-test-" + [guid]::NewGuid().ToString('N'))
$onWindows = ([Environment]::GetEnvironmentVariable('OS') -eq 'Windows_NT')

New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

$script:Failures = 0

function Pass {
	param([string]$Message)
	Write-Host "ok - $Message"
}

function Fail-Test {
	param([string]$Message)
	Write-Host "not ok - $Message" -ForegroundColor Red
	$script:Failures++
}

function Assert-True {
	param(
		[bool]$Condition,
		[string]$Message
	)
	if ($Condition) { Pass $Message } else { Fail-Test $Message }
}

function Assert-Equals {
	param(
		[string]$Actual,
		[string]$Expected,
		[string]$Message
	)
	if ($Actual -eq $Expected) {
		Pass $Message
	} else {
		Fail-Test "$Message (expected '$Expected', got '$Actual')"
	}
}

function Get-Text {
	param([string]$Path)
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
		return ''
	}
	return [string](Get-Content -LiteralPath $Path -Raw)
}

function Assert-Contains {
	param(
		[string]$Path,
		[string]$Needle,
		[string]$Message
	)
	if ((Get-Text -Path $Path).Contains($Needle)) {
		Pass $Message
	} else {
		Fail-Test "$Message (missing '$Needle' in $Path)"
	}
}

function Assert-File {
	param(
		[string]$Path,
		[string]$Message
	)
	if (Test-Path -LiteralPath $Path -PathType Leaf) { Pass $Message } else { Fail-Test "$Message (missing $Path)" }
}

function Assert-NoFile {
	param(
		[string]$Path,
		[string]$Message
	)
	if (-not (Test-Path -LiteralPath $Path)) { Pass $Message } else { Fail-Test "$Message (unexpected $Path)" }
}

function Get-BackupCount {
	param([string]$Directory)
	if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
		return 0
	}
	return @(Get-ChildItem -LiteralPath $Directory -Filter '*.bak-*' -ErrorAction SilentlyContinue).Count
}

function New-Case {
	$caseRoot = Join-Path $Tmp ("case-" + [guid]::NewGuid().ToString('N'))
	$homeDir = Join-Path $caseRoot 'home'
	$bin = Join-Path $caseRoot 'bin'
	$log = Join-Path $caseRoot 'pi.log'
	$gitLog = Join-Path $caseRoot 'git.log'
	$cloneFixtures = Join-Path $caseRoot 'clones'

	New-Item -ItemType Directory -Path (Join-Path $homeDir 'dev/FIT_pi') -Force | Out-Null
	New-Item -ItemType Directory -Path (Join-Path $homeDir 'dev/sin/pi_questionare/extensions') -Force | Out-Null
	New-Item -ItemType Directory -Path (Join-Path $homeDir 'dev/pi-git-commands') -Force | Out-Null
	New-Item -ItemType Directory -Path (Join-Path $cloneFixtures 'FIT_pi') -Force | Out-Null
	New-Item -ItemType Directory -Path (Join-Path $cloneFixtures 'pi-git-commands') -Force | Out-Null
	New-Item -ItemType Directory -Path $bin -Force | Out-Null

	Set-Content -LiteralPath (Join-Path $homeDir 'dev/FIT_pi/package.json') -Value @'
{
  "name": "pi-fit",
  "pi": { "extensions": ["./src/index.ts"] }
}
'@

	Set-Content -LiteralPath (Join-Path $homeDir 'dev/sin/pi_questionare/package.json') -Value @'
{
  "name": "@sloppymcslopperson/pi-questions",
  "pi": { "extensions": ["./extensions/questionnaire.ts"] }
}
'@

	Set-Content -LiteralPath (Join-Path $homeDir 'dev/sin/pi_questionare/extensions/questionnaire.ts') -Value @'
export default function questionnaire() {
	return undefined;
}
'@

	Set-Content -LiteralPath (Join-Path $homeDir 'dev/pi-git-commands/package.json') -Value @'
{
  "name": "@svyaddict/pi-git-commands",
  "pi": { "extensions": ["./extensions/index.ts"] }
}
'@

	Copy-Item -LiteralPath (Join-Path $homeDir 'dev/FIT_pi/package.json') -Destination (Join-Path $cloneFixtures 'FIT_pi/package.json')
	Copy-Item -LiteralPath (Join-Path $homeDir 'dev/pi-git-commands/package.json') -Destination (Join-Path $cloneFixtures 'pi-git-commands/package.json')

	if ($onWindows) {
		$fake = @'
@echo off
echo %*>>"%PI_LOG%"
if not "%FAKE_PI_FAIL_ON%"=="" (
  echo %* | findstr /C:"%FAKE_PI_FAIL_ON%" >nul && exit /b 1
)
exit /b 0
'@
		Set-Content -LiteralPath (Join-Path $bin 'pi.cmd') -Value $fake -Encoding ASCII

		$fakeGit = @'
@echo off
echo %*>>"%GIT_LOG%"
set "URL=%~2"
set "DEST=%~3"
if not "%1"=="clone" exit /b 0
if "%URL%"=="git@github.com:Zaphodious/FIT_pi.git" set "NAME=FIT_pi"
if "%URL%"=="https://github.com/svyaddict/pi-git-commands.git" set "NAME=pi-git-commands"
xcopy /E /I /Y "%GIT_CLONE_FIXTURES%\%NAME%" "%DEST%" >nul
exit /b 0
'@
		Set-Content -LiteralPath (Join-Path $bin 'git.cmd') -Value $fakeGit -Encoding ASCII
	} else {
		$fake = @'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PI_LOG"
if [ -n "${FAKE_PI_FAIL_ON:-}" ] && [[ "$*" == *"$FAKE_PI_FAIL_ON"* ]]; then
  exit 1
fi
exit 0
'@
		$fakePath = Join-Path $bin 'pi'
		Set-Content -LiteralPath $fakePath -Value $fake
		& chmod +x $fakePath

		$fakeGit = @'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_LOG"
if [ "$1" = clone ]; then
  url="$2"
  dest="$3"
  name=${url##*/}
  name=${name%.git}
  mkdir -p "$dest"
  cp -R "$GIT_CLONE_FIXTURES/$name/." "$dest/"
fi
exit 0
'@
		$fakeGitPath = Join-Path $bin 'git'
		Set-Content -LiteralPath $fakeGitPath -Value $fakeGit
		& chmod +x $fakeGitPath
	}

	New-Item -ItemType File -Path $log -Force | Out-Null
	New-Item -ItemType File -Path $gitLog -Force | Out-Null
	return [pscustomobject]@{
		Root = $caseRoot
		Home = $homeDir
		Bin = $bin
		Log = $log
		GitLog = $gitLog
		CloneFixtures = $cloneFixtures
	}
}

function Invoke-Setup {
	param(
		[object]$Case,
		[string[]]$Arguments,
		[hashtable]$Environment = @{}
	)

	$managed = @('HOME', 'USERPROFILE', 'PATH', 'PI_LOG', 'GIT_LOG', 'GIT_CLONE_FIXTURES', 'FAKE_PI_FAIL_ON', 'FIT_PI_SRC', 'QUESTIONNAIRE_SRC', 'GIT_COMMANDS_SRC')
	$saved = @{}
	foreach ($key in $managed) {
		$saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
	}

	try {
		if ($onWindows) {
			$env:USERPROFILE = $Case.Home
		} else {
			$env:HOME = $Case.Home
		}
		$env:PATH = "$($Case.Bin)$([IO.Path]::PathSeparator)$env:PATH"
		$env:PI_LOG = $Case.Log
		$env:GIT_LOG = $Case.GitLog
		$env:GIT_CLONE_FIXTURES = $Case.CloneFixtures

		foreach ($key in @('FAKE_PI_FAIL_ON', 'FIT_PI_SRC', 'QUESTIONNAIRE_SRC', 'GIT_COMMANDS_SRC')) {
			[Environment]::SetEnvironmentVariable($key, $null, 'Process')
		}
		foreach ($key in $Environment.Keys) {
			[Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
		}

		$parameters = @{}
		foreach ($argument in $Arguments) {
			switch ($argument) {
				'-DryRun' { $parameters['DryRun'] = $true }
				'-SkipUpdate' { $parameters['SkipUpdate'] = $true }
				'-Verbose' { $parameters['Verbose'] = $true }
				'-Yes' { $parameters['Yes'] = $true }
				'-Help' { $parameters['Help'] = $true }
				default { throw "unsupported test argument: $argument" }
			}
		}

		try {
			$output = (& $Setup @parameters 6>&1 | Out-String)
			return [pscustomobject]@{ Success = $true; Error = ''; Output = $output }
		} catch {
			return [pscustomobject]@{ Success = $false; Error = $_.Exception.Message; Output = '' }
		}
	} finally {
		foreach ($key in $saved.Keys) {
			[Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
		}
	}
}

function Test-InstallPackages {
	$case = New-Case
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate', '-Yes')
	if (-not $result.Success) {
		Fail-Test "basic setup succeeds ($($result.Error))"
		return
	}
	Pass 'basic setup succeeds'

	$fitPiPath = "$($case.Home)/dev/FIT_pi".Replace('/', [IO.Path]::DirectorySeparatorChar)
	$questionnairePath = "$($case.Home)/dev/sin/pi_questionare".Replace('/', [IO.Path]::DirectorySeparatorChar)
	$gitCommandsPath = "$($case.Home)/dev/pi-git-commands".Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-Contains -Path $case.Log -Needle "install $fitPiPath" -Message 'installs FIT_pi by discovered path'
	Assert-Contains -Path $case.Log -Needle "install $questionnairePath" -Message 'installs questionnaire package by discovered path'
	Assert-Contains -Path $case.Log -Needle "install $gitCommandsPath" -Message 'installs pi-git-commands by discovered path'
	Assert-NoFile -Path (Join-Path $case.Home '.pi/agent/extensions/questionnaire.ts') -Message 'does not copy a bare extension'
	Assert-True -Condition (-not (Get-Text -Path $case.Log).Contains('update')) -Message '-SkipUpdate avoids update commands'
}

function Test-DryRun {
	$case = New-Case
	$result = Invoke-Setup -Case $case -Arguments @('-DryRun', '-SkipUpdate')
	if (-not $result.Success) {
		Fail-Test "dry run succeeds ($($result.Error))"
		return
	}
	Pass 'dry run succeeds'
	$fitPiPath = "$($case.Home)/dev/FIT_pi".Replace('/', [IO.Path]::DirectorySeparatorChar)
	$gitCommandsPath = "$($case.Home)/dev/pi-git-commands".Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-True -Condition ($result.Output.Contains("install $fitPiPath")) -Message 'dry run prints planned FIT_pi install'
	Assert-True -Condition ($result.Output.Contains("install $gitCommandsPath")) -Message 'dry run prints planned pi-git-commands install'
	Assert-Equals -Actual (Get-Text -Path $case.Log) -Expected '' -Message 'dry run does not invoke pi'
	Assert-NoFile -Path (Join-Path $case.Home '.pi/agent/extensions/questionnaire.ts') -Message 'dry run does not write an extension copy'
}

function Test-UpdateOrder {
	$case = New-Case
	$result = Invoke-Setup -Case $case -Arguments @('-Yes')
	if (-not $result.Success) {
		Fail-Test "setup with updates succeeds ($($result.Error))"
		return
	}
	Pass 'setup with updates succeeds'
	$lines = @(Get-Content -LiteralPath $case.Log | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
	if ($lines.Count -ge 2) {
		Assert-Equals -Actual $lines[0] -Expected 'update' -Message 'updates Pi first'
		Assert-Equals -Actual $lines[1] -Expected 'update --extensions' -Message 'updates packages second'
	} else {
		Fail-Test 'update commands were logged'
	}
	$fitPiPath = "$($case.Home)/dev/FIT_pi".Replace('/', [IO.Path]::DirectorySeparatorChar)
	$questionnairePath = "$($case.Home)/dev/sin/pi_questionare".Replace('/', [IO.Path]::DirectorySeparatorChar)
	$gitCommandsPath = "$($case.Home)/dev/pi-git-commands".Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-Contains -Path $case.Log -Needle "install $fitPiPath" -Message 'installs FIT_pi after updates'
	Assert-Contains -Path $case.Log -Needle "install $questionnairePath" -Message 'installs questionnaire after FIT_pi'
	Assert-Contains -Path $case.Log -Needle "install $gitCommandsPath" -Message 'installs pi-git-commands after questionnaire'
}

function Test-IdempotentRuns {
	$case = New-Case
	$first = Invoke-Setup -Case $case -Arguments @('-SkipUpdate')
	$second = Invoke-Setup -Case $case -Arguments @('-SkipUpdate')
	if (-not $first.Success -or -not $second.Success) {
		Fail-Test 'setup can run twice'
		return
	}
	Pass 'setup can run twice'
	$backups = Get-BackupCount -Directory (Join-Path $case.Home '.pi/agent/extensions')
	Assert-Equals -Actual ([string]$backups) -Expected '0' -Message 'no extension backups are created when there is no old copy'
}

function Test-PackageSwitch {
	$case = New-Case
	$questionnaire = Join-Path $case.Home 'dev/sin/pi_questionare'
	$extensionDir = Join-Path $case.Home '.pi/agent/extensions'
	New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
	$extension = Join-Path $extensionDir 'questionnaire.ts'
	Set-Content -LiteralPath $extension -Value 'old copy'

	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate')
	if (-not $result.Success) {
		Fail-Test "package switch succeeds ($($result.Error))"
		return
	}
	Pass 'package switch succeeds'
	$questionnairePath = $questionnaire.Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-Contains -Path $case.Log -Needle "install $questionnairePath" -Message 'installs questionnaire package'
	Assert-NoFile -Path $extension -Message 'removes old extension copy'
	$backups = Get-BackupCount -Directory $extensionDir
	Assert-Equals -Actual ([string]$backups) -Expected '1' -Message 'backs up old extension before removal'
}

function Test-FailureIsFatal {
	$case = New-Case
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate') -Environment @{ FAKE_PI_FAIL_ON = 'install' }
	if ($result.Success) {
		Fail-Test 'install failure exits non-zero'
	} else {
		Pass 'install failure exits non-zero'
	}
}

function Test-AmbiguousDiscovery {
	$case = New-Case
	$other = Join-Path $case.Home 'dev/other/FIT_pi'
	New-Item -ItemType Directory -Path $other -Force | Out-Null
	Copy-Item -LiteralPath (Join-Path $case.Home 'dev/FIT_pi/package.json') -Destination (Join-Path $other 'package.json')
	$result = Invoke-Setup -Case $case -Arguments @('-DryRun', '-SkipUpdate')
	if ($result.Success) {
		Fail-Test 'ambiguous discovery fails'
	} else {
		Pass 'ambiguous discovery fails'
	}
	Assert-True -Condition ($result.Error.Contains('found multiple FIT_pi package candidates')) -Message 'ambiguous discovery explains the problem'
}

function Test-CloneMissingFitPi {
	$case = New-Case
	Remove-Item -LiteralPath (Join-Path $case.Home 'dev/FIT_pi') -Recurse -Force
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate')
	if (-not $result.Success) {
		Fail-Test "missing FIT_pi is cloned ($($result.Error))"
		return
	}
	Pass 'missing FIT_pi is cloned'
	$target = "$($case.Home)/dev/FIT_pi".Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-Contains -Path $case.GitLog -Needle "clone git@github.com:Zaphodious/FIT_pi.git $target" -Message 'clones FIT_pi from GitHub into HOME/dev'
	Assert-Contains -Path $case.Log -Needle "install $target" -Message 'installs the cloned FIT_pi checkout'
}

function Test-MissingPackage {
	$case = New-Case
	Remove-Item -LiteralPath (Join-Path $case.Home 'dev/sin/pi_questionare/package.json') -Force
	$result = Invoke-Setup -Case $case -Arguments @('-DryRun', '-SkipUpdate')
	if ($result.Success) {
		Fail-Test 'questionnaire without a package manifest fails'
	} else {
		Pass 'questionnaire without a package manifest fails'
	}
	Assert-True -Condition ($result.Error.Contains('does not look valid')) -Message 'missing package manifest explains the problem'
}

function Test-VendoredQuestionnaireFallback {
	$case = New-Case
	Remove-Item -LiteralPath (Join-Path $case.Home 'dev/sin/pi_questionare') -Recurse -Force
	$result = Invoke-Setup -Case $case -Arguments @('-DryRun', '-SkipUpdate')
	if (-not $result.Success) {
		Fail-Test "missing questionnaire falls back to the vendored copy ($($result.Error))"
		return
	}
	Pass 'missing questionnaire falls back to the vendored copy'
	$vendorPath = (Join-Path (Join-Path $Root 'vendor') 'pi_questionare').Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-True -Condition ($result.Output.Contains("Questionnaire: $vendorPath")) -Message 'uses the vendored questionnaire path'
	Assert-True -Condition ($result.Output.Contains("install $vendorPath")) -Message 'prints the vendored questionnaire install'
}

function Test-InvalidGitCommandsPackage {
	$case = New-Case
	Set-Content -LiteralPath (Join-Path $case.Home 'dev/pi-git-commands/package.json') -Value @'
{
  "name": "some-other-package",
  "pi": { "extensions": ["./extensions/index.ts"] }
}
'@
	$result = Invoke-Setup -Case $case -Arguments @('-DryRun', '-SkipUpdate')
	if ($result.Success) {
		Fail-Test 'pi-git-commands with the wrong package name fails'
	} else {
		Pass 'pi-git-commands with the wrong package name fails'
	}
	Assert-True -Condition ($result.Error.Contains('does not look valid')) -Message 'wrong pi-git-commands package name explains the problem'
}

function Test-CloneMissingGitCommands {
	$case = New-Case
	Remove-Item -LiteralPath (Join-Path $case.Home 'dev/pi-git-commands') -Recurse -Force
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate')
	if (-not $result.Success) {
		Fail-Test "missing pi-git-commands is cloned ($($result.Error))"
		return
	}
	Pass 'missing pi-git-commands is cloned'
	$target = "$($case.Home)/dev/pi-git-commands".Replace('/', [IO.Path]::DirectorySeparatorChar)
	Assert-Contains -Path $case.GitLog -Needle "clone https://github.com/svyaddict/pi-git-commands.git $target" -Message 'clones pi-git-commands from GitHub into HOME/dev'
	Assert-Contains -Path $case.Log -Needle "install $target" -Message 'installs the cloned pi-git-commands checkout'
}

function Test-EnvOverride {
	$case = New-Case
	$custom = Join-Path $case.Root 'custom-fit'
	Move-Item -LiteralPath (Join-Path $case.Home 'dev/FIT_pi') -Destination $custom
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate') -Environment @{ FIT_PI_SRC = $custom }
	if (-not $result.Success) {
		Fail-Test "FIT_PI_SRC override succeeds ($($result.Error))"
		return
	}
	Pass 'FIT_PI_SRC override succeeds'
	Assert-Contains -Path $case.Log -Needle "install $custom" -Message 'override path is used'
}

function Test-GitCommandsEnvOverride {
	$case = New-Case
	$custom = Join-Path $case.Root 'custom-git-commands'
	Move-Item -LiteralPath (Join-Path $case.Home 'dev/pi-git-commands') -Destination $custom
	$result = Invoke-Setup -Case $case -Arguments @('-SkipUpdate') -Environment @{ GIT_COMMANDS_SRC = $custom }
	if (-not $result.Success) {
		Fail-Test "GIT_COMMANDS_SRC override succeeds ($($result.Error))"
		return
	}
	Pass 'GIT_COMMANDS_SRC override succeeds'
	Assert-Contains -Path $case.Log -Needle "install $custom" -Message 'git commands override path is used'
}

try {
	Test-InstallPackages
	Test-DryRun
	Test-UpdateOrder
	Test-IdempotentRuns
	Test-PackageSwitch
	Test-FailureIsFatal
	Test-AmbiguousDiscovery
	Test-CloneMissingFitPi
	Test-MissingPackage
	Test-VendoredQuestionnaireFallback
	Test-InvalidGitCommandsPackage
	Test-CloneMissingGitCommands
	Test-EnvOverride
	Test-GitCommandsEnvOverride
} finally {
	Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Failures -ne 0) {
	Write-Host ""
	Write-Host "$($script:Failures) test(s) failed" -ForegroundColor Red
	exit 1
}

Write-Host ""
Write-Host 'All PowerShell setup tests passed.'
