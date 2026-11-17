import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ytDlpBaseArgs, ytBotWallHint } from './yt-dlp-args.js';

// The sound of a show in her theater (theater.js), reached with two programs already on this PC: yt-dlp (finds a
// video, says what it is, fetches its audio) and ffmpeg (decodes any stretch of that audio). The page in her browser
// plays the picture and the sound for the people watching; this is how the same sound reaches her, stretch by stretch,
// in step with the player. Every failure says what failed, why, and what fixes it.

const ytDlp = () => process.env.YT_DLP_PATH || 'yt-dlp';
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const RATE = 48000; // what her speech-to-text takes (voice/stt.js)
const ytArgs = (...rest) => [...ytDlpBaseArgs(), ...rest];

function run(exe, args, { timeoutMs = 60_000, binary = false, what = exe } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(exe, args, { windowsHide: true }); } catch (err) { return reject(new Error(`${what} couldn't start: ${err.message}`)); }
    const out = []; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`)); }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(e.code === 'ENOENT' ? `${what} isn't installed (or isn't on the PATH)` : `${what} failed: ${e.message}`), { missing: e.code === 'ENOENT' })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const data = Buffer.concat(out);
      if (code === 0) return resolve(binary ? data : data.toString('utf8'));
      const last = err.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) || `exit code ${code}`;
      reject(new Error(`${what} failed: ${last}${ytBotWallHint(last)}`));
    });
  });
}
const missingFix = (err, program) => (err.missing ? ` Fix: your owner installs ${program} (winget install ${program === 'yt-dlp' ? 'yt-dlp.yt-dlp' : 'Gyan.FFmpeg'}) and restarts you.` : '');

// The 11-character id in anything that points at one YouTube video: a watch, share, shorts, live or embed address, or
// the bare id. Anything else (words, another site) is null: the caller searches for it instead.
export function videoId(text) {
  const s = String(text ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let url;
  try { url = new URL(/^https?:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, kind, rest] = url.pathname.split('/');
    id = kind === 'watch' ? url.searchParams.get('v') : ['shorts', 'live', 'embed', 'v'].includes(kind) ? rest : null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// Where in the video an address starts (?t=90, ?t=1m30s, ?start=90), in seconds; 0 when it doesn't say.
export function startAt(text) {
  try {
    const url = new URL(/^https?:/i.test(String(text)) ? String(text) : `https://${text}`);
    const t = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '';
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m && t ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : 0;
  } catch { return 0; }
}

// yt-dlp prints each fact about a video on its own line, so a title can hold any character and still be read back
// (a separator character inside one line didn't survive the Windows console's encoding).
const FIELDS = ['id', 'title', 'duration', 'is_live', 'channel'];
const PRINT = FIELDS.flatMap((f) => ['--print', `%(${f})s`]);
const ENCODING = ['--encoding', 'utf-8'];
function parseVideos(out) {
  const lines = String(out).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const videos = [];
  for (let i = 0; i + FIELDS.length <= lines.length; i += FIELDS.length) {
    const [id, title, duration, live, channel] = lines.slice(i, i + FIELDS.length).map((l) => l.trim());
    if (!/^[\w-]{11}$/.test(id ?? '')) continue;
    videos.push({ id, title: title && title !== 'NA' ? title : 'an untitled video', duration: Number(duration) || 0, live: live === 'True', channel: channel && channel !== 'NA' ? channel : '' });
  }
  return videos;
}

// What one video is: its title, how long it runs, who posted it, whether it's a live stream.
export async function lookUp(id) {
  let out;
  try { out = await run(ytDlp(), ytArgs('--no-playlist', '--skip-download', ...ENCODING, ...PRINT, `https://www.youtube.com/watch?v=${id}`), { timeoutMs: 30_000, what: 'yt-dlp' }); }
  catch (err) { throw new Error(`YouTube wouldn't say what video ${id} is: ${err.message}.${missingFix(err, 'yt-dlp') || ' The video may be private, removed or blocked here; try another one.'}`); }
  const info = parseVideos(out)[0];
  if (!info) throw new Error(`YouTube's answer about video ${id} couldn't be read. Try again, or another video.`);
  return info;
}

// Videos that match some words, best first.
export async function search(query, count = 5) {
  const words = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!words) throw new Error('No words were given to search YouTube for. Say what to look for.');
  let out;
  try { out = await run(ytDlp(), ytArgs('--flat-playlist', ...ENCODING, ...PRINT, `ytsearch${count}:${words}`), { timeoutMs: 30_000, what: 'yt-dlp' }); }
  catch (err) { throw new Error(`The YouTube search for "${words}" failed: ${err.message}.${missingFix(err, 'yt-dlp') || ' Try again in a moment, or give the video\'s address instead.'}`); }
  return parseVideos(out);
}

// Only remove leftover media files — never wipe sibling folders (e.g. data/theater/captions).
function clearOtherMedia(dir, id) {
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${id}.`)) continue;
    const p = path.join(dir, f);
    try {
      if (statSync(p).isDirectory()) continue;
      rmSync(p, { force: true });
    } catch {}
  }
}
function clearIdMedia(dir, id) {
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${id}.`)) continue;
    rmSync(path.join(dir, f), { force: true, recursive: true });
  }
}
const ytReload = (msg) => /page needs to be reloaded|HTTP Error 403/i.test(String(msg || ''));

// The show's sound, fetched once to a file she can read any stretch of. Kept small: speech doesn't need more.
export async function fetchAudio(id, dir) {
  mkdirSync(dir, { recursive: true });
  clearOtherMedia(dir, id); // the last show's sound (keep captions/ and other folders)
  const have = readdirSync(dir).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.part') && (() => { try { return statSync(path.join(dir, f)).isFile() && statSync(path.join(dir, f)).size > 0; } catch { return false; } })());
  if (have) return path.join(dir, have);
  // --no-part writes straight to the final name, so a failed try can leave a half file the check above would trust.
  const dropHalf = () => clearIdMedia(dir, id);
  const args = ytArgs('--no-playlist', '--no-part', '--match-filter', '!is_live', '--http-chunk-size', '10M', '-f', 'bestaudio[abr<=80]/bestaudio/best', '-o', path.join(dir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath', `https://www.youtube.com/watch?v=${id}`);
  let out;
  for (let attempt = 1; ; attempt++) {
    try { out = await run(ytDlp(), args, { timeoutMs: 5 * 60_000, what: 'yt-dlp' }); break; }
    catch (err) {
      dropHalf();
      // YouTube now and then refuses one stream address (403) or demands a reload; a fresh run usually gets through.
      if (attempt < 3 && !err.missing && ytReload(err.message)) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(`the show's sound couldn't be fetched (${err.message}).${missingFix(err, 'yt-dlp') || ' Fix: your owner updates yt-dlp (yt-dlp -U); YouTube changes often and an old copy stops working.'}`);
    }
  }
  const file = out.trim().split('\n').at(-1);
  if (!file) throw new Error("the show's sound was fetched but the file wasn't reported. Fix: your owner updates yt-dlp (yt-dlp -U).");
  return file;
}

// One stretch of the show's sound: 48 kHz mono 16-bit PCM from `start` seconds, `seconds` long.
export async function decodeWindow(file, start, seconds) {
  try {
    return await run(ffmpeg(), ['-v', 'error', '-nostdin', '-ss', String(Math.max(0, start)), '-t', String(seconds), '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { timeoutMs: 30_000, binary: true, what: 'ffmpeg' });
  } catch (err) { throw new Error(`the show's sound at ${Math.round(start)}s couldn't be read (${err.message}).${missingFix(err, 'ffmpeg')}`); }
}

// Where to end a stretch so it doesn't cut a word in half: the quietest tenth of a second between `from` and `to`
// seconds into the PCM. Returns the cut in seconds (the middle of that quiet), or the PCM's own length when it's short.
export function quietCut(pcm, { from = 10, to = 20, rate = RATE } = {}) {
  const total = pcm.length / 2 / rate;
  if (total <= from) return total;
  const step = Math.floor(rate / 10);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  let best = Infinity, at = Math.min(to, total);
  for (let s = Math.floor(from * rate); s + step <= Math.min(samples.length, Math.floor(to * rate)); s += step) {
    let sum = 0;
    for (let i = s; i < s + step; i++) sum += samples[i] * samples[i];
    if (sum < best) { best = sum; at = (s + step / 2) / rate; }
  }
  return at;
}

// The show's picture, fetched once, small (360p or less, no sound: what's in the frame is all it's for), in its own
// folder so the sound's folder keeps only the sound. Owner, 2026-11-16: "capture a storyboard of images and send them
// through to be able to see exactly what's going on in the video, what the scenery is, what's going on".
export async function fetchVideo(id, dir) {
  mkdirSync(dir, { recursive: true });
  clearOtherMedia(dir, id); // the last show's picture (keep sprites/ and other folders)
  const have = readdirSync(dir).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.part') && (() => { try { return statSync(path.join(dir, f)).isFile() && statSync(path.join(dir, f)).size > 0; } catch { return false; } })());
  if (have) return path.join(dir, have);
  const dropHalf = () => clearIdMedia(dir, id);
  const args = ytArgs('--no-playlist', '--no-part', '--match-filter', '!is_live', '--http-chunk-size', '10M', '-f', 'bv*[height<=360]/wv*/w', '-o', path.join(dir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath', `https://www.youtube.com/watch?v=${id}`);
  let out;
  for (let attempt = 1; ; attempt++) {
    try { out = await run(ytDlp(), args, { timeoutMs: 10 * 60_000, what: 'yt-dlp' }); break; }
    catch (err) {
      dropHalf();
      if (attempt < 3 && !err.missing && ytReload(err.message)) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(`the show's picture couldn't be fetched (${err.message}).${missingFix(err, 'yt-dlp') || ' Fix: your owner updates yt-dlp (yt-dlp -U); YouTube changes often and an old copy stops working.'}`);
    }
  }
  const file = out.trim().split('\n').at(-1);
  if (!file) throw new Error("the show's picture was fetched but the file wasn't reported. Fix: your owner updates yt-dlp (yt-dlp -U).");
  return file;
}

// A storyboard: `frames` frames taken evenly across `seconds` of the picture from `start`, each 640x360, laid out in
// a grid `cols` wide, in order left to right and top to bottom, as one JPEG. Measured on this PC (2026-11-16): lfm3-vl
// reads a 3x3 one in under a second (about 235 image tokens a frame) and describes it in about another.
export async function storyboard(file, start, seconds, { frames = 9, cols = 3 } = {}) {
  const rows = Math.ceil(frames / cols);
  const vf = `fps=${frames}/${seconds},scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}`;
  try {
    return await run(ffmpeg(), ['-v', 'error', '-nostdin', '-ss', String(Math.max(0, start)), '-t', String(seconds), '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-'], { timeoutMs: 60_000, binary: true, what: 'ffmpeg' });
  } catch (err) { throw new Error(`the show's picture at ${Math.round(start)}s couldn't be read (${err.message}).${missingFix(err, 'ffmpeg')}`); }
}

export const pcmSlice = (pcm, seconds, rate = RATE) => pcm.subarray(0, Math.min(pcm.length, Math.floor(seconds * rate) * 2));
export function forget(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

// ---- captions (hearing when audio download is blocked) ----

function parseVtt(text) {
  const lines = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const m = block.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (!m) continue;
    const toSec = (h, mi, s, ms) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const body = block.split('\n').slice(1).join(' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) lines.push({ start, end, text: body });
  }
  return lines;
}

/** YouTube captions / auto-captions as timed lines — usually works without cookies. */
export async function fetchCaptions(id, dir) {
  mkdirSync(dir, { recursive: true });
  const prefix = path.join(dir, id);
  for (const f of readdirSync(dir)) if (f.startsWith(`${id}.`) && f.endsWith('.vtt')) rmSync(path.join(dir, f), { force: true });
  // Only en (not en.*) — broad lang globs pull many tracks and hit YouTube 429s.
  try {
    await run(ytDlp(), ytArgs('--no-playlist', '--skip-download', '--write-auto-sub', '--write-sub', '--sub-langs', 'en', '--convert-subs', 'vtt', '-o', `${prefix}.%(ext)s`, `https://www.youtube.com/watch?v=${id}`), { timeoutMs: 60_000, what: 'yt-dlp' });
  } catch (err) {
    // yt-dlp may exit non-zero after writing the main en track if a secondary lang 429s.
    const any = readdirSync(dir).some((f) => f.startsWith(`${id}.`) && f.endsWith('.vtt'));
    if (!any) throw new Error(`captions for ${id} couldn't be fetched (${err.message}).${missingFix(err, 'yt-dlp')}`);
  }
  const vtt = readdirSync(dir)
    .filter((f) => f.startsWith(`${id}.`) && f.endsWith('.vtt'))
    .sort((a, b) => a.length - b.length)[0];
  if (!vtt) throw new Error(`no English captions for ${id}. Fix: pick a video with captions, or get the audio working (cookies file).`);
  const lines = parseVtt(readFileSync(path.join(dir, vtt), 'utf8'));
  if (!lines.length) throw new Error(`captions for ${id} were empty.`);
  return { file: path.join(dir, vtt), lines, duration: lines.at(-1).end };
}

// ---- YouTube storyboard sprites (sight when full video download is blocked) ----

/** yt-dlp storyboard mhtml: HTML captions + raw binary image parts (not base64). */
function extractMhtmlStoryboard(mhtmlPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) rmSync(path.join(outDir, f), { force: true });
  const raw = readFileSync(mhtmlPath);
  const latin = raw.toString('latin1');
  const boundary = (latin.match(/boundary="([^"]+)"/i) || [])[1];
  if (!boundary) throw new Error('storyboard mhtml has no multipart boundary');
  const toSec = (h, mi, s, ms) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
  const slides = [];
  for (const m of latin.matchAll(/Slide #\d+:\s*(\d{2}):(\d{2}):(\d{2}),(\d+)\s*.{1,3}\s*(\d{2}):(\d{2}):(\d{2}),(\d+)/g)) {
    slides.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]) });
  }
  const marker = Buffer.from(`--${boundary}`, 'ascii');
  const parts = [];
  let from = 0;
  while (true) {
    const at = raw.indexOf(marker, from);
    if (at < 0) break;
    if (parts.length) parts[parts.length - 1].end = at;
    parts.push({ start: at + marker.length, end: raw.length });
    from = at + marker.length;
  }
  const files = [];
  let tCursor = 0;
  for (const part of parts) {
    const chunk = raw.subarray(part.start, part.end);
    const head = chunk.toString('latin1', 0, Math.min(chunk.length, 800));
    if (!/Content-type:\s*image\//i.test(head)) continue;
    const len = Number((head.match(/Content-length:\s*(\d+)/i) || [])[1] || 0);
    const dur = Number((head.match(/X\.yt-dlp\.Duration:\s*([\d.]+)/i) || [])[1] || 0);
    const sep = chunk.indexOf(Buffer.from('\r\n\r\n'));
    const sep2 = sep < 0 ? chunk.indexOf(Buffer.from('\n\n')) : sep;
    if (sep2 < 0) continue;
    const bodyStart = sep2 + (sep >= 0 ? 4 : 2);
    const type = (head.match(/Content-type:\s*(image\/[\w+.-]+)/i) || [])[1] || 'image/webp';
    const ext = /jpeg|jpg/i.test(type) ? 'jpg' : /png/i.test(type) ? 'png' : 'webp';
    const body = len > 0 ? chunk.subarray(bodyStart, bodyStart + len) : chunk.subarray(bodyStart);
    if (body.length < 64) continue;
    const i = files.length;
    const name = `${String(i).padStart(4, '0')}.${ext}`;
    writeFileSync(path.join(outDir, name), body);
    const timing = slides[i];
    const start = timing?.start ?? tCursor;
    const end = timing?.end ?? (tCursor + (dur || 1));
    tCursor = end;
    files.push({ file: name, start, end });
  }
  return files;
}

/** Download YouTube's own storyboard sprites (no login needed) into a folder of images. */
export async function fetchStoryboardSprites(id, dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true, recursive: true });
  const out = path.join(dir, `${id}.%(ext)s`);
  try {
    await run(ytDlp(), ytArgs('--no-playlist', '-f', 'sb0/sb1/sb2/sb3', '-o', out, `https://www.youtube.com/watch?v=${id}`), { timeoutMs: 120_000, what: 'yt-dlp' });
  } catch (err) {
    throw new Error(`storyboard for ${id} couldn't be fetched (${err.message}).${missingFix(err, 'yt-dlp')}`);
  }
  const mhtml = readdirSync(dir).find((f) => f.startsWith(`${id}.`) && /\.mhtml$/i.test(f));
  if (!mhtml) throw new Error(`storyboard for ${id} downloaded but no mhtml appeared.`);
  const imgDir = path.join(dir, 'frames');
  const files = extractMhtmlStoryboard(path.join(dir, mhtml), imgDir);
  if (!files.length) throw new Error(`storyboard for ${id} had no images inside.`);
  return { dir: imgDir, count: files.length, files, mhtml: path.join(dir, mhtml) };
}

/** JPEG for a stretch of the show from YouTube storyboard slides (each slide is already a frame grid). */
export async function storyboardFromSprites(sprites, start, seconds) {
  const end = start + seconds;
  const files = sprites.files?.length
    ? sprites.files
    : readdirSync(sprites.dir).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort().map((f, i) => ({ file: f, start: i, end: i + 1 }));
  if (!files.length) throw new Error('no storyboard frames on disk');
  // Prefer the slide that covers this stretch; else nearest by mid-time.
  const mid = start + seconds / 2;
  let best = files[0];
  let bestScore = Infinity;
  for (const f of files) {
    const overlap = Math.max(0, Math.min(end, f.end) - Math.max(start, f.start));
    const score = overlap > 0 ? -overlap : Math.abs((f.start + f.end) / 2 - mid);
    if (score < bestScore) { bestScore = score; best = f; }
  }
  const src = path.join(sprites.dir, best.file);
  try {
    return await run(ffmpeg(), ['-v', 'error', '-nostdin', '-i', src, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-'], { timeoutMs: 30_000, binary: true, what: 'ffmpeg' });
  } catch (err) {
    throw new Error(`storyboard slide couldn't be read (${err.message}).${missingFix(err, 'ffmpeg')}`);
  }
}
