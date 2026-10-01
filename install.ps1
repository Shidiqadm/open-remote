# Installs the Open Remote helper (native messaging host) for Chromium-based
# browsers on Windows.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <id>[,<id>]
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param(
  [string[]]$ExtensionId = @(),
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

$HostName = "io.github.shidiqadm.openremote"
$LegacyHostNames = @("com.atvremote.host")
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Join-Path $Root "host"
$Launcher = Join-Path $HostDir "open-remote-host.bat"
$ManifestPath = Join-Path $HostDir "$HostName.json"
$RegistryRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Vivaldi\NativeMessagingHosts"
)

function Remove-Registration([string[]]$Names) {
  foreach ($r in $RegistryRoots) {
    foreach ($n in $Names) {
      Remove-Item -Path "$r\$n" -ErrorAction SilentlyContinue
    }
  }
}

if ($Uninstall) {
  Remove-Registration (@($HostName) + $LegacyHostNames)
  Remove-Item -Recurse -Force (Join-Path $HostDir ".venv") -ErrorAction SilentlyContinue
  Remove-Item -Force $Launcher, $ManifestPath -ErrorAction SilentlyContinue
  Write-Host "Helper removed. Pairing keys are kept in %APPDATA%\OpenRemote; delete it to unpair everything."
  exit 0
}

# Allowed extension IDs: the list file plus any given on the command line.
$Ids = @(Get-Content (Join-Path $HostDir "extension-ids.txt") |
  ForEach-Object { ($_ -split "#")[0].Trim() } |
  Where-Object { $_ }) + @($ExtensionId | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Ids = @($Ids | Select-Object -Unique)
if ($Ids.Count -eq 0) { Write-Error "No extension IDs in host\extension-ids.txt or on the command line." }
foreach ($id in $Ids) {
  if ($id -notmatch "^[a-p]{32}$") { Write-Error "Not a valid extension ID: $id" }
}

# Find Python 3.10+ (prefer the py launcher).
$Candidates = @(
  @{ Exe = "py"; Args = @("-3") },
  @{ Exe = "python"; Args = @() },
  @{ Exe = "python3"; Args = @() }
)
$Python = $null
foreach ($c in $Candidates) {
  try {
    $pyArgs = $c.Args
    & $c.Exe @pyArgs -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { $Python = $c; break }
  } catch {}
}
if (-not $Python) {
  Write-Error "Python 3.10 or newer is required. Install it from https://www.python.org/downloads/ (tick 'Add to PATH')."
}
$exe = $Python.Exe; $pyArgs = $Python.Args

# Native commands don't trip $ErrorActionPreference, so check exit codes.
function Invoke-Checked([string]$What, [scriptblock]$Block) {
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

Write-Host "Creating virtual environment..."
Invoke-Checked "Creating the virtual environment" { & $exe @pyArgs -m venv (Join-Path $HostDir ".venv") }
$VenvPy = Join-Path $HostDir ".venv\Scripts\python.exe"
Invoke-Checked "Upgrading pip" { & $VenvPy -m pip install --quiet --upgrade pip }
Invoke-Checked "Installing dependencies" { & $VenvPy -m pip install --quiet -r (Join-Path $HostDir "requirements.txt") }

Set-Content -Path $Launcher -Encoding ASCII -Value "@echo off`r`n`"%~dp0.venv\Scripts\python.exe`" `"%~dp0open_remote_host.py`" %*"

$Manifest = [ordered]@{
  name            = $HostName
  description     = "Open Remote helper for Android TV / Google TV"
  path            = $Launcher
  type            = "stdio"
  allowed_origins = @($Ids | ForEach-Object { "chrome-extension://$_/" })
}
# PowerShell 5 writes a BOM with -Encoding UTF8, which Chrome rejects; write it without one.
[System.IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

Remove-Registration $LegacyHostNames
foreach ($r in $RegistryRoots) {
  $key = "$r\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $ManifestPath
}

Write-Host ""
Write-Host "Done. Allowed extension IDs: $($Ids -join ', ')"
Write-Host "If you move this folder, run install.ps1 again."
