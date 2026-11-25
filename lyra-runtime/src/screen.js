import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Her look at the owner's screen (owner, 2026-11-25: "screen sharing"): one screenshot, taken only when he asks
// in that very message (the look_at_screen tool checks), shrunk to at most 1600 px wide, read by her eyes model,
// then deleted. Nothing is kept: no file, no image in her memory, only what she said about it.
// Windows only: PowerShell with System.Drawing, DPI-aware so a scaled display is captured whole.

const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][W.Dpi]::SetProcessDPIAware()
$b = if ($env:LYRA_SCREEN -eq 'all') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$scale = [Math]::Min(1.0, 1600.0 / $b.Width)
$w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
$small = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $w, $h)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 82L
$small.Save($env:LYRA_SHOT, $enc, $p)
Write-Output "$($b.Width)x$($b.Height)"
`;

export const screenAvailable = () => process.platform === 'win32';

// Returns { buf, mime, size: "2560x1440" }.
export async function captureScreen({ which = 'primary' } = {}) {
  if (!screenAvailable()) throw new Error('screen capture only works on Windows');
  const dir = await mkdtemp(path.join(tmpdir(), 'lyra-screen-'));
  const file = path.join(dir, 'screen.jpg');
  try {
    const size = await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        windowsHide: true, env: { ...process.env, LYRA_SHOT: file, LYRA_SCREEN: which === 'all' ? 'all' : 'primary' },
      });
      let out = '', err = '';
      ps.stdout.on('data', (d) => (out += d));
      ps.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => { ps.kill(); reject(new Error('screen capture timed out')); }, 20_000);
      ps.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim().split(/\s+/).pop()) : reject(new Error(err.trim().split('\n').pop() || `capture failed (${code})`)); });
      ps.stdin.end(PS);
    });
    return { buf: await readFile(file), mime: 'image/jpeg', size };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
