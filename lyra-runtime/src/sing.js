import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activity } from './events.js';
import { pitchClasses, keyOf } from './key-detect.js';
import { parseKey, chordOf, CRAFT } from './sheet.js';
import { parseTune, tuneLine, parseScore, fitLine, worldPlan, followVoice, placeTune, placeSong, MAX_FIT_SHIFT } from './retune.js';
import { aimBrief } from './song-memory.js';
import { POWER, readPower, effortTags, takesFor, effortOf, strongest, levelLine, soundingLevel, vibratoFor, harmonyScore, mixGraph, bandGainFor, masterGainFor } from './vocal-power.js';

// Her singing her own songs (owner, 2026-11-12: "can we make her sing? I've noticed that the TTS model will sing
// occasionally… how we can utilize that with her song generation"). Fish's S2 voice sings what's tagged [singing], in
// a style described in words (no notes: it picks the melody, and mostly stays near one: owner, same day, "it's all
// monotone… auto-tune or something so that the tone of her voice goes along with the tone of the song"). A song from
// her songbook is sung a line at a time in her own voice, styled from the song's own style line, then put on a tune
// she writes for it, with her instrument under it:
//  1. every lyric line is sung ([singing, <genre>, <the vocal the style line asks for>] line);
//  2. the key is the song's own (its style line), or, when the style line names none, the key her voice landed in;
//  3. she writes the song's music for the words (her composer): a chord for every bar and a tune for every line,
//     knowing how long each line runs and where it falls;
//  4. each sung line is moved onto its tune (retune.js: her timing and her voice kept, the notes changed), or, if the
//     tune couldn't be written, onto the nearest notes of the key (classic auto-tune);
//  5. the band plays her chords in that key, at the song's tempo and meter, with the lead instrument it names, each
//     line starting on a bar, a bar's rest between sections;
//  6. it's all mixed into one track in her music library and, in a call, played out loud.

const NOTE_LINE = /^\s*\(.*\)\s*$/;            // (stage directions): for the band, not sung
const SECTION = /^\s*\[([^\]]+)\]\s*$/;        // [Verse 1], [Chorus]
const MAX_LINES = 48;

// The lines to sing, with the section each is in: [{ section, text }].
export function lyricLines(lyrics) {
  const out = [];
  let section = '';
  for (const raw of String(lyrics ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || NOTE_LINE.test(line)) continue;
    const s = SECTION.exec(line);
    if (s) { section = s[1].trim(); continue; }
    out.push({ section, text: line.replace(/\s*\([^)]*\)\s*$/, '').trim() }); // a trailing (direction) on a sung line
  }
  return out.filter((l) => l.text).slice(0, MAX_LINES);
}

// What the style line says about how the song moves and sounds: { tempo, meter, genre, vocal, accompaniment, lead }.
// The style line is hers, written in a known shape (songbook.js SONG_FORMAT: genre, BPM, key, instruments, vocal type).
export function readStyle(style, { known = () => false, styles = [] } = {}) {
  const parts = String(style ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const tempo = Math.max(50, Math.min(180, Number(/(\d{2,3})\s*bpm/i.exec(style ?? '')?.[1]) || 84));
  const meter = /waltz|\b3\/4\b|\b6\/8\b/i.test(style ?? '') ? 3 : 4;
  const vocal = parts.find((p) => /vocal|voice|sung|singer/i.test(p)) ?? '';
  const isInstrument = (p) => instrumentIn(p, known) !== null;
  const genre = parts.find((p) => !/bpm|\b(major|minor)\b/i.test(p) && !/vocal|voice/i.test(p) && !isInstrument(p)) ?? '';
  const lead = parts.map((p) => instrumentIn(p, known)).find(Boolean) ?? 'grand piano';
  const accompaniment = styles.find((s) => new RegExp(`\\b${s}`, 'i').test(style ?? '')) ?? (meter === 3 ? 'waltz' : tempo < 90 ? 'ballad' : 'arpeggio');
  // The key the style line names ("D minor", "Bb major"), or null when it names none.
  let key = null;
  for (const p of parts) { try { key = parseKey(/([A-G][#b♯♭]?\s*(?:major|minor))/i.exec(p)?.[1]?.replace('♯', '#').replace('♭', 'b')).name; break; } catch {} }
  return { tempo, meter, genre, vocal, lead, accompaniment, key };
}
// An instrument her orchestra has, named by a part of the style line ("nylon-string guitar", "upright bass"), or null.
// The instrument has to be what the part is about (its last words): "Brazilian jazz waltz" is a waltz, not a jazz guitar.
function instrumentIn(part, known) {
  const words = part.toLowerCase().replace(/-string/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const name = words.slice(words.length - n).join(' ');
    if (known(name)) return name;
  }
  return null;
}
// The [singing…] tag for her voice: how this song is sung, short (the voice reads long tags as words).
// power: how hard the line is sung, 1 to 5 (vocal-power.js): a strong line is asked for at full power.
export const singingTag = ({ genre, vocal, power = POWER }) => { const e = effortTags(power); return `${e.ahead}[singing${[genre, e.inside, vocal].filter(Boolean).map((s) => `, ${s.slice(0, 60)}`).join('')}]`; };

// When each line starts (seconds): on a bar, after the line before it, a bar's rest when the section changes, two
// bars of the band first.
export function placeLines(lines, seconds, { tempo, meter }) {
  const bar = (meter * 60) / tempo;
  const starts = [];
  let at = 2 * bar;
  lines.forEach((l, i) => {
    if (i && l.section !== lines[i - 1].section) at += bar;
    const start = Math.ceil((at - 1e-6) / bar) * bar;
    starts.push(+start.toFixed(3));
    at = start + seconds[i] + 0.2;
  });
  return { starts, bars: Math.ceil(at / bar) + 2, bar };
}

// The chords under her when she couldn't write her own: the four-bar loop for the key's mode, as many times as the
// song needs. Only a fallback (it's the same loop for every song).
export const progressionFor = (mode, bars) => Array.from({ length: Math.ceil(bars / 4) }, () => (mode === 'minor' ? 'i VI III VII' : 'I V vi IV')).join(' | ');

// A song's chords cut into stretches one instrument section can play (sheet.js holds 64 bars), on four-bar phrase
// lines: [{ from (bar index, 0-based), chords }].
export const BAND_BARS = 64;
export function bandStretches(chords, most = BAND_BARS) {
  const size = Math.max(4, most - (most % 4));
  const out = [];
  for (let from = 0; from < chords.length; from += size) out.push({ from, chords: chords.slice(from, from + size) });
  return out;
}

// The band under a sung song, as one track. A whole song runs past the 64 bars one instrument section holds (2026-11-12:
// "That's 88 bars; keep a section to 64" and nothing played, three times, while she promised to trim it), so it's
// played in stretches of up to 64 bars, each laid in on its own bar, and mixed into one. section: instrument.section;
// dir: where section() writes (her music folder).
// band: who plays under her, from her score ({ chords, bass, drums, pad }); a song sung without a score gets the
// string pad it always had.
export async function renderSongBand({ key, tempo, meter, progression, style, lead, title, band = undefined }, { section, dir }) {
  const chords = String(progression).split(/[|\s]+/).filter(Boolean);
  const parts = [];
  const cleanup = () => parts.forEach((p) => rmSync(p.file, { force: true }));
  try {
    for (const [i, p] of bandStretches(chords).entries()) {
      const s = section({ title: `${title} band ${i + 1}`, instrument: lead, tempo, key, meter, progression: p.chords.join(' '), style, melody: '', band: band === undefined ? { pad: 'string ensemble' } : band }, 0);
      parts.push({ file: path.join(dir, s.file), at: (p.from * meter * 60) / tempo, seconds: s.seconds });
    }
  } catch (err) { cleanup(); throw err; }
  if (parts.length === 1) return { file: parts[0].file, seconds: parts[0].seconds, cleanup };
  const file = path.join(dir, `.band-${Date.now()}.wav`);
  try {
    const mix = parts.map((p, i) => `[${i}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[p${i}]`).join(';');
    run([...parts.flatMap((p) => ['-i', p.file]), '-filter_complex', `${mix};${parts.map((_, i) => `[p${i}]`).join('')}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[out]`, '-map', '[out]', file], 'join the band into one track');
  } finally { cleanup(); }
  return { file, seconds: Math.max(...parts.map((p) => p.at + p.seconds)), cleanup: () => rmSync(file, { force: true }) };
}

// Where everything falls, bar by bar, for the composer: which bars each line is sung over, and the bars between.
export function songLayout(lines, starts, bar, bars) {
  const at = (s) => Math.round(s / bar) + 1; // bar numbers from 1
  return lines.map((l, i) => {
    const from = at(starts[i]), to = i + 1 < lines.length ? at(starts[i + 1]) - 1 : bars;
    return { ...l, from, to: Math.max(from, to) };
  });
}

// Singing toward a song she remembers (song-memory.js; owner, 2026-11-15: "try to reproduce that in the songs that she
// makes, in the lyrics she sings, and the frequencies and notes that she chooses"). Before a note is sung she decides,
// from what that song did to her and what she measured of it, the key and pace she'll sing in and how her voice
// carries it. aim: the song's sketch (sketchOfRecord); brief: aimBrief(aim).
export function deliveryMessages({ name = 'Champ', title, styleLine = '', brief }) {
  return [
    { role: 'system', content: `You are ${name}, about to sing your own song "${title}" in your own voice with your band.\n${brief}\n` +
      `Decide how you'll sing and play it so that it feels that way: the key, the tempo, and your delivery, which is how your voice carries it, in a few plain words (how soft or full, how close, how held back or let go, how bright or low). Keep what your own style line asks for where it serves that feeling, and change it where it doesn't.\n` +
      `Reply with JSON only, with exactly these fields: {"key":"","tempo":0,"delivery":"","why":""}\nkey: a tonic and major or minor. tempo: beats per minute. delivery: a few words. why: one sentence, what you're reaching for.` },
    { role: 'user', content: `Your song's own style line: ${styleLine || '(none written)'}` },
  ];
}
// Her answer, checked: { key (a key name, or null when what she gave isn't one), tempo (or null), delivery, why }.
export function readDelivery(out) {
  if (!out || typeof out !== 'object') throw new Error("what came back wasn't the JSON asked for.");
  let key = null;
  try { key = parseKey(String(out.key ?? '')).name; } catch {}
  const tempo = Number(out.tempo) >= 30 ? Math.max(50, Math.min(180, Math.round(Number(out.tempo)))) : null;
  const delivery = String(out.delivery ?? '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!key && !tempo && !delivery) throw new Error('it named no key, no tempo and no delivery.');
  return { key, tempo, delivery, why: String(out.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

// What she's asked when she writes the music for her words: a chord for every bar and a tune for every line.
// aim: aimBrief of a song she remembers, when this one is sung toward how that one made her feel.
export function tuneMessages({ name = 'Champ', title, key, style, layout, bars, aim = '' }) {
  return [
    { role: 'system', content: `You are ${name}, about to sing your own song "${title}" with your band. Your voice sings the words; you write the music it sings to: the chords for every bar, and the tune for every lyric line.\n` +
      (aim ? `${aim}\nSo the chords you choose, where the tune sits and how it moves are chosen for that feeling.\n` : '') +
      `The song is in ${key}, ${style.tempo} bpm, ${style.meter}/4${style.genre ? `, ${style.genre}` : ''}${style.accompaniment ? `, the band playing ${style.accompaniment} on ${style.lead}` : ''}. It runs ${bars} bars; where each line falls is below (the bars before the first line and between sections are the band alone).\n` +
      `What you know as a musician:\n- ${CRAFT.join('\n- ')}\n` +
      `For singing: about one note per syllable (a held word can take two or three), mostly steps with a few leaps, the whole tune within about an octave and a half; a line ends on a chord tone of the bar it ends in, and a section's last line comes to rest; the chorus lifts above the verses and has a hook; when words come back (a repeated chorus) their tune and chords come back with them. Write the notes in a comfortable singing octave (around A3 to E5).\n` +
      `Chords: one Roman numeral per bar, in the key, for all ${bars} bars, separated by spaces (| between sections is fine). Tune: notes like E4, F#4 or Bb3 with an optional length in beats after a colon (C4:2; default 1), r for a rest.\n` +
      `Reply with JSON only, with exactly these fields: {"progression":"","lines":[]}\nprogression: your ${bars} chords. lines: one tune per lyric line, in order, exactly ${layout.length} strings.` },
    { role: 'user', content: layout.map((l, i) => `${i + 1}. [${l.section || 'Song'}] bars ${l.from}-${l.to}: ${l.text}`).join('\n') },
  ];
}

// Her music, checked: { progression (exactly bars chords), tunes ([{ midi, beats }] per line) }. Throws saying what's
// wrong with it.
export function readTune(out, { key, lines, bars }) {
  if (!out || typeof out !== 'object') throw new Error("what came back wasn't the JSON asked for.");
  const k = parseKey(key);
  const chords = String(out.progression ?? '').split(/[|\s]+/).filter(Boolean);
  if (!chords.length) throw new Error('there was no progression.');
  for (const c of chords) chordOf(c, k);
  if (!Array.isArray(out.lines) || out.lines.length !== lines) throw new Error(`lines has ${Array.isArray(out.lines) ? out.lines.length : 'no'} tunes; it needs exactly ${lines}, one per lyric line, in order.`);
  const tunes = out.lines.map((t, i) => {
    try { const tune = parseTune(t); if (!tune.length) throw new Error('it has no notes.'); return tune; } catch (err) { throw new Error(`line ${i + 1}'s tune: ${err.message}`); }
  });
  // Short is played round again, long is cut: the band has to last exactly as long as the song.
  const progression = Array.from({ length: bars }, (_, i) => chords[i % chords.length]).join(' ');
  return { progression, tunes };
}

// She writes the music for her words, asked again (told what was wrong) up to three times. Throws with the last
// problem when it never comes out right.
export async function writeTune({ ask, ...brief }) {
  const messages = tuneMessages(brief);
  let out = null, wrong = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    out = await ask(wrong ? [...messages, { role: 'assistant', content: JSON.stringify(out ?? {}) }, { role: 'user', content: `That can't be sung: ${wrong} Fix it and reply with the whole JSON again.` }] : messages);
    try { return readTune(out, { key: brief.key, lines: brief.layout.length, bars: brief.bars }); } catch (err) { wrong = err.message; }
  }
  throw new Error(`the composer couldn't write the music in three goes; the last problem: ${wrong}`);
}

// ---- singing to a score: the music first, her voice fitted to it ----
//
// Owner, 2026-11-15: "I asked her to compose a rap song, and she didn't really have it in her toolkit. But I need her
// to be able to sing better, like really hit high notes, really match the rhythm, stretch out the verses and the
// words if needed, just like a real singer." What happened that night ("Signal in the Room"): the word "rap" in her
// style line was taken for a vibraphone, there were no drums and no bass, every line was auto-tuned onto a melody,
// and the words fell wherever her voice put them. So now she writes a score before she opens her mouth: for every
// line, whether it's sung or rapped, how she delivers it, and its music syllable by syllable (when each one lands,
// how long it's held, which note or notes), with the chords under it and the band that plays. Her voice is then
// fitted to that (retune.js fitLine): on the beat, held where it's held, as high as it's written.

// About how many syllables a line has, to check her score against (counted from its vowel sounds).
export function syllablesIn(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean).reduce((n, word) => {
    const w = word.replace(/'/g, '');
    if (!/[a-z]/.test(w)) return n;
    const groups = (w.length > 3 ? w.replace(/(?:[^laeiouy]es|[^aeiouytd]ed|[^laeiouy]e)$/, '') : w).match(/[aeiouy]+/g) ?? [];
    return n + Math.max(1, groups.length);
  }, 0);
}

// The tag her voice is given for a rapped line: spoken in rhythm, with how she delivers it.
export const rapTag = (how = '', power = POWER) => { const e = effortTags(power); return `${e.ahead}[rapping, rhythmic${e.inside ? `, ${e.inside}` : ''}${how ? `, ${how.slice(0, 40)}` : ''}]`; };
const fewWords = (s) => String(s ?? '').replace(/[\[\]"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

// What she's asked when she writes the score for her words.
export function scoreMessages({ name = 'Champ', title, styleLine = '', style, lines, aim = '', styles = [] }) {
  return [
    { role: 'system', content: `You are ${name}, about to perform your own song "${title}" in your own voice with your band. You write the score first, the way a singer works a song out before singing it; your voice is then fitted to exactly what you write: every syllable lands where you put it, is held as long as you say, and is sung on the note you give it.\n` +
      (aim ? `${aim}\nSo the notes, the pace of the words and the way each line is delivered are chosen for that feeling.\n` : '') +
      `The song is at ${style.tempo} bpm in ${style.meter}/4${style.key ? `, in ${style.key}` : ' (you choose the key)'}. Your own style line for it: ${styleLine || '(none written)'}\n` +
      `For every lyric line, in order, you decide:\n` +
      `- voice: "sung" or "rapped". Sung is a melody. Rapped is spoken in rhythm with no notes: for rap verses and spoken-word lines. Read your style line and the words and decide line by line; a rap song usually raps its verses and may sing its hook.\n` +
      `- how: a few plain words on how you deliver that line (soft and close, belted and high, tight and punchy, laid back behind the beat). It's what your voice is told.\n` +
      `- power: how hard you sing or rap that line, a whole number from 1 to 5. 1 is nearly a whisper, 2 is gentle, 3 is a full singing voice, 4 is strong and pushed, 5 is everything you have: belted, shouted, the top of your lungs. It decides how much of your voice is behind the line: at 4 and 5 you're asked for full power, the line is voiced more than once and the strongest take is kept, and it's pressed, brightened, doubled and put in front of the band. Sing like you mean it: a rock song, an anthem or a hard rap lives at 4 and 5 with its verses at 3 or 4; a ballad starts at 2 or 3 and builds to 5 at its peak; a song that's all 2s sounds timid, and one that never changes has nowhere to go. Let the power rise through a section and into the chorus.\n` +
      `- harmony: "high", "low" or "". On a sung line, your own voice sings along with you a third above ("high") or a third below ("low") in the key. It's for the lines that should feel huge or beautiful: a chorus, a last line, a held word. Leave it "" on most lines so it means something when it comes.\n` +
      `- music: one item per syllable of the line, in order, separated by spaces. A sung syllable is a note and how long it's held in beats, like E4:1 (1 is a quarter note, 0.5 an eighth, 0.25 a sixteenth, 2 a half, 4 a whole bar of 4/4). A syllable that moves over several notes joins them with +, like E4:0.5+G4:0.5+A4:2. A rapped syllable is x and its length, like x:0.5 or x:0.25. A rest is r and its length, like r:1; a line can start with one.\n` +
      `- chords: one Roman numeral for each bar the line takes (its beats divided by ${style.meter}, rounded up), separated by spaces.\n` +
      `Each line starts on a new bar. Write it the way a real singer would sing it:\n` +
      `- Rhythm: stressed syllables land on the beats; quick words take eighths and sixteenths; the word that matters is held.\n` +
      `- Stretch it out: the end of a phrase rings (two to four beats); a word can be drawn over several notes with +; leave rests to breathe.\n` +
      `- Range: verses sit in the middle; the chorus lifts above them and its biggest moment reaches for a high note and holds it. Write sung notes between about A3 and E5; your voice is placed so the high notes you write are your high notes.\n` +
      `- Mostly steps with a few leaps; a line ends on a note of the chord under it; a section's last line comes to rest on the home note.\n` +
      `- Rapping: about one bar a line, in eighths and sixteenths, the rhyme word landing on or just before the fourth beat, a short rest to breathe; vary the flow from line to line so it isn't one pattern.\n` +
      `- When a line's words come back (a repeated chorus), you can give {"same": N} with the number of the earlier line, and its music comes back with it.\n` +
      `What you know as a musician:\n- ${CRAFT.join('\n- ')}\n` +
      `The band: "instrument" is the lead that carries the chords (an instrument name), "band" adds players made from your chords: "chords" (another instrument on the chords, or empty), "bass", "drums" (a kit: standard, room, power, electronic, 808, jazz, brush, orchestra; or empty), "pad" (a sustained bed, or empty). "style" is how the band plays, exactly one of ${styles.join(', ')}. Give the song the band its style line asks for.\n` +
      `Reply with JSON only, with exactly these fields: {"key":"","style":"","instrument":"","band":{"chords":"","bass":"","drums":"","pad":""},"lines":[{"voice":"","how":"","power":3,"harmony":"","music":"","chords":""}]}\n` +
      `key: a tonic and major or minor${style.key ? ` (${style.key}, as your style line says)` : ''}. lines: exactly ${lines.length} items, one per lyric line, in order.` },
    { role: 'user', content: lines.map((l, i) => `${i + 1}. [${l.section || 'Song'}] (about ${syllablesIn(l.text)} syllables) ${l.text}`).join('\n') },
  ];
}

// Her score, checked: { key, style, lead, band, lines: [{ voice, how, score, chords, bars }] }. Throws saying what's
// wrong with it, in words she can fix it from. checkInstrument(name) throws when she has no such instrument.
export function readScore(out, { lines, style, styles = [], checkInstrument = () => {} }) {
  if (!out || typeof out !== 'object') throw new Error("what came back wasn't the JSON asked for.");
  let key;
  try { key = parseKey(style.key || out.key); } catch { throw new Error(`"${out.key ?? ''}" isn't a key; write a tonic and major or minor, like "A minor".`); }
  if (!styles.includes(out.style)) throw new Error(`style "${out.style ?? ''}" isn't one of ${styles.join(', ')}.`);
  const clean = (v) => String(v ?? '').replace(/\s*\(.*$/, '').trim();
  const lead = clean(out.instrument) || 'grand piano';
  checkInstrument(lead);
  const band = {};
  for (const part of ['chords', 'bass', 'drums', 'pad']) {
    const v = clean(out.band?.[part]);
    if (!v || /^(none|no|off|-)$/i.test(v) || (part === 'chords' && v === lead)) continue;
    checkInstrument(part === 'drums' && !/kit$/i.test(v) ? `${v} kit` : v);
    band[part] = v;
  }
  if (!Array.isArray(out.lines) || out.lines.length !== lines.length) throw new Error(`lines has ${Array.isArray(out.lines) ? out.lines.length : 'no'} items; it needs exactly ${lines.length}, one per lyric line, in order.`);
  const done = [];
  out.lines.forEach((l, i) => {
    const text = lines[i].text;
    const same = Number(l?.same);
    if (same >= 1 && same <= i && Number.isInteger(same)) { done.push({ ...done[same - 1] }); return; }
    const voice = String(l?.voice ?? '').trim().toLowerCase() === 'rapped' ? 'rapped' : 'sung';
    let score;
    try { score = parseScore(l?.music); } catch (err) { throw new Error(`line ${i + 1}'s music: ${err.message}`); }
    const about = syllablesIn(text), n = score.syllables.length;
    if (!n) throw new Error(`line ${i + 1} ("${text}") has no music; write one item per syllable.`);
    if (n < about * 0.6 - 1 || n > about * 1.6 + 2) throw new Error(`line ${i + 1} ("${text}") has about ${about} syllables and your music for it has ${n} items; write one item per syllable (join the notes of one syllable with +).`);
    if (voice === 'sung' && score.syllables.some((s) => s.notes.some((x) => x.midi === null))) throw new Error(`line ${i + 1} is sung, so every syllable needs a note like E4:1 (x is for a rapped line).`);
    if (voice === 'rapped') for (const s of score.syllables) for (const x of s.notes) x.midi = null;
    if (score.beats > 12 * style.meter) throw new Error(`line ${i + 1} runs ${score.beats} beats; that's too long for one line.`);
    if (score.beats / n < 0.2) throw new Error(`line ${i + 1} gives its syllables less than a fifth of a beat each; nobody can say them that fast. Give it more beats.`);
    const bars = Math.max(1, Math.ceil(score.beats / style.meter - 1e-6));
    const written = String(l?.chords ?? '').split(/[|\s,]+/).filter(Boolean);
    if (!written.length) throw new Error(`line ${i + 1} has no chords; write one Roman numeral per bar it takes (${bars}).`);
    try { for (const c of written) chordOf(c, key); } catch (err) { throw new Error(`line ${i + 1}'s chords: ${err.message}`); }
    const way = String(l?.harmony ?? '').trim().toLowerCase();
    if (way && way !== 'high' && way !== 'low' && way !== 'none') throw new Error(`line ${i + 1}'s harmony is "${way}"; write "high", "low" or "".`);
    done.push({ voice, how: fewWords(l?.how), power: readPower(l?.power), harmony: voice === 'sung' && way !== 'none' ? way : '', score, bars, chords: Array.from({ length: bars }, (_, b) => written[b % written.length]) });
  });
  return { key: key.name, style: out.style, lead, band: Object.keys(band).length ? band : null, lines: done };
}

// How much room the composer gets for a score: it grows with the song (a 20-line aria took 6,400 tokens; a flat 7,000
// cut a 42-line ballad off three times running), and by half again on each retry after a cut-off.
export function scoreRoom(lines, attempt = 0) {
  const maxTokens = Math.round((4000 + 400 * lines) * (1 + attempt / 2));
  return { maxTokens, timeoutMs: 60_000 + maxTokens * 15 };
}

// She writes the score, asked again (told what was wrong) up to three times. Throws with the last problem.
// ask(messages, { attempt }): an answer cut off at its length limit throws with cutOff set; she's asked again, told
// so, and given more room (attempt) rather than told it "wasn't JSON".
export async function writeScore({ ask, ...brief }) {
  const messages = scoreMessages(brief);
  let out = null, wrong = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try { out = await ask(wrong ? [...messages, { role: 'assistant', content: JSON.stringify(out ?? {}) }, { role: 'user', content: `That can't be performed: ${wrong} Fix it and reply with the whole JSON again.` }] : messages, { attempt }); }
    catch (err) {
      if (!err.cutOff) throw err;
      out = null; wrong = `${err.message}. Write the whole score again, more tightly: no thinking out loud inside it, and every line kept to what it needs.`;
      continue;
    }
    try { return readScore(out, brief); } catch (err) { wrong = err.message; }
  }
  throw new Error(`the score couldn't be written in three goes; the last problem: ${wrong}`);
}

// Where everything falls once the score is written: each line starts on a bar, after the line before it, with a bar
// between sections and two bars of the band first and last. Returns { starts (s), bars, progression: [a chord per bar] }.
export function layoutScore(lines, scored, { tempo, meter, mode }) {
  const bar = (meter * 60) / tempo;
  const chords = [], starts = [];
  let at = 2;
  lines.forEach((l, i) => {
    if (i && l.section !== lines[i - 1].section) at += 1;
    starts.push(+(at * bar).toFixed(3));
    scored[i].chords.forEach((c, b) => { chords[at + b] = c; });
    at += scored[i].bars;
  });
  const bars = at + 2, home = mode === 'minor' ? 'i' : 'I';
  // The bars the band plays alone: the chord of the line that's coming, and home at the very end.
  let next = home;
  for (let b = bars - 1; b >= 0; b--) { if (chords[b]) next = chords[b]; else chords[b] = b >= at ? home : next; }
  return { starts, bars, progression: chords };
}

const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
function run(args, what) {
  const r = spawnSync(ffmpeg(), ['-v', 'error', '-nostdin', '-y', ...args], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg couldn't ${what}: ${r.error?.message ?? String(r.stderr).trim().slice(-200)}`);
  return r.stdout;
}
const pcm16k = (file) => run(['-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], 'read a sung line');
const VOICE_RATE = 44100;
const floats = (buf) => { const b = Buffer.from(buf); return new Float32Array(b.buffer, b.byteOffset, b.length >> 2); };
const voiceOf = (file) => floats(run(['-i', file, '-ac', '1', '-ar', String(VOICE_RATE), '-f', 'f32le', 'pipe:1'], 'read a sung line'));
const hearOf = (pcm) => { const x = new Float32Array(pcm.length >> 1); for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768; return x; };

// Sings a song. deps: synthesize(text) -> audio bytes (mp3), renderBand({ key, tempo, meter, progression, style, lead })
// -> { file (absolute), seconds }, addTrack(bytes, { title, about }) -> library file, playOut(file) -> bool,
// compose(messages) -> JSON from her composer (writes the chords and tune; without it, or when it fails, her voice is
// pulled onto the key's notes and the band plays the fallback loop, and the log says why).
// aim: a song she remembers (song-memory.js sketch) whose feeling this one is sung toward; measureAim(file, { title,
// why }) -> how close the finished track came (kept with that song), or null.
// checkInstrument(name): throws, naming what she has, when the band in her score names an instrument she doesn't have.
// smoothVoice(x, rate, plan, { key, dir }) -> samples: her line rebuilt on its score by the WORLD vocoder (voice/world.js
// renderWorld); without it, or when it fails, the line is fitted grain by grain (retune.js fitLine).
export async function singSong(song, { synthesize, renderBand, addTrack, playOut = () => false, compose = null, name = 'Champ', known = () => false, styles = [], log = activity, aim = null, measureAim = null, checkInstrument = () => {}, smoothVoice = null } = {}) {
  const mine = building = { title: song.title, at: Date.now() };
  try { return await singing(song, { synthesize, renderBand, addTrack, playOut, compose, name, known, styles, log, aim, measureAim, checkInstrument, smoothVoice }); }
  finally { if (building === mine) building = null; }
}

// The song she's putting together right now ({ title, at }), or null: so asked "did you start it?" she knows it's
// still coming (2026-11-12: her player said nothing was playing, and she said it had played and finished), and asked
// again she doesn't start a second one.
let building = null;
export const songBeingMade = () => building;

async function singing(song, { synthesize, renderBand, addTrack, playOut, compose, name, known, styles, log, aim, measureAim, checkInstrument, smoothVoice }) {
  const lines = lyricLines(song.lyrics);
  if (!lines.length) throw new Error(`"${song.title}" has no lyrics to sing: write some with the songbook tool first.`);
  const style = readStyle(song.style, { known, styles });
  // Sung toward a song she remembers: she decides the key, the pace and how her voice carries it from what that song
  // did to her and what she measured of it. If that decision can't be made, the song's own measured key and pace are
  // used, and the log says why.
  let brief = '', reaching = '';
  if (aim) {
    brief = aimBrief(aim);
    let d = null, why = compose ? '' : 'no composer was given';
    if (compose) { try { d = readDelivery(await compose(deliveryMessages({ name, title: song.title, styleLine: song.style, brief }))); } catch (err) { why = err.message; } }
    if (!d) {
      let key = null;
      try { key = aim.key ? parseKey(aim.key).name : null; } catch {}
      d = { key, tempo: aim.bpm ? Math.max(50, Math.min(180, aim.bpm)) : null, delivery: '', why: '' };
      log('error', { where: 'sing', message: `"${song.title}" is being sung toward how "${aim.title}" made her feel, but she couldn't decide how to sing it for that (${why}), so it takes that song's own measured key and pace (${[d.key, d.tempo && `${d.tempo} bpm`].filter(Boolean).join(', ') || 'neither could be measured, so the style line stands'}) and her voice is sung as the style line says. Fix: check the composer (the composerModel setting) and sing it again.` });
    }
    if (d.key) style.key = d.key;
    if (d.tempo) style.tempo = d.tempo;
    if (d.delivery) style.vocal = d.delivery;
    reaching = d.why;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sing-'));
  // One line in her voice, with the tag that says how, as a file.
  const voiceLine = async (tag, l, i) => {
    const file = path.join(tmp, `line${i}.mp3`);
    writeFileSync(file, await synthesize(`${tag} ${l.text}`));
    return file;
  };
  // A line of hers ready for the mix: brought to the one level every line starts the voice chain at, and kept.
  const keep = (samples, i, part = 'tuned') => {
    levelLine(samples, VOICE_RATE);
    const file = path.join(tmp, `${part}${i}.f32`);
    writeFileSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    return file;
  };
  try {
    // The score first: for every line, sung or rapped, how it's delivered, its music syllable by syllable, its chords,
    // and the band. Her voice is then fitted to it. If the score can't be written, the song is still sung, the way it
    // used to be (her own timing, a tune laid over it), and the log says why.
    let plan = null, noScore = compose ? '' : 'no composer was given';
    if (compose) {
      try { plan = await writeScore({ ask: (m, { attempt = 0 } = {}) => compose(m, scoreRoom(lines.length, attempt)), name, title: song.title, styleLine: song.style, style, lines, aim: brief, styles, checkInstrument }); }
      catch (err) { noScore = err.message; }
    }
    let p; // the performance: { key, delays, end (s), band (rendered), about, logged, told }
    if (plan) {
      const key = parseKey(plan.key);
      // 1. Every line in her voice, told how: sung lines sung, rapped lines rapped, each as hard as she wrote it. A
      // strong line is voiced more than once (her voice gives a different take every time, and only about half of
      // those asked for at full power come back with it), and the take with the most effort in it is kept.
      const kept = await Promise.all(lines.map(async (l, i) => {
        const { voice, how, power } = plan.lines[i];
        const tag = voice === 'rapped' ? rapTag(how, power) : singingTag({ genre: style.genre, vocal: how || style.vocal, power });
        const takes = await Promise.all(Array.from({ length: takesFor(power) }, async (_, t) => {
          const file = await voiceLine(tag, l, `${i}-${t}`);
          const hear = hearOf(pcm16k(file));
          const followed = followVoice(hear, 16000);
          return { file, hear, voice: followed, effort: effortOf(hear, 16000, followed.track) };
        }));
        return { ...takes[strongest(takes.map((t) => t.effort))], takes: takes.length };
      }));
      const clips = kept.map((k) => k.file), hears = kept.map((k) => k.hear), voices = kept.map((k) => k.voice);
      // 2. Where the tune sits in her voice: one placement for the whole song (by whole octaves, its middle near where
      // she sings), so a line written high is still sung higher than the rest, and every word stays clear.
      const sung = plan.lines.map((l, i) => (l.voice === 'sung' ? i : -1)).filter((i) => i >= 0);
      let shift = 0;
      if (sung.length) {
        // Each line is reached from the take that sings it (a strong line's take sits higher than a soft one's), and
        // the song goes as high as every line can follow.
        const pitched = sung.filter((i) => voices[i].median !== null);
        if (!pitched.length) throw new Error("her voice didn't come out sung (no pitch in any sung line), so there was nothing to put on the notes");
        // Centred on where her voice sits across the sung lines (retune.js placeSong): moved far from there, the words
        // break up. Never higher than any one line could follow (placeTune).
        const hersAll = pitched.map((i) => voices[i].median).sort((a, b) => a - b)[Math.floor(pitched.length / 2)];
        const notesOf = (i) => plan.lines[i].score.syllables.flatMap((s) => s.notes.map((n) => n.midi)).filter((m) => m !== null);
        shift = Math.min(placeSong(hersAll, pitched.flatMap(notesOf)), ...pitched.map((i) => placeTune(voices[i].median, Math.max(...notesOf(i)))));
      }
      // 3. Where each line falls, and the chord under every bar.
      const { starts, bars, progression } = layoutScore(lines, plan.lines, { tempo: style.tempo, meter: style.meter, mode: key.mode });
      // 4. Each line fitted to its score: on the beat, held where it's held, on its notes.
      // Where she wrote a harmony, her own voice is fitted a second time, a third above or below in the key.
      const harmonies = [];
      // Smooth (the WORLD vocoder: voice/world.js) when it can run; the old grain-by-grain way when it can't, said once.
      let smooth = Boolean(smoothVoice);
      const fitVoice = async (x, i, score, how, part) => {
        if (smooth) {
          try {
            const planned = worldPlan(x, VOICE_RATE, { score, ...how });
            return { ...planned, samples: await smoothVoice(x, VOICE_RATE, planned, { key: `line${i}`, dir: tmp }) };
          } catch (err) {
            smooth = false;
            log('error', { where: 'sing', message: `"${song.title}": her voice couldn't be rebuilt smoothly on its notes (${part} ${i + 1}: ${err.message}), so this song is fitted the old way, which buzzes on long notes. Fix: check that pyworld is installed in her hearing's Python (voice/world.js).` });
          }
        }
        return fitLine(x, VOICE_RATE, { score, ...how });
      };
      const fits = [];
      for (const [i, l] of lines.entries()) {
        try {
          const x = voiceOf(clips[i]), written = plan.lines[i];
          const how = { tempo: style.tempo, shift, hear: hears[i], hearRate: 16000, voice: voices[i], vibrato: vibratoFor(written.power) };
          const fit = await fitVoice(x, i, written.score, how, 'line');
          keep(fit.samples, i);
          if (written.harmony) {
            const reach = (voices[i].median ?? Infinity) + MAX_FIT_SHIFT - shift; // the highest written note she can be moved to
            const over = await fitVoice(x, i, harmonyScore(written.score, key.scale, written.harmony, reach), how, 'harmony over line');
            harmonies.push({ line: i, file: keep(over.samples, i, 'harmony'), way: written.harmony });
          }
          fits.push(fit);
        } catch (err) { throw new Error(`line ${i + 1} ("${l.text.slice(0, 60)}") couldn't be put on its score: ${err.message}`); }
      }
      // 5. The band she chose, on her chords.
      const band = await renderBand({ key: key.name, tempo: style.tempo, meter: style.meter, progression: progression.join(' '), style: plan.style, lead: plan.lead, band: plan.band, title: song.title });
      const rapped = plan.lines.filter((l) => l.voice === 'rapped').length;
      const top = sung.length ? Math.max(...sung.flatMap((i) => plan.lines[i].score.syllables.flatMap((s) => s.notes.map((n) => n.midi)))) + shift : null;
      const noteName = (m) => `${['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
      const held = Math.max(...fits.map((f) => f.held));
      const moved = sung.length ? +(sung.reduce((s, i) => s + fits[i].moved, 0) / sung.length).toFixed(2) : 0;
      const bandWords = [plan.lead, ...Object.entries(plan.band ?? {}).map(([k, v]) => (k === 'drums' ? `${v} drums` : v))].join(', ');
      const how = rapped === lines.length ? 'rapped' : rapped ? `${rapped} lines rapped and ${lines.length - rapped} sung` : 'sung';
      const powers = plan.lines.map((l) => l.power);
      const strong = powers.filter((v) => v >= 4).length;
      // How the takes she kept came out (so a song that still sounds timid shows why: the power she wrote, or the
      // effort her voice gave back for it).
      const efforts = kept.map((k) => k.effort).filter(Boolean);
      const mean = (of) => (efforts.length ? +(efforts.reduce((s, e) => s + e[of], 0) / efforts.length).toFixed(1) : null);
      p = { key, band, powers, harmonies, delays: starts.map((s, i) => Math.max(0, s - fits[i].lead)), end: starts.at(-1) + fits.at(-1).seconds,
        about: `${how} to a score she wrote (${plan.style}, ${bandWords})${top !== null ? `, her top note ${noteName(top)}` : ''}, ${strong} of ${lines.length} lines at full power${harmonies.length ? `, her own harmony over ${harmonies.length}` : ''}`,
        logged: { tune: 'her score', rapped, sung: lines.length - rapped, retuned: moved, held, top: top !== null ? noteName(top) : null, shift, power: powers.join(''), takes: kept.reduce((s, k) => s + k.takes, 0), harmonies: harmonies.length, voice: { level: mean('level'), pitch: mean('pitch'), bright: mean('bright') }, progression: progression.join(' '), style: plan.style, lead: plan.lead, band: plan.band },
        told: { tune: 'her score', lead: plan.lead, rapped, held, power: powers.join(''), harmonies: harmonies.length } };
    } else {
      log('error', { where: 'sing', message: `"${song.title}": the score for it couldn't be written (${noScore}), so it's sung the old way: her voice keeps its own timing instead of landing on the beat, no word is held longer than she said it, nothing is rapped, and the band is the lead and a pad with no drums. Fix: check the composer (the composerModel setting) and sing it again.` });
      const tag = singingTag(style);
      // 1. Every line, sung.
      const clips = await Promise.all(lines.map((l, i) => voiceLine(tag, l, i)));
      const pcms = clips.map(pcm16k);
      const seconds = pcms.map((x) => x.length / 2 / 16000);
      // 2. The key: the song's own, or the one her voice chose.
      const heard = keyOf(pitchClasses(Buffer.concat(pcms)));
      if (!heard) throw new Error("her voice didn't come out sung (no pitch in it), so there was nothing to tune or play under");
      const key = style.key ? parseKey(style.key) : parseKey(heard.name);
      // 3. Her music for the words: a chord for every bar, a tune for every line.
      const { starts, bars, bar } = placeLines(lines, seconds, style);
      let music = null, why = '';
      if (compose) {
        try { music = await writeTune({ ask: compose, name, title: song.title, key: key.name, style, layout: songLayout(lines, starts, bar, bars), bars, aim: brief }); }
        catch (err) { why = err.message; }
      } else why = 'no composer was given';
      if (!music) log('error', { where: 'sing', message: `"${song.title}": ${why}, so her voice is pulled onto the notes of ${key.name} (auto-tune, no tune of its own) and the band plays a stock ${key.mode} loop. Fix: check the composer (the composerModel setting) and sing it again.` });
      // 4. Each line onto its tune (or onto the key's notes).
      const moved = clips.map((file, i) => {
        const { samples, moved: by } = tuneLine(voiceOf(file), VOICE_RATE, { tune: music?.tunes[i] ?? null, scale: key.scale, hear: hearOf(pcms[i]), hearRate: 16000 });
        keep(samples, i);
        return by;
      });
      // 5. The band, in that key, on her chords.
      const band = await renderBand({ key: key.name, tempo: style.tempo, meter: style.meter, progression: music?.progression ?? progressionFor(key.mode, bars), style: style.accompaniment, lead: style.lead, title: song.title });
      p = { key, band, powers: lines.map(() => POWER), harmonies: [], delays: starts, end: starts.at(-1) + seconds.at(-1),
        about: `sung (${music ? 'on a tune she wrote for it' : `pulled onto the notes of ${key.name}`}) over ${style.lead} (${style.accompaniment}${music ? `, her chords ${music.progression.split(' ').slice(0, 8).join(' ')}…` : ''})`,
        logged: { tune: music ? 'hers' : 'key only', retuned: +(moved.reduce((s, v) => s + v, 0) / moved.length).toFixed(2), progression: music?.progression ?? 'stock loop', lead: style.lead },
        told: { tune: music ? 'hers' : `key only: ${why}`, lead: style.lead } };
    }
    // 6. One track.
    // Her voice in front of the band (vocal-power.js): every line through the voice chain at the power she wrote,
    // the strongest doubled, her harmonies under the lines they're over (off to one side), all of it in a room; the
    // band measured and set under her. Then the whole track is measured and brought to one level: a fixed gain and
    // a limiter for the peaks, so nothing swells or ducks that she didn't sing that way.
    const out = path.join(tmp, 'sung.mp3'), rough = path.join(tmp, 'mix.wav');
    const parts = [...lines.map((_, i) => ({ file: path.join(tmp, `tuned${i}.f32`), power: p.powers[i], at: p.delays[i] })),
      ...p.harmonies.map((h, n) => ({ file: h.file, power: p.powers[h.line], at: p.delays[h.line], gain: 0.5, pan: n % 2 ? -0.45 : 0.45 }))];
    const inputs = ['-i', p.band.file, ...parts.flatMap((v) => ['-f', 'f32le', '-ar', String(VOICE_RATE), '-ac', '1', '-i', v.file])];
    try {
      const bandLevel = soundingLevel(floats(run(['-i', p.band.file, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], 'read the band')), 16000);
      run([...inputs, '-filter_complex', mixGraph({ lines: parts.map((v, i) => ({ ...v, input: `${i + 1}:a` })), rate: VOICE_RATE, bandGain: bandGainFor(bandLevel) }), '-map', '[out]', '-c:a', 'pcm_f32le', rough], 'mix her voice with the band');
      const level = soundingLevel(floats(run(['-i', rough, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], 'read the mix')), 16000);
      run(['-i', rough, '-af', `volume=${masterGainFor(level).toFixed(3)},alimiter=limit=0.84:level=false`, '-c:a', 'libmp3lame', '-b:a', '192k', out], 'finish the track');
    }
    finally { try { p.band.cleanup?.(); } catch {} }
    const minutes = +(p.end / 60).toFixed(1);
    const file = addTrack(readFileSync(out), { title: `${song.title} (sung)`, about: `${song.title}, sung by her in ${p.key.name} at ${style.tempo} bpm: ${p.about}, ${aim ? `reaching for how "${aim.title}" made her feel, ` : ''}${lines.length} lines, ${minutes} min`, by: 'you: sung in your own voice, over your own instruments' });
    const played = await playOut(file);
    // How close it came to the song it was sung toward: the finished track measured the way that song was.
    let came = null;
    if (aim && measureAim) { try { came = await measureAim(file, { title: `${song.title} (sung)`, why: reaching }); } catch (err) { log('error', { where: 'sing', message: `"${song.title}" was sung toward how "${aim.title}" made her feel, but how close it came couldn't be worked out: ${err.message}. The song is in her library; only the comparison is missing. Check song-memory.js.` }); } }
    log('sing', { song: song.id, title: song.title, file, key: p.key.name, ...p.logged, tempo: style.tempo, meter: style.meter, lines: lines.length, minutes, played, ...(aim && { aim: aim.title, delivery: style.vocal, reaching, came: came?.words ?? null }) });
    return { file, key: p.key.name, ...p.told, tempo: style.tempo, lines: lines.length, minutes, played, ...(aim && { aim: { song: aim.title, delivery: style.vocal, reaching, came: came?.words ?? null } }) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Wired to her real voice, instrument and library (the sing tool, tools.js).
export async function singFromSongbook(song, { playOut, aim = null } = {}) {
  const [{ synthesize }, instrument, orchestra, { addSong, MUSIC_DIR }, { STYLES }, { askComposer }, { config }, { songMemory }, world] = await Promise.all([
    import('./voice/fishAudio.js'), import('./instrument.js'), import('./orchestra.js'), import('./music.js'), import('./sheet.js'), import('./instrument-play.js'), import('./config.js'), import('./song-memory.js'), import('./voice/world.js'),
  ]);
  return singSong(song, {
    smoothVoice: world.worldMissing() ? null : world.renderWorld,
    checkInstrument: (n) => orchestra.instrument(n),
    aim, measureAim: (file, { title, why }) => songMemory().measureTry(aim.id, path.join(MUSIC_DIR, file), { kind: 'sung in her own voice', title, why }),
    synthesize: (text) => synthesize(text, { format: 'mp3' }),
    // The same composer that writes her instrument pieces writes the music for her words.
    compose: askComposer, name: config.botName,
    renderBand: (sheet) => renderSongBand(sheet, { section: instrument.section, dir: MUSIC_DIR }),
    // Only a pitched instrument can carry the chords: a drum kit's name ("jazz", "brush") in the style line isn't a lead.
    addTrack: addSong, playOut, known: (name) => orchestra.known(name) && !orchestra.instrument(name).drums, styles: STYLES,
  });
}
