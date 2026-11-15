# stops tempestune's lavalink nodes, bot and tray, nothing else
param([switch]$KeepTray)
$all = Get-CimInstance Win32_Process
$kill = @()

foreach ($port in 2333, 2334) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $kill += $_.OwningProcess }
}

foreach ($p in $all) {
  $c = $p.CommandLine
  if (-not $c) { continue }
  if ($p.Name -eq 'java.exe' -and $c -match 'Lavalink\.jar') { $kill += $p.ProcessId }
  if ($p.Name -in 'cmd.exe', 'node.exe' -and $c -match 'Tempestune\\dist\\') { $kill += $p.ProcessId }
  # windows left by older boot scripts
  if ($p.Name -eq 'cmd.exe' -and ($c -match 'lavalink\\run\.cmd' -or $c -match 'bot stopped, starting again')) { $kill += $p.ProcessId }
  if (-not $KeepTray -and $p.Name -eq 'powershell.exe' -and $c -match 'tempestune-tray\.ps1') { $kill += $p.ProcessId }
}

$kill = $kill | Where-Object { $_ -ne $PID } | Sort-Object -Unique
foreach ($id in $kill) { taskkill /T /F /PID $id 2>$null | Out-Null }
