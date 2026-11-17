import { cleanMelody } from './sheet.js';

// Her sung voice put on the song's notes (owner, 2026-11-12: "it's all monotone. Is there any way we can do like
// auto-tune or something so that the tone of her voice that she's singing with goes along with the tone of the
// song?"). Her voice chooses its own notes and mostly stays near one; this bends each sung line onto a tune:
//  1. her pitch is followed frame by frame (10 ms, autocorrelation: key-detect.js), cleaned of octave slips;
//  2. each frame gets the note it should be on: the line's tune laid over the stretches she's actually voicing (her
//     own timing stays, so the words stay hers), or, with no tune, the nearest note of the key (classic auto-tune);
//     a short glide between notes and a little of her own wobble kept, so it's sung, not robotic;
//  3. the voice is moved there by TD-PSOLA: each pitch period cut out and laid back down at the new spacing, which
//     changes the note without changing the length or the shape of her voice (it still sounds like her).
// Pure: samples in, samples out; no files, no model.

const HOP = 0.01;             // seconds between pitch frames
const RETUNE = 0.035;         // seconds a glide from one note to the next takes (auto-tune's "retune speed")
const KEEP_WOBBLE = 0.5;      // how much of her own vibrato and scoops is kept on top of the note
const MAX_SHIFT = 9;          // semitones a line is ever moved (PSOLA gets rough beyond that)
const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const midiOfHz = (hz) => 69 + 12 * Math.log2(hz / 440);
// "C4", "F#3", "Bb2" -> MIDI number; null if it isn't a note.
function noteMidi(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(name).trim());
  return m ? (m[3] | 0) * 12 + 12 + NAMES[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) : null;
}

// A line's tune as written ("E4:1 F4 G4:2 | r A4"): [{ midi, beats }], rests left out (her voice's own gaps are the
// rests). Throws naming the word it couldn't read.
export function parseTune(text) {
  const out = [];
  for (const w of cleanMelody(text).split(/[|\s]+/).filter(Boolean)) {
    const [n, len] = w.split(/:(?=[\d.]+$)/);
    const beats = len === undefined ? 1 : Number(len);
    if (!Number.isFinite(beats) || beats <= 0) throw new Error(`"${w}": a length is beats more than 0, like E4:2.`);
    if (/^r(est)?$/i.test(n)) continue;
    const midi = noteMidi(n);
    if (midi === null) throw new Error(`"${n}" isn't a note; write a letter, an optional # or b, and an octave, like E4 or F#3.`);
    out.push({ midi, beats });
  }
  return out;
}

// Her pitch, every 10 ms: [{ t (s), midi | null }]. x: mono float samples. Octave slips (a frame an octave off its
// neighbours) and lone frames are smoothed out with a median over five frames.
// Her voice sits low (measured 2026-11-15 on her real sung and rapped lines: 60 to 145 Hz, with much of it under the
// 80 Hz this used to stop at, so two thirds of what she sang wasn't followed and couldn't be moved). It's followed
// down to 55 Hz, over frames long enough to hold two periods of that.
// Her voice is also a little rough, so a frame counts as pitched when it repeats itself half-well (0.5; at 0.6 a
// third of her loud frames were left out, at 0.5 a quarter, with none read wildly high).
//
// Followed as one line, not frame by frame (owner, 2026-11-15: "there's got to be something we can do to clean up any
// distortion or weird pitch changes. I want this clean and fluid"). Measured that day on nine real takes of one line:
// each frame judged on its own, 20 to 70 frames a take were read far off her pitch (a hiss read as 700 Hz, a vowel
// read an octave down), a third of her voiced frames weren't read as voiced at all, and so 16 to 29% of what came out
// was more than a semitone and a half off the written note: the misread frames were cut at the wrong period and moved
// by the wrong amount, and the unread ones stayed at her speaking pitch in the middle of a sung note. Now every frame
// offers its few best readings and the path through them that moves least is taken (a voice glides; it doesn't leap
// an octave for one hundredth of a second), a reading is placed between samples, and a short dropout inside a vowel
// is bridged.
const FRAME_S = 0.05, VOICE_MIN_HZ = 55, VOICE_MAX_HZ = 520, VOICE_CLARITY = 0.5;
const READINGS = 5;           // readings a frame offers
const LEAP_COST = 0.6;        // what an octave's leap between two frames costs (in clarity), less in proportion
const VOICING_COST = 0.15;    // what starting or stopping the voice costs: no flicker in and out
const LOW_COST = 0.02;        // per octave lower: of two readings as clear as each other, the higher is the period
const BRIDGE = 4;             // frames of dropout inside a vowel that are bridged

// The readings one frame offers: [{ midi, clarity }], best first; and how loud it is. Empty when it's silence.
function frameReadings(x, rate) {
  let energy = 0;
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
  const rms = Math.sqrt(energy / x.length);
  if (energy / x.length < 1e-5) return { rms, readings: [] };
  const minLag = Math.floor(rate / VOICE_MAX_HZ), maxLag = Math.min(x.length - 2, Math.ceil(rate / VOICE_MIN_HZ));
  const rs = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let num = 0, a = 0, b = 0;
    for (let i = 0; i + lag < x.length; i++) { num += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; }
    rs[lag] = num / Math.sqrt(a * b || 1);
  }
  const readings = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (rs[lag] < 0.3 || rs[lag] < rs[lag - 1] || rs[lag] <= rs[lag + 1]) continue;
    // The top of the peak lies between samples: at 16 kHz a whole sample is a fifth of a semitone at 200 Hz.
    const d = rs[lag - 1] - 2 * rs[lag] + rs[lag + 1];
    const off = d < 0 ? Math.max(-0.5, Math.min(0.5, (rs[lag - 1] - rs[lag + 1]) / (2 * d))) : 0;
    readings.push({ midi: midiOfHz(rate / (lag + off)), clarity: rs[lag] });
  }
  readings.sort((p, q) => q.clarity - p.clarity);
  return { rms, readings: readings.slice(0, READINGS) };
}

export function pitchTrack(x, rate) {
  const frame = Math.round(rate * FRAME_S), hop = Math.round(rate * HOP);
  const frames = [];
  for (let at = 0; at + frame <= x.length; at += hop) frames.push({ t: (at + frame / 2) / rate, ...frameReadings(x.subarray(at, at + frame), rate) });
  // The path through the readings that costs least: each frame is one of its readings or unvoiced (the last state).
  const lowest = midiOfHz(VOICE_MIN_HZ);
  let prev = null;
  const back = [];
  for (const f of frames) {
    const states = [...f.readings.map((r) => ({ midi: r.midi, cost: 1 - r.clarity + LOW_COST * Math.max(0, 5 - (r.midi - lowest) / 12) })), { midi: null, cost: 1 - VOICE_CLARITY }];
    const from = new Int32Array(states.length);
    states.forEach((s, j) => {
      if (!prev) return;
      let best = Infinity;
      prev.forEach((p, i) => {
        const step = p.midi === null || s.midi === null ? (p.midi === s.midi ? 0 : VOICING_COST) : LEAP_COST * Math.min(1, Math.abs(p.midi - s.midi) / 12);
        if (p.total + step < best) { best = p.total + step; from[j] = i; }
      });
      s.total = best + s.cost;
    });
    if (!prev) for (const s of states) s.total = s.cost;
    back.push(from);
    prev = states;
    f.states = states;
  }
  const midi = new Array(frames.length).fill(null);
  if (prev) {
    let j = prev.reduce((b, s, i) => (s.total < prev[b].total ? i : b), 0);
    for (let i = frames.length - 1; i >= 0; i--) { midi[i] = frames[i].states[j].midi; j = back[i][j]; }
  }
  // A dropout inside a vowel (still loud, the same note either side) is bridged; a voiced blip on its own is a
  // consonant, not a note.
  for (let i = 1; i < midi.length; i++) {
    if (midi[i] !== null || midi[i - 1] === null) continue;
    let end = i;
    while (end < midi.length && midi[end] === null) end++;
    if (end < midi.length && end - i <= BRIDGE && Math.abs(midi[end] - midi[i - 1]) < 3) {
      const loud = (frames[i - 1].rms + frames[end].rms) / 2;
      let quiet = false;
      for (let k = i; k < end; k++) if (frames[k].rms < loud * 0.3) quiet = true;
      if (!quiet) for (let k = i; k < end; k++) midi[k] = midi[i - 1] + ((midi[end] - midi[i - 1]) * (k - i + 1)) / (end - i + 1);
    }
    i = end;
  }
  for (let i = 0; i < midi.length;) {
    if (midi[i] === null) { i++; continue; }
    let end = i;
    while (end < midi.length && midi[end] !== null) end++;
    if (end - i < 3) for (let k = i; k < end; k++) midi[k] = null;
    i = end;
  }
  return frames.map((f, i) => ({ t: f.t, midi: midi[i] }));
}

// The stretches she's voicing (sung syllables): [{ from, to }] as frame indices, to exclusive. Gaps of a frame or two
// inside a syllable don't split it.
export function voicedRuns(track) {
  const runs = [];
  let from = -1, gap = 0;
  track.forEach((f, i) => {
    if (f.midi !== null) { if (from < 0) from = i; gap = 0; return; }
    if (from >= 0 && ++gap > 2) { runs.push({ from, to: i - gap + 1 }); from = -1; gap = 0; }
  });
  if (from >= 0) runs.push({ from, to: track.length - gap });
  return runs.filter((r) => r.to - r.from >= 3);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// The note each frame should be on. tune: [{ midi, beats }] (from parseTune) or null; scale: the key's pitch classes
// (sheet.js parseKey().scale), used when there's no tune. Returns [{ t, midi (hers) | null, target | null }].
export function planTargets(track, { tune = null, scale = null } = {}) {
  const runs = voicedRuns(track);
  const out = track.map((f) => ({ t: f.t, midi: null, target: null }));
  if (!runs.length) return out;
  const voicedFrames = runs.flatMap((r) => Array.from({ length: r.to - r.from }, (_, k) => r.from + k));
  const hers = median(voicedFrames.map((i) => track[i].midi));
  // Where each frame's note comes from.
  let noteAt;
  if (tune?.length) {
    // The tune sits where her voice sits: moved by whole octaves so its middle is nearest hers.
    const mid = median(tune.map((n) => n.midi));
    const shift = 12 * Math.round((hers - mid) / 12);
    const total = tune.reduce((s, n) => s + n.beats, 0);
    // Note boundaries as a share of the voiced time; each moved to the edge of a syllable when one is close, so a
    // new note starts with a new syllable rather than halfway through one.
    const edges = [];
    let acc = 0;
    for (const n of tune.slice(0, -1)) { acc += n.beats; edges.push(acc / total); }
    const runEdges = []; // voiced-time share where each run after the first starts
    let seen = 0;
    for (const r of runs) { if (seen) runEdges.push(seen / voicedFrames.length); seen += r.to - r.from; }
    const snapped = edges.map((e, k) => {
      const room = (tune[k].beats + tune[k + 1].beats) / total / 3;
      const near = runEdges.reduce((b, x) => (Math.abs(x - e) < Math.abs(b - e) ? x : b), Infinity);
      return Math.abs(near - e) <= room ? near : e;
    });
    const share = new Map(voicedFrames.map((i, k) => [i, (k + 0.5) / voicedFrames.length]));
    noteAt = (i) => { const s = share.get(i); let k = 0; while (k < snapped.length && s >= snapped[k]) k++; return tune[k].midi + shift; };
  } else if (scale?.length) {
    // Classic auto-tune: the nearest note of the key, held until she's clearly nearer another (no flutter between two).
    let held = null;
    noteAt = (i) => {
      const m = track[i].midi;
      if (held !== null && Math.abs(m - held) < 0.7) return held;
      let best = null;
      for (let n = Math.floor(m) - 2; n <= Math.ceil(m) + 2; n++) if (scale.includes(((n % 12) + 12) % 12) && (best === null || Math.abs(n - m) < Math.abs(best - m))) best = n;
      return (held = best ?? Math.round(m));
    };
  } else {
    return track.map((f) => ({ t: f.t, midi: f.midi, target: f.midi }));
  }
  // The glide into each note, and her own wobble on top of it (her pitch against its own running average).
  const glide = 1 - Math.exp(-HOP / RETUNE);
  let at = null;
  for (const r of runs) {
    for (let i = r.from; i < r.to; i++) {
      const m = track[i].midi;
      if (m === null) continue; // a gap inside a syllable stays as it was
      const note = noteAt(i);
      at = at === null ? note : at + (note - at) * glide;
      const near = track.slice(Math.max(r.from, i - 7), Math.min(r.to, i + 8)).map((f) => f.midi).filter((v) => v !== null);
      const avg = near.reduce((s, v) => s + v, 0) / near.length;
      const wobble = Math.max(-0.6, Math.min(0.6, (m - avg) * KEEP_WOBBLE));
      out[i] = { t: track[i].t, midi: m, target: at + wobble };
    }
  }
  return out;
}

// Moves the voice to the planned notes (TD-PSOLA). x: mono float samples at rate; plan: from planTargets on a
// pitchTrack of the same audio. Returns new samples, the same length.
export function retune(x, rate, plan) {
  const hop = HOP * rate;
  const frameAt = (pos) => plan[Math.max(0, Math.min(plan.length - 1, Math.round((pos - rate * FRAME_S / 2) / hop)))];
  // Analysis marks: one per pitch period where she's voiced (on the period's peak), every 5 ms elsewhere.
  const marks = [];
  const still = Math.round(rate * 0.005);
  for (let pos = 0; pos < x.length;) {
    const f = frameAt(pos);
    if (!f || f.midi === null || f.target === null) { marks.push({ pos, T: still, ratio: 1 }); pos += still; continue; }
    const T = Math.round(rate / (440 * 2 ** ((f.midi - 69) / 12)));
    const lo = Math.max(0, pos - (T >> 2)), hi = Math.min(x.length - 1, pos + (T >> 2));
    let peak = pos;
    for (let i = lo; i <= hi; i++) if (x[i] > x[peak]) peak = i;
    if (marks.length && peak <= marks.at(-1).pos) peak = marks.at(-1).pos + 1;
    const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, f.target - f.midi));
    marks.push({ pos: peak, T, ratio: 2 ** (shift / 12) });
    pos = peak + T;
  }
  // Synthesis: a grain (two periods, Hann-windowed) from the nearest mark, laid down every new period.
  const out = new Float32Array(x.length), weight = new Float32Array(x.length);
  let k = 0;
  for (let s = marks[0]?.pos ?? 0; s < x.length;) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1].pos - s) <= Math.abs(marks[k].pos - s)) k++;
    const { pos, T, ratio } = marks[k];
    // Laid down at the exact (fractional) spot, read between samples: rounding each grain to a whole sample makes
    // the periods alternate a sample long and short, which the ear hears as roughness and a pitch tracker as an
    // octave down.
    const base = Math.floor(s), frac = s - base;
    for (let j = -T; j <= T + 1; j++) {
      const dst = base + j, rel = j - frac, src = pos + rel;
      if (rel < -T || rel > T || src < 0 || src >= x.length - 1 || dst < 0 || dst >= x.length) continue;
      const i0 = Math.floor(src), v = x[i0] + (x[i0 + 1] - x[i0]) * (src - i0);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * rel) / T);
      out[dst] += v * w;
      weight[dst] += w;
    }
    s += Math.max(1, T / ratio);
  }
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(weight[i], 0.5);
  return out;
}

// ---- singing a line the way it's written: on the beat, held where it's held, as high as it's written ----
//
// Owner, 2026-11-15: "I need her to be able to sing better, like really hit high notes, really match the rhythm,
// stretch out the verses and the words if needed, just like a real singer." Until now a line kept the timing her
// voice happened to give it (so the words fell wherever, never on the band's beat), no note was ever held longer than
// she happened to say it, and every line was moved by whole octaves to where her voice sat on that line (so a chorus
// written higher than the verse came out no higher). Here a line is sung to its score:
//  - the score says, syllable by syllable, when it starts (in beats), how long it's held, and its note or notes (a
//    syllable can run over several notes; a rapped syllable has a length and no note);
//  - her syllables are found in what she sang (findSyllables: where the sound swells, one per written syllable);
//  - each syllable's vowel is moved to start on its beat and stretched or shortened to its written length (the
//    consonants keep their own length and sit just ahead of the beat, as a singer's do), and silence is left where
//    the score rests;
//  - the pitch goes where the score says, with one placement for the whole song (so high lines are high), a glide
//    between notes, a little of her own wobble, and vibrato growing on a note she holds.
// It's the same TD-PSOLA as retune(), with the grains laid down along the new timing. Pure: samples in, samples out.

// Semitones a sung note is ever moved when sung to a score. It was 14, and a real rock chorus (2026-11-15) came out
// two octaves under where it was written, its "belted" top note an E3: her takes sit around 110 to 150 Hz, and with
// 14 semitones of reach the only whole-octave placement that fitted was the bottom one. A voice singing that low has
// no power in it whatever is done to it afterwards. With 19 (an octave and a fifth) the same chorus sits an octave
// higher.
export const MAX_FIT_SHIFT = 19;
// How far a vowel is shortened or held, against how long she said it. Her vowels come out around a tenth of a second
// (measured on her real voice), and a note written to ring for a bar is two or three seconds, so a hold has to be able
// to reach twenty times: at 8 a note held for a bar was cut off after a second.
const MIN_STRETCH = 0.4, MAX_STRETCH = 20;
const LEGATO = 0.05;          // seconds a glide between two written notes takes
const VIBRATO_HZ = 5.5, VIBRATO_DEPTH = 0.3, VIBRATO_AFTER = 0.25, VIBRATO_NOTE = 0.6; // on notes held this long (s)

// A line's music as written, one item per syllable: "E4:1 F4:0.5+G4:0.5 r:1 A4:2" (a note and its beats; + joins the
// notes one syllable runs over; r is a rest) or, rapped, "x:0.5 x:0.25 x:0.25 r:0.5 x:1" (a length and no note).
// Returns { syllables: [{ at (beats from the line's start), beats, notes: [{ midi | null, beats }] }], beats }.
// Throws naming the item it couldn't read.
export function parseScore(text) {
  const syllables = [];
  let at = 0;
  const lengthOf = (w, len) => { const b = len === undefined ? 1 : Number(len); if (!Number.isFinite(b) || b <= 0) throw new Error(`"${w}": a length is beats more than 0, like E4:2 or x:0.5.`); return b; };
  for (const w of cleanMelody(text).split(/[|\s]+/).filter(Boolean)) {
    const rest = /^r(?:est)?(?::([\d.]+))?$/i.exec(w);
    if (rest) { at += lengthOf(w, rest[1]); continue; }
    const notes = w.split('+').filter(Boolean).map((part) => {
      const [n, len] = part.split(/:(?=[\d.]+$)/);
      const beats = lengthOf(part, len);
      if (/^x$/i.test(n)) return { midi: null, beats };
      const midi = noteMidi(n);
      if (midi === null) throw new Error(`"${n}" isn't a note; write a letter, an optional # or b, and an octave, like E4 or F#3 (or x for a rapped syllable, r for a rest).`);
      return { midi, beats };
    });
    if (!notes.length) continue;
    const beats = notes.reduce((s, n) => s + n.beats, 0);
    syllables.push({ at, beats, notes });
    at += beats;
  }
  return { syllables, beats: at };
}

// Where her syllables are in what she sang or said: `count` of them, the ones that stand out most in how the sound
// swells and dips (a syllable is a swell; the dip before it is its consonant). x: mono float samples.
// Returns { start, end (s: where her voice starts and stops), syllables: [{ dip, beat, peak }] (s) } or null when
// there's no sound. dip: where the syllable's consonant begins; beat: where its vowel comes in (what lands on the
// beat); peak: its loudest point. When fewer swells are heard than syllables written (two run together), the longest
// stretches are divided so there's still one place per written syllable.
// track: her pitch through the same sound (pitchTrack), when it's known. A syllable is then looked for where she's
// voicing (a hiss or a breath is loud too, and isn't one), two that ran together are divided where she's voicing
// longest, and each syllable also says where its sound stops (end), so a pause she took isn't taken for part of a
// word (measured 2026-11-15: a held note was landing on the breath after a comma and came out as a second of hiss).
export function findSyllables(x, rate, count, track = null) {
  const hop = Math.round(rate * HOP), win = Math.round(rate * 0.025);
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  if (n < 5 || !(count > 0)) return null;
  let e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let sq = 0; for (let j = i * hop; j < i * hop + win; j++) sq += x[j] * x[j]; e[i] = Math.sqrt(sq / win); }
  for (let pass = 0; pass < 2; pass++) { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = (e[Math.max(0, i - 1)] + 2 * e[i] + e[Math.min(n - 1, i + 1)]) / 4; e = s; }
  let max = 0;
  for (const v of e) if (v > max) max = v;
  if (!(max > 0)) return null;
  let a = 0, b = n - 1;
  while (a < n - 1 && e[a] < max * 0.06) a++;
  while (b > a && e[b] < max * 0.06) b--;
  if (b - a < 3) return null;
  const time = (i) => (i * hop + win / 2) / rate;
  // Whether she's voicing at a frame of the swell-and-dip curve (or a frame or two either side of it).
  const pitched = track?.some((f) => f.midi !== null) ? (i) => {
    const j = Math.round((time(i) - FRAME_S / 2) / HOP);
    for (let d = -2; d <= 2; d++) if (track[j + d]?.midi != null) return true;
    return false;
  } : null;
  // Every swell, with how far it stands above the dips either side of it.
  const swells = (where) => {
    const found = [];
    for (let i = a; i <= b; i++) {
      if (e[i] < max * 0.1 || (i > a && e[i] < e[i - 1]) || (i < b && e[i] <= e[i + 1]) || (where && !where(i))) continue;
      let left = e[i], right = e[i];
      for (let j = i - 1; j >= a && e[j] <= e[i]; j--) left = Math.min(left, e[j]);
      for (let j = i + 1; j <= b && e[j] <= e[i]; j++) right = Math.min(right, e[j]);
      found.push({ i, prominence: e[i] - Math.max(left, right) });
    }
    return found;
  };
  let peaks = swells(pitched);
  if (!peaks.length) peaks = swells(null);
  // The `count` that stand out most, none closer than 60 ms to a stronger one.
  const chosen = [];
  for (const p of [...peaks].sort((p, q) => q.prominence - p.prominence)) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => Math.abs(c.i - p.i) >= 6)) chosen.push(p);
  }
  const nuclei = chosen.map((p) => p.i).sort((p, q) => p - q);
  if (!nuclei.length) nuclei.push(Math.round((a + b) / 2));
  // Fewer swells than syllables (two ran together, or a word was sung straight into the next): the swell with the
  // most sound to itself is divided in two, until there's one each.
  const sounding = [];
  for (let i = a; i <= b; i++) if (pitched ? pitched(i) && e[i] >= max * 0.06 : e[i] >= max * 0.1) sounding.push(i);
  while (nuclei.length < count) {
    const own = nuclei.map(() => []);
    for (const i of sounding) own[nuclei.reduce((best, p, k) => (Math.abs(p - i) < Math.abs(nuclei[best] - i) ? k : best), 0)].push(i);
    const most = own.reduce((best, o, k) => (o.length > own[best].length ? k : best), 0);
    const o = own[most];
    if (o.length < 6) break;
    const first = o[o.length >> 2], second = o[(3 * o.length) >> 2];
    if (first === second || nuclei.some((p, k) => k !== most && (p === first || p === second))) break;
    nuclei.splice(most, 1, first, second);
    nuclei.sort((p, q) => p - q);
  }
  // Still short (hardly any sound to divide): the longest stretch between two is divided.
  while (nuclei.length < count) {
    const edges = [a, ...nuclei, b];
    let widest = 0;
    for (let k = 1; k < edges.length - 1; k++) if (edges[k + 1] - edges[k] > edges[widest + 1] - edges[widest]) widest = k;
    const mid = Math.round((edges[widest] + edges[widest + 1]) / 2);
    if (nuclei.includes(mid) || edges[widest + 1] - edges[widest] < 2) break;
    nuclei.push(mid); nuclei.sort((p, q) => p - q);
  }
  const quiet = max * 0.05;
  const dips = nuclei.map((peak, k) => {
    const lo = k ? nuclei[k - 1] : a;
    let dip = k ? lo + 1 : a;
    if (k) for (let j = lo + 1; j <= peak; j++) if (e[j] < e[dip]) dip = j;
    return dip;
  });
  const syllables = nuclei.map((peak, k) => {
    // Its consonant starts at the dip, or, when the dip is a pause, where the sound comes back.
    let dip = dips[k];
    while (dip < peak - 1 && e[dip + 1] < quiet) dip++;
    // The vowel comes in where the sound has climbed a third of the way from the dip to the swell.
    const level = e[dip] + (e[peak] - e[dip]) * 0.35;
    let beat = dip;
    while (beat < peak && e[beat] < level) beat++;
    // And its sound stops at the next syllable's dip, or sooner, where it falls quiet.
    const stop = k + 1 < nuclei.length ? dips[k + 1] : b;
    let end = peak;
    while (end < stop && e[end + 1] >= quiet) end++;
    return { dip: time(dip), beat: time(beat), peak: time(peak), end: time(end) + hop / rate / 2 };
  });
  return { start: time(a) - win / 2 / rate, end: Math.min(x.length / rate, time(b) + win / 2 / rate), syllables };
}

// Where a whole song's tune sits in her voice: moved by whole octaves (the band stays in its key) as high as she can
// reach, so the highest note she wrote is really sung (within MAX_FIT_SHIFT of where her voice sits) instead of being
// flattened. hers: the middle of her sung pitch (MIDI); top: the highest note written. Returns semitones.
export const placeTune = (hers, top) => 12 * Math.floor((hers + MAX_FIT_SHIFT - top) / 12);

// Where a sung song's tune sits in her voice: by whole octaves, with the middle of the tune near where she sings
// (a little above it), never higher than placeTune would put it. Owner, 2026-11-16: "her words are very distorted
// sometimes... She needs to sound beautiful and coherent and fluid." Measured that day on four real lines at full
// power, written G4 to E5 over takes around C4: placed as high as she could reach, every line was moved 10 to 13
// semitones and a third of the words came out wrong ("match your smile" -> "matches my own"); an octave lower, they
// moved 2 to 4 and every word came through as clearly as her own take. Her voice model chooses how high she sings;
// moving it far from there is what breaks the words. hers: the middle of her sung pitch (MIDI); notes: every note
// written (MIDI). Returns semitones.
export const SONG_LEAN = 3; // semitones above where she sings that the middle of the tune is aimed at
export function placeSong(hers, notes) {
  const written = notes.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!written.length || !Number.isFinite(hers)) return 0;
  const mid = written[Math.floor(written.length / 2)];
  return Math.min(12 * Math.round((hers + SONG_LEAN - mid) / 12), placeTune(hers, written.at(-1)));
}

// Her pitch through a line, with each frame's wobble (her pitch against its own running average), for fitLine.
export function followVoice(hear, hearRate) {
  const track = pitchTrack(hear, hearRate);
  const voiced = track.filter((f) => f.midi !== null).map((f) => f.midi);
  return { track, median: median(voiced), voiced: voiced.length };
}

// The analysis marks PSOLA cuts her voice at: one per pitch period where she's voiced (on the period's peak), every
// 5 ms elsewhere. track: her pitch every 10 ms. [{ pos (sample), T (samples), midi | null }].
function marksOf(x, rate, track) {
  const hop = HOP * rate;
  const frameAt = (pos) => track[Math.max(0, Math.min(track.length - 1, Math.round((pos - rate * FRAME_S / 2) / hop)))];
  const marks = [];
  const still = Math.round(rate * 0.005);
  for (let pos = 0; pos < x.length;) {
    const f = frameAt(pos);
    if (!f || f.midi === null) { marks.push({ pos, T: still, midi: null }); pos += still; continue; }
    const T = Math.round(rate / (440 * 2 ** ((f.midi - 69) / 12)));
    const lo = Math.max(0, pos - (T >> 2)), hi = Math.min(x.length - 1, pos + (T >> 2));
    let peak = pos;
    for (let i = lo; i <= hi; i++) if (x[i] > x[peak]) peak = i;
    if (marks.length && peak <= marks.at(-1).pos) peak = marks.at(-1).pos + 1;
    marks.push({ pos: peak, T, midi: f.midi });
    pos = peak + T;
  }
  return marks;
}

// One line sung to its score. x: her voice (mono float samples at rate); score: parseScore's; tempo: bpm; shift:
// semitones the whole song's tune is moved to sit where her voice does (the same for every line, so a line written
// high is sung high); hear/hearRate: the line at a lower rate, for following her pitch and finding her syllables.
// Returns { samples, lead (s of consonant sounded before the line's own start), seconds, moved (average semitones
// her pitch was moved), held (the most a vowel was stretched, as a ratio), syllables (how many places were found) }.
// Throws when there's nothing in the line to sing.
// vibrato: how deep it is on a held note, in semitones either side (wider on a line she's putting more into).
export function fitLine(x, rate, opts = {}) {
  const plan = planFit(x, rate, opts);
  return { ...psolaFit(x, rate, plan, opts), lead: plan.lead, seconds: plan.total, held: plan.held, syllables: plan.found, beats: plan.beatsOut };
}

// The same line rendered smoothly (voice/world.js, the WORLD vocoder): every 5 ms of the output, where in what she sang
// it's read from (-1: silence) and the note it's sung on (null: her own pitch). Owner, 2026-11-16: "her words are very
// distorted sometimes... She needs to sound beautiful and coherent and fluid." Returns { frames: { srcT, midi, frame },
// lead, seconds, held, moved, syllables, beats, length (samples) }.
export const WORLD_FRAME = 0.005;
export function worldPlan(x, rate, opts = {}) {
  const plan = planFit(x, rate, opts);
  const { pieces, total, noteAt, wobbleAt, track } = plan;
  const shift = opts.shift ?? 0, vibrato = opts.vibrato ?? VIBRATO_DEPTH;
  const frames = Math.ceil(total / WORLD_FRAME) + 1;
  const srcT = new Array(frames).fill(-1), midi = new Array(frames).fill(null);
  let p = 0, at = null, movedSum = 0, movedN = 0;
  for (let f = 0; f < frames; f++) {
    const t = f * WORLD_FRAME;
    while (p < pieces.length && pieces[p].o1 <= t) p++;
    const piece = pieces[p];
    if (!piece || piece.o0 > t) { at = null; continue; }
    const tin = piece.i0 + (t - piece.o0) * ((piece.i1 - piece.i0) / (piece.o1 - piece.o0));
    srcT[f] = tin;
    const note = noteAt(t);
    if (note.midi === null) { at = null; continue; } // rapped: her own pitch
    const goal = note.midi + shift;
    at = at === null ? goal : at + (goal - at) * (1 - Math.exp(-WORLD_FRAME / LEGATO));
    const vib = note.seconds >= VIBRATO_NOTE && note.into > VIBRATO_AFTER
      ? vibrato * Math.min(1, (note.into - VIBRATO_AFTER) / 0.3) * Math.sin(2 * Math.PI * VIBRATO_HZ * note.into) : 0;
    const k = Math.max(0, Math.min(track.length - 1, Math.round((tin - FRAME_S / 2) / HOP)));
    midi[f] = +(at + vib + wobbleAt(k)).toFixed(3);
    if (track[k]?.midi != null) { movedSum += Math.min(MAX_FIT_SHIFT, Math.abs(midi[f] - track[k].midi)); movedN++; }
  }
  return { frames: { srcT, midi, frame: WORLD_FRAME }, lead: plan.lead, seconds: total, length: Math.ceil(total * rate), held: plan.held,
    moved: movedN ? +(movedSum / movedN).toFixed(2) : 0, syllables: plan.found, beats: plan.beatsOut };
}

// Where every piece of what she sang goes for the line to be sung to its score, and the note at every moment.
function planFit(x, rate, { score, tempo = 90, hear = x, hearRate = rate, voice = null } = {}) {
  const N = score?.syllables?.length ?? 0;
  if (!N) throw new Error('the line has no syllables written for it.');
  const { track } = voice ?? followVoice(hear, hearRate);
  const found = findSyllables(hear, hearRate, N, track);
  if (!found) throw new Error("there was no sound in what her voice gave for the line.");
  // The longest stretch she's voicing between two moments of what she sang: { from, to } (s), or null. It's the
  // only part of a word that's ever held: a breath or a hiss drawn out is noise, a vowel drawn out is a held note.
  const voicedCore = (t0, t1) => {
    let best = null, from = -1;
    const first = Math.max(0, Math.ceil((t0 - FRAME_S / 2) / HOP)), end = Math.min(track.length, Math.floor((t1 - FRAME_S / 2) / HOP) + 1);
    for (let i = first; i <= end; i++) {
      const on = i < end && track[i].midi !== null;
      if (on && from < 0) from = i;
      if (!on && from >= 0) { if (!best || i - from > best.to - best.from) best = { from, to: i }; from = -1; }
    }
    return best && { from: Math.max(t0, best.from * HOP + FRAME_S / 2 - HOP / 2), to: Math.min(t1, (best.to - 1) * HOP + FRAME_S / 2 + HOP / 2) };
  };
  const spb = 60 / tempo, S = found.syllables;
  const lead = Math.max(0, Math.min(0.3, S[0].beat - found.start));
  // Where each piece of her voice goes: [{ o0, o1 (s out), i0, i1 (s in) }], in order; gaps between them are silence.
  const pieces = [], beatsOut = [];
  const piece = (o0, len, i0, i1) => { if (len > 0.001 && i1 > i0) pieces.push({ o0, o1: o0 + len, i0, i1 }); return o0 + len; };
  let cursor = piece(Math.max(0, score.syllables[0].at * spb), lead, S[0].beat - lead, S[0].beat);
  let held = 1;
  for (let k = 0; k < N; k++) {
    const syl = score.syllables[k], last = k === N - 1;
    const start = Math.max(lead + syl.at * spb, cursor); // on its beat, or as soon after as the one before allows
    beatsOut.push(start);
    const vin0 = S[k].beat, vin1 = Math.max(vin0 + 0.01, Math.min(S[k].end ?? Infinity, last ? found.end : S[k + 1].dip));
    const cin = last ? 0 : Math.max(0, S[k + 1].beat - S[k + 1].dip);
    const vin = vin1 - vin0, written = syl.beats * spb;
    const room = last ? written : lead + score.syllables[k + 1].at * spb - start - cin;
    let vout = Math.max(MIN_STRETCH * vin, Math.min(MAX_STRETCH * vin, Math.min(written, room)));
    // Held longer than she said it: only the part she's voicing is held, from its middle; the way into it and out
    // of it, and any breath or consonant around it, keep their own length. With nothing voiced in it there's
    // nothing to hold: it's said once, and the rest of its time is left quiet. Shorter: all of it is drawn in evenly.
    const core = vout > vin ? voicedCore(vin0, vin1) : null;
    const edge = core ? Math.min(0.03, (core.to - core.from) / 4) : 0;
    if (core && core.to - core.from - 2 * edge > 0.015) {
      const h0 = core.from + edge, h1 = core.to - edge;
      cursor = piece(start, h0 - vin0, vin0, h0);
      cursor = piece(Math.max(cursor, start), vout - (h0 - vin0) - (vin1 - h1), h0, h1);
      cursor = piece(cursor, vin1 - h1, h1, vin1);
    } else {
      if (vout > vin) vout = vin;
      cursor = piece(start, vout, vin0, vin1);
    }
    held = Math.max(held, vout / vin);
    // The next syllable's consonant, at its own length, ending on that syllable's beat.
    if (!last && cin > 0) cursor = piece(Math.max(cursor, lead + score.syllables[k + 1].at * spb - cin), cin, S[k + 1].dip, S[k + 1].beat);
  }
  const total = cursor + 0.03;
  // The note sounding at a moment of the output: which syllable, and which of its notes.
  const noteAt = (t) => {
    let k = 0;
    while (k + 1 < N && beatsOut[k + 1] <= t) k++;
    const syl = score.syllables[k];
    let into = Math.max(0, t - beatsOut[k]), j = 0;
    while (j + 1 < syl.notes.length && into >= syl.notes[j].beats * spb) { into -= syl.notes[j].beats * spb; j++; }
    return { midi: syl.notes[j].midi, into, seconds: syl.notes[j].beats * spb };
  };
  // Her wobble at each frame of what she sang.
  const wobbleAt = (f) => {
    const m = track[f]?.midi;
    if (m == null) return 0;
    let sum = 0, cnt = 0;
    for (let i = Math.max(0, f - 7); i < Math.min(track.length, f + 8); i++) if (track[i].midi !== null) { sum += track[i].midi; cnt++; }
    return Math.max(-0.5, Math.min(0.5, (m - sum / cnt) * 0.35));
  };
  return { pieces, total, lead, held: +held.toFixed(2), beatsOut, noteAt, wobbleAt, track, found: S.length };
}

// The planned line laid down by TD-PSOLA: her pitch periods cut and laid back along the new timing. Rough on long holds
// and big moves; used when the WORLD vocoder can't run (voice/world.js).
function psolaFit(x, rate, { pieces, total, noteAt, wobbleAt, track }, { shift = 0, vibrato = VIBRATO_DEPTH } = {}) {
  const marks = marksOf(x, rate, track);
  const len = Math.ceil(total * rate);
  const out = new Float32Array(len), weight = new Float32Array(len);
  const frameOf = (pos) => Math.max(0, Math.min(track.length - 1, Math.round((pos - rate * FRAME_S / 2) / (HOP * rate))));
  let k = 0, at = null, movedSum = 0, movedN = 0, seed = 1;
  for (const p of pieces) {
    const slope = (p.i1 - p.i0) / (p.o1 - p.o0);
    for (let s = p.o0 * rate; s < p.o1 * rate;) {
      const tin = (p.i0 + (s / rate - p.o0) * slope) * rate;
      while (k + 1 < marks.length && Math.abs(marks[k + 1].pos - tin) <= Math.abs(marks[k].pos - tin)) k++;
      while (k > 0 && Math.abs(marks[k - 1].pos - tin) < Math.abs(marks[k].pos - tin)) k--;
      const { T, midi } = marks[k];
      let pos = marks[k].pos;
      // Breath and consonants have no pitch to follow, so their grains come every 5 ms. Held longer than she made
      // them, the same grain would come round again and again and hum at 200 Hz (measured on her real voice); each
      // is taken from a slightly different place instead, which keeps it breath.
      if (midi === null) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pos = Math.round(tin + (slope < 0.9 ? (seed / 0x7fffffff - 0.5) * 2 * T : 0)); }
      let ratio = 1;
      if (midi !== null) {
        const note = noteAt(s / rate);
        if (note.midi !== null) {
          const goal = note.midi + shift;
          at = at === null ? goal : at + (goal - at) * (1 - Math.exp(-(T / rate) / LEGATO));
          const vib = note.seconds >= VIBRATO_NOTE && note.into > VIBRATO_AFTER
            ? vibrato * Math.min(1, (note.into - VIBRATO_AFTER) / 0.3) * Math.sin(2 * Math.PI * VIBRATO_HZ * note.into) : 0;
          const move = Math.max(-MAX_FIT_SHIFT, Math.min(MAX_FIT_SHIFT, at + vib + wobbleAt(frameOf(pos)) - midi));
          ratio = 2 ** (move / 12);
          movedSum += Math.abs(move); movedN++;
        } else at = null; // a rapped syllable keeps the pitch she said it at
      }
      // A held vowel is the same few periods of her voice laid down many times over. Taken one period at a time it
      // steps from each to the next (a buzz with a stair in it); each grain is instead a blend of the two periods
      // either side of where the hold has got to, so the vowel moves through itself without a seam.
      const other = midi !== null && slope < 0.75 ? k + (tin >= pos ? 1 : -1) : -1;
      const far = other >= 0 && other < marks.length && marks[other].midi !== null ? Math.min(0.5, Math.abs(tin - pos) / Math.max(1, Math.abs(marks[other].pos - pos))) : 0;
      const base = Math.floor(s), frac = s - base;
      for (let j = -T; j <= T + 1; j++) {
        const dst = base + j, rel = j - frac;
        if (rel < -T || rel > T || dst < 0 || dst >= len) continue;
        const read = (p) => { const src = p + rel; if (src < 0 || src >= x.length - 1) return 0; const i0 = Math.floor(src); return x[i0] + (x[i0 + 1] - x[i0]) * (src - i0); };
        const v = far ? read(pos) * (1 - far) + read(marks[other].pos) * far : read(pos);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * rel) / T);
        out[dst] += v * w;
        weight[dst] += w;
      }
      s += Math.max(1, T / ratio);
    }
  }
  for (let i = 0; i < len; i++) out[i] /= Math.max(weight[i], 0.5);
  return { samples: out, moved: movedN ? +(movedSum / movedN).toFixed(2) : 0 };
}

// One sung line onto its tune (or the key): samples in, samples out, and how far it was moved on average (semitones,
// for the log). hear/hearRate: the same line at a lower rate for following her pitch (16 kHz is plenty, and
// several times faster than following it at full rate); defaults to x itself.
export function tuneLine(x, rate, { tune = null, scale = null, hear = x, hearRate = rate } = {}) {
  const plan = planTargets(pitchTrack(hear, hearRate), { tune, scale });
  const moved = plan.filter((f) => f.target !== null && f.midi !== null).map((f) => Math.abs(f.target - f.midi));
  return { samples: retune(x, rate, plan), moved: moved.length ? +(moved.reduce((s, v) => s + v, 0) / moved.length).toFixed(2) : 0 };
}
