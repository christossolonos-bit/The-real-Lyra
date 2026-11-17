/**
 * Capture the Windows PC microphone on the server (ffmpeg), not in the browser.
 * Push-to-talk and hands-free (server VAD) both use this so a blocked browser mic still works.
 */
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { activity } from '../events.js';

const RATE = 48000; // matches /api/avatar/listen + Discord STT
const VAD_ON = 0.018; // RMS to start speech
const VAD_OFF = 0.010; // RMS to count as silence
const VAD_START_MS = 180;
const VAD_END_MS = 850;
const PREROLL_MS = 280;
const MAX_UTTER_MS = 20000;

let proc = null;
let chunks = [];
let level = 0;
let startedAt = 0;
let deviceName = '';
let mode = 'off'; // 'ptt' | 'listen' | 'off'

/** Hands-free VAD state */
const vad = {
  speaking: false,
  voicedMs: 0,
  silentMs: 0,
  preroll: [],
  utter: [],
  pending: null, // Buffer ready for STT
  lastUtterAt: 0,
};

function ffmpegBin() {
  return (process.env.FFMPEG || process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}

/** List DirectShow audio devices (Windows). */
export async function listMicDevices() {
  if (process.platform !== 'win32') {
    return { devices: [], hint: 'PC mic capture is wired for Windows (ffmpeg dshow/wasapi).' };
  }
  const bin = ffmpegBin();
  const out = await runCapture(bin, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 8000).catch((e) => e.message || '');
  const devices = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (m) devices.push(m[1]);
  }
  return { devices, hint: devices.length ? null : 'No dshow audio devices found. Install ffmpeg and check Windows privacy → Microphone.' };
}

function pickDevice(preferred) {
  const env = (process.env.PC_MIC_DEVICE || config.pcMic?.device || '').trim();
  return preferred || env || '';
}

function buildArgs(device) {
  if (device) {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${device}`, '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'];
  }
  if (process.platform === 'win32') {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'wasapi', '-i', 'default', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'];
  }
  return ['-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-i', 'default', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'];
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const t = setTimeout(() => {
      child.kill();
      resolve(err);
    }, timeoutMs);
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(t);
      resolve(err);
    });
  });
}

function updateLevel(buf) {
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  level = n ? Math.sqrt(sum / n) : 0;
}

function blockMs(buf) {
  return (buf.length / 2 / RATE) * 1000;
}

function resetVad() {
  vad.speaking = false;
  vad.voicedMs = 0;
  vad.silentMs = 0;
  vad.preroll = [];
  vad.utter = [];
}

function finalizeUtterance() {
  const parts = [...vad.preroll, ...vad.utter];
  vad.preroll = [];
  vad.utter = [];
  vad.speaking = false;
  vad.voicedMs = 0;
  vad.silentMs = 0;
  const pcm = Buffer.concat(parts);
  if (pcm.length < RATE * 2 * 0.35) return; // under ~0.35s
  vad.pending = pcm;
  vad.lastUtterAt = Date.now();
  activity('mic', { action: 'utterance', bytes: pcm.length, device: deviceName });
}

function onListenAudio(buf) {
  const ms = blockMs(buf);
  const copy = Buffer.from(buf);
  if (!vad.speaking) {
    vad.preroll.push(copy);
    const maxPreroll = Math.ceil((PREROLL_MS / 1000) * RATE * 2 / Math.max(1, copy.length));
    while (vad.preroll.length > Math.max(4, maxPreroll)) vad.preroll.shift();
    if (level >= VAD_ON) {
      vad.voicedMs += ms;
      if (vad.voicedMs >= VAD_START_MS && !vad.pending) {
        vad.speaking = true;
        vad.silentMs = 0;
        vad.utter = [];
        activity('mic', { action: 'vad-start', device: deviceName });
      }
    } else {
      vad.voicedMs = Math.max(0, vad.voicedMs - ms * 0.5);
    }
  } else {
    vad.utter.push(copy);
    const utterMs = vad.utter.reduce((n, b) => n + blockMs(b), 0);
    if (level <= VAD_OFF) {
      vad.silentMs += ms;
      if (vad.silentMs >= VAD_END_MS) finalizeUtterance();
    } else {
      vad.silentMs = 0;
    }
    if (utterMs >= MAX_UTTER_MS) finalizeUtterance();
  }
}

async function spawnCapture(chosen) {
  const bin = ffmpegBin();
  const args = buildArgs(chosen);
  const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 2000) stderr = stderr.slice(-1500);
  });
  child.stdout.on('data', (buf) => {
    updateLevel(buf);
    if (mode === 'ptt') {
      chunks.push(Buffer.from(buf));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total > RATE * 2 * 45) chunks.shift();
    } else if (mode === 'listen') {
      onListenAudio(buf);
    }
  });
  child.on('error', (err) => {
    activity('error', { where: 'pc-mic', message: err.message });
    proc = null;
    mode = 'off';
  });
  child.on('close', (code) => {
    if (code && code !== 0 && mode !== 'off') {
      activity('error', { where: 'pc-mic', message: `ffmpeg exited ${code}: ${stderr.slice(-300)}` });
    }
    if (proc === child) {
      proc = null;
      mode = 'off';
    }
  });
  await new Promise((r) => setTimeout(r, 280));
  if (child.exitCode != null || child.signalCode || !child.pid) {
    throw Object.assign(new Error(`PC mic failed to start (${stderr.slice(-200) || 'ffmpeg missing or no device'}). Set PC_MIC_DEVICE to your mic name.`), { status: 503 });
  }
  return { child, stderr: () => stderr };
}

async function resolveDevice(device) {
  let chosen = pickDevice(device);
  if (!chosen && process.platform === 'win32') {
    const { devices } = await listMicDevices();
    chosen = devices.find((d) => /microphone|mic\b|headset|blackshark|realtek/i.test(d))
      || devices.find((d) => !/voicemeeter|cable|virtual/i.test(d))
      || devices[0]
      || '';
  }
  return chosen;
}

/**
 * Push-to-talk capture. Returns { ok, device }.
 */
export async function startMic({ device } = {}) {
  stopMic();
  chunks = [];
  level = 0;
  startedAt = Date.now();
  mode = 'ptt';
  const chosen = await resolveDevice(device);
  deviceName = chosen || 'default';
  const { child, stderr } = await spawnCapture(chosen);
  proc = child;
  if (!proc || proc.exitCode != null) {
    mode = 'off';
    throw Object.assign(new Error(`PC mic failed to start (${stderr().slice(-200) || 'no device'}).`), { status: 503 });
  }
  activity('mic', { action: 'start', device: deviceName, mode: 'ptt' });
  return { ok: true, device: deviceName, rate: RATE, mode: 'ptt' };
}

/**
 * Hands-free continuous listen with server VAD. Utterances land in takeUtterance().
 */
export async function startListen({ device } = {}) {
  stopMic();
  resetVad();
  vad.pending = null;
  level = 0;
  startedAt = Date.now();
  mode = 'listen';
  const chosen = await resolveDevice(device);
  deviceName = chosen || 'default';
  const { child, stderr } = await spawnCapture(chosen);
  proc = child;
  if (!proc || proc.exitCode != null) {
    mode = 'off';
    throw Object.assign(new Error(`PC mic listen failed (${stderr().slice(-200) || 'no device'}).`), { status: 503 });
  }
  activity('mic', { action: 'listen', device: deviceName, mode: 'listen' });
  return { ok: true, device: deviceName, rate: RATE, mode: 'listen' };
}

/** Stop capture and return { pcm, ms, device, level } (PTT path). */
export function stopMic() {
  const child = proc;
  proc = null;
  const was = mode;
  mode = 'off';
  const pcm = Buffer.concat(chunks);
  chunks = [];
  const ms = startedAt ? Date.now() - startedAt : 0;
  startedAt = 0;
  const peak = level;
  level = 0;
  resetVad();
  if (child) {
    try {
      child.stdout?.destroy();
      child.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  if (was !== 'off') activity('mic', { action: 'stop', ms, bytes: pcm.length, device: deviceName, mode: was });
  return { pcm, ms, device: deviceName, level: peak, rate: RATE };
}

/** Pop the next completed hands-free utterance, or null. */
export function takeUtterance() {
  const pcm = vad.pending;
  vad.pending = null;
  if (!pcm) return null;
  return { pcm, device: deviceName, rate: RATE, ms: Math.round((pcm.length / 2 / RATE) * 1000) };
}

export function micStatus() {
  return {
    active: Boolean(proc),
    mode,
    device: deviceName || null,
    level,
    ms: startedAt ? Date.now() - startedAt : 0,
    rate: RATE,
    speaking: Boolean(vad.speaking),
    utteranceReady: Boolean(vad.pending),
  };
}
