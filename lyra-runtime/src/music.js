import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// The music library: every audio file in data/music, whether she made it (generate_music) or it
// was dropped in by hand, plus named playlists. library.json keeps what's known about her own
// songs (title and the prompt they were made from) so she can pick tracks by mood, not just name.
export const MUSIC_DIR = path.join(DATA_DIR, 'music');
const INFO_FILE = path.join(MUSIC_DIR, 'library.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const AUDIO = /\.(mp3|wav|ogg|opus|m4a|aac|flac|webm)$/i;

const readJson = (file, fallback) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

// Songs made before titles existed end in a timestamp ("...-mvp3dt7z"); leave that out of the title.
const titleFromFile = (file) =>
  path.basename(file, path.extname(file)).replace(/-[a-z0-9]{8}$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

// [{ file, title, about, made }] sorted by title. `about` is the prompt for songs she made.
export function tracks() {
  mkdirSync(MUSIC_DIR, { recursive: true });
  const info = readJson(INFO_FILE, {});
  return readdirSync(MUSIC_DIR)
    .filter((f) => AUDIO.test(f) && statSync(path.join(MUSIC_DIR, f)).isFile())
    .map((file) => ({ file, title: info[file]?.title || titleFromFile(file), about: info[file]?.about || '', made: Boolean(info[file]) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Saves a song she made under a readable, unique file name. Returns the file name.
export function addSong(bytes, { title, about }) {
  mkdirSync(MUSIC_DIR, { recursive: true });
  const slug = String(title || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'song';
  let file = `${slug}.mp3`;
  for (let n = 2; existsSync(path.join(MUSIC_DIR, file)); n++) file = `${slug}-${n}.mp3`;
  writeFileSync(path.join(MUSIC_DIR, file), bytes);
  const info = readJson(INFO_FILE, {});
  info[file] = { title: title || titleFromFile(file), about, at: Date.now() };
  writeFileSync(INFO_FILE, JSON.stringify(info, null, 2));
  return file;
}

// Strip spoken/typed filler around a song ask ("hey luna can you play … please").
// Returns the cleaned search/title, or '' if nothing useful remains.
export function stripMusicFiller(text) {
  const url = String(text || '').match(/https?:\/\/\S+/i)?.[0];
  if (url) return url;
  return String(text || '')
    .replace(/^(hey |ok |okay |yo |so )?(lyra|luna|amy)[, ]+/i, '')
    .replace(/\b(can you|could you|would you|will you|please|just)\b/gi, ' ')
    .replace(/\b(i want( you)? to|i wanna|i('d| would) like( you)? to|let'?s|we should)\b/gi, ' ')
    .replace(/\b(put on|put up|queue( up)?|play( me| us| for me)?|listen to|hear|spin|blast|drop|tune( in| into)?)\b/gi, ' ')
    .replace(/\b(on|from|via)\s+(youtube|yt|spotify)\b/gi, ' ')
    .replace(/\b(youtube|youtu\.be|spotify)\b/gi, ' ')
    .replace(/\b((a|some|the) )?(song|track|tune|music|playlist)( (called|named|by))?\b/gi, ' ')
    .replace(/\b(please|thanks|thank you)\b/gi, ' ')
    .replace(/[^a-z0-9&.''-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|some|the)\s+/i, '')
    .trim();
}

// Exact / substring library match only — never the fuzzy word-overlap path (that false-hits "up", "song", etc.).
function findTrackNamed(query, list = tracks()) {
  const q = String(query ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q.length < 2) return null;
  const norm = (t) => t.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = list.find((t) => norm(t) === q);
  if (exact) return exact;
  const contains = list.filter((t) => norm(t).includes(q) || q.includes(norm(t)));
  if (!contains.length) return null;
  const rank = (t) => (norm(t).startsWith(q) ? 0 : 1000) + Math.abs(norm(t).length - q.length);
  return contains.sort((a, b) => rank(a) - rank(b))[0];
}

/** Turn a musicAsk() result into music-tool arguments the runner can call directly. */
export function musicArgsFromAsk(ask) {
  if (!ask) return null;
  if (ask.kind === 'control') {
    return { action: ask.action || 'now_playing', tracks: [], playlist: '', youtube: '', spotify: '', radio: '', shuffle: false };
  }
  const action = ask.action === 'queue' ? 'queue' : 'play';
  const base = { action, tracks: [], playlist: '', youtube: '', spotify: '', radio: '', shuffle: false };
  if (ask.kind === 'library' && ask.track?.title) return { ...base, tracks: [ask.track.title] };
  if (ask.kind === 'playlist' && ask.query) return { ...base, playlist: ask.query };
  if (ask.kind === 'radio') return { ...base, radio: ask.query || '' };
  if (ask.kind === 'spotify') return { ...base, spotify: ask.query || '' };
  if (ask.kind === 'search') return { ...base, youtube: ask.query || '' };
  return null;
}

// Spoken/typed music ask → { kind, query, action?, source? } or null.
// Sources: youtube | spotify | radio | library. Voice: "play X on spotify", "put on jazz radio".
export function musicAsk(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const queue = /\bqueue\b/i.test(raw) ? 'queue' : 'play';

  if (/\b(what('?s| is) playing|now playing)\b/.test(low)) return { kind: 'control', action: 'now_playing', query: null };
  if (/\b(pause|paused?)\b/.test(low) && /\b(music|song|track|it)\b/.test(low)) return { kind: 'control', action: 'pause', query: null };
  if (/\b(resume|unpause)\b/.test(low)) return { kind: 'control', action: 'resume', query: null };
  if (/\b(skip|next( song| track)?)\b/.test(low)) return { kind: 'control', action: 'skip', query: null };
  if (/\bstop\b/.test(low) && /\b(music|song|track|playing|it|radio)\b/.test(low)) return { kind: 'control', action: 'stop', query: null };

  const wantsSpotify = /\bspotify\b|open\.spotify\.com/i.test(raw);
  const wantsRadio =
    /\b(radio station|fm radio|am radio)\b/i.test(raw) ||
    (/\bradio\b/i.test(raw) && /\b(play|put on|tune|listen|station)\b/i.test(raw));
  const wantsYoutube = /\byoutube\b|youtu\.be/i.test(raw);

  const hasIntent =
    /\b(play|put on|put up|queue|listen to|hear|spin|blast|tune)\b/i.test(raw) ||
    wantsYoutube ||
    wantsSpotify ||
    wantsRadio;
  const query = stripMusicFiller(raw);

  if (wantsRadio) {
    // Keep a bit of "radio" context for station search when the name is just "BBC 1".
    const radioQ = query || raw.replace(/\b(play|put on|tune( in| into)?|listen to)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (radioQ.length >= 2) return { kind: 'radio', action: 'play', query: radioQ, source: 'radio' };
  }
  if (wantsSpotify) {
    const spotifyQ = query || raw;
    if (spotifyQ.length >= 2) return { kind: 'spotify', action: queue, query: spotifyQ, source: 'spotify' };
  }

  // Strong library / playlist name only (exact or substring) — never fuzzy "up"/"song" hits.
  if (query && !wantsYoutube) {
    const libHit = findTrackNamed(query);
    if (libHit) return { kind: 'library', action: queue, query: libHit.title, track: libHit, source: 'library' };
    const listHit = findPlaylist(query);
    if (listHit) return { kind: 'playlist', action: queue, query: listHit.name, source: 'library' };
  }
  // Bare utterance that is exactly a library/playlist title (said the name, no "play").
  if (!hasIntent) {
    const bare = findTrackNamed(raw) || findPlaylist(raw);
    if (bare?.title) return { kind: 'library', action: 'play', query: bare.title, track: bare, source: 'library' };
    if (bare?.name) return { kind: 'playlist', action: 'play', query: bare.name, source: 'library' };
    return null;
  }
  // Default search → YouTube (explicit "on youtube" or plain "play <title>").
  if (query.length >= 2) return { kind: 'search', action: queue, query, source: 'youtube' };
  return null;
}

// Finds the best track for a spoken or typed title: exact, then contains, then most words in common.
export function findTrack(query, list = tracks()) {
  const q = String(query ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const norm = (t) => t.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = list.find((t) => norm(t) === q || t.file.toLowerCase() === q);
  if (exact) return exact;
  // Several titles contain it: one that starts with it wins, then the closest in length.
  const contains = list.filter((t) => norm(t).includes(q) || q.includes(norm(t)));
  if (contains.length) {
    const rank = (t) => (norm(t).startsWith(q) ? 0 : 1000) + Math.abs(norm(t).length - q.length);
    return contains.sort((a, b) => rank(a) - rank(b))[0];
  }
  const words = q.split(' ').filter((w) => w.length > 2);
  let best = null, score = 0;
  for (const t of list) {
    const s = words.filter((w) => norm(t).includes(w) || t.about.toLowerCase().includes(w)).length;
    if (s > score) [best, score] = [t, s];
  }
  return score >= Math.max(1, Math.ceil(words.length / 2)) ? best : null;
}

// ---- Playlists: { name: [file, ...] } ----

export const playlists = () => readJson(PLAYLISTS_FILE, {});

export function findPlaylist(name) {
  const all = playlists();
  const q = String(name ?? '').toLowerCase().trim();
  const key = Object.keys(all).find((k) => k.toLowerCase() === q) ?? Object.keys(all).find((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()));
  if (!key) return null;
  const have = new Set(tracks().map((t) => t.file));
  return { name: key, files: all[key].filter((f) => have.has(f)) }; // skip songs deleted since
}

export function savePlaylist(name, files) {
  const all = playlists();
  const key = Object.keys(all).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  all[key] = files;
  writeFileSync(PLAYLISTS_FILE, JSON.stringify(all, null, 2));
  return key;
}

export function deletePlaylist(name) {
  const found = findPlaylist(name);
  if (!found) return null;
  const all = playlists();
  delete all[found.name];
  writeFileSync(PLAYLISTS_FILE, JSON.stringify(all, null, 2));
  return found.name;
}
