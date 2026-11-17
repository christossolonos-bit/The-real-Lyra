import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';
import { EmbedWorker, prepareVoice, downsample16k, unavailableReason } from './voiceprints.js';

// Who is talking in a show in her theater (owner, 2026-11-16: "she's not able to distinguish between the characters
// who is talking… some kind of a voice analysis… so she can pick out the different characters that are speaking and
// she knows when the different lines are being said").
//
// - Lines: the show's speech-to-text gives each line with where it starts and ends (voice/stt.js transcribeShowLines).
// - Voices: each line long enough to judge (a second of voice, once the silence is cut) becomes a speaker embedding
//   with the same local model as her voiceprints of people (voiceprints.js). The show's lines are grouped by how alike
//   they sound: the whole show's recent lines are grouped again with every stretch, so a voice heard a few times
//   settles, and older lines are folded into their voice for good. Each voice gets a letter (A, B, …).
// - Pitch: how alike two lines sound to the speaker model is weak evidence for a line of a second or two under a music
//   bed, so how high each voice sits is measured too, and two groups whose voices sit far apart are never one voice.
// - Names: her model reads a whole part of the show at once (theater.js reads the show ahead of the player), with the
//   voice groups and what came before, and says who says each line, from what the characters call each other, who
//   answers whom and who is in the scene. The voices are its evidence, not its answer: the matcher can merge two alike
//   voices, and the dialogue untangles them. Each voice takes the name she's given its lines most often.
// - Series: a channel's named voices are kept (data/theater-casts.json, the voice's average embedding, never audio), so
//   in the next episode she knows Lyra's voice from her first line.
// Measured on all of LYRA Ep 3 (2026-11-16, 106 lines, 78 long enough to judge by voice): the speaker model alone at
// 0.55 put 18 of the women's lines and 20 of the men's into one voice, and she called Solo and Nova "Marcus" (same-voice
// pairs score 0.60 on the median, different voices 0.49). Kept within PITCH_APART, no voice mixed a man and a woman,
// Marcus's lines were one voice and Solo's another, and Lyra's scene voice a third. Nothing here throws into her
// hearing: a failure leaves the lines as they were, without voices.

export const JOIN = 0.55;      // how alike two groups of lines must sound to be one voice (centroid of unit embeddings)
export const PITCH_APART = 5;  // semitones between two groups' average pitch beyond which they are never one voice
const OPEN = 300;              // the newest lines grouped again each stretch; older ones are folded into their voice
const NEW_VOICE_S = 2;         // seconds of voice one line alone needs to be a voice of its own (two lines always are)
const CAST_MIN_LINES = 6;      // lines a named voice needs before it's kept for the channel's next episode
const CAST_KEEP = 12;          // voices kept per channel
const CAST_WEIGHT = 20;        // a kept voice counts as this many lines, so a new episode can still move it
const BEFORE_LINES = 60;       // lines of what came before that her model is shown when naming a part of the show

const CAST_FILE = path.join(DATA_DIR, 'theater-casts.json');

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
const dotOf = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const label = (k) => (k < 26 ? String.fromCharCode(65 + k) : `V${k + 1}`);
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
// A name as her model gave it, without the voice letter it sometimes echoes back ("Lyra (voice A)", "voice C").
const tidyName = (s) => String(s ?? '').replace(/\(?\bvoice\s+[A-Z]\d*\b\)?/gi, '').replace(/\s+/g, ' ').replace(/^["'\s(]+|["'\s.)]+$/g, '').trim().slice(0, 40);
const UNKNOWN = /^(|[A-Z]\d*|unknown|unclear|unclear who|someone|\?|n\/a|none|unsure|too short to tell)$/i;

// Groups by sound: agglomerative, average linkage (how alike two groups are is how alike their lines are on average;
// a settled voice stands in by its centroid). Centroid linkage was tried first and on real film audio one muddy voice
// swallowed nearly every line. nodes: [{ sum, n, fixed, members, pitch }], pitch the voice's pitch in Hz (0: none
// measured). Two fixed nodes (voices already settled) are never merged with each other, and neither are two groups
// whose average pitch is more than `apart` semitones apart. Returns the groups.
export function cluster(nodes, join = JOIN, apart = PITCH_APART) {
  const live = nodes.map((x) => ({ sum: Float32Array.from(x.sum), n: x.n, fixed: x.fixed ?? null, members: [...(x.members ?? [])],
    ps: x.pitch > 0 ? 12 * Math.log2(x.pitch) : 0, pn: x.pitch > 0 ? 1 : 0 }));
  const far = (a, b) => a.pn > 0 && b.pn > 0 && Math.abs(a.ps / a.pn - b.ps / b.pn) > apart;
  const k = live.length, alive = new Array(k).fill(true);
  const cen = live.map((x) => unit(x.sum));
  const sim = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) sim[i][j] = sim[j][i] = dotOf(cen[i], cen[j]);
  for (;;) {
    let best = join, bi = -1, bj = -1;
    for (let i = 0; i < k; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < k; j++) if (alive[j] && sim[i][j] >= best && !(live[i].fixed && live[j].fixed) && !far(live[i], live[j])) { best = sim[i][j]; bi = i; bj = j; }
    }
    if (bi < 0) break;
    const a = live[bi], b = live[bj], na = a.n, nb = b.n;
    for (let d = 0; d < a.sum.length; d++) a.sum[d] += b.sum[d];
    a.n += b.n; a.ps += b.ps; a.pn += b.pn; a.members.push(...b.members); a.fixed ??= b.fixed;
    alive[bj] = false;
    for (let j = 0; j < k; j++) if (alive[j] && j !== bi) sim[bi][j] = sim[j][bi] = (na * sim[bi][j] + nb * sim[bj][j]) / (na + nb);
  }
  return live.filter((_, i) => alive[i]);
}

export function createShowVoices({
  embed = null,                 // pcm16k -> embedding; null: the real model (voiceprints.js), when it's installed
  unavailable = () => unavailableReason(),
  castFile = CAST_FILE,         // null: kept in memory only
  log = activity,
} = {}) {
  let worker = null;
  const embedder = embed ?? ((pcm16k) => { worker ??= new EmbedWorker(); return worker.embed(pcm16k); });
  let voices = new Map(), open = [], made = 0, key = '', off = '', failedOnce = false;

  const readCasts = () => { try { return castFile ? JSON.parse(readFileSync(castFile, 'utf8')) : { channels: {} }; } catch { return { channels: {} }; } };
  const newVoice = (extra = {}) => { const v = { id: label(made++), sum: null, n: 0, pitches: [], tally: {}, earlier: false, ...extra }; voices.set(v.id, v); return v; };
  // A voice goes by a name once at least two of its lines and most of its named lines were given it. A voice the matcher
  // has merged from two people (LYRA Ep 2: James and Lyra's diary under music) splits its names and keeps its letter.
  const nameOf = (v) => {
    const all = Object.entries(v?.tally ?? {}).sort((a, b) => b[1] - a[1]);
    const total = all.reduce((s, [, n]) => s + n, 0);
    return all[0] && all[0][1] >= 2 && all[0][1] / total > 0.5 ? all[0][0] : '';
  };
  const linesOf = (v) => v.n - (v.earlier ? v.seeded : 0) + open.filter((r) => r.line.voice === v.id).length;

  // Every recent line grouped again, with the settled voices as fixed points; each group keeps the letter most of its
  // lines had, so a voice's letter (and the name on it) doesn't move about from stretch to stretch.
  function regroup() {
    const nodes = [...voices.values()].filter((v) => v.sum).map((v) => ({ sum: v.sum, n: v.n, fixed: v.id, members: [], pitch: median(v.pitches) }))
      .concat(open.map((r) => ({ sum: r.emb, n: 1, fixed: null, members: [r], pitch: r.pitch })));
    const groups = cluster(nodes);
    const claimed = new Set(groups.filter((g) => g.fixed).map((g) => g.fixed));
    const order = [...groups].sort((a, b) => (b.fixed ? 1 : 0) - (a.fixed ? 1 : 0) || b.members.length - a.members.length);
    for (const g of order) {
      let id = g.fixed;
      if (!id) {
        const was = {};
        for (const r of g.members) if (r.prev) was[r.prev] = (was[r.prev] ?? 0) + 1;
        const keep = Object.entries(was).sort((a, b) => b[1] - a[1]).map(([w]) => w).find((w) => !claimed.has(w) && voices.has(w));
        const voiced = g.members.reduce((s, r) => s + r.voiced, 0);
        id = keep ?? (g.members.length >= 2 || voiced >= NEW_VOICE_S ? newVoice().id : null);
        if (id) claimed.add(id);
      }
      for (const r of g.members) { r.line.voice = id; r.prev = id; }
    }
    // The oldest lines are settled into their voice for good.
    while (open.length > OPEN) {
      const r = open.shift(), v = voices.get(r.line.voice);
      if (!v) continue;
      v.sum ??= new Float32Array(r.emb.length);
      for (let d = 0; d < r.emb.length; d++) v.sum[d] += r.emb[d];
      v.n++;
    }
  }

  return {
    // A new show: its voices start empty, except the named voices kept from this channel's earlier episodes.
    start({ channel = '', title = '' } = {}) {
      voices = new Map(); open = []; made = 0; failedOnce = false;
      off = unavailable() || '';
      key = String(channel || title || '').trim().toLowerCase();
      const kept = key ? readCasts().channels?.[key]?.voices ?? [] : [];
      for (const k of kept) {
        if (!Array.isArray(k.mean) || !k.name) continue;
        const w = Math.min(Number(k.n) || 1, CAST_WEIGHT);
        newVoice({ sum: Float32Array.from(unit(k.mean), (x) => x * w), n: w, seeded: w, pitches: k.pitch ? [k.pitch] : [], tally: { [k.name]: 3 }, earlier: true });
      }
      return { kept: kept.length, off };
    },
    off: () => off,

    // One stretch's lines (times within pcm48k, which starts `offset` seconds into the show): each one long enough to
    // judge is given a voice; lines too short keep voice null. Lines are changed in place (line.voice), and so are
    // earlier lines whose group changed.
    async hear(pcm48k, lines) {
      if (off || !lines.length) return lines;
      let added = 0;
      for (const line of lines) {
        const a = Math.floor(line.from * 48000) * 2, b = Math.floor(line.to * 48000) * 2;
        const voice = prepareVoice(downsample16k(pcm48k.subarray(Math.max(0, a), Math.min(pcm48k.length, b))));
        line.voice = null;
        if (!voice) continue;
        try {
          const emb = unit(await embedder(voice.pcm));
          open.push({ line, emb, voiced: voice.seconds, pitch: voice.pitch, prev: null });
          added++;
        } catch (err) {
          if (!failedOnce) log('error', { where: 'theater voices', message: `A line's voice couldn't be measured (${err.message}), so she can't tell by sound who said it; her model still works it out from the dialogue. Fix: run scripts/setup-voiceprints.ps1 if the speaker model or its Python is missing.` });
          failedOnce = true;
        }
      }
      if (added) regroup();
      for (const r of open) if (r.pitch && r.line.voice && lines.includes(r.line)) { const v = voices.get(r.line.voice); v.pitches.push(r.pitch); if (v.pitches.length > 200) v.pitches.shift(); }
      return lines;
    },

    // The name a voice goes by, '' when it has none yet.
    name: (id) => nameOf(voices.get(id)),
    cast: () => Object.fromEntries([...voices.values()].map((v) => [v.id, nameOf(v)]).filter(([, n]) => n)),
    // The voices so far, in words, for her model and her prompt.
    describe() {
      return [...voices.values()].filter((v) => linesOf(v) > 0 || v.earlier).map((v) => {
        const name = nameOf(v), lines = linesOf(v), pitch = median(v.pitches);
        const pw = !pitch ? '' : pitch < 130 ? 'a deep voice' : pitch < 175 ? 'a middle voice' : 'a higher voice';
        return `voice ${v.id}: ${lines} line${lines === 1 ? '' : 's'} so far${pw ? `, ${pw}` : ''}${name ? `; taken to be ${name}` : '; no name yet'}${v.earlier ? ' (known from an earlier episode)' : ''}`;
      }).join('\n');
    },

    // Who said each line, as her model read it: the name goes on the line, and counts toward its voice's name.
    credit(lines) {
      for (const l of lines) {
        const who = tidyName(l.who);
        l.who = UNKNOWN.test(who) ? '' : who;
        const v = voices.get(l.voice);
        if (v && l.who) v.tally[l.who] = (v.tally[l.who] ?? 0) + 1;
      }
    },

    // The channel's named voices, kept for its next episode.
    keep() {
      if (!castFile || !key) return;
      const named = [...voices.values()].filter((v) => nameOf(v) && linesOf(v) >= CAST_MIN_LINES).map((v) => {
        const sum = v.sum ? Float32Array.from(v.sum) : null;
        let total = sum, n = v.n;
        for (const r of open) if (r.line.voice === v.id) { total ??= new Float32Array(r.emb.length); for (let d = 0; d < r.emb.length; d++) total[d] += r.emb[d]; n++; }
        return total && { name: nameOf(v), mean: Array.from(unit(total), (x) => +x.toFixed(5)), n, pitch: median(v.pitches) };
      }).filter(Boolean);
      if (!named.length) return;
      const casts = readCasts();
      casts.channels ??= {};
      const had = casts.channels[key]?.voices ?? [];
      const merged = [...named, ...had.filter((h) => !named.some((v) => v.name === h.name))].sort((a, b) => b.n - a.n).slice(0, CAST_KEEP);
      casts.channels[key] = { at: new Date().toISOString(), voices: merged };
      try { writeFileSync(castFile, JSON.stringify(casts)); }
      catch (err) { log('error', { where: 'theater voices', message: `The voices of "${key}" couldn't be kept for its next episode (${err.message}); she'll learn them again by listening. Fix: check that the data folder can be written to.` }); }
    },

    stop() { worker?.stop(); worker = null; },
  };
}

// One line as she reads it: "Lyra: …", "voice C: …", or the words alone when it was too short to tell.
export function whoSaid(line, cast = {}) {
  return line.who || (line.voice && cast[line.voice]) || (line.voice ? `voice ${line.voice}` : '');
}

// Her model's read of who says each new line. lines: [{ at, text, voice }]; before: earlier lines as she has them.
// seen: what the picture shows over these lines (theater-sight.js), as "[1:00-1:27] …" lines: who is on screen.
export async function attribute({ ask, title, voices, before = [], lines, clock, seen = '' }) {
  if (!lines.length) return lines;
  const cast = voices.cast();
  const fmt = (l) => { const who = whoSaid(l, cast); return `[${clock(l.at)}] ${who || '(unclear who)'}${l.voice && who !== `voice ${l.voice}` ? ` (voice ${l.voice})` : ''}: ${l.text}`; };
  const known = voices.describe();
  const read = await ask([
    { role: 'system', content: 'You are watching a show, and have its next part in front of you, every line of it. Work out who says each new line. '
      + 'A voice matcher has grouped the lines by how the voice sounds (voice A, B, …). It is usually right, but it can put two similar voices in one group (two deep voices, or anyone under loud music) and lines too short to judge have no voice. Weigh it against the dialogue: '
      + 'who is on screen, what the characters call each other ("Hey, Lyra" is said TO Lyra, so not by her; "See ya, Nova" is said by someone leaving Nova), who is answering whom, who is in each scene (a scene can change partway through: other people, another place), what each character has been talking about, and a voice-over or diary that sounds like one of the characters. One character can have two voices (their own, and a narration or recording of them). '
      + 'Give a character\'s name when the show has told you it; a short role ("narrator", "soldier on the radio") when that is all you have; "" when you can\'t tell. Never invent a name the show hasn\'t said, and never answer with a voice letter: "voice C" is not a name. '
      + 'Once you know whose a voice is, its other lines are probably theirs too unless the dialogue says otherwise. '
      + 'Reply with JSON only: {"lines": [{"n": 1, "who": "name, role or empty"}]}, one entry for each new line.' },
    { role: 'user', content: `The show: "${title}".`
      + `${known ? `\nThe voices so far:\n${known}` : ''}`
      + `${before.length ? `\nWhat came just before:\n${before.slice(-BEFORE_LINES).map(fmt).join('\n')}` : ''}`
      + `${seen ? `\nWhat the picture shows over the new lines (who is on screen, and what they look like):\n${seen}` : ''}`
      + `\nThe new lines:\n${lines.map((l, i) => `${i + 1}. [${clock(l.at)}] (${l.voice ? `voice ${l.voice}` : 'too short to tell by voice'}) ${l.text}`).join('\n')}` },
  ]);
  const said = Array.isArray(read?.lines) ? read.lines : [];
  for (const s of said) { const l = lines[Number(s?.n) - 1]; if (l) l.who = s.who; }
  voices.credit(lines);
  return lines;
}
