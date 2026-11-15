# Tempestune tray icon: runs the lavalink nodes and the bot in the background,
# shows whether everything is up, and lets you turn it off, restart, rebuild and update
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$ll = Join-Path $root 'lavalink'
$logs = Join-Path $root 'logs'
$logFile = Join-Path $logs 'tempestune.log'
$aliveFile = Join-Path $logs '.alive'
$settingsFile = Join-Path $PSScriptRoot 'settings.json'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Tempestune.lnk'
New-Item -ItemType Directory -Force $logs | Out-Null

# one tray at a time
$mutex = New-Object System.Threading.Mutex($false, 'tempestune-tray')
if (-not $mutex.WaitOne(0)) { exit }

$settings = [pscustomobject]@{ botOn = $true; autoUpdate = $true; lastUpdateCheck = '' }
$firstRun = -not (Test-Path $settingsFile)
if (-not $firstRun) {
  $saved = Get-Content $settingsFile -Raw | ConvertFrom-Json
  foreach ($p in $saved.PSObject.Properties) { $settings | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force }
}
function Save-Settings { $settings | ConvertTo-Json | Set-Content $settingsFile }
function Write-Log($text) { Add-Content -Path $logFile -Value "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) tray: $text" }

# .env goes into this process so the nodes get the lavalink password
function Read-Env {
  $vars = @{}
  foreach ($line in Get-Content (Join-Path $root '.env')) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim(); [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process') }
  }
  $vars
}
$envVars = Read-Env
function YouTube-On { ([string]$envVars['YOUTUBE']).ToLower() -eq 'on' }

$java = (Get-Command java -ErrorAction SilentlyContinue).Source
if (-not $java) { $java = Join-Path $ll 'jre\bin\java.exe' }

# small coloured dots for the tray
function New-Dot($color) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#10161c'))), 0, 0, 15, 15)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))), 3, 3, 9, 9)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{ online = New-Dot '#4fb8e0'; stuck = New-Dot '#f0a232'; off = New-Dot '#8b8f9a' }

# ---------- the three processes ----------

$script:procs = @{}
$script:fails = @{}
$script:startedAt = $null
$script:watchUntil = $null
$script:rollbackTo = $null

function Start-Part($name) {
  $p = $script:procs[$name]
  if ($p -and -not $p.HasExited) { return }
  if ($name -eq 'bot') {
    $psi = New-Object System.Diagnostics.ProcessStartInfo 'cmd.exe', "/c node --env-file=`"$root\.env`" `"$root\dist\main.js`" 2>> `"$logs\crash.log`""
    $psi.WorkingDirectory = $root
  } else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $java, "-Xms256M -Xmx1G -jar `"$ll\Lavalink.jar`""
    $psi.WorkingDirectory = Join-Path $ll $name
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:procs[$name] = [System.Diagnostics.Process]::Start($psi)
  if (-not $script:startedAt) { $script:startedAt = Get-Date }
}

function Parts { if (YouTube-On) { 'main', 'youtube', 'bot' } else { 'main', 'bot' } }

function Start-All { foreach ($n in Parts) { Start-Part $n }; Write-Log 'started' }

function Stop-All {
  foreach ($p in $script:procs.Values) { if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } }
  $script:procs = @{}
  $script:startedAt = $null
  # anything left over from boot.cmd windows or an old tray
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ll 'stop.ps1') -KeepTray | Out-Null
  Remove-Item $aliveFile -ErrorAction SilentlyContinue
}

function Invoke-Setup {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\setup.ps1') 2>&1
  $out | ForEach-Object { Write-Log "setup: $_" }
  return $LASTEXITCODE -eq 0
}

function Show-Tip($text) { $tray.ShowBalloonTip(4000, 'Tempestune', $text, 'None') }

# ---------- updates, with a rollback if the new version won't start ----------

function Update-Bot([bool]$quiet) {
  $settings.lastUpdateCheck = (Get-Date).ToString('o'); Save-Settings
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { if (-not $quiet) { Show-Tip 'Git is not installed, so I cannot update.' }; return }
  Push-Location $root
  git fetch --quiet origin main 2>$null
  $here = (git rev-parse HEAD).Trim()
  $there = (git rev-parse origin/main 2>$null)
  Pop-Location
  # only move forward: a local copy that is ahead of github (testing before a push) is left alone
  $behind = $false
  if ($there) { Push-Location $root; git merge-base --is-ancestor HEAD $there.Trim() 2>$null; $behind = $LASTEXITCODE -eq 0; Pop-Location }
  if (-not $there -or $here -eq $there.Trim() -or -not $behind) { if (-not $quiet) { Show-Tip 'Already on the newest version.' }; return }
  Push-Location $root
  git merge --ff-only --quiet origin/main 2>$null
  $merged = $LASTEXITCODE -eq 0
  Pop-Location
  if (-not $merged) { Show-Tip 'Update skipped, the local copy has its own changes.'; Write-Log 'update skipped, local changes'; return }
  Write-Log "updating $($here.Substring(0,7)) -> $($there.Trim().Substring(0,7))"
  Stop-All
  if (-not (Invoke-Setup)) { Undo-Update $here 'setup failed'; return }
  $script:envVars = Read-Env
  if ($settings.botOn) { Start-All }
  $script:watchUntil = (Get-Date).AddSeconds(90)
  $script:rollbackTo = $here
  Show-Tip 'Updated to the newest version.'
}

function Undo-Update($to, $why) {
  Write-Log "rolling back to $($to.Substring(0,7)): $why"
  Stop-All
  Push-Location $root; git reset --hard --quiet $to; Pop-Location
  Invoke-Setup | Out-Null
  if ($settings.botOn) { Start-All }
  $script:watchUntil = $null
  Show-Tip "The update broke something ($why), went back to the last working version."
}

# ---------- tray and menu ----------

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons.off
$tray.Text = 'Tempestune'
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$status = $menu.Items.Add('Tempestune')
$status.Enabled = $false
$nodesLine = $menu.Items.Add('Nodes: starting')
$nodesLine.Enabled = $false
$menu.Items.Add('-') | Out-Null
$toggle = $menu.Items.Add('Turn off')
$toggle.add_Click({
  $settings.botOn = -not $settings.botOn; Save-Settings
  if ($settings.botOn) { $script:fails = @{}; Start-All } else { Stop-All; Write-Log 'turned off from the tray' }
})
$menu.Items.Add('Restart').add_Click({ Stop-All; $settings.botOn = $true; Save-Settings; $script:envVars = Read-Env; Start-All })
$menu.Items.Add('Rebuild and restart').add_Click({
  Stop-All
  if (Invoke-Setup) { Show-Tip 'Rebuilt.' } else { Show-Tip 'Rebuild failed, see the log.' }
  $script:envVars = Read-Env
  if ($settings.botOn) { Start-All }
})
$menu.Items.Add('-') | Out-Null
$startup = $menu.Items.Add('Start with Windows')
$startup.CheckOnClick = $true
function Set-Startup([bool]$on) {
  if ($on) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($startupLink)
    $lnk.TargetPath = 'wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'tempestune-tray.vbs') + '"'
    $lnk.WorkingDirectory = $root
    $lnk.Save()
  } else { Remove-Item $startupLink -ErrorAction SilentlyContinue }
}
# first run turns startup on, after that it follows the tick
if ($firstRun) { Set-Startup $true; Save-Settings }
$startup.Checked = Test-Path $startupLink
$startup.add_Click({ Set-Startup $startup.Checked })
$auto = $menu.Items.Add('Auto update')
$auto.CheckOnClick = $true
$auto.Checked = [bool]$settings.autoUpdate
$auto.add_Click({ $settings.autoUpdate = $auto.Checked; Save-Settings })
$menu.Items.Add('Check for updates now').add_Click({ Update-Bot $false })
$menu.Items.Add('-') | Out-Null
$menu.Items.Add('Open log').add_Click({ Start-Process notepad.exe $logFile })
$menu.Items.Add('Open Lavalink log').add_Click({ Start-Process notepad.exe (Join-Path $ll 'main\logs\spring.log') })
$menu.Items.Add('Open folder').add_Click({ Start-Process explorer.exe $root })
$menu.Items.Add('-') | Out-Null
$menu.Items.Add('Quit (stops Tempestune)').add_Click({ Stop-All; $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ if ($_.Button -eq 'Left') { $menu.Show([System.Windows.Forms.Cursor]::Position) } })

# ---------- the heartbeat check ----------

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if ($settings.botOn) {
    foreach ($n in Parts) {
      $p = $script:procs[$n]
      if ($p -and -not $p.HasExited) { continue }
      if ($n -eq 'bot' -and $script:watchUntil -and (Get-Date) -lt $script:watchUntil -and $script:rollbackTo) { Undo-Update $script:rollbackTo 'it crashed on start'; return }
      $script:fails[$n] = 1 + [int]$script:fails[$n]
      # back off if something keeps falling over
      if ($script:fails[$n] -le 5 -or ($script:fails[$n] % 6) -eq 0) { Write-Log "$n was not running, starting it"; Start-Part $n }
    }
  }
  if ($script:watchUntil -and (Get-Date) -gt $script:watchUntil) { $script:watchUntil = $null; $script:fails = @{} }

  $beat = $null
  if (Test-Path $aliveFile) { try { $beat = Get-Content $aliveFile -Raw | ConvertFrom-Json } catch { } }
  $fresh = $beat -and $beat.t -gt 0 -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$beat.t) -lt 45000
  $up = { param($v) if ($v -eq $true) { 'up' } elseif ($v -eq $false) { 'down' } else { 'off' } }
  if ($beat) { $nodesLine.Text = "Main node: $(& $up $beat.main) - YouTube node: $(& $up $beat.youtube)" }

  if (-not $settings.botOn) { $tray.Icon = $icons.off; $status.Text = 'Tempestune is off'; $tray.Text = 'Tempestune - off'; $nodesLine.Text = 'Nodes: off' }
  elseif ($fresh -and $beat.main -eq $true) {
    $span = (Get-Date) - $script:startedAt
    $since = if ($span.TotalHours -ge 1) { '{0}h {1}m' -f [int][math]::Floor($span.TotalHours), $span.Minutes } else { '{0}m' -f [int]$span.TotalMinutes }
    $playing = if ($beat.players -gt 0) { " - playing in $($beat.players)" } else { '' }
    $tray.Icon = $icons.online; $status.Text = "Tempestune is online - $since$playing"; $tray.Text = "Tempestune - online $since"
  }
  elseif ($fresh) { $tray.Icon = $icons.stuck; $status.Text = 'Tempestune is up, waiting for the main node'; $tray.Text = 'Tempestune - node down' }
  else { $tray.Icon = $icons.stuck; $status.Text = 'Tempestune is starting'; $tray.Text = 'Tempestune - starting' }
  $toggle.Text = if ($settings.botOn) { 'Turn off' } else { 'Turn on' }

  # once a day, when auto update is on
  if ($settings.autoUpdate) {
    $last = [datetime]::MinValue
    [datetime]::TryParse([string]$settings.lastUpdateCheck, [ref]$last) | Out-Null
    if ((Get-Date) - $last -gt [TimeSpan]::FromHours(24)) { Update-Bot $true }
  }
})

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ll 'stop.ps1') -KeepTray | Out-Null
if ($settings.botOn) { Start-All }
$timer.Start()
[System.Windows.Forms.Application]::Run()
