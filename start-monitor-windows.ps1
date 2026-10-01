$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root '.monitor-runtime'
$envFile = Join-Path $root '.env'
$entryUrl = 'https://dksbluesky.github.io/TAR-OBI/entry-assessment.html'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cloudflared = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe'
$servicePidFile = Join-Path $runtime 'monitor.pid'
$tunnelPidFile = Join-Path $runtime 'tunnel.pid'

if (-not (Test-Path -LiteralPath $cloudflared)) {
    [System.Windows.Forms.MessageBox]::Show('Cloudflare Tunnel is not installed for this Windows user. Install Cloudflare.cloudflared with WinGet, then run this launcher again.', 'TAR-OBI Monitor') | Out-Null
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $root) 'ETF_DCA-plan\index.html'))) {
    [System.Windows.Forms.MessageBox]::Show('ETF_DCA-plan was not found beside TAR-OBI. The monitor static route will not work until that project folder is available.', 'TAR-OBI Monitor') | Out-Null
    exit 1
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Read-EnvValues {
    $values = @{}
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in Get-Content -LiteralPath $envFile -Encoding utf8) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
                $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
            }
        }
    }
    return $values
}

function Show-CredentialForm {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'TAR-OBI Always-On Monitor Setup'
    $form.Size = New-Object System.Drawing.Size(540, 350)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $labels = @('Fugle API Key', 'Telegram Bot Token', 'Telegram Chat ID', 'Private Control Token')
    $keys = @('FUGLE_API_KEY', 'TELEGRAM_TOKEN', 'CHAT_ID', 'TAR_OBI_CONTROL_TOKEN')
    $fields = @{}
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $labels[$i]
        $label.Location = New-Object System.Drawing.Point(18, (20 + 58 * $i))
        $label.Size = New-Object System.Drawing.Size(470, 18)
        $form.Controls.Add($label)
        $box = New-Object System.Windows.Forms.TextBox
        $box.Location = New-Object System.Drawing.Point(18, (40 + 58 * $i))
        $box.Size = New-Object System.Drawing.Size(485, 24)
        $box.UseSystemPasswordChar = $true
        $form.Controls.Add($box)
        $fields[$keys[$i]] = $box
    }

    $save = New-Object System.Windows.Forms.Button
    $save.Text = 'Save locally and start'
    $save.Location = New-Object System.Drawing.Point(343, 260)
    $save.Size = New-Object System.Drawing.Size(160, 32)
    $save.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($save)
    $form.AcceptButton = $save
    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }

    $result = @{}
    foreach ($key in $keys) {
        $value = $fields[$key].Text.Trim()
        if (-not $value) {
            [System.Windows.Forms.MessageBox]::Show("$key is required.", 'TAR-OBI Monitor') | Out-Null
            $form.Dispose()
            return $null
        }
        if ($value.Contains("`n") -or $value.Contains("`r")) {
            [System.Windows.Forms.MessageBox]::Show("$key must be a single line.", 'TAR-OBI Monitor') | Out-Null
            $form.Dispose()
            return $null
        }
        $result[$key] = $value
    }
    $form.Dispose()
    return $result
}

$values = Read-EnvValues
$required = @('FUGLE_API_KEY', 'TELEGRAM_TOKEN', 'CHAT_ID', 'TAR_OBI_CONTROL_TOKEN')
if (@($required | Where-Object { -not $values.ContainsKey($_) -or -not $values[$_] }).Count -gt 0) {
    $entered = Show-CredentialForm
    if (-not $entered) { exit 1 }
    foreach ($key in $required) { $values[$key] = $entered[$key] }
    $values['PORT'] = if ($values['PORT']) { $values['PORT'] } else { '8080' }
    $lines = @($required | ForEach-Object { "$_=$($values[$_])" }) + "PORT=$($values['PORT'])"
    [System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
}

if (Test-Path -LiteralPath $servicePidFile) {
    $oldPid = [int](Get-Content -LiteralPath $servicePidFile -ErrorAction SilentlyContinue)
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show('The monitor launcher already has a running service. Use stop-monitor-windows.bat before starting another copy.', 'TAR-OBI Monitor') | Out-Null
        exit 1
    }
    Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
}

$port = if ($values['PORT']) { [int]$values['PORT'] } else { 8080 }
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    [System.Windows.Forms.MessageBox]::Show("Port $port is already used by another process. Stop that process or change PORT in the local .env file.", 'TAR-OBI Monitor') | Out-Null
    exit 1
}

$serviceLog = Join-Path $runtime 'monitor.log'
$serviceError = Join-Path $runtime 'monitor-error.log'
$service = Start-Process -FilePath $node -ArgumentList 'monitor-service.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $serviceLog -RedirectStandardError $serviceError
Set-Content -LiteralPath $servicePidFile -Value $service.Id -Encoding ascii

$localReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $service.Id -ErrorAction SilentlyContinue)) { break }
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/config" -TimeoutSec 2
        $localReady = $true
        break
    } catch {}
}
if (-not $localReady) {
    Get-Process -Id $service.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show("The monitor service did not start. Check $serviceError.", 'TAR-OBI Monitor') | Out-Null
    exit 1
}

$tunnelOut = Join-Path $runtime 'tunnel.log'
$tunnelError = Join-Path $runtime 'tunnel-error.log'
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$port") -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelError
Set-Content -LiteralPath $tunnelPidFile -Value $tunnel.Id -Encoding ascii

$publicUrl = $null
for ($i = 0; $i -lt 60 -and -not $publicUrl; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue)) { break }
    foreach ($log in @($tunnelOut, $tunnelError)) {
        if (Test-Path -LiteralPath $log) {
            $logText = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
            if ([string]::IsNullOrWhiteSpace($logText)) { continue }
            $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($match.Success) { $publicUrl = $match.Value; break }
        }
    }
}
if (-not $publicUrl) {
    Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Id $service.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item -LiteralPath $tunnelPidFile, $servicePidFile -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show("Cloudflare Tunnel did not provide a public URL. Check $tunnelError.", 'TAR-OBI Monitor') | Out-Null
    exit 1
}

Set-Clipboard -Value $publicUrl
Start-Process $entryUrl
[System.Windows.Forms.MessageBox]::Show("Monitor service and tunnel are running on this PC.`n`nNew Service URL (copied to clipboard):`n$publicUrl`n`nIn Entry Assessment, paste this into Service URL. Use the private control token from your saved local .env file. The Mac is not needed while this PC is running.", 'TAR-OBI Monitor') | Out-Null
