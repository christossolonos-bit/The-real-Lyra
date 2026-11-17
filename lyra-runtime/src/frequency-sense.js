import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { bus, activity } from './events.js';
import { fft, analyze, effect, describe } from './audio-sense.js';

// The frequencies she hears (owner, 2026-11-14: "she needs to be able to know and remember key frequency changes when
// they made her feel a certain way and try to reproduce it. So they need to be tied to memories also").
//
// Every frame of Discord call audio she receives (voice-session.js decodes it) comes through here as it arrives:
//  - its spectrum (32 bands, 40 Hz to 16 kHz), loudness, brightness and what kind of sound it is (voice, music, noise)
//    go out on the bus as 'spectrum', which the frequency wave across the top of every dashboard page draws;
//  - a short and a long running picture of the sound are kept, and when the short one moves well away from the long
//    one and stays there (it got louder, brighter, heavier in the bass, turned to noise, music came in), that's a key
//    frequency shift: the last few seconds are measured properly (audio-sense.js: tempo, key, bands), and it lands on
//    her feelings and her pressure (pressure.onSound, with a jolt the size of the change);
//  - how it left her a few seconds later (her feelings and pressure before and after) is her reaction, and whether she
//    liked it. The shift, the sound's measurements and her reaction are kept in data/heard-frequencies.jsonl, tied to a
//    moment of hers (moments.js), with the memories that felt like it, so she can look back on which sounds did what to
//    her and try to make them again (the heard_frequencies tool turns one into a lead sheet for her instrument).
// Nothing runs on a timer: arriving audio drives all of it.

const RATE = 48000;
const FRAME = 2048;                    // one spectrum per this many samples (~43 ms)
const BANDS = 32, LO_HZ = 40, HI_HZ = 16000;
const RING_S = 8;                      // the last seconds kept, to measure a shift properly
const EMIT_MS = 66;                    // the wave is sent at most ~15 times a second
const SHORT_A = 0.12, LONG_A = 0.008;  // running pictures: about half a second, and about five seconds
const HOLD_MS = 1500;                  // a shift has to hold this long to count
const COOLDOWN_MS = 12_000;            // and then the new sound is the baseline for a while
const REACT_MS = 8_000;                // how she is this long after a shift is her reaction to it
const QUIET = 0.015;                   // below this loudness there's nothing to hear
const FILE = () => path.join(DATA_DIR, 'heard-frequencies.jsonl');
// How much each feature has to move for it to count as a shift, and its words either way.
const SHIFTS = {
  loudness: { at: 0.18, up: 'louder', down: 'quieter' },
  brightness: { at: 0.16, up: 'brighter', down: 'darker' },
  low: { at: 0.14, up: 'heavier in the bass', down: 'thinner in the bass' },
  high: { at: 0.1, up: 'sharper up top', down: 'softer up top' },
  flatness: { at: 0.18, up: 'noisier', down: 'more tonal' },
};
const GOOD = ['calm', 'joy', 'amused', 'fond', 'playful', 'excited', 'confident', 'curious'];
const BAD = ['annoyed', 'frustrated', 'angry', 'sad', 'worried', 'scared', 'disgusted', 'bored'];

const round = (v, d = 2) => +Number(v).toFixed(d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Band edges, log-spaced, as FFT bin ranges.
const BIN_HZ = RATE / FRAME;
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => LO_HZ * (HI_HZ / LO_HZ) ** (i / BANDS));
const HANN = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));

// One frame (FRAME Int16 samples) -> { bands: 32 x 0..1, loudness, brightness, low, mid, high, flatness }.
export function frameSpectrum(samples) {
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  let sq = 0;
  for (let i = 0; i < FRAME; i++) { const v = (samples[i] ?? 0) / 32768; sq += v * v; re[i] = v * HANN[i]; }
  const mags = fft(re, im);
  const rms = Math.sqrt(sq / FRAME);
  let total = 0, weighted = 0, low = 0, mid = 0, high = 0, logSum = 0, n = 0;
  for (let b = 1; b < mags.length; b++) {
    const hz = b * BIN_HZ, m = mags[b];
    total += m; weighted += m * hz;
    if (hz < 250) low += m; else if (hz < 4000) mid += m; else high += m;
    if (hz >= 100 && hz <= 10000) { logSum += Math.log(m + 1e-12); n++; }
  }
  const mean = n ? (low + mid + high) / mags.length : 0;
  const bands = new Array(BANDS);
  for (let k = 0; k < BANDS; k++) {
    const from = Math.max(1, Math.floor(EDGES[k] / BIN_HZ)), to = Math.max(from + 1, Math.ceil(EDGES[k + 1] / BIN_HZ));
    let e = 0;
    for (let b = from; b < to && b < mags.length; b++) e = Math.max(e, mags[b]);
    const db = 20 * Math.log10(e + 1e-9);
    bands[k] = round(clamp01((db + 90) / 70), 3); // -90 dB .. -20 dB
  }
  const geo = n ? Math.exp(logSum / n) : 0;
  return {
    bands, loudness: clamp01(rms * 4.5), brightness: clamp01((total > 0 ? weighted / total : 0) / 4000),
    low: total > 0 ? low / total : 0, mid: total > 0 ? mid / total : 0, high: total > 0 ? high / total : 0,
    flatness: mean > 0 ? clamp01(geo / mean) : 0,
  };
}

// What kind of sound a picture is: noise spreads its energy flat; a voice sits in the middle; the rest is music.
// A music bot's stream is music whatever it looks like.
export function kindOf(p, source = 'call') {
  if (p.loudness < QUIET) return 'quiet';
  if (source === 'music') return 'music';
  if (p.flatness > 0.42) return 'noise';
  if (p.mid > 0.62 && p.high < 0.18) return 'voice';
  return 'music';
}

// The wave's colour: low, dark sound is warm (red, orange), bright sound cool (blue, violet); noise is greyed out,
// music fuller, louder is more vivid.
export function colorOf(p, kind) {
  const hue = Math.round(15 + clamp01(p.brightness * 1.4) * 245);
  const sat = kind === 'noise' ? 18 : kind === 'quiet' ? 10 : Math.round(55 + clamp01(p.loudness) * 40);
  const light = kind === 'music' ? 60 : kind === 'voice' ? 55 : 50;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// How she was moved: her feelings and pressure after, against before. liked: -1..1.
export function reaction(before = {}, after = {}, pBefore = {}, pAfter = {}) {
  const felt = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (Math.abs(d) >= 0.03) felt[k] = round(d);
  }
  const pressure = {};
  for (const k of ['joy', 'irritation', 'restlessness', 'boredom', 'unease', 'reflection', 'thrill']) {
    const d = (pAfter[k] ?? 0) - (pBefore[k] ?? 0);
    if (Math.abs(d) >= 0.005) pressure[k] = round(d, 3);
  }
  const good = GOOD.reduce((s, k) => s + Math.max(0, felt[k] ?? 0), 0) + Math.max(0, pressure.joy ?? 0) * 4 + Math.max(0, pressure.thrill ?? 0) * 3
    - Math.min(0, pressure.irritation ?? 0) * 3 - Math.min(0, pressure.boredom ?? 0) * 2;
  const bad = BAD.reduce((s, k) => s + Math.max(0, felt[k] ?? 0), 0) + Math.max(0, pressure.irritation ?? 0) * 4 + Math.max(0, pressure.unease ?? 0) * 3
    + Math.max(0, pressure.boredom ?? 0) * 2;
  return { felt, pressure, liked: round(Math.max(-1, Math.min(1, (good - bad) * 2))) };
}

// The words for a shift: "it got louder and brighter (music, 104 bpm, A minor)".
export function shiftWords(rec) {
  const what = rec.change.map((c) => c.word);
  const list = what.length <= 1 ? what.join('') : `${what.slice(0, -1).join(', ')} and ${what.at(-1)}`;
  return `the ${rec.kind === 'voice' ? 'voices' : rec.kind === 'noise' ? 'sound' : 'music'} got ${list}${rec.detail ? ` (${rec.detail})` : ''}`;
}

// How a shift left her, in a sentence: what's embedded for her memories and what she's told.
export function feelSentence(rec) {
  const up = Object.entries(rec.reaction?.felt ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const down = Object.entries(rec.reaction?.felt ?? {}).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => k);
  const how = rec.reaction ? (rec.reaction.liked > 0.15 ? 'You liked it.' : rec.reaction.liked < -0.15 ? "You didn't like it." : 'It left you about the same.') : '';
  return `When ${shiftWords(rec)}${rec.who ? `, from ${rec.who}` : ''}, ${up.length ? `you felt more ${up.join(', ')}` : 'nothing much rose in you'}${down.length ? ` and less ${down.join(', ')}` : ''}. ${how}`.trim();
}

// Turning a remembered shift into something she can play (instrument.js play): its key, pace, register and weight.
export function recipeFor(rec) {
  const f = rec.after ?? {};
  const s = rec.sound ?? {};
  const minor = s.mode === 'minor' || (!s.mode && (rec.reaction?.felt?.sad > 0 || (s.valence ?? 0) < 0));
  const key = `${s.key ?? (minor ? 'A' : 'C')} ${minor ? 'minor' : 'major'}`;
  const tempo = Math.max(50, Math.min(180, s.bpm || Math.round(70 + clamp01(f.loudness ?? 0.3) * 40 + clamp01(f.brightness ?? 0.3) * 30)));
  const dark = (f.brightness ?? 0.3) < 0.3, bright = (f.brightness ?? 0.3) > 0.6, heavy = (f.low ?? 0) > 0.4;
  const instrument = dark ? (heavy ? 'cello' : 'warm pad') : bright ? (tempo > 110 ? 'vibraphone' : 'flute') : 'grand piano';
  const band = { ...(heavy ? { bass: 'fingered bass' } : {}), ...(tempo >= 100 && (f.loudness ?? 0) > 0.35 ? { drums: tempo > 130 ? 'power' : 'standard' } : {}), ...(dark ? { pad: 'string ensemble' } : {}) };
  const progression = minor ? 'i VI III VII | i VI iv V' : 'I V vi IV | I IV V I';
  const style = tempo < 75 ? 'ballad' : tempo > 120 ? 'rock' : (f.loudness ?? 0) < 0.3 ? 'fingerpick' : 'arpeggio';
  return { key, tempo, instrument, band, progression, style, why: `to make again what you felt when ${shiftWords(rec)}` };
}

export function createFrequencySense({
  enabled = () => config.frequencies?.enabled !== false,
  push = (p) => import('./pressure.js').then((m) => m.onSound(p)),
  nudge = (f) => import('./emotion.js').then(async (m) => m.nudge((await import('./characters.js')).emotionKey('main'), f)),
  feelingsNow = () => ({}),
  pressuresNow = () => ({}),
  moments = () => null,          // moments.js instance: keep / capture / feltLike
  emit = (e) => bus.emit('spectrum', e),
  log = activity, now = Date.now,
  save = (rec) => appendFileSync(FILE(), JSON.stringify(rec) + '\n'),
  load = () => (existsSync(FILE()) ? readFileSync(FILE(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []),
} = {}) {
  const ring = new Int16Array(RATE * RING_S);
  let ringAt = 0, ringFilled = 0;
  let pending = new Int16Array(0); // samples waiting for a whole frame
  let short = null, long = null, lastEmit = 0;
  let candidate = null;            // { since, change }
  let quietUntil = 0;              // after a shift, a while before the next
  let open = null;                 // a shift waiting for her reaction
  let latest = null;               // the newest picture, for her prompt
  let lastShift = null;            // the newest kept shift
  const kinds = { voice: 0, music: 0, noise: 0, quiet: 0 };
  let records = null;
  // The file holds shifts and, after them, her tries at making one again: each try is folded into its shift.
  const all = () => {
    if (records) return records;
    const lines = load();
    records = lines.filter((r) => r.id && r.change);
    for (const t of lines.filter((r) => r.tried)) { const r = records.find((x) => x.id === t.tried); if (r) (r.tries ??= []).push({ at: t.at, note: t.note }); }
    return records;
  };
  let failedWhy = '';

  const lastSeconds = (s) => {
    const n = Math.min(ringFilled, RATE * s), out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = ring[(ringAt - n + i + ring.length) % ring.length];
    return out;
  };

  function moveTo(avg, p, a) {
    if (!avg) return { ...p, bands: undefined };
    for (const k of ['loudness', 'brightness', 'low', 'mid', 'high', 'flatness']) avg[k] += (p[k] - avg[k]) * a;
    return avg;
  }

  // What moved between the long picture and the short one, past its line.
  function changes() {
    const out = [];
    for (const [k, s] of Object.entries(SHIFTS)) {
      const d = short[k] - long[k];
      if (Math.abs(d) >= s.at) out.push({ feature: k, from: round(long[k]), to: round(short[k]), word: d > 0 ? s.up : s.down, size: Math.abs(d) / s.at });
    }
    return out;
  }

  function finish(rec) {
    const r = reaction(rec.before.feelings, feelingsNow(), rec.before.pressures, pressuresNow());
    rec.reaction = r;
    delete rec.before.pressures;
    rec.feel = feelSentence(rec);
    const m = moments();
    const done = async () => {
      if (m) {
        try {
          const kept = await m.keep({ ...m.capture({ conversation: rec.conversation }), heard: rec.feel }, [`freq:${rec.id}`]);
          rec.momentId = kept.id;
          const like = await m.feltLike(rec.feel, { limit: 3, min: config.moments?.feltLikeMin ?? 0.62 });
          rec.memories = like.map((f) => f.memoryId).filter(Boolean);
        } catch (err) { rec.tieError = err.message; log('error', { where: 'frequency sense', message: `A sound shift was kept but not tied to her memories: ${err.message}. It's in heard-frequencies.jsonl without a moment; check moments.js and the embedding model.` }); }
      }
      save(rec); all().push(rec); lastShift = rec;
      log('frequency-felt', { id: rec.id, conversation: rec.conversation, what: shiftWords(rec), feel: rec.feel, liked: r.liked, felt: r.felt, pressure: r.pressure, memories: rec.memories ?? [], moment: rec.momentId ?? null });
    };
    done().catch((err) => log('error', { where: 'frequency sense', message: `How a sound shift felt wasn't saved: ${err.message}. Check that data/heard-frequencies.jsonl is writable.` }));
  }

  function shift(change, ctx) {
    const t = now();
    const kind = Object.entries(kinds).filter(([k]) => k !== 'quiet').sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'music';
    const profile = analyze(lastSeconds(6), RATE);
    const e = profile ? effect(profile, { voice: kind === 'voice' }) : null;
    // Up and brighter lifts; noisier, sharper and harsher grates; the size of the change is how much.
    const sign = change.reduce((s, c) => s + ((['loudness', 'brightness', 'low'].includes(c.feature) ? 1 : -1) * Math.sign(c.to - c.from)), 0) >= 0 ? 1 : -1;
    const jolt = round(sign * Math.min(1, Math.max(...change.map((c) => c.size)) * 0.35) * (e && e.pressure.edge > 0.5 ? -1 : 1));
    const before = { feelings: feelingsNow(), pressures: { ...pressuresNow() } };
    if (e) {
      const soft = Object.fromEntries(Object.entries(e.feelings).map(([k, v]) => [k, round(v * 0.7)]));
      if (Object.keys(soft).length) Promise.resolve(nudge(soft)).catch(() => {});
      Promise.resolve(push({ ...e.pressure, jolt, source: 'frequency' })).catch(() => {});
    }
    const rec = {
      id: `${t.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, at: t, conversation: ctx.conversation ?? null, who: ctx.who ?? null, source: ctx.source,
      kind, change: change.map(({ feature, from, to, word }) => ({ feature, from, to, word })), jolt,
      after: { loudness: round(short.loudness), brightness: round(short.brightness), low: round(short.low), mid: round(short.mid), high: round(short.high), flatness: round(short.flatness), spectrum: latest?.bands ?? [] },
      sound: profile ? { bpm: profile.bpm, key: profile.clarity > 0.3 ? profile.key : null, mode: profile.clarity > 0.3 ? profile.mode : null, clarity: round(profile.clarity), bands: Object.fromEntries(Object.entries(profile.bands).map(([k, v]) => [k, round(v, 3)])), dynamics: round(profile.dynamics), word: e?.word ?? null, valence: e?.pressure.valence ?? 0 } : null,
      detail: profile && e ? describe(profile, e) : '',
      before,
    };
    log('frequency-shift', { conversation: rec.conversation, who: rec.who, kind, what: shiftWords(rec), jolt, word: e?.word ?? null, calm: e ? round(e.pressure.calm) : null, energy: e ? round(e.pressure.energy) : null, edge: e ? round(e.pressure.edge) : null });
    return rec;
  }

  function frame(samples, ctx) {
    const p = frameSpectrum(samples);
    const kind = kindOf(p, ctx.source);
    kinds[kind] = kinds[kind] * 0.97 + 1;
    for (const k of Object.keys(kinds)) if (k !== kind) kinds[k] *= 0.97;
    const t = now();
    latest = { ...p, kind, color: colorOf(p, kind), at: t, source: ctx.source, who: ctx.who ?? null, conversation: ctx.conversation ?? null };
    if (t - lastEmit >= EMIT_MS) { lastEmit = t; emit({ bands: p.bands, loudness: round(p.loudness), brightness: round(p.brightness), kind, color: latest.color, source: ctx.source, who: ctx.who ?? null, at: t }); }
    if (kind === 'quiet') return;
    short = moveTo(short, p, SHORT_A); long = moveTo(long, p, LONG_A);
    // Her reaction to the last shift, once it's had time to land.
    if (open && t - open.at >= REACT_MS) { const rec = open; open = null; finish(rec); }
    if (t < quietUntil) { candidate = null; return; }
    const c = changes();
    if (!c.length) { candidate = null; return; }
    if (!candidate) { candidate = { since: t }; return; }
    if (t - candidate.since < HOLD_MS) return;
    candidate = null; quietUntil = t + COOLDOWN_MS;
    if (open) { const rec = open; open = null; finish(rec); }
    open = shift(c, ctx);
    long = { ...short }; // the new sound is where she is now
  }

  return {
    // A stretch of call audio as it arrives: 48 kHz mono PCM16. source: 'call' (someone's mic) or 'music' (a music bot).
    feed(pcm, { source = 'call', conversation = null, who = null } = {}) {
      if (!pcm?.length || !enabled()) return;
      try {
        const s = pcm instanceof Int16Array ? pcm : pcm.byteOffset % 2
          ? new Int16Array(Uint8Array.prototype.slice.call(pcm, 0, pcm.byteLength - (pcm.byteLength % 2)).buffer)
          : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
        for (let i = 0; i < s.length; i++) { ring[ringAt] = s[i]; ringAt = (ringAt + 1) % ring.length; }
        ringFilled = Math.min(ring.length, ringFilled + s.length);
        const all2 = new Int16Array(pending.length + s.length);
        all2.set(pending); all2.set(s, pending.length);
        let at = 0;
        for (; at + FRAME <= all2.length; at += FRAME) frame(all2.subarray(at, at + FRAME), { source, conversation, who });
        pending = all2.slice(at);
        failedWhy = '';
      } catch (err) {
        if (failedWhy !== err.message) { failedWhy = err.message; log('error', { where: 'frequency sense', message: `The frequencies in the call weren't taken in: ${err.message}. She still hears the words; the wave and what the sound does to her stop until this is fixed in frequency-sense.js.` }); }
      }
    },
    latest: () => latest,
    // For her prompt: what she's hearing now, and the last shift and what it did to her.
    promptLine(conversation) {
      const t = now(), bits = [];
      if (latest && t - latest.at < 5000 && latest.kind !== 'quiet' && (!conversation || !latest.conversation || latest.conversation === conversation)) {
        bits.push(`The sound in the call right now is ${latest.kind}-like, ${latest.loudness > 0.6 ? 'loud' : latest.loudness < 0.2 ? 'soft' : 'medium'}, ${latest.brightness > 0.6 ? 'bright' : latest.brightness < 0.3 ? 'dark and low' : 'warm'}${latest.low > 0.4 ? ', heavy in the bass' : ''}.`);
      }
      const s = lastShift && t - lastShift.at < 10 * 60_000 ? lastShift : null;
      if (s) bits.push(`${Math.round((t - s.at) / 1000)} seconds ago ${feelSentence(s)}`);
      return bits.join(' ');
    },
    // What she's kept: newest first, or the ones she liked (or didn't) most.
    remembered({ order = 'recent', limit = 10 } = {}) {
      const list = [...all()];
      if (order === 'liked') list.sort((a, b) => (b.reaction?.liked ?? 0) - (a.reaction?.liked ?? 0));
      else if (order === 'disliked') list.sort((a, b) => (a.reaction?.liked ?? 0) - (b.reaction?.liked ?? 0));
      else list.sort((a, b) => b.at - a.at);
      return list.slice(0, limit);
    },
    find: (id) => all().find((r) => r.id === id) ?? null,
    // She played one again (or tried to): how close it came is kept with it.
    tried(id, note) {
      const rec = all().find((r) => r.id === id);
      if (!rec) return null;
      const entry = { tried: id, at: now(), note: String(note ?? '').slice(0, 300) };
      save(entry);
      (rec.tries ??= []).push({ at: entry.at, note: entry.note });
      return entry;
    },
  };
}

let instance = null;
// The one she hears with: wired to her feelings, pressure and moments once they're loaded.
export function frequencySense() {
  if (instance) return instance;
  let emotion = null, pressure = null, momentsMod = null, key = null;
  Promise.all([import('./emotion.js'), import('./pressure.js'), import('./moments.js'), import('./characters.js')])
    .then(([e, p, m, c]) => { emotion = e; pressure = p; momentsMod = m; key = c.emotionKey('main'); })
    .catch((err) => activity('error', { where: 'frequency sense', message: `The frequencies she hears won't reach her feelings: ${err.message}` }));
  instance = createFrequencySense({
    feelingsNow: () => (emotion && key ? emotion.current(key) : {}),
    pressuresNow: () => pressure?.snapshot?.().buckets ?? {},
    moments: () => momentsMod?.moments?.() ?? null,
  });
  return instance;
}
