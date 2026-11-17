import { activity, bus } from './events.js';
import { sleep } from './sleep.js';
import { mindPageOpened } from './mind-view.js';

// Live bridge between Discord voice and the Avatar studio page: when Luna speaks in a call,
// open studio tabs receive the line (text + mp3) so the 3D mouth lip-syncs in sync with Discord.
// Mind page also connects here (?page=mind) for camera steering (mind-view.js).

const clients = new Set(); // open SSE responses from /avatar.html / mind.html

export const liveConnected = () => clients.size > 0;

// Sleep status → studio (sleep.js emits avatar-sleep).
bus.on('avatar-sleep', (status) => broadcast({ type: 'sleep', sleep: status }));
// Mind camera commands → every live client (mind.html listens for type mind-view).
bus.on('mind-view', (cmd) => broadcast({ type: 'mind-view', cmd }));

export function attachLive(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  clients.add(res);
  const page = (() => {
    try { return new URL(req.url, 'http://x').searchParams.get('page'); } catch { return null; }
  })();
  const closeMind = page === 'mind' ? mindPageOpened() : null;
  activity('avatar', { message: page === 'mind' ? 'Mind page live bridge connected' : 'Avatar studio live bridge connected' });
  // Push current motion state so a freshly opened page matches what Luna last set.
  res.write(`data: ${JSON.stringify({ type: 'motion', ...getMotionState() })}\n\n`);
  try { res.write(`data: ${JSON.stringify({ type: 'sleep', sleep: sleep.status() })}\n\n`); } catch {}
  // Re-sync pressure → body/face so a freshly opened studio matches her mood.
  if (page !== 'mind') {
    import('./pressure-motion.js').then(({ syncPressureBody }) => import('./pressure.js').then((pressure) => {
      const snap = pressure.snapshot?.() || {};
      syncPressureBody({ buckets: snap.buckets, loneliness: snap.loneliness });
    })).catch(() => {});
  }
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
    closeMind?.();
    activity('avatar', { message: page === 'mind' ? 'Mind page live bridge disconnected' : 'Avatar studio live bridge disconnected' });
  });
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

// Discord voice (or anything else) → studio lip sync. audioBase64 is mp3 the browser can decode.
// playLocal: true when there is no Discord call carrying the audio (theater reactions in the studio).
export function broadcastSpeech({ text, audioBase64, character = 'main', playLocal = false } = {}) {
  if (!clients.size || !text) return false;
  broadcast({
    type: 'speech',
    character,
    text: String(text).slice(0, 2000),
    audio: audioBase64 || null,
    playLocal: Boolean(playLocal),
  });
  return true;
}

// ---- Motion / posture state (Luna can read and change this with avatar_motion) ----

const motion = {
  mode: 'rest', // rest | auto | listen | talk | idle | clip
  clip: null, // when mode === 'clip'
  intensity: 0.85,
  fullBody: false, // when true, studio plays hips/legs (planted) instead of upper-only
  note: 'Natural resting pose (Rocketbox body mocap off until you enable it)',
  source: null, // 'pressure' | 'manual' | null
  setAt: 0,
};

export function getMotionState() {
  return { ...motion, studioOpen: clients.size > 0 };
}

export function setMotionState(patch = {}) {
  if (typeof patch.mode === 'string') {
    const m = patch.mode.toLowerCase().trim();
    if (['rest', 'auto', 'listen', 'talk', 'idle', 'clip'].includes(m)) motion.mode = m;
  }
  if (patch.clip !== undefined) motion.clip = patch.clip ? String(patch.clip).replace(/\.json$/i, '') : null;
  if (patch.intensity !== undefined) {
    const n = Number(patch.intensity);
    if (Number.isFinite(n)) motion.intensity = Math.max(0, Math.min(1, n));
  }
  if (patch.fullBody !== undefined) motion.fullBody = Boolean(patch.fullBody);
  if (typeof patch.note === 'string') motion.note = patch.note.slice(0, 200);
  if (patch.source === 'pressure' || patch.source === 'manual') motion.source = patch.source;
  else if (patch.source === null) motion.source = null;
  else if (patch.mode !== undefined || patch.clip !== undefined) motion.source = 'manual'; // tool / API without explicit source
  motion.setAt = Date.now();
  if (motion.mode === 'clip' && !motion.clip) motion.mode = 'rest';
  if (motion.mode !== 'clip') motion.clip = motion.mode === 'rest' ? null : motion.clip;
  // Idle/auto ambient from pressure should stay planted; pure rest clears the flag unless set.
  if (motion.mode === 'rest' && patch.fullBody === undefined) motion.fullBody = false;
  broadcast({ type: 'motion', ...getMotionState() });
  activity('avatar', { message: `Avatar motion → ${motion.mode}${motion.clip ? ` (${motion.clip})` : ''}${motion.fullBody ? ' full-body' : ''}` });
  return getMotionState();
}

/** Face blend from pressure (or anything else) → open studio tabs. */
export function broadcastFeelings({ character = 'main', feelings = {}, pressure = null } = {}) {
  if (!clients.size) return false;
  broadcast({
    type: 'feelings',
    character,
    feelings: feelings && typeof feelings === 'object' ? feelings : {},
    pressure: pressure || null,
  });
  return true;
}
