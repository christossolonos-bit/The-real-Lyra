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

# 2. Her mind (lyra-runtime: memory, Discord, dashboard on :3010). Its own restart loop keeps her up if it crashes.
$mindLog = Join-Path $logs 'mind.log'
Start-Process cmd.exe -WorkingDirectory $runtime -WindowStyle Hidden `
  -ArgumentList "/c set LYRA_QUIET_START=1&& call `"$runtime\start.bat`" > `"$mindLog`" 2>&1"

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
