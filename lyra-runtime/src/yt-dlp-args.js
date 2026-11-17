/** Shared yt-dlp flags so music + theater hit the same YouTube workarounds. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { browserCookieName } from './browser-path.js';

const COOKIE_CANDIDATES = () => [
  process.env.YTDLP_COOKIES,
  path.join(DATA_DIR, 'youtube-cookies.txt'),
  path.join(DATA_DIR, 'cookies.txt'),
].filter(Boolean);

function ytDlpBin() {
  return process.env.YT_DLP_PATH || process.env.YOUTUBE_DLP || process.env.YTP || 'yt-dlp';
}

/** Probe once: older installs (2025.x) reject --js-runtimes / --remote-components. */
let _modernFlags = null;
function modernYoutubeFlags() {
  if (_modernFlags) return _modernFlags;
  try {
    const help = spawnSync(ytDlpBin(), ['--help'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const text = `${help.stdout || ''}\n${help.stderr || ''}`;
    // No \b before -- : word-boundary does not match before a hyphen.
    const js = /--js-runtimes\b/.test(text);
    const remote = /--remote-components\b/.test(text);
    _modernFlags = js || remote
      ? [
          ...(js ? ['--js-runtimes', 'node'] : []),
          ...(remote ? ['--remote-components', 'ejs:github'] : []),
        ]
      : [];
  } catch {
    _modernFlags = [];
  }
  return _modernFlags;
}

/**
 * Base args every yt-dlp call should carry.
 * - node JS runtime + remote EJS when this yt-dlp build supports them
 * - android+web player clients: avoids intermittent "page needs to be reloaded" on web-only
 * - cookies file only when the owner dropped one in data/ (browser cookies often lock while Brave is open)
 * - YTDLP_BROWSER=brave|chrome|edge opts into --cookies-from-browser (off by default)
 */
export function ytDlpBaseArgs() {
  const args = [
    '--no-warnings',
    ...modernYoutubeFlags(),
    '--extractor-args', 'youtube:player_client=android,web',
  ];
  const cookieFile = COOKIE_CANDIDATES().find((p) => existsSync(p));
  if (cookieFile) args.push('--cookies', cookieFile);
  else if (process.env.YTDLP_BROWSER) args.push('--cookies-from-browser', process.env.YTDLP_BROWSER || browserCookieName());
  return args;
}

/** Plain-language fix when YouTube returns the bot / sign-in wall. */
export function ytBotWallHint(errMessage = '') {
  if (!/not a bot|Sign in to confirm/i.test(String(errMessage))) return '';
  const hasCookies = COOKIE_CANDIDATES().some((p) => existsSync(p));
  if (hasCookies) {
    return ' Fix: refresh data/youtube-cookies.txt (export again from Brave while signed into YouTube), then retry.';
  }
  return ' Fix: YouTube is blocking this PC as a bot. Close Brave briefly and retry (cookies from Brave), or export cookies into amy-smith/data/youtube-cookies.txt. Watching on youtube.com in Brave still works without that.';
}
