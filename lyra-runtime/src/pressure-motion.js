import { activity } from './events.js';
import { getMotionState, setMotionState, liveConnected, broadcastFeelings } from './avatarLive.js';
import * as emotion from './emotion.js';
import { emotionKey } from './characters.js';

// Pressure buckets → face feeling + Rocketbox clips.
// Clip names match data/anims labels (incl. move/leg/breathe) so the whole body can play, not arms-only.

/** @type {Record<string, { feel: string, label: string, clips: string[], fullBody?: boolean }>} */
export const BUCKET_BODY = {
  boredom: {
    feel: 'bored',
    label: 'zoning out',
    fullBody: true,
    clips: ['f_idle_yawn_01', 'f_idle_stretch_arms_01', 'f_idle_move_01', 'f_idle_shake_leg_01', 'f_idle_breathe_02', 'f_idle_neutral_04'],
  },
  curiosity: {
    feel: 'curious',
    label: 'wondering',
    fullBody: true,
    clips: ['f_idle_look_around_01', 'f_idle_look_around_02', 'f_gestic_thoughtful_01', 'f_idle_scratch_head_01', 'f_idle_move_01'],
  },
  irritation: {
    feel: 'annoyed',
    label: 'side-eyeing',
    fullBody: true,
    clips: ['f_idle_angry_01', 'f_idle_shake_arms_01', 'f_gestic_listen_deny_01', 'f_idle_roll_head_01', 'f_idle_move_leg_01'],
  },
  restlessness: {
    feel: 'excited',
    label: 'restless energy',
    fullBody: true,
    clips: ['f_idle_shake_arms_01', 'f_idle_shake_leg_01', 'f_idle_move_01', 'f_dancing_silly', 'f_idle_stretch_arms_01', 'f_cheer_02'],
  },
  usefulness: {
    feel: 'pensive',
    label: 'wanting to help',
    fullBody: true,
    clips: ['f_idle_waiting_01', 'f_gestic_thoughtful_01', 'f_gestic_talk_self-assured_01', 'f_idle_neutral_02', 'f_idle_move_01'],
  },
  unease: {
    feel: 'worried',
    label: 'fidgeting',
    fullBody: true,
    clips: ['f_idle_nervous_01', 'f_idle_nervous_02', 'f_idle_shake_leg_01', 'f_gestic_talk_nervous_01', 'f_idle_move_leg_01'],
  },
  loneliness: {
    feel: 'sad',
    label: 'missing someone',
    fullBody: true,
    clips: ['f_gestic_talk_sad_01', 'f_idle_breathe_02', 'f_gestic_listen_sad_01', 'f_idle_neutral_05', 'f_idle_move_01'],
  },
  world: {
    feel: 'curious',
    label: 'catching up on the world',
    fullBody: true,
    clips: ['f_idle_look_around_01', 'f_idle_look_around_03', 'f_gestic_thoughtful_01', 'f_documents_check', 'f_idle_move_01'],
  },
  watching: {
    feel: 'surprised',
    label: 'into the show',
    fullBody: true,
    clips: ['f_idle_neutral_01', 'f_idle_breathe_01', 'f_idle_look_around_01', 'f_idle_move_01', 'f_gestic_laugh_low', 'f_cheer_03', 'f_idle_neutral_03'],
  },
};

const CALM = {
  feel: 'calm',
  label: 'at ease',
  fullBody: true,
  clips: ['f_idle_breathe_01', 'f_idle_neutral_01', 'f_idle_neutral_02', 'f_gestic_talk_relaxed_01'],
};

const EMOTE_KEY = () => emotionKey('main');

let lastSyncKey = '';
let lastSyncAt = 0;

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

/** Loudest pressure signal (bucket or loneliness person). */
export function dominantPressure(buckets = {}, loneliness = {}) {
  let best = { key: null, bucket: null, value: 0, person: null };
  for (const [name, raw] of Object.entries(buckets || {})) {
    const value = clamp01(raw);
    if (value > best.value) best = { key: name, bucket: name, value, person: null };
  }
  for (const [id, p] of Object.entries(loneliness || {})) {
    const value = clamp01(p?.value);
    if (value > best.value) best = { key: `loneliness:${id}`, bucket: 'loneliness', value, person: p?.name || null };
  }
  return best;
}

function pickClip(clips, seed = Date.now()) {
  if (!clips?.length) return null;
  return clips[Math.abs(seed) % clips.length];
}

/**
 * Resolve body + face for current pressure (or a just-fired want).
 * @param {{ buckets?: object, loneliness?: object, fired?: { bucket?: string, value?: number, person?: string }|null }} opts
 */
export function resolvePressureBody({ buckets = {}, loneliness = {}, fired = null } = {}) {
  if (fired?.bucket && BUCKET_BODY[fired.bucket]) {
    const body = BUCKET_BODY[fired.bucket];
    const value = clamp01(fired.value ?? buckets[fired.bucket] ?? 0.7);
    const feel = fired.bucket === 'irritation' && value >= 0.7 ? 'angry' : body.feel;
    return {
      bucket: fired.bucket,
      person: fired.person || null,
      value,
      feel,
      label: body.label,
      clip: pickClip(body.clips, Date.now() + Math.floor(value * 100)),
      clips: body.clips,
      fullBody: true,
      intensity: Math.min(1, 0.55 + value * 0.45),
      mode: 'clip',
      beat: true,
    };
  }

  const dom = dominantPressure(buckets, loneliness);
  if (!dom.bucket || dom.value < 0.28) {
    return {
      bucket: null,
      person: null,
      value: dom.value || 0,
      feel: CALM.feel,
      label: CALM.label,
      clip: pickClip(CALM.clips, Math.floor(Date.now() / 60_000)),
      clips: CALM.clips,
      fullBody: true,
      intensity: 0.5,
      mode: 'clip',
      beat: false,
    };
  }

  const body = BUCKET_BODY[dom.bucket] || CALM;
  const feel = dom.bucket === 'irritation' && dom.value >= 0.7 ? 'angry' : body.feel;
  // Always pick a mood clip (incl. mid pressure) so legs/hips stay in the loop.
  return {
    bucket: dom.bucket,
    person: dom.person,
    value: dom.value,
    feel,
    label: body.label,
    clip: pickClip(body.clips, Math.floor(Date.now() / 45_000) + Math.floor(dom.value * 10)),
    clips: body.clips,
    fullBody: true,
    intensity: 0.5 + dom.value * 0.4,
    mode: 'clip',
    beat: false,
  };
}

/**
 * Push pressure mood into Rocketbox motion + emotion blend.
 * Skips redundant ambient syncs; always applies a fired want beat.
 * Respects a recent manual avatar_motion override (2 min).
 */
export function syncPressureBody(opts = {}) {
  const resolved = resolvePressureBody(opts);
  const now = Date.now();
  const fired = Boolean(opts.fired?.bucket);
  const syncKey = `${resolved.mode}|${resolved.bucket || 'calm'}|${resolved.clip || ''}|${resolved.feel}|${Math.round(resolved.value * 5)}|fb`;

  if (!fired && syncKey === lastSyncKey && now - lastSyncAt < 50_000) {
    return { skipped: true, reason: 'unchanged', ...resolved };
  }

  const current = getMotionState();
  const manualRecent = current.source === 'manual' && now - (current.setAt || 0) < 120_000;
  if (!fired && manualRecent) {
    applyFeelings(resolved, fired);
    lastSyncKey = syncKey;
    lastSyncAt = now;
    return { skipped: true, reason: 'manual-motion', ...resolved };
  }

  const note = resolved.bucket
    ? `pressure:${resolved.bucket}${resolved.person ? ` (${resolved.person})` : ''} — ${resolved.label}`
    : 'pressure: calm';

  if (liveConnected() || fired) {
    setMotionState({
      mode: resolved.mode,
      clip: resolved.mode === 'clip' ? resolved.clip : null,
      intensity: resolved.intensity,
      fullBody: true,
      note,
      source: 'pressure',
    });
  }

  const feelings = applyFeelings(resolved, fired);
  broadcastFeelings({
    character: 'main',
    feelings,
    pressure: {
      bucket: resolved.bucket,
      person: resolved.person,
      value: +resolved.value.toFixed(2),
      label: resolved.label,
      feel: resolved.feel,
      beat: fired,
      fullBody: true,
    },
  });

  lastSyncKey = syncKey;
  lastSyncAt = now;
  if (fired || resolved.bucket) {
    activity('avatar', {
      message: `Pressure → body ${resolved.mode}${resolved.clip ? ` (${resolved.clip})` : ''} full-body / ${resolved.feel}`,
      bucket: resolved.bucket,
      feel: resolved.feel,
    });
  }
  return { skipped: false, feelings, ...resolved };
}

function applyFeelings(resolved, beat) {
  const strength = beat ? Math.min(1, 0.55 + resolved.value * 0.45) : Math.min(0.85, 0.25 + resolved.value * 0.55);
  const feelings = { [resolved.feel]: strength };
  if (resolved.bucket === 'loneliness' && resolved.feel === 'sad') feelings.fond = strength * 0.35;
  if (resolved.bucket === 'watching' && resolved.feel === 'surprised') feelings.amused = strength * 0.4;
  if (resolved.bucket === 'restlessness') feelings.playful = strength * 0.35;
  return beat ? emotion.feel(EMOTE_KEY(), feelings) : emotion.nudge(EMOTE_KEY(), feelings);
}
