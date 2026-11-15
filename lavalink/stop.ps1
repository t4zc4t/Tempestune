# stops tempestune's lavalink nodes and bot loop, nothing else
$all = Get-CimInstance Win32_Process
$kill = @()

foreach ($port in 2333, 2334) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $kill += $_.OwningProcess }
}

foreach ($p in $all) {
  if (-not $p.CommandLine) { continue }
  if ($p.Name -eq 'cmd.exe' -and ($p.CommandLine -match 'lavalink\\run\.cmd' -or $p.CommandLine -match 'bot stopped, starting again')) { $kill += $p.ProcessId }
  if ($p.Name -eq 'java.exe' -and $p.CommandLine -match 'Lavalink\.jar') { $kill += $p.ProcessId }
}

# the run.cmd loop sits above java, take it down too so it can't restart
foreach ($id in @($kill)) {
  $parent = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
  if ($parent) {
    $up = $all | Where-Object { $_.ProcessId -eq $parent.ParentProcessId -and $_.Name -eq 'cmd.exe' } | Select-Object -First 1
    if ($up -and $up.CommandLine -match 'run\.cmd') { $kill += $up.ProcessId }
  }
}

$kill = $kill | Sort-Object -Unique
foreach ($id in $kill) { taskkill /T /F /PID $id 2>$null | Out-Null }
Write-Output "stopped $($kill.Count) process(es)"
