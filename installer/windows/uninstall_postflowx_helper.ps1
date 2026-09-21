# PostFlowX Native Helper — Windows Uninstaller
#Requires -Version 5.0

$HostName   = "com.postflowx.companion"
$InstallDir = Join-Path $env:LOCALAPPDATA "PostFlowX\Helper"
$RegPath    = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

Write-Host "Removing registry key..."
if (Test-Path $RegPath) {
    Remove-Item -Path $RegPath -Force
    Write-Host "  Removed: $RegPath"
} else {
    Write-Host "  Not found (skipping): $RegPath"
}

Write-Host "Removing helper files..."
$FilesToRemove = @(
    (Join-Path $InstallDir "postflowx-helper.bat"),
    (Join-Path $InstallDir "$HostName.json")
)
foreach ($f in $FilesToRemove) {
    if (Test-Path $f) {
        Remove-Item $f -Force
        Write-Host "  Removed: $f"
    }
}
if ((Test-Path $InstallDir) -and -not (Get-ChildItem $InstallDir)) {
    Remove-Item $InstallDir -Force
}

Write-Host ""
Write-Host "Uninstall complete. Quit and relaunch Chrome to apply."
Read-Host "Press Enter to close"
