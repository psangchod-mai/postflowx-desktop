# PostFlowX Native Helper — Windows Installer
# Run in PowerShell: Right-click → "Run with PowerShell"
# Or from a terminal: powershell -ExecutionPolicy Bypass -File install_postflowx_helper.ps1
#Requires -Version 5.0

$HostName   = "com.postflowx.companion"
# Pre-filled by the PostFlowX extension when downloaded from the panel.
$ExtensionId = "PASTE_YOUR_EXTENSION_ID_HERE"

# ── Validate extension ID ────────────────────────────────────────────────────
if ([string]::IsNullOrEmpty($ExtensionId) -or $ExtensionId -eq "PASTE_YOUR_EXTENSION_ID_HERE") {
    $ExtensionId = Read-Host "Enter your PostFlowX Extension ID (32 lowercase letters)"
}
if ($ExtensionId -notmatch '^[a-z]{32}$') {
    Write-Error "Extension ID must be exactly 32 lowercase letters. Got: '$ExtensionId'"
    exit 1
}

# ── Find Python 3.10+ ────────────────────────────────────────────────────────
$Python = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd -c "import sys; print('%d%d' % sys.version_info[:2])" 2>$null
        if ($ver -as [int] -ge 310) {
            $Python = $cmd
            break
        }
    } catch {}
}
if (-not $Python) {
    Write-Error "Python 3.10 or later is required. Install from https://python.org and re-run."
    exit 1
}
Write-Host "Using Python: $Python ($(& $Python --version))"

# ── Install postflowx-companion ───────────────────────────────────────────────
Write-Host "Installing postflowx-companion..."
& $Python -m pip install --quiet --upgrade postflowx-companion

# ── Create wrapper batch file ─────────────────────────────────────────────────
$InstallDir = Join-Path $env:LOCALAPPDATA "PostFlowX\Helper"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$WrapperPath = Join-Path $InstallDir "postflowx-helper.bat"
$WrapperContent = "@echo off`r`n`"$Python`" -m postflowx_companion.app --mode native-host %*`r`n"
[System.IO.File]::WriteAllText($WrapperPath, $WrapperContent, [System.Text.Encoding]::ASCII)
Write-Host "Wrapper created: $WrapperPath"

# ── Write manifest JSON ───────────────────────────────────────────────────────
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$Manifest = @{
    name            = $HostName
    description     = "PostFlowX Native Helper — AAF export and media tools"
    path            = $WrapperPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $Manifest, [System.Text.UTF8Encoding]::new($false))
Write-Host "Manifest written: $ManifestPath"

# ── Register in Windows registry ──────────────────────────────────────────────
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath
Write-Host "Registry key set: $RegPath"

Write-Host ""
Write-Host "Installation complete!"
Write-Host "  Host:         $HostName"
Write-Host "  Extension ID: $ExtensionId"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Quit and relaunch Chrome."
Write-Host "  2. Open PostFlowX and click 'Re-check Helper' in the AAF panel."
Read-Host "Press Enter to close"
