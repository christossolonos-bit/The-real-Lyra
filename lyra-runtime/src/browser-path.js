/** Locate a desktop browser. Prefers Brave (this machine), then Chrome, then Edge. */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function findBrowser(env = process.env, exists = existsSync) {
  if (env.AVATAR_BROWSER && exists(env.AVATAR_BROWSER)) return env.AVATAR_BROWSER;
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
  const candidates = [
    ...roots.map((r) => path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
    ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    '/usr/bin/brave-browser', '/usr/bin/brave',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => p && exists(p)) ?? null;
}

/** Short name for yt-dlp --cookies-from-browser (brave|chrome|edge). */
export function browserCookieName(exe = findBrowser()) {
  if (!exe) return process.env.YTDLP_BROWSER || 'brave';
  const s = String(exe).toLowerCase();
  if (s.includes('brave')) return 'brave';
  if (s.includes('edge')) return 'edge';
  if (s.includes('chrome') || s.includes('chromium')) return 'chrome';
  return process.env.YTDLP_BROWSER || 'brave';
}
