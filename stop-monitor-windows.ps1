$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$runtime = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '.monitor-runtime'
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (Test-Path -LiteralPath $tailscale) {
    & $tailscale funnel --https=443 off 2>$null | Out-Null
}
foreach ($name in @('monitor.pid')) {
    $file = Join-Path $runtime $name
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $id = 0
    [void][int]::TryParse((Get-Content -LiteralPath $file -ErrorAction SilentlyContinue), [ref]$id)
    if ($id -gt 0) {
        Get-Process -Id $id -ErrorAction SilentlyContinue | Stop-Process -Force
    }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
[System.Windows.Forms.MessageBox]::Show('TAR-OBI monitor and Tailscale Funnel have been stopped.', 'TAR-OBI Monitor') | Out-Null
