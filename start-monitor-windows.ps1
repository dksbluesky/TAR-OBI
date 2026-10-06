$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root '.monitor-runtime'
$envFile = Join-Path $root '.env'
$entryUrl = 'https://dksbluesky.github.io/TAR-OBI/entry-assessment.html'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$servicePidFile = Join-Path $runtime 'monitor.pid'

if (-not (Test-Path -LiteralPath $tailscale)) {
    [System.Windows.Forms.MessageBox]::Show('Tailscale is not installed. Install and sign in to Tailscale, then run this launcher again.', 'TAR-OBI Monitor') | Out-Null
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

$port = if ($values['PORT']) { [int]$values['PORT'] } else { 8080 }
if (Test-Path -LiteralPath $servicePidFile) {
    $oldPid = [int](Get-Content -LiteralPath $servicePidFile -ErrorAction SilentlyContinue)
    $oldProcess = if ($oldPid -gt 0) {
        Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
    }
    $oldListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $oldPid } |
        Select-Object -First 1
    $oldMonitorRunning = $oldProcess `
        -and $oldProcess.Name -eq 'node.exe' `
        -and $oldProcess.CommandLine -match 'monitor-service\.js' `
        -and $oldListener
    if ($oldMonitorRunning) {
        [System.Windows.Forms.MessageBox]::Show('The monitor launcher already has a running service. Use stop-monitor-windows.bat before starting another copy.', 'TAR-OBI Monitor') | Out-Null
        exit 1
    }
    if ($oldProcess -and $oldProcess.Name -eq 'node.exe' -and $oldProcess.CommandLine -match 'monitor-service\.js') {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
}

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

try {
    $null = & $tailscale status 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale is not connected.' }
    $funnelOutput = (& $tailscale funnel --bg $port 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw $funnelOutput.Trim() }
    $funnelStatus = (& $tailscale funnel status 2>&1 | Out-String)
    $match = [regex]::Match($funnelStatus, 'https://[a-z0-9.-]+\.ts\.net')
    if (-not $match.Success) { throw 'Tailscale Funnel did not provide a public URL.' }
    $publicUrl = $match.Value
    $publicReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $service.Id -ErrorAction SilentlyContinue)) { break }
        try {
            $publicConfig = Invoke-RestMethod -Uri "$publicUrl/api/config" -TimeoutSec 3
            if ($publicConfig.notification -eq 'telegram') {
                $publicReady = $true
                break
            }
        } catch {}
    }
    if (-not $publicReady) { throw 'Tailscale Funnel did not become publicly reachable.' }
} catch {
    Get-Process -Id $service.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show("Tailscale Funnel did not start.`n`n$($_.Exception.Message)", 'TAR-OBI Monitor') | Out-Null
    exit 1
}

Set-Clipboard -Value $publicUrl
Start-Process $entryUrl
[System.Windows.Forms.MessageBox]::Show("Monitor service and Tailscale Funnel are running on this PC.`n`nStable Service URL (copied to clipboard):`n$publicUrl`n`nSave this URL once in Entry Assessment on each device. It remains the same after restarts. Use the private control token from your saved local .env file.", 'TAR-OBI Monitor') | Out-Null
