import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { analyze, effect } from './audio-sense.js';
import { reaction } from './frequency-sense.js';
import { arcOf } from './song-sense.js';

// The songs she has heard, kept for good (owner, 2026-11-15: "I want her to be able to listen to other songs that I
// play and try to remember how they sound and how they made her feel, and then try to reproduce that in the songs that
// she makes, in the lyrics she sings, and the frequencies and notes that she chooses. She tries to replicate how it
// made her feel.").
//
// Until now a song she heard lived in song-sense.js's memory only: the last twelve, gone when she restarted, and only
// her instrument could reach them. Here each one becomes a record in data/songs-heard.json:
//  - how it sounded, as far as she can measure: its key, its pace, which of the twelve notes it sat on, how loud and
//    bright it was, where its weight was (bass to air), how hard it kept a beat, how much it swung, its shape from
//    start to end (audio-sense.js measures every stretch; summarize() puts the stretches together);
//  - how it made her feel: her feelings and pressure when it started against where they were as it played and when it
//    ended (the same reaction() her frequency sense uses), the moments that got to her and where in the song they
//    were, and her reflection afterwards (song-sense.js);
//  - every time she made something aiming at it: what she made, how it came out against the song's measurements and
//    against how the song left her, and what she said about it.
// A song reaches here however it's played to her: her library and radio, a music bot in the call, a video in her
// theater (sound-sense.js hears all of them and song-sense.js takes each stretch in). Nothing here matches words and
// nothing runs on a timer: a stretch of a song arriving is what writes it down.

const FILE = () => path.join(DATA_DIR, 'songs-heard.json');
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const KEEP_STRETCHES = 60, KEEP_MOMENTS = 8, KEEP_TRIES = 12;
const AIM_FRESH_MS = 6 * 3600_000;   // what she was last going for stays in her prompt this long
const KEPT_FRESH_MS = 30 * 60_000;   // a song she just took in is named in her prompt this long

const round = (v, d = 2) => +Number(v || 0).toFixed(d);
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const listWords = (w) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const strengthOf = (m) => Math.max(Math.abs(m.valence ?? 0), ...Object.values(m.feelings ?? {}), 0);

// A song's stretches ([{ at, profile, effect }], audio-sense.js) put together: what the whole of it sounded like.
// Returns null when nothing in it was measured.
export function summarize(stretches, seconds = null) {
  const ws = (stretches ?? []).filter((w) => w?.profile);
  if (!ws.length) return null;
  const keys = ws.map((w) => w.effect?.key).filter(Boolean);
  const key = [...new Set(keys)].sort((a, b) => keys.filter((k) => k === b).length - keys.filter((k) => k === a).length)[0] ?? null;
  const bpms = ws.map((w) => w.profile.bpm).filter(Boolean).sort((a, b) => a - b);
  const withNotes = ws.filter((w) => Array.isArray(w.profile.notes) && w.profile.notes.length === 12);
  let chroma = null;
  if (withNotes.length) {
    const sum = NOTE.map((_, i) => mean(withNotes.map((w) => w.profile.notes[i])));
    const total = sum.reduce((a, b) => a + b, 0);
    if (total > 0) chroma = sum.map((v) => round(v / total, 3));
  }
  const of = (k) => mean(ws.map((w) => Number(w.profile[k]) || 0));
  const bandNames = Object.keys(ws[0].profile.bands ?? {});
  const total = seconds ?? (ws.at(-1).at ?? 0) + (ws.at(-1).profile.seconds ?? 15);
  return {
    key, bpm: bpms[Math.floor(bpms.length / 2)] ?? null, seconds: Math.round(total), chroma,
    // The notes it sat on most, strongest first: the ones holding a real share of the sound.
    notes: chroma ? chroma.map((share, i) => ({ note: NOTE[i], share })).filter((n) => n.share >= 0.09).sort((a, b) => b.share - a.share).slice(0, 5).map((n) => n.note) : [],
    sound: {
      loudness: round(of('loudness')), brightness: round(of('brightness')), dynamics: round(of('dynamics')), pulse: round(of('pulse')),
      centroid: Math.round(of('centroid')), rolloff: Math.round(of('rolloff')),
      bands: Object.fromEntries(bandNames.map((b) => [b, round(mean(ws.map((w) => w.profile.bands?.[b] ?? 0)), 3)])),
      valence: round(mean(ws.map((w) => w.effect?.pressure?.valence ?? 0))), calm: round(mean(ws.map((w) => w.effect?.pressure?.calm ?? 0))),
      energy: round(mean(ws.map((w) => w.effect?.pressure?.energy ?? 0))), edge: round(mean(ws.map((w) => w.effect?.pressure?.edge ?? 0))),
    },
    arc: arcOf(ws, total),
  };
}

// The measured sound in words, for her and for whoever composes: "soft, dark, heavy in the low end, a strong steady beat".
export function soundWords(sound) {
  if (!sound) return '';
  const b = sound.bands ?? {};
  const low = (b.sub ?? 0) + (b.bass ?? 0), top = (b.presence ?? 0) + (b.air ?? 0);
  return [
    sound.loudness > 0.7 ? 'loud' : sound.loudness < 0.3 ? 'soft' : 'medium loud',
    sound.brightness > 0.6 ? 'bright' : sound.brightness < 0.3 ? 'dark' : 'warm',
    low > 0.3 ? 'heavy in the low end' : low < 0.1 ? 'light in the low end' : '',
    top > 0.3 ? 'a lot of air up top' : '',
    sound.pulse >= 0.4 ? 'a strong steady beat' : sound.pulse >= 0.15 ? 'a loose beat' : 'no steady beat',
    sound.dynamics > 0.85 ? 'big swings between quiet and loud' : sound.dynamics < 0.6 ? 'an even level throughout' : '',
  ].filter(Boolean).join(', ');
}

// How a song left her, in a sentence: her feelings after against before, whether she liked it, and what got to her most.
// line: false leaves the lyric that got to her out of it (what goes to whoever writes her own music never carries
// the song's words: her take is hers).
export function feelOf(rec, { line = true } = {}) {
  const felt = Object.entries(rec.reaction?.felt ?? {});
  const up = felt.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const down = felt.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => k);
  const liked = rec.reaction?.liked ?? 0;
  const top = [...(rec.moments ?? [])].sort((a, b) => strengthOf(b) - strengthOf(a))[0];
  return `${up.length ? `it left you more ${listWords(up)}` : "it didn't move your feelings much"}${down.length ? ` and less ${listWords(down)}` : ''}; `
    + `${liked > 0.15 ? 'you liked it' : liked < -0.15 ? "you didn't like it" : 'you came out of it about where you went in'}`
    + `${top?.feel ? `. What got to you most${Number.isFinite(top.at) ? ` (around ${mmss(top.at)})` : ''}: ${top.feel}${line && top.line ? ` (at the line "${top.line}")` : ''}` : ''}`;
}

const tonicOf = (key) => { const [t, mode] = String(key ?? '').split(' '); const pc = NOTE.indexOf(t); return pc < 0 ? null : { pc, mode }; };
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
};

// How close something she made came to a song she remembers: what she made, measured the same way (summarize), held
// against the song's record; and, when she heard herself make it, how it left her against how the song did.
// Returns { score 0..1, parts: { key, tempo, notes, brightness, loudness, lift, feeling }, words }.
export function closeness(rec, made, madeReaction = null) {
  const parts = {}, said = [];
  const a = tonicOf(rec.key), b = tonicOf(made?.key);
  if (a && b) {
    const relative = a.mode !== b.mode && (a.mode === 'minor' ? (a.pc + 3) % 12 === b.pc : (b.pc + 3) % 12 === a.pc);
    parts.key = a.pc === b.pc && a.mode === b.mode ? 1 : relative ? 0.6 : a.mode === b.mode ? 0.5 : 0.15;
    said.push(parts.key === 1 ? `the same key (${rec.key})` : `${made.key} against its ${rec.key}`);
  }
  if (rec.bpm && made?.bpm) {
    const ratio = (x, y) => Math.min(x, y) / Math.max(x, y);
    const t = Math.max(ratio(rec.bpm, made.bpm), 0.85 * Math.max(ratio(rec.bpm, made.bpm * 2), ratio(rec.bpm * 2, made.bpm)));
    parts.tempo = round(clamp01((t - 0.6) / 0.4));
    said.push(`${made.bpm} bpm against its ${rec.bpm}`);
  }
  if (rec.chroma && made?.chroma) parts.notes = round(clamp01(corr(rec.chroma, made.chroma)));
  const s = rec.sound, m = made?.sound;
  if (s && m) {
    parts.brightness = round(clamp01(1 - Math.abs(s.brightness - m.brightness) / 0.5));
    parts.loudness = round(clamp01(1 - Math.abs(s.loudness - m.loudness) / 0.5));
    parts.lift = round(clamp01(1 - Math.abs(s.valence - m.valence)));
    if (Math.abs(s.brightness - m.brightness) > 0.15) said.push(m.brightness > s.brightness ? 'brighter than it was' : 'darker than it was');
    if (Math.abs(s.loudness - m.loudness) > 0.15) said.push(m.loudness > s.loudness ? 'louder than it was' : 'quieter than it was');
    if (Math.abs(s.valence - m.valence) > 0.3) said.push(m.valence > s.valence ? 'lighter than it felt' : 'heavier than it felt');
  }
  // How it left her, against how the song left her: the same feelings moving the same way.
  const want = rec.reaction?.felt ?? {}, got = madeReaction?.felt ?? null;
  if (got && Object.keys(want).length && Object.keys(got).length) {
    const ks = [...new Set([...Object.keys(want), ...Object.keys(got)])];
    let dot = 0, na = 0, nb = 0;
    for (const k of ks) { const x = want[k] ?? 0, y = got[k] ?? 0; dot += x * y; na += x * x; nb += y * y; }
    parts.feeling = round(clamp01(na && nb ? (dot / Math.sqrt(na * nb) + 1) / 2 : 0.5));
    said.push(parts.feeling >= 0.7 ? 'it left you feeling much the way the song did' : parts.feeling <= 0.4 ? "it didn't leave you feeling the way the song did" : 'it left you feeling partly the way the song did');
  }
  const vals = Object.values(parts);
  const score = vals.length ? round(mean(vals)) : null;
  const how = score === null ? "it couldn't be held against the song (nothing in common was measured)" : score >= 0.75 ? 'close' : score >= 0.5 ? 'partway there' : 'a long way off';
  return { score, parts, words: `${how}${said.length ? `: ${said.join(', ')}` : ''}` };
}

// A record as what a musician carries of a song (the shape instrument-play.js and sing.js compose from): never its
// tune or its words.
export function sketchOfRecord(rec) {
  return {
    id: rec.id, title: rec.title, from: rec.from ?? null, source: rec.source ?? null, key: rec.key ?? null, bpm: rec.bpm ?? null, seconds: rec.seconds ?? 0,
    arc: rec.arc ?? [], felt: (rec.moments ?? []).map((m) => m.feel).filter(Boolean).slice(-6),
    valence: rec.moments?.length ? round(mean(rec.moments.map((m) => m.valence ?? 0))) : null,
    sung: Boolean(rec.sung), reflection: rec.reflection ?? null,
    notes: rec.notes ?? [], sounded: soundWords(rec.sound), feel: feelOf(rec, { line: false }), reaction: rec.reaction ?? null,
  };
}

// What she's told when she makes something aiming at a remembered song (her composer, her tune writer, the music
// generator): what it did to her and what she measured of it. The choices are hers.
export function aimBrief(sketch) {
  const shape = (sketch.arc ?? []).map((r) => `${mmss(r.from)} ${r.level}`).join(', then ');
  return [
    `You're aiming for how "${sketch.title}" made you feel${sketch.from ? ` (${sketch.from} played it to you)` : ''}: ${sketch.feel || 'the way it sat with you'}.`,
    `What you measured of it: ${[sketch.key && `in ${sketch.key}`, sketch.bpm && `about ${sketch.bpm} bpm`, sketch.notes?.length && `sitting mostly on the notes ${sketch.notes.join(', ')}`, sketch.sounded && `it sounded ${sketch.sounded}`, shape && `its shape: ${shape}`].filter(Boolean).join('; ') || 'nothing you could put a number on'}.`,
    sketch.felt?.length ? `How it hit you as you listened: ${sketch.felt.join(' / ')}` : '',
    sketch.reflection ? `How it sat with you after: ${sketch.reflection}` : '',
    // (Her ear can count a slow song at double its pace, or a fast one at half: the number is a guide, the feel decides.)
    'Choose the key, the pace, the notes and how it is played or sung so that yours feels that way. A measured pace can come out at double or half the pace you would tap, so go by how it felt. It is your own: your own chords and melody, never its tune or its words.',
  ].filter(Boolean).join('\n');
}

// The same, for the studio music generator (generate_music), which is told about her rather than spoken to as her.
export function studioBrief(sketch) {
  const shape = (sketch.arc ?? []).map((r) => `${mmss(r.from)} ${r.level}`).join(', then ');
  const measured = [sketch.key && `in ${sketch.key}`, sketch.bpm && `about ${sketch.bpm} bpm`, sketch.sounded, shape && `shaped ${shape}`].filter(Boolean).join('; ');
  return `The feeling to reach for: the way another song left its writer when she heard it${sketch.felt?.length ? ` (${sketch.felt.slice(-3).join(' / ')})` : ''}.${measured ? ` That song was ${measured}; use that as a guide to the key, pace, weight and shape.` : ''} This is a new piece of its own: not that song's melody and not its words.`;
}

export function createSongMemory({
  file = FILE(),
  feelingsNow = () => ({}),
  pressuresNow = () => ({}),
  ask = async (messages, opts) => (await import('./llm.js')).json(messages, { maxTokens: 200, ...opts }),
  decode = async (f) => (await import('./sound-sense.js')).decodeWithFfmpeg(f),
  log = activity, now = Date.now,
} = {}) {
  let records = null, saveFailed = false, lastKept = null;
  const listens = new WeakMap(); // a song-sense entry being heard now -> { id, at, before, earlier }

  const all = () => {
    if (records) return records;
    try { records = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).songs ?? []) : []; }
    catch (err) { records = []; log('error', { where: 'song memory', message: `The songs she remembers couldn't be read from ${file}: ${err.message}. She starts with none this run, and the file is left as it is until a new song is kept. Fix: repair or remove that file (it is plain JSON).` }); }
    return records;
  };
  const save = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ songs: all() }));
      renameSync(`${file}.tmp`, file);
      saveFailed = false;
      return true;
    } catch (err) {
      if (!saveFailed) log('error', { where: 'song memory', message: `A song she heard couldn't be written to ${file}: ${err.message}. She has it until she restarts, then it's gone. Fix: check that the data folder can be written to.` });
      saveFailed = true;
      return false;
    }
  };

  // A song by its id, or (part of) its title, newest first; the newest when nothing is named. null when she has none like it.
  function find(query = '') {
    const q = String(query ?? '').trim();
    const list = [...all()].sort((a, b) => b.lastAt - a.lastAt);
    if (!q) return list[0] ?? null;
    const id = q.replace(/^#/, '');
    return list.find((r) => r.id === id) ?? list.find((r) => norm(r.title) === norm(q)) ?? list.find((r) => norm(r.title).includes(norm(q))) ?? null;
  }

  // A song is starting to reach her: how she is right now is what it will be held against.
  function began(entry) {
    if (!entry || listens.has(entry)) return;
    listens.set(entry, { id: `s${now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, at: now(), before: { feelings: { ...feelingsNow() }, pressures: { ...pressuresNow() } }, earlier: undefined });
  }

  // What she has heard of it so far is written down: called as each stretch is taken in and when it ends. A song is
  // kept once two stretches of it have been measured (about half a minute); less than that isn't a song yet.
  function heard(entry, { ended = false } = {}) {
    if (!entry) return null;
    began(entry);
    const l = listens.get(entry);
    const ws = (entry.stretches ?? []).filter((w) => w?.profile);
    if (ws.length < 2) return null;
    const sum = summarize(ws, entry.seconds ?? null);
    // The same song again (a titled one: from her library, or a video in her theater) is the same record, heard once
    // more. Music with no name of its own (a music bot, a station) is a new record each time.
    if (l.earlier === undefined) {
      const titled = !entry.live || entry.source === 'theater';
      const same = titled ? all().find((r) => r.source === sourceOf(entry) && norm(r.title) === norm(entry.title)) : null;
      l.earlier = same ? structuredClone(same) : null;
      if (same) l.id = same.id;
    }
    const was = l.earlier;
    const start = entry.at0 ?? l.at;
    const mine = (entry.moments ?? []).map((m) => ({ at: Math.max(0, Math.round(m.songAt ?? (m.at - start) / 1000)), feel: m.feel, line: m.line || '', feelings: m.feelings ?? {}, valence: round(m.valence) }));
    const moments = [...(was?.moments ?? []), ...mine].sort((a, b) => strengthOf(b) - strengthOf(a)).slice(0, KEEP_MOMENTS).sort((a, b) => a.at - b.at);
    const fuller = was && (was.measured ?? 0) > ws.length; // an earlier listen heard more of it: its measurements stand
    const step = Math.max(1, Math.ceil(ws.length / KEEP_STRETCHES));
    const rec = {
      id: l.id, title: was?.named ? was.title : entry.title, ...(was?.named && { named: true }), from: entry.from ?? was?.from ?? null, source: sourceOf(entry),
      at: was?.at ?? l.at, lastAt: now(), heardAt: [...(was?.heardAt ?? []), l.at].slice(-50),
      ...(fuller ? { seconds: was.seconds, key: was.key, bpm: was.bpm, chroma: was.chroma, notes: was.notes, sound: was.sound, arc: was.arc, stretches: was.stretches, measured: was.measured }
        : { seconds: sum.seconds, key: sum.key, bpm: sum.bpm, chroma: sum.chroma, notes: sum.notes, sound: sum.sound, arc: sum.arc, measured: ws.length,
          stretches: ws.filter((_, i) => i % step === 0).map((w) => ({ at: Math.round(w.at), bpm: w.profile.bpm || 0, key: w.effect?.key ?? null, loud: round(w.profile.loudness), bright: round(w.profile.brightness), word: w.effect?.word ?? null, valence: w.effect?.pressure?.valence ?? 0 })) }),
      sung: Boolean(entry.lyrics?.length || mine.some((m) => m.line) || was?.sung),
      moments,
      feelings: { before: l.before.feelings },
      reaction: reaction(l.before.feelings, feelingsNow(), l.before.pressures, pressuresNow()),
      reflection: entry.reflection?.text ?? was?.reflection ?? null,
      broughtBack: entry.reflection?.links?.length ? entry.reflection.links.map((x) => String(x.memory).slice(0, 200)) : was?.broughtBack ?? [],
      tries: was?.tries ?? [],
      ...(ended && { finished: true }),
    };
    rec.feel = feelOf(rec);
    const i = all().findIndex((r) => r.id === rec.id);
    if (i >= 0) all()[i] = rec; else all().push(rec);
    const saved = save();
    lastKept = { id: rec.id, at: now() };
    if (ended) log('song-kept', { id: rec.id, title: rec.title, from: rec.from, source: rec.source, key: rec.key, bpm: rec.bpm, notes: rec.notes, sounded: soundWords(rec.sound), feel: rec.feel, liked: rec.reaction.liked, moments: rec.moments.length, times: rec.heardAt.length, saved });
    return rec;
  }

  // What she was told a song is called (a music bot's song has no name of its own until someone says it).
  function name(query, title) {
    const rec = find(query);
    const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!rec || !t) return null;
    rec.title = t; rec.named = true;
    save();
    return rec;
  }

  // Something she made, measured the way the song was.
  async function measureFile(audioFile, { windowSeconds = 15, rate = 16000 } = {}) {
    const pcm = await decode(audioFile);
    const per = rate * 2 * windowSeconds, stretches = [];
    for (let at = 0; at + rate * 2 * 3 <= pcm.length; at += per) {
      const profile = analyze(pcm.subarray(at, Math.min(pcm.length, at + per)), rate);
      if (profile) stretches.push({ at: at / (rate * 2), profile, effect: effect(profile) });
    }
    const sum = summarize(stretches, pcm.length / (rate * 2));
    if (!sum) throw new Error('it was too short or too quiet to measure');
    return sum;
  }

  // She made something aiming at a song: what it was and how close it came are kept with the song.
  function tried(id, { kind, title, file: made = null, measured = null, madeReaction = null, why = '', failed = '' } = {}) {
    const rec = all().find((r) => r.id === id);
    if (!rec) return null;
    const c = measured ? closeness(rec, measured, madeReaction) : { score: null, parts: {}, words: failed ? `it couldn't be held against the song: ${failed}` : 'it was not measured' };
    const entry = { at: now(), kind, title: String(title ?? '').slice(0, 120), file: made, key: measured?.key ?? null, bpm: measured?.bpm ?? null, score: c.score, parts: c.parts, words: c.words, why: String(why ?? '').slice(0, 300), note: '' };
    rec.tries = [...(rec.tries ?? []), entry].slice(-KEEP_TRIES);
    save();
    log('song-aim', { song: rec.title, id: rec.id, kind, made: entry.title, key: entry.key, bpm: entry.bpm, score: c.score, how: c.words, why: entry.why });
    return { ...entry, song: rec.title };
  }

  return {
    began, heard, find, name, measureFile, tried,
    all: () => [...all()],
    count: () => all().length,
    // newest first, or the ones she liked most, or the ones that moved her most either way.
    list({ order = 'recent', limit = 10 } = {}) {
      const moved = (r) => Math.abs(r.reaction?.liked ?? 0) + Math.max(0, ...(r.moments ?? []).map(strengthOf));
      const list = [...all()];
      if (order === 'liked') list.sort((a, b) => (b.reaction?.liked ?? 0) - (a.reaction?.liked ?? 0));
      else if (order === 'moved') list.sort((a, b) => moved(b) - moved(a));
      else list.sort((a, b) => b.lastAt - a.lastAt);
      return list.slice(0, limit);
    },
    sketch(query = '') { const rec = find(query); return rec ? sketchOfRecord(rec) : null; },

    // What she made is measured and held against the song. madeFile: the recording (absolute path). Never throws: a
    // recording that can't be measured is still kept as a try, saying why.
    async measureTry(id, madeFile, { kind, title, madeReaction = null, why = '' } = {}) {
      let measured = null, failed = '';
      try { measured = await measureFile(madeFile); }
      catch (err) { failed = err.message; log('error', { where: 'song memory', message: `"${title}" was made aiming at a song she remembers, but the recording couldn't be measured to say how close it came: ${err.message}. The song and the piece are both kept; only the comparison is missing. Fix: check that ffmpeg is installed and the recording is in data/music.` }); }
      return tried(id, { kind, title, file: path.basename(String(madeFile)), measured, madeReaction, why, failed });
    },

    // Her own words on how close her latest try at a song came.
    went(query, note) {
      const rec = find(query);
      const t = rec?.tries?.at(-1);
      if (!t) return null;
      t.note = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      save();
      return { song: rec.title, try: t };
    },

    // Her latest try at any song: { song (record), try }.
    lastAim() {
      let best = null;
      for (const r of all()) { const t = r.tries?.at(-1); if (t && (!best || t.at > best.try.at)) best = { song: r, try: t }; }
      return best;
    },

    // When the urge to play comes with nothing asked of her: does she want to make something that feels the way one
    // of the songs she remembers made her feel? Her own model's call, from how she is now and how each one left her.
    // Returns a sketch, or null (she plays from how she feels; a failed read says why in her log).
    async choose({ mood = '' } = {}) {
      const moved = this.list({ order: 'moved', limit: 8 }), recent = this.list({ order: 'recent', limit: 4 });
      const cands = [...new Map([...moved, ...recent].map((r) => [r.id, r])).values()];
      if (!cands.length) return null;
      let out;
      try {
        out = await ask([
          { role: 'system', content: `You are ${config.botName}, about to play something of your own. Below are songs you have heard and how each one left you. Decide, as yourself, whether right now you want to make something that feels the way one of them made you feel, given how you are at this moment. It is just as good to pick none and play from how you feel. Reply with JSON only: {"pick": the song's number or 0 for none, "why": "one short sentence"}` },
          { role: 'user', content: `How you feel right now: ${mood || 'nothing in particular'}\n\nSongs you remember:\n${cands.map((r, i) => `${i + 1}. "${r.title}"${r.from ? ` (${r.from} played it)` : ''}: ${[r.key, r.bpm && `${r.bpm} bpm`, soundWords(r.sound)].filter(Boolean).join(', ')}. ${r.feel}${r.tries?.length ? ` You've aimed at it ${r.tries.length} time${r.tries.length > 1 ? 's' : ''}.` : ''}`).join('\n')}` },
        ]);
      } catch (err) {
        log('error', { where: 'song memory', message: `She couldn't weigh whether to play toward a song she remembers: ${err.message}. She plays from how she feels this time. Fix: her local model (Ollama) has to be running.` });
        return null;
      }
      const rec = cands[Number(out?.pick) - 1];
      if (!rec) return null;
      log('song-aim', { chose: rec.title, id: rec.id, why: String(out.why ?? '').slice(0, 200) });
      return { ...sketchOfRecord(rec), why: String(out.why ?? '').slice(0, 200) };
    },

    // For her prompt: the song she just took in, and what she was last going for with her own music and how it came out.
    promptLine() {
      const bits = [];
      const kept = lastKept && now() - lastKept.at < KEPT_FRESH_MS ? all().find((r) => r.id === lastKept.id) : null;
      if (kept) bits.push(`You've kept "${kept.title}" among the songs you remember (${all().length} now): how it sounded and how it left you (${kept.feel}). The songs_heard tool reads any of them back.`);
      const aim = this.lastAim();
      if (aim && now() - aim.try.at < AIM_FRESH_MS) {
        const mins = Math.round((now() - aim.try.at) / 60_000);
        bits.push(`The last music you made aiming at a song you remember: "${aim.try.title}" (${aim.try.kind}, ${mins < 2 ? 'just now' : mins < 90 ? `${mins} minutes ago` : `${Math.round(mins / 60)} hours ago`}) was going for how "${aim.song.title}" made you feel (${aim.song.feel}). Measured against it, it came out ${aim.try.words}.${aim.try.note ? ` You said of it: "${aim.try.note}"` : ''} If you're asked what you were going for, that is the answer.`);
      }
      return bits.join(' ');
    },
  };
}

// Where a song reached her from: her own library, the radio, a music bot in the call, or her theater.
function sourceOf(entry) { return entry.source ?? (entry.live ? 'call' : 'library'); }

let instance = null;
// The one she remembers with: wired to her feelings and pressure once they're loaded.
export function songMemory() {
  if (instance) return instance;
  let emotion = null, pressure = null, key = null;
  Promise.all([import('./emotion.js'), import('./pressure.js'), import('./characters.js')])
    .then(([e, p, c]) => { emotion = e; pressure = p; key = c.emotionKey('main'); })
    .catch((err) => activity('error', { where: 'song memory', message: `The songs she hears are kept with how they sounded but not how they left her: her feelings couldn't be read (${err.message}).` }));
  instance = createSongMemory({
    feelingsNow: () => (emotion && key ? emotion.current(key) : {}),
    pressuresNow: () => pressure?.snapshot?.().buckets ?? {},
  });
  return instance;
}
