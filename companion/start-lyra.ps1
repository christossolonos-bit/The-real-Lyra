# Starts Lyra with no windows on screen. Closes any running Lyra first, then starts her mind,
# her ears and her hologram hidden, each writing to companion\logs\, and opens her page.
# If she doesn't come up, a message box says which log to look at.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path (Split-Path -Parent $here) 'lyra-runtime'
$logs = Join-Path $here 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

# 1. Put any running Lyra to sleep
try { & (Join-Path $here 'stop-lyra.ps1') *>&1 | Out-File (Join-Path $logs 'restart.log') -Encoding utf8 } catch { }

$key = (Select-String -Path (Join-Path $here '.env') -Pattern '^OWNER_KEY=(.*)$').Matches[0].Groups[1].Value.Trim()

# 1b. Wait for the old Lyra to be fully gone (2026-11-23: the new mind was started while the old one's window still
# held mind.log open, so it couldn't write its log, quit at once in its hidden window, and the hologram fell back
# to its standalone mind)
for ($i = 0; $i -lt 30; $i++) {
  $busy = @(3010, 8770, 8772 | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
  $old = @(Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match 'lyra-runtime\\start\.bat' })
  if (-not $busy.Count -and -not $old.Count) { break }
  Start-Sleep -Milliseconds 500
}

# 2. Her mind (lyra-runtime: memory, Discord, dashboard on :3010). Its own restart loop keeps her up if it crashes.
# Its log is mind.log, or a dated one if mind.log is still held open by something.
function Get-MindLog {
  $log = Join-Path $logs 'mind.log'
  for ($i = 0; $i -lt 10; $i++) {
    try { $f = [System.IO.File]::Open($log, 'OpenOrCreate', 'Write', 'None'); $f.Close(); return $log } catch { Start-Sleep -Milliseconds 500 }
  }
  return (Join-Path $logs ("mind-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))
}
function Start-Mind {
  $script:mindLog = Get-MindLog
  Start-Process cmd.exe -WorkingDirectory $runtime -WindowStyle Hidden `
    -ArgumentList "/c set LYRA_QUIET_START=1&& call `"$runtime\start.bat`" > `"$script:mindLog`" 2>&1"
}
Start-Mind

# 3. Her ears (PC microphone + Discord voice transcription)
Start-Process python.exe -WorkingDirectory $here -WindowStyle Hidden -ArgumentList '-u', 'ears\ears.py' `
  -RedirectStandardOutput (Join-Path $logs 'ears.log') -RedirectStandardError (Join-Path $logs 'ears-errors.log')

# 4. Her hologram server
Start-Process node.exe -WorkingDirectory $here -WindowStyle Hidden -ArgumentList '--env-file=.env', 'src/server.js' `
  -RedirectStandardOutput (Join-Path $logs 'hologram.log') -RedirectStandardError (Join-Path $logs 'hologram-errors.log')

# 5. Open her page once the hologram answers
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  Start-Sleep -Milliseconds 500
  $up = [bool](Get-NetTCPConnection -LocalPort 8770 -State Listen -ErrorAction SilentlyContinue)
}
if ($up) {
  Start-Process "http://localhost:8770/?owner=$key"
} else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Lyra's hologram didn't start.`n`nLook in:`n$logs\hologram-errors.log`n`nor send that file to Claude.", 'Lyra', 'OK', 'Warning') | Out-Null
}

# 6. Check her mind came up (it registers Discord commands first, so give it a while); if not, start it once more,
# and if it still isn't there, say so instead of leaving the hologram on its standalone mind without a word
function Wait-Mind([int]$seconds) {
  for ($i = 0; $i -lt ($seconds * 2); $i++) {
    if (Get-NetTCPConnection -LocalPort 3010 -State Listen -ErrorAction SilentlyContinue) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
if (-not (Wait-Mind 90)) {
  "mind didn't come up within 90 s; starting it again" | Out-File (Join-Path $logs 'restart.log') -Append -Encoding utf8
  Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match 'lyra-runtime\\start\.bat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-Mind
  if (-not (Wait-Mind 90)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Lyra's mind (her memory, tools and Discord) didn't start, so her hologram is on its simple backup mind.`n`nLook in:`n$script:mindLog`n`nor send that file to Claude.", 'Lyra', 'OK', 'Warning') | Out-Null
  }
}
