// Her video recorder runs by itself: a hidden (headless) browser that loads /recorder.html, which shows
// her hologram and records each Discord text reply as a clip (avatarVideo.js). Nobody has to open anything.
// It starts with her when video replies are on, comes back if it dies, and closes when she stops.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { findBrowser } from './browser-path.js';
import { activity } from './events.js';
import { recorderConnected } from './avatarVideo.js';

const PROFILE = path.join(DATA_DIR, 'recorder-profile'); // its own browser profile, so it never touches yours
let child = null, timer = null, failures = 0, lastStart = 0;

function launch() {
  const exe = findBrowser();
  if (!exe) { activity('video', { message: 'No browser found for the video recorder (Brave, Chrome or Edge). Video replies stay off.' }); return; }
  mkdirSync(PROFILE, { recursive: true });
  const url = `http://127.0.0.1:${config.dashboard.port}/recorder.html`;
  child = spawn(exe, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required', // her voice can play into the recording without a click
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--window-size=520,620', url,
  ], { windowsHide: true, stdio: 'ignore' });
  lastStart = Date.now();
  activity('video', { message: 'Video recorder started (hidden)' });
  child.on('exit', (code) => { child = null; activity('video', { message: `Video recorder closed (${code ?? 'killed'})` }); });
  child.on('error', (err) => { child = null; activity('error', { where: 'video recorder', message: err.message }); });
}

function stopChild() {
  if (!child) return;
  // the browser starts helper processes; close the whole tree
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { try { child.kill(); } catch {} }
  child = null;
}

// Every 20 s: on and not connected -> start it (backing off if it keeps failing); off -> close it.
function check() {
  if (!config.avatarVideo) { stopChild(); failures = 0; return; }
  if (recorderConnected()) { failures = 0; return; }
  if (child && Date.now() - lastStart < 45_000) return; // still loading her hologram
  if (child) { failures++; stopChild(); }
  if (failures > 5 && Date.now() - lastStart < 10 * 60_000) return; // something's wrong; try again in a while
  launch();
}

export function startRecorder() {
  if (timer) return;
  setTimeout(check, 3000); // after the dashboard is listening
  timer = setInterval(check, 20_000);
  timer.unref();
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { stopChild(); if (sig !== 'exit') process.exit(0); });
}
