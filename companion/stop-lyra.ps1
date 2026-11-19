# Puts every running part of Lyra to sleep: her mind (lyra-runtime), her ears, her hologram server,
# and their windows, including old launcher windows. Used by Start Lyra.bat (before a fresh start) and Stop Lyra.bat.
# -DryRun lists what it would close without closing anything.
param([switch]$DryRun)

$me = $PID
$launcher = (Get-CimInstance Win32_Process -Filter "ProcessId=$me").ParentProcessId   # the .bat window that called us
$targets = @{}

# Her windows, found by what they run (closing a window closes everything started inside it)
foreach ($p in Get-CimInstance Win32_Process) {
  if ($p.ProcessId -eq $me -or $p.ProcessId -eq $launcher) { continue }
  $cmd = [string]$p.CommandLine
  # recorder-profile: her hidden video recorder (a headless browser that only she uses)
  if ($cmd -match 'lyra-runtime\\start\.bat' -or $cmd -match 'ears\\ears\.py' -or $cmd -match 'Start Lyra\.bat' -or $cmd -match 'recorder-profile') {
    $targets[[int]$p.ProcessId] = $cmd
  }
}

# Anything still holding her ports (mind 3010, hologram 8770, ears 8772), even without a window
foreach ($port in 3010, 8770, 8772) {
  foreach ($c in Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    if ($c.OwningProcess -ne $me -and $c.OwningProcess -ne $launcher) { $targets[[int]$c.OwningProcess] = "port $port" }
  }
}

if (-not $targets.Count) { Write-Host "Lyra wasn't running."; exit 0 }
foreach ($id in $targets.Keys) {
  $what = $targets[$id]; if ($what.Length -gt 90) { $what = $what.Substring(0, 90) + '...' }
  if ($DryRun) { Write-Host "would close $id  ($what)" }
  else { cmd.exe /c "taskkill /pid $id /t /f >nul 2>&1"; Write-Host "closed $id  ($what)" }  # already gone is fine
}
if (-not $DryRun) { Start-Sleep -Seconds 2 }
