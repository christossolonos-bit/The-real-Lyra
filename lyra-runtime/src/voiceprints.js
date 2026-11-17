import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, config } from './config.js';
import { activity, bus } from './events.js';

// Who a voice sounds like. Every utterance she hears is turned into a speaker embedding by a local
// model (sherpa-onnx, voice/voiceprint_worker.py), and each person she knows has a voiceprint: the
// running mean of their embeddings, under their Discord id. A new utterance is compared with every
// voiceprint. When it matches the tag it came in under (or nobody yet), it joins that person's print,
// so she learns voices by listening, no enrollment step. When it clearly matches a different person
// than the tag says, that's noted: the voice on Travis's mic that sounds like Chris is worth knowing.
// She also keeps what each voice sounded like day by day (a print and a pitch per day, never audio),
// and what every name tag has sounded like lately, so she can compare a voice with how it used to be.
// Nothing here ever throws into the voice path.

export const MODEL_FILE = 'wespeaker_en_voxceleb_CAM++.onnx';
export const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${MODEL_FILE}`;
const MODEL = process.env.VOICEPRINT_MODEL || path.join(ROOT, 'models', 'voiceprints', MODEL_FILE);
const PYTHON = process.env.VOICEPRINT_PYTHON || (existsSync(config.parakeet?.python ?? '') ? config.parakeet.python : 'python');
const FILE = path.join(DATA_DIR, 'voiceprints.json');
const VERSION = 2; // 1: prints made from whole clips, silence and all, at any length (see prepareVoice): not kept
const MIN_SECONDS = 1.2;
const MIN_VOICED_SECONDS = 1; // of actual voice, once the silence is cut out
const MAX_COUNT = 200; // a print keeps adapting: the mean forgets slowly past this many utterances
// Learned: enough of someone's voice to tell it apart. Both must be met (lines and seconds of speech).
const LEARN_UTTERANCES = 12;
const LEARN_SECONDS = 40; // of voice, with the silence cut out
// threshold: how alike a voice must be to a known person's print to count as theirs. margin: how much
// more alike than the tagged person's own print before the tag is doubted. Measured with this model on
// clips prepared as below: the same voice scores 0.7 to 0.95, a different one 0.2 to 0.75.
const DEFAULTS = { threshold: 0.75, margin: 0.1 };
const STRONG = 0.08; // one line this far over the threshold is enough alone; otherwise two lines must agree
const ACCEPT = 0.5; // a learned print only takes in lines at least this like itself
const RELEARN_AFTER = 20; // lines in a row unlike their own learned print (and nobody else's): the voice changed, take it in
const POOL = { lines: 3, ms: 120_000 }; // a tag's last few lines are weighed together: more voice, a surer ear
const EAR_LINES = 40; // what each tag sounded like, the last this many lines
const DAYS_KEPT = 7; // a print per day heard, the newest this many, plus the first day ever
const SEGMENT = 32000, SEGMENT_SHORT = 80;

// What the speaker model is given: only the voice, at a length it can use. Measured on this model
// (2026-11-15): CAM++ pools in 2-second segments, and a clip whose last segment is barely filled (2.2 s,
// 3 s, 5 s) comes out as noise: the same voice scored 0.15 against itself at 2.5 s and 0.9 at 2.0 s, and
// with clips of any length four voices were told apart half the time. The receiver's clips also end in
// most of a second of silence. So the silence is cut out (start, end, and pauses over a quarter second)
// and what is left is repeated to just under a whole number of 2-second segments: the same four voices
// are then told apart 98 times in 100. Returns null when there is under a second of voice in it.
export function prepareVoice(pcm16k) {
  const FRAME = 320, total = Math.floor(pcm16k.length / 2 / FRAME); // 20 ms frames
  if (!total) return null;
  const energy = new Float64Array(total);
  for (let f = 0; f < total; f++) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { const v = pcm16k.readInt16LE((f * FRAME + i) * 2); sum += v * v; }
    energy[f] = Math.sqrt(sum / FRAME);
  }
  const loud = Float64Array.from(energy).sort()[Math.min(total - 1, Math.floor(total * 0.95))];
  const floor = Math.max(loud * 0.08, 4);
  const voiced = [];
  for (let f = 0; f < total; f++) if (energy[f] > floor) voiced.push(f);
  if (!voiced.length) return null;
  const PAD = 3, GAP = 12; // 60 ms kept each side of the voice; pauses over 240 ms dropped
  const keep = new Uint8Array(total);
  for (let f = Math.max(0, voiced[0] - PAD); f <= Math.min(total - 1, voiced.at(-1) + PAD); f++) keep[f] = 1;
  for (let i = 1; i < voiced.length; i++) if (voiced[i] - voiced[i - 1] > GAP) for (let f = voiced[i - 1] + PAD + 1; f < voiced[i] - PAD; f++) keep[f] = 0;
  const parts = [];
  for (let f = 0; f < total; f++) if (keep[f]) parts.push(pcm16k.subarray(f * FRAME * 2, (f + 1) * FRAME * 2));
  const voice = Buffer.concat(parts), samples = voice.length / 2, seconds = samples / 16000;
  if (seconds < MIN_VOICED_SECONDS) return null;
  const want = Math.min(30, Math.ceil((samples + SEGMENT_SHORT) / SEGMENT)) * SEGMENT - SEGMENT_SHORT;
  const out = Buffer.alloc(want * 2);
  for (let at = 0; at < out.length; at += voice.length) voice.copy(out, at, 0, Math.min(voice.length, out.length - at));
  return { pcm: out, seconds, pitch: pitchOf(voice) };
}

// How high or low the voice sits: the middle of its pitch over the clip, in Hz (0 when it can't be told).
// Autocorrelation on 40 ms frames, 70 to 350 Hz, counting only frames that clearly repeat.
export function pitchOf(pcm16k) {
  const N = 640, SMOOTH = 8, LO = Math.floor(16000 / 350), HI = Math.ceil(16000 / 70), found = [];
  const x = new Float64Array(N), r = new Float64Array(HI + 2);
  for (let start = 0, frames = 0; start + N + SMOOTH <= pcm16k.length / 2 && frames < 80; start += N * 2, frames++) { // every other frame, 6 s of it: plenty
    let e0 = 0;
    for (let i = 0; i < N; i++) {
      let sum = 0; // a short running average: the pitch is in the low end, the rest only confuses it
      for (let k = 0; k < SMOOTH; k++) sum += pcm16k.readInt16LE((start + i + k) * 2);
      x[i] = sum / SMOOTH; e0 += x[i] * x[i];
    }
    if (e0 / N < 1000) continue; // too quiet to have a pitch
    let top = 0;
    for (let l = LO - 1; l <= HI + 1; l++) {
      let dot = 0, ea = 0, eb = 0;
      for (let i = 0; i + l < N; i++) { dot += x[i] * x[i + l]; ea += x[i] * x[i]; eb += x[i + l] * x[i + l]; }
      r[l] = ea && eb ? dot / Math.sqrt(ea * eb) : 0;
      if (l >= LO && l <= HI && r[l] > top) top = r[l];
    }
    if (top < 0.6) continue;
    // The shortest repeat that is nearly as good as the best one: a voice also repeats every two and three periods.
    for (let l = LO; l <= HI; l++) if (r[l] >= top * 0.9 && r[l] >= r[l - 1] && r[l] >= r[l + 1]) { found.push(16000 / l); break; }
  }
  if (found.length < 5) return 0;
  return Math.round(found.sort((a, b) => a - b)[Math.floor(found.length / 2)]);
}

// A pitch in plain words, for telling someone what a voice sounds like.
export function pitchWords(hz) {
  if (!hz) return '';
  return hz < 100 ? 'a very deep voice' : hz < 130 ? 'a deep voice' : hz < 165 ? 'a low-to-middle voice' : hz < 200 ? 'a middle voice' : hz < 250 ? 'a higher voice' : 'a high voice';
}

// ---------- the worker: one embedding at a time, same JSON-lines pattern as parakeet.js ----------
export class EmbedWorker {
  constructor({ python = PYTHON, model = MODEL, spawnImpl = spawn } = {}) {
    Object.assign(this, { python, model, spawnImpl, child: null, sequence: 0, pending: new Map(), queue: Promise.resolve() });
  }
  stop(message = 'Voiceprint worker stopped') {
    const child = this.child; this.child = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear(); child?.kill();
  }
  start() {
    if (this.child) return;
    const child = this.spawnImpl(this.python, ['-u', fileURLToPath(new URL('./voice/voiceprint_worker.py', import.meta.url)), '--model', this.model, '--threads', '2'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return this.stop('Voiceprint response exceeded size limit');
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        let response;
        try { response = JSON.parse(line); } catch { this.stop('Voiceprint worker returned invalid data'); return; }
        const p = this.pending.get(response.id); if (!p) continue;
        this.pending.delete(response.id); clearTimeout(p.timer);
        if (response.ok && Array.isArray(response.embedding)) p.resolve(Float32Array.from(response.embedding));
        else p.reject(new Error(`Voiceprint: ${response.error || 'no embedding'}`));
      }
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    child.on('error', () => { if (this.child === child) this.stop('Could not start the voiceprint worker. Run scripts/setup-voiceprints.ps1'); });
    child.stdin.on('error', () => { if (this.child === child) this.stop('Voiceprint worker input closed'); });
    child.on('exit', (code) => { if (this.child === child) this.stop(`Voiceprint worker exited (${code}): ${stderr.slice(-500)}`); });
  }
  // pcm16k: 16 kHz mono PCM16 Buffer -> Float32Array embedding.
  embed(pcm16k) {
    const job = this.queue.then(() => {
      this.start();
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.stop('Voiceprint embedding timed out'), 30000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.stdin.write(JSON.stringify({ id, pcm: pcm16k.toString('base64') }) + '\n');
      });
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

// 48 kHz -> 16 kHz, averaging each group of 3 samples (as voice/stt.js does).
export function downsample16k(pcm48k) {
  const samples = Math.floor(pcm48k.length / 6);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const o = i * 6;
    out.writeInt16LE(Math.round((pcm48k.readInt16LE(o) + pcm48k.readInt16LE(o + 2) + pcm48k.readInt16LE(o + 4)) / 3), i * 2);
  }
  return out;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// What's missing for this to work at all, or '' when it can run. Checked by file, never by importing.
export function unavailableReason({ python = PYTHON, model = MODEL } = {}) {
  if (!existsSync(model)) return `the speaker model is missing at ${model}`;
  if (python !== 'python' && !existsSync(python)) return `the Python for it is missing at ${python}`;
  return '';
}

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
const round = (v, places = 5) => Array.from(v, (x) => +x.toFixed(places));
const pct = (x) => `${Math.round(x * 100)}%`;
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayWords = (key) => new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// A running mean: v folded into a mean that already stands for n lines.
const fold = (mean, v, n) => { for (let i = 0; i < v.length; i++) mean[i] = (mean[i] * n + v[i]) / (n + 1); return mean; };

export function createVoiceprints({ embed = null, file = FILE, python = PYTHON, model = MODEL, now = Date.now, log = activity, onLearned = (event) => bus.emit('voiceprint-learned', event) } = {}) {
  let worker = null;
  const embedder = embed ?? ((pcm16k) => { worker ??= new EmbedWorker({ python, model }); return worker.embed(pcm16k); });
  const fresh = () => ({ version: VERSION, settings: { ...DEFAULTS }, people: {}, ear: {} });
  const load = () => {
    try {
      if (!existsSync(file)) return fresh();
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version === VERSION) return { ...fresh(), ...data };
      // Prints from before the model was given clean, whole-segment clips are mostly noise: set aside, learned again.
      const aside = `${file.replace(/\.json$/, '')}.v1.json`;
      renameSync(file, aside);
      log('voiceprint', { relearning: true, why: 'older voiceprints were made from clips the speaker model reads badly; everyone is learned again by listening', kept: aside });
      return fresh();
    } catch { return fresh(); }
  };
  const save = (data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data)); renameSync(`${file}.tmp`, file); };
  const lastHeard = new Map(); // conversation -> { userId, name, score, match, at }
  const lastMismatch = new Map(); // conversation -> { tag, userId, soundsLike, score, at }
  const recent = new Map(); // conversation and tag -> that tag's last few lines [{ emb, seconds, at }]
  let saidUnavailable = false;

  // Fold one embedding into a person's print (running mean, capped so it keeps adapting), and into that day's.
  function learn(data, userId, name, emb, seconds, pitch) {
    const at = now();
    const p = data.people[userId] ?? { name, count: 0, seconds: 0, centroid: round(emb), updated: at, since: at, days: {} };
    if (p.count > 0) p.centroid = round(fold(p.centroid, emb, Math.min(p.count, MAX_COUNT)));
    if (pitch) { const n = Math.min(p.pitched ?? 0, MAX_COUNT); p.pitch = Math.round(((p.pitch ?? 0) * n + pitch) / (n + 1)); p.pitched = (p.pitched ?? 0) + 1; }
    p.count += 1; p.seconds = +((p.seconds ?? 0) + seconds).toFixed(1); p.name = name; p.updated = at; p.misses = 0;
    // What they sounded like that day: its own print and pitch, so today can be held against before.
    p.days ??= {};
    const key = dayOf(at), d = p.days[key] ?? { count: 0, seconds: 0, centroid: round(emb), pitch: 0, pitched: 0 };
    if (d.count > 0) d.centroid = round(fold(d.centroid, emb, d.count));
    if (pitch) { d.pitch = Math.round((d.pitch * d.pitched + pitch) / (d.pitched + 1)); d.pitched += 1; }
    d.count += 1; d.seconds = +(d.seconds + seconds).toFixed(1);
    p.days[key] = d;
    const keys = Object.keys(p.days).sort();
    for (const k of keys.slice(1, Math.max(1, keys.length - DAYS_KEPT))) delete p.days[k]; // the first day stays
    data.people[userId] = p;
    return p;
  }

  // What a tag sounded like, line by line (numbers only): kept across restarts so she can be asked afterwards.
  function note(data, userId, name, line) {
    const e = data.ear[userId] ?? { name, lines: [] };
    e.name = name; e.lines.push(line);
    if (e.lines.length > EAR_LINES) e.lines.splice(0, e.lines.length - EAR_LINES);
    data.ear[userId] = e;
  }

  // Someone by Discord id or by name (a print, or only a tag she has heard), or null.
  function find(data, who) {
    const key = String(who ?? '').trim(), low = key.toLowerCase();
    if (!key) return null;
    const all = new Map();
    for (const [id, e] of Object.entries(data.ear)) all.set(id, e.name);
    for (const [id, p] of Object.entries(data.people)) all.set(id, p.name);
    if (all.has(key)) return { userId: key, name: all.get(key) };
    const names = [...all].map(([userId, name]) => ({ userId, name, low: String(name).toLowerCase() }));
    return names.find((n) => n.low === low) ?? names.find((n) => n.low.startsWith(low)) ?? names.find((n) => n.low.includes(low)) ?? null;
  }

  // What one tag has sounded like over its recent lines, counted.
  function tally(data, userId, minutes = 0) {
    const e = data.ear[userId];
    const lines = (e?.lines ?? []).filter((l) => !minutes || now() - l.at <= minutes * 60_000);
    const like = new Map(); // other person -> { n, total, sure }
    let own = 0, unsure = 0;
    for (const l of lines) {
      if (l.verdict === 'own') own++;
      else if (l.like) { const k = like.get(l.like) ?? { n: 0, total: 0, sure: 0 }; k.n++; k.total += l.score; if (l.verdict === 'other') k.sure++; like.set(l.like, k); }
      else unsure++;
    }
    const others = [...like].map(([name, k]) => ({ name, lines: k.n, sure: k.sure, score: +(k.total / k.n).toFixed(3) })).sort((a, b) => b.lines - a.lines);
    return { userId, name: e?.name ?? data.people[userId]?.name ?? '', lines: lines.length, own, unsure, others, last: lines.at(-1)?.at ?? 0, hasPrint: Boolean(data.people[userId]?.learnedAt) };
  }

  return {
    async heard(pcm48k, { userId, name, conversation }) {
      try {
        if (!Buffer.isBuffer(pcm48k) || pcm48k.length < 48000 * 2 * MIN_SECONDS || !userId) return null;
        if (!embed) {
          const why = unavailableReason({ python, model });
          if (why) { if (!saidUnavailable) { saidUnavailable = true; log('voiceprint', { unavailable: why, fix: 'scripts/setup-voiceprints.ps1' }); } return null; }
        }
        const voice = prepareVoice(downsample16k(pcm48k.subarray(0, pcm48k.length - pcm48k.length % 6)));
        if (!voice) return null; // under a second of actual voice: not enough to go on
        const emb = unit(await embedder(voice.pcm));
        const at = now();
        const data = load();
        const { threshold, margin } = { ...DEFAULTS, ...data.settings };
        // This line alone, and this tag's last few lines together (more voice is a much surer read).
        const key = `${conversation}|${userId}`;
        const lines = [...(recent.get(key) ?? []).filter((l) => at - l.at <= POOL.ms), { emb, seconds: voice.seconds, at }].slice(-POOL.lines);
        recent.set(key, lines);
        const pooled = new Float32Array(emb.length);
        for (const l of lines) for (let i = 0; i < emb.length; i++) pooled[i] += l.emb[i] * Math.min(l.seconds, 6);
        const rank = (v) => Object.entries(data.people).map(([id, p]) => ({ id, name: p.name, score: cosine(v, p.centroid) })).sort((a, b) => b.score - a.score);
        const one = rank(emb), many = rank(pooled);
        const own = one.find((s) => s.id === userId)?.score ?? null, ownMany = many.find((s) => s.id === userId)?.score ?? null;
        const other = one.find((s) => s.id !== userId) ?? null, otherMany = many.find((s) => s.id !== userId) ?? null;
        const leaning = other && other.score >= threshold - 0.1 && other.score > (own ?? 0); // toward someone else, at least a little
        // Someone else's voice on this tag: one unmistakable line, or two or more lines that agree.
        const alone = other && other.score >= Math.min(0.97, threshold + STRONG) && other.score - (own ?? 0) >= margin;
        const together = leaning && lines.length >= 2 && otherMany.id === other.id && otherMany.score >= threshold && otherMany.score - (ownMany ?? 0) >= margin;
        const mismatch = Boolean(alone || together);
        const mine = data.people[userId];
        let verdict = 'own', changed = 0;
        if (mismatch) {
          verdict = 'other';
          lastMismatch.set(conversation, { tag: name, userId, soundsLike: other.name, score: +other.score.toFixed(3), at });
          log('voiceprint', { mismatch: true, tag: name, sounds_like: other.name, score: +other.score.toFixed(3), own: own == null ? null : +own.toFixed(3), lines: lines.length });
        } else if (leaning) {
          verdict = 'unsure'; // not surely someone else, but kept out of this tag's print
        } else if (mine?.learnedAt && own < ACCEPT) {
          // Unlike their own learned voice and unlike anyone else's. A run of these means the voice itself changed (a new mic):
          // from then on every such line is taken in, until the print has moved far enough to sound like them again.
          mine.misses = (mine.misses ?? 0) + 1;
          if (mine.misses < RELEARN_AFTER) verdict = 'unsure';
          else {
            changed = mine.misses;
            if (changed === RELEARN_AFTER) log('voiceprint', { changed: true, tag: name, lines: changed, own: +own.toFixed(3) });
          }
        }
        if (verdict === 'own') {
          const p = learn(data, userId, name, emb, voice.seconds, voice.pitch);
          if (changed) p.misses = changed; // still unlike the print: the run goes on until a line sounds like it
          if (!p.learnedAt && p.count >= LEARN_UTTERANCES && p.seconds >= LEARN_SECONDS) {
            p.learnedAt = at;
            onLearned({ userId, name: p.name, utterances: p.count, seconds: Math.round(p.seconds), conversation });
          }
        }
        note(data, userId, name, { at, verdict, like: verdict !== 'own' && leaning ? other.name : null, score: +((verdict !== 'own' && leaning ? other.score : own) ?? 0).toFixed(3), own: own == null ? null : +own.toFixed(3), pitch: voice.pitch });
        save(data);
        const result = { userId, name, match: mismatch ? other.name : name, score: +((mismatch ? other.score : own ?? 1)).toFixed(3), mismatch, verdict, pitch: voice.pitch, known: data.people[userId]?.count ?? 0, at };
        lastHeard.set(conversation, result);
        return result;
      } catch (err) {
        log('error', { where: 'voiceprint', message: err.message });
        return null;
      }
    },
    who(conversation) { return lastHeard.get(conversation) ?? null; },
    // What one tag (a name or a Discord id) has sounded like lately, or null when she has never heard it.
    heardAs(who, { minutes = 0 } = {}) { const d = load(), f = find(d, who); return f ? tally(d, f.userId, minutes) : null; },
    // Every tag heard in the last while, most recent first.
    heardLately(minutes = 30) { const d = load(); return Object.keys(d.ear).map((id) => tally(d, id, minutes)).filter((t) => t.lines).sort((a, b) => b.last - a.last); },
    // For her prompt: only when the voice and the tag disagree, and only while it's fresh.
    promptLine(conversation) {
      const m = lastMismatch.get(conversation);
      if (!m || now() - m.at > 5 * 60_000) return '';
      const d = load(), t = tally(d, m.userId, 30), same = t.others.find((o) => o.name === m.soundsLike);
      // A tag with no voice of its own that keeps sounding like one person she knows: that person on another account.
      const pattern = same && same.sure >= 2 && !t.hasPrint ? ` ${same.lines} of the last ${t.lines} lines from ${m.tag} sounded like ${m.soundsLike}, and ${m.tag} has no voice of its own that you know: it is very likely ${m.soundsLike} talking through that account.` : '';
      return `Your ear says the voice on ${m.tag}'s mic sounds like ${m.soundsLike} (${Math.round(m.score * 100)}% alike), not ${m.tag}.${pattern} Trust the voice over the name tag, and ask who's talking if it matters.`;
    },
    list() { const d = load(); return Object.entries(d.people).map(([id, p]) => ({ userId: id, name: p.name, utterances: p.count, seconds: Math.round(p.seconds ?? 0), learned: Boolean(p.learnedAt), pitch: p.pitch ?? 0, days: Object.keys(p.days ?? {}).length, updated: p.updated })).sort((a, b) => b.utterances - a.utterances); },
    // How someone's voice has sounded day by day, each day held against their usual voice and the day before it.
    history(who) {
      const d = load(), f = find(d, who), p = f && d.people[f.userId];
      if (!p) return null;
      const keys = Object.keys(p.days ?? {}).sort();
      const days = keys.map((k, i) => ({ day: k, lines: p.days[k].count, seconds: Math.round(p.days[k].seconds), pitch: p.days[k].pitch || 0, usual: +cosine(p.days[k].centroid, p.centroid).toFixed(3), before: i ? +cosine(p.days[k].centroid, p.days[keys[i - 1]].centroid).toFixed(3) : null }));
      return { userId: f.userId, name: p.name, since: p.since ?? p.updated, learned: Boolean(p.learnedAt), utterances: p.count, seconds: Math.round(p.seconds ?? 0), pitch: p.pitch ?? 0, days };
    },
    // How alike two people's voices are (their prints), or null when either isn't known by voice.
    compare(a, b) {
      const d = load(), fa = find(d, a), fb = find(d, b), pa = fa && d.people[fa.userId], pb = fb && d.people[fb.userId];
      if (!pa || !pb) return null;
      return { a: pa.name, b: pb.name, score: +cosine(pa.centroid, pb.centroid).toFixed(3), pitchA: pa.pitch ?? 0, pitchB: pb.pitch ?? 0, threshold: { ...DEFAULTS, ...d.settings }.threshold };
    },
    // By Discord id or name: the print, its days and what the tag sounded like all go.
    forget(who) {
      const d = load(), f = find(d, who);
      if (!f) return null;
      delete d.people[f.userId]; delete d.ear[f.userId]; save(d);
      for (const k of [...recent.keys()]) if (k.endsWith(`|${f.userId}`)) recent.delete(k);
      return f.name;
    },
    settings(patch = null) {
      const d = load();
      if (patch) {
        const t = patch.threshold !== undefined ? Number(patch.threshold) : undefined, m = patch.margin !== undefined ? Number(patch.margin) : undefined;
        if (t !== undefined && !(t >= 0.2 && t <= 0.95)) throw new Error('threshold is 0.2 to 0.95 (how alike two voices must be to count as the same person).');
        if (m !== undefined && !(m >= 0 && m <= 0.5)) throw new Error('margin is 0 to 0.5 (how much more alike another voice must be before the tag is doubted).');
        d.settings = { ...DEFAULTS, ...d.settings, ...(t !== undefined && { threshold: t }), ...(m !== undefined && { margin: m }) };
        save(d);
      }
      return { ...DEFAULTS, ...d.settings };
    },
    status() {
      const why = embed ? '' : unavailableReason({ python, model });
      const people = this.list();
      return { ready: !why, ...(why && { missing: why, fix: `Run scripts/setup-voiceprints.ps1 (it does: pip install sherpa-onnx numpy, then downloads ${MODEL_URL} to ${path.dirname(model)}).` }), model, python, people: people.length, learned: people.filter((p) => p.learned).length, utterances: people.reduce((n, p) => n + p.utterances, 0), ...this.settings() };
    },
    stop() { worker?.stop(); worker = null; },
  };
}

export const voiceprints = createVoiceprints();
process.once('exit', () => voiceprints.stop());

// One tag's recent lines in words: "Amy Smith: 6 line(s), 5 sounded like Travis (88% alike), 1 too unclear to place".
export function heardWords(t) {
  if (!t.lines) return `${t.name}: nothing heard`;
  const parts = [];
  if (t.own) parts.push(`${t.own} in ${t.hasPrint ? 'their own voice' : 'a voice still being learned as theirs'}`);
  for (const o of t.others) parts.push(`${o.lines} sounded like ${o.name} (${pct(o.score)} alike${o.sure < o.lines ? `, ${o.sure} of them for sure` : ''})`);
  if (t.unsure) parts.push(`${t.unsure} too unclear to place`);
  return `${t.name}: ${t.lines} line(s), ${parts.join(', ')}`;
}

// The tool, in the shape src/tools.js uses. Registered there by the parent.
export function createVoiceprintsTool(vp = voiceprints) {
  return {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'voiceprints',
        description: "Owner only. How you tell people apart by their voice, not just their name tag, and how you remember what voices sounded like: every voice you hear in a call feeds that person's voiceprint, and when a voice on someone's mic or account sounds like a different person you know, you notice. status: whether it is working, what is missing and how to fix it, how many people you know by voice, and the match settings. list: everyone you know by voice, how much of each you've heard, and how high or low they speak. who: with `name`, what that name tag has sounded like over its recent lines, its own voice or someone else's (the way to answer \"did that account sound like me?\"); without it, the last voice heard here and every tag heard in the last half hour. history: with `name`, how that person's voice has sounded day by day, against their usual voice. compare: how alike `name` and `other` sound. forget: drop someone's voiceprint (`name` or `user_id`) so it is learned fresh. settings: change threshold (0.2-0.95, how alike counts as the same voice) or margin (0-0.5). You cannot enroll anyone by hand: you learn voices by listening. Only numbers are kept, never recordings.",
        parameters: { type: 'object', properties: {
          action: { type: 'string', enum: ['status', 'list', 'who', 'history', 'compare', 'forget', 'settings'] },
          name: { type: 'string', description: 'who, history, compare, forget: the person or name tag (a name or a Discord user id).' },
          other: { type: 'string', description: 'compare: the second person.' },
          user_id: { type: 'string', description: 'forget: the Discord user id.' },
          threshold: { type: 'number' }, margin: { type: 'number' },
        }, required: ['action'] },
      },
    },
    run: ({ action, name, other, user_id, threshold, margin }, ctx) => {
      const hz = (p) => (p ? `, around ${p} Hz (${pitchWords(p)})` : '');
      switch (action) {
        case 'status': return JSON.stringify(vp.status());
        case 'list': { const l = vp.list(); return l.length ? l.map((p) => `${p.name} (${p.userId}): ${p.utterances} utterance(s), ${p.seconds}s of speech${hz(p.pitch)}, ${p.learned ? 'learned (tells them apart by voice)' : `still learning (needs ${LEARN_UTTERANCES} utterances and ${LEARN_SECONDS}s)`}, heard on ${p.days} day(s), last ${new Date(p.updated).toLocaleString()}`).join('\n') : 'Nobody known by voice yet. It fills in as people talk in calls.'; }
        case 'who': {
          if (name) {
            const t = vp.heardAs(name);
            if (!t) return `No name tag like "${name}" has spoken where you could hear it (only lines with over a second of voice are kept).`;
            return `${heardWords(t)}. Last heard ${new Date(t.last).toLocaleString()}.${t.hasPrint ? '' : ` You have not learned a voice of its own for ${t.name}.`}`;
          }
          const w = vp.who(ctx.conversation), lately = vp.heardLately(30);
          const last = w ? `${w.name} (tag) last spoke; the voice ${w.mismatch ? `sounded like ${w.match}` : w.verdict === 'unsure' ? 'was not clear enough to place' : 'matched the tag'} at ${Math.round(w.score * 100)}%, ${w.known} utterance(s) of ${w.name} known.` : 'No voice heard in this conversation since I started.';
          return lately.length ? `${last}\nThe last half hour, by name tag:\n${lately.map(heardWords).join('\n')}` : last;
        }
        case 'history': {
          if (!name) throw new Error('history needs name.');
          const h = vp.history(name);
          if (!h) return `You don't know "${name}" by voice yet.`;
          const days = h.days.map((d) => `${dayWords(d.day)}: ${d.lines} line(s), ${d.seconds}s${d.pitch ? `, ${d.pitch} Hz` : ''}, ${pct(d.usual)} like their usual voice${d.before == null ? '' : `, ${pct(d.before)} like the day before it`}${d.lines >= 5 && d.usual < 0.75 ? ' (sounded noticeably different: another mic, a cold, or someone else on the account)' : ''}`);
          return `${h.name}: known by voice since ${new Date(h.since).toLocaleDateString()}, ${h.utterances} utterance(s), ${h.seconds}s${hz(h.pitch)}, ${h.learned ? 'learned' : 'still learning'}.\n${days.join('\n')}`;
        }
        case 'compare': {
          if (!name || !other) throw new Error('compare needs name and other.');
          const c = vp.compare(name, other);
          if (!c) return 'You need to know both of them by voice to compare them (see list).';
          return `${c.a} and ${c.b} sound ${pct(c.score)} alike${c.pitchA && c.pitchB ? ` (${c.a} around ${c.pitchA} Hz, ${c.b} around ${c.pitchB} Hz)` : ''}: ${c.score >= c.threshold ? 'close enough to take one for the other, or the same person on two accounts' : c.score >= c.threshold - 0.15 ? 'similar voices, but you can tell them apart' : 'clearly different voices'}.`;
        }
        case 'forget': { const target = user_id || name; if (!target) throw new Error('forget needs user_id or name.'); const n = vp.forget(target); return n ? `Forgot ${n}'s voiceprint.` : 'No voiceprint under that id or name.'; }
        case 'settings': return JSON.stringify(vp.settings(threshold !== undefined || margin !== undefined ? { threshold, margin } : null));
        default: throw new Error('Use status, list, who, history, compare, forget or settings.');
      }
    },
  };
}
export const voiceprintsTool = createVoiceprintsTool();
