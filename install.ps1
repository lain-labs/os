#Requires -Version 5.1
<#
.SYNOPSIS
    LainOS installer for Windows.

.DESCRIPTION
    Usage:
      irm https://raw.githubusercontent.com/lain-labs/os/main/install.ps1 | iex
      .\install.ps1                (from inside a checked-out LainOS repo)

    Env overrides (all optional):
      LAINOS_REPO_URL   git URL to clone (default: https://github.com/lain-labs/os.git)
      LAINOS_HOME       install root (default: $env:USERPROFILE\.lainos)
      LAINOS_REF        git ref/branch to check out (default: main)

    This script never requires an elevated/admin shell: it either uses a
    Node >=20 already on PATH, or downloads the official prebuilt zip into
    $LAINOS_HOME\node and adds it to the *user* PATH.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Error "error: $msg"; exit 1 }

# The PATH this process actually started with — captured before we prepend a
# privately-downloaded Node's directory below, so we can tell later whether a
# directory needs to be made *persistently* reachable (the user's saved PATH
# env var) or is already there for every new terminal.
$OriginalPath = $env:Path
$script:NeedsNewShell = $false
$script:NewShellDir = $null

function Ensure-PathPersisted([string]$Dir) {
  if (($OriginalPath -split ';') -contains $Dir) { return } # already durable
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if ($userPath -split ';' -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable('Path', "$Dir;$userPath", 'User')
    Write-Step "added $Dir to your user PATH"
  }
  $env:Path = "$Dir;$env:Path"
  $script:NeedsNewShell = $true
  $script:NewShellDir = $Dir
}

$LainosHome   = if ($env:LAINOS_HOME) { $env:LAINOS_HOME } else { Join-Path $env:USERPROFILE '.lainos' }
$RepoUrl      = if ($env:LAINOS_REPO_URL) { $env:LAINOS_REPO_URL } else { 'https://github.com/lain-labs/os.git' }
$Ref          = if ($env:LAINOS_REF) { $env:LAINOS_REF } else { 'main' }
$NodeMinMajor = 20
$NodePinVersion = '22.23.3' # used only when we fetch a zip ourselves

# ---------------------------------------------------------------- detect os

$archRaw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($archRaw) {
  'Arm64' { $Arch = 'arm64' }
  'X64'   { $Arch = 'x64' }
  default { Fail "unsupported architecture '$archRaw'" }
}
Write-Step "detected win32/$Arch"

# ------------------------------------------------------------- resolve node

function Get-NodeMajor([string]$NodeExe) {
  try {
    $v = & $NodeExe -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>$null
    return [int]$v
  } catch {
    return 0
  }
}

$NodeBin = $null
$NpmCmd = $null

$existing = Get-Command node -ErrorAction SilentlyContinue
if ($existing) {
  $major = Get-NodeMajor $existing.Source
  if ($major -ge $NodeMinMajor) {
    $NodeBin = $existing.Source
    $NpmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
    Write-Step "using existing Node $(& node -v) on PATH"
  } else {
    Write-Step "found Node $(& node -v) on PATH, but LainOS needs >=$NodeMinMajor — installing a private copy"
  }
} else {
  Write-Step "no Node found on PATH — installing a private copy"
}

if (-not $NodeBin) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Step "winget found — attempting Node install via winget"
    try {
      & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
      $refreshed = Get-Command node -ErrorAction SilentlyContinue
      if ($refreshed -and (Get-NodeMajor $refreshed.Source) -ge $NodeMinMajor) {
        $NodeBin = $refreshed.Source
        $NpmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
      }
    } catch {
      Write-Step "winget install failed or needs interaction — falling back to a direct download"
    }
  }
}

if (-not $NodeBin) {
  $nodeDir = Join-Path $LainosHome 'node'
  $nodeDistName = "node-v$NodePinVersion-win-$Arch"
  $nodeUrl = "https://nodejs.org/dist/v$NodePinVersion/$nodeDistName.zip"
  $extractDir = Join-Path $nodeDir $nodeDistName
  $candidateExe = Join-Path $extractDir 'node.exe'

  if (Test-Path $candidateExe) {
    Write-Step "reusing previously downloaded Node at $extractDir"
  } else {
    Write-Step "downloading Node v$NodePinVersion for win-$Arch"
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    $tmpZip = Join-Path ([System.IO.Path]::GetTempPath()) "lainos-node-$([guid]::NewGuid()).zip"
    try {
      Invoke-WebRequest -Uri $nodeUrl -OutFile $tmpZip -UseBasicParsing
    } catch {
      Fail "failed to download $nodeUrl : $_"
    }
    try {
      Expand-Archive -Path $tmpZip -DestinationPath $nodeDir -Force
    } catch {
      Fail "failed to extract Node zip: $_"
    } finally {
      Remove-Item $tmpZip -ErrorAction SilentlyContinue
    }
  }

  if (-not (Test-Path $candidateExe)) {
    Fail "Node download did not produce an executable at $candidateExe"
  }
  $NodeBin = $candidateExe
  $NpmCmd = Join-Path $extractDir 'npm.cmd'
  $env:Path = "$extractDir;$env:Path"
}

$foundMajor = Get-NodeMajor $NodeBin
if ($foundMajor -lt $NodeMinMajor) {
  Fail "resolved Node at $NodeBin is version $(& $NodeBin -v), but LainOS needs >=$NodeMinMajor"
}
Write-Step "Node ready: $(& $NodeBin -v) ($NodeBin)"

# ------------------------------------------------------------- resolve repo

function Test-LainosDir([string]$Dir) {
  $pkg = Join-Path $Dir 'package.json'
  if (-not (Test-Path $pkg)) { return $false }
  try {
    $json = Get-Content $pkg -Raw | ConvertFrom-Json
    return $json.name -eq 'lainos'
  } catch {
    return $false
  }
}

$SrcDir = $null
$scriptDir = $PSScriptRoot
if ($scriptDir -and (Test-LainosDir $scriptDir)) {
  $SrcDir = $scriptDir
  Write-Step "running from an existing LainOS checkout at $SrcDir"
} elseif (Test-LainosDir (Get-Location).Path) {
  $SrcDir = (Get-Location).Path
  Write-Step "running from an existing LainOS checkout at $SrcDir"
} else {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) { Fail "git is required to fetch LainOS (no local checkout found and git is not on PATH) — install Git for Windows and re-run" }

  $appDir = Join-Path $LainosHome 'app'
  if (Test-Path (Join-Path $appDir '.git')) {
    Write-Step "updating existing checkout at $appDir"
    Push-Location $appDir
    try {
      & git fetch --depth 1 origin $Ref
      if ($LASTEXITCODE -ne 0) { Fail "git fetch failed in $appDir" }
      & git checkout -q $Ref 2>$null
      & git reset -q --hard "origin/$Ref"
      if ($LASTEXITCODE -ne 0) { Fail "git reset failed in $appDir" }
    } finally {
      Pop-Location
    }
  } else {
    Write-Step "cloning $RepoUrl into $appDir"
    New-Item -ItemType Directory -Force -Path $LainosHome | Out-Null
    & git clone --depth 1 --branch $Ref $RepoUrl $appDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone of $RepoUrl failed" }
  }
  $SrcDir = $appDir
}

Set-Location $SrcDir

# ------------------------------------------------------------- build

Write-Step "installing dependencies (npm install)"
& $NpmCmd install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed in $SrcDir" }

Write-Step "building LainOS (npm run build)"
& $NpmCmd run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build failed in $SrcDir" }

# ------------------------------------------------------------- expose `lain`

$linked = $false
try {
  & $NpmCmd link 2>$null | Out-Null
  $linkedCmd = Get-Command lain -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -eq 0 -and $linkedCmd) {
    $linked = $true
    Write-Step "linked the 'lain' command via npm link ($($linkedCmd.Source))"
    Ensure-PathPersisted (Split-Path -Parent $linkedCmd.Source)
  }
} catch {
  # fall through to the shim below
}

if (-not $linked) {
  Write-Step "npm link unavailable or not on PATH — installing wrapper scripts instead"
  $binDir = Join-Path $LainosHome 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  function Write-Shim([string]$Name, [string]$DistScript) {
    $shimPath = Join-Path $binDir "$Name.cmd"
    $target = Join-Path $SrcDir "dist\scripts\$DistScript"
    @"
@echo off
"$NodeBin" "$target" %*
"@ | Set-Content -Path $shimPath -Encoding ASCII
    Write-Step "wrote $shimPath"
  }
  Write-Shim 'lain' 'tui.js'
  Write-Shim 'lain-cli' 'chat.js'
  Write-Shim 'lain-serve' 'serve.js'
  Ensure-PathPersisted $binDir
}

# ------------------------------------------------------------- .env

$envPath = Join-Path $SrcDir '.env'
$envExamplePath = Join-Path $SrcDir '.env.example'
if (-not (Test-Path $envPath)) {
  Copy-Item $envExamplePath $envPath
  Write-Step "created $envPath from .env.example — edit it before running lain"
  Write-Step "at minimum, set an on-chain endpoint (CHAIN_RPC_URL, CHAIN_ID) and one model provider key (e.g. ANTHROPIC_API_KEY or OPENROUTER_API_KEY)"
} else {
  Write-Step "$envPath already exists — leaving it as is"
}

# ------------------------------------------------------------- done

Write-Host ""
Write-Step "LainOS is installed at $SrcDir"
Write-Step "next: edit $envPath, then run: lain (TUI), lain-cli (REPL), or lain-serve (daemon)"

if ($script:NeedsNewShell) {
  Write-Step "open a new terminal for 'lain' to be found (added to your user PATH: $($script:NewShellDir))"
}
