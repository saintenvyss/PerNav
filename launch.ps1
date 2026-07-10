# PerNav launcher (Windows) - starts the local bridge (if needed) and opens a
# Chromium-based browser with the PerNav extension loaded in an isolated profile.
#
#   .\launch.ps1                          # picks the first browser it finds
#   .\launch.ps1 -Browser brave           # chrome | edge | brave | vivaldi | opera | chromium
#   .\launch.ps1 -Browser C:\path\to\any\chromium-based.exe
#   .\launch.ps1 -Url https://example.com
#   .\launch.ps1 -ProfileDir C:\my\profile   # use a specific profile directory
#
# NOTE: keep this file pure ASCII - Windows PowerShell 5.1 misreads UTF-8 without
# a BOM, and stray smart-quote bytes break parsing.
param(
  [string]$Browser = "",
  [string]$Url = "https://example.com",
  [string]$ProfileDir = ""
)
$root      = $PSScriptRoot
$ext       = Join-Path $root 'extension'
$bridgeDir = Join-Path $root 'bridge'

# Start the bridge only if nothing is already listening on 8765.
if (-not (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue)) {
  Write-Host "[pernav] starting bridge..."
  Start-Process node -ArgumentList 'bridge.mjs' -WorkingDirectory $bridgeDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $bridgeDir 'bridge-run.log') `
    -RedirectStandardError  (Join-Path $bridgeDir 'bridge-run.err.log')
  Start-Sleep -Seconds 2
}

$candidates = [ordered]@{
  chrome   = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
               "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
               "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  edge     = @("$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
               "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")
  brave    = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
               "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
  vivaldi  = @("$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe")
  opera    = @("$env:LOCALAPPDATA\Programs\Opera\opera.exe")
  chromium = @("$env:LOCALAPPDATA\Chromium\Application\chrome.exe")
}

$exe = $null; $name = $null
if ($Browser -and (Test-Path $Browser)) {
  $exe = $Browser
  $name = [IO.Path]::GetFileNameWithoutExtension($Browser).ToLower()
} elseif ($Browser) {
  $key = $Browser.ToLower()
  if (-not $candidates.Contains($key)) {
    Write-Host "[pernav] unknown browser '$Browser' - use one of: $($candidates.Keys -join ', '), or a full .exe path"
    exit 1
  }
  $exe = $candidates[$key] | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $name = $key
  if (-not $exe) { Write-Host "[pernav] '$Browser' is not installed (or not in a standard location) - pass its full .exe path"; exit 1 }
} else {
  foreach ($k in $candidates.Keys) {
    $hit = $candidates[$k] | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($hit) { $exe = $hit; $name = $k; break }
  }
  if (-not $exe) { Write-Host "[pernav] no Chromium-based browser found - pass one with -Browser <path>"; exit 1 }
}

# One isolated profile per browser - sharing a profile dir across different
# Chromium forks corrupts it.
$prof = if ($ProfileDir) { $ProfileDir } else { Join-Path $root ".profiles\$name" }
New-Item -ItemType Directory -Force -Path $prof | Out-Null

Write-Host "[pernav] launching $name ($exe)"
Start-Process $exe -ArgumentList @(
  "--user-data-dir=$prof",
  "--load-extension=$ext",
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--no-first-run", "--no-default-browser-check",
  $Url
)
