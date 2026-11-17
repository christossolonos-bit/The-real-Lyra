import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import * as showAudio from './theater-audio.js';
import { createShowVoices, attribute, whoSaid } from './theater-voices.js';
import { readBoard } from './theater-sight.js';

// Her theater (owner, 2026-11-15: "I want her to be able to watch YouTube videos with us… a total new environment that
// she pulls up, kind of like a movie theater, her own little YouTube browser where we can watch shows. I want her to be
// able to listen and transcribe the show and bring up questions about it… at key points. She can even pause it and ask
// questions if she's confused about something.").
//
// - The room: a page on her own dashboard (public/theater.html), opened in a tab of her browser (browser.js), which
//   the owner streams into the call. It plays the video with YouTube's own player and tells her where the player is.
// - Her hearing: the show's sound is fetched once (theater-audio.js) and read from where the player is to the end, as
//   fast as it reads, a stretch at a time, with the speech-to-text she already has (voice/stt.js): the whole show is
//   read up front (owner, 2026-11-16: "she should be getting the transcript up front and should key in on certain
//   moments, not 3 minutes behind"; all of LYRA Ep 3, eight minutes, reads in about half a minute). Who says each line
//   is worked out a part of the show at a time, with all of that part in view (theater-voices.js). A stretch reaches
//   her when the player has played it, with where in the show it was. Paced by the player's own clock (the page's
//   reports), never a timer of hers: paused, nothing more is heard; skipped, she listens from where it lands.
// - Her reactions: each part of the show, once read, is read by her own model for the few moments in it she'd really
//   say something about, which line each comes right after, and whether she'd stop the show to ask. When the player
//   reaches that line, it moves energy into her `watching` want (pressure.js onShow); when the want fires she says it
//   in the call (voice/session.js), pausing the show first when the read said she would. Before this, each stretch was
//   only weighed after it had played: every reaction came 10 to 20 seconds late before she'd said a word, a thought
//   could still be said two minutes on, and a stretch judged alone was worth speaking about nearly every time.
// - The show is not the call: a line a microphone picked up from the show is told apart from a person speaking by her
//   model, against what the show itself says around then (isShowSound).
// Nothing here matches words. Every failure says what failed, why, and what fixes it.

const WINDOW_MIN = 10, WINDOW_MAX = 20; // a stretch ends at the quietest moment between these (seconds)
const JUMP_S = 45;     // the player this far past what she's read means someone skipped: she listens from there
const LATE_S = 30;     // a stretch that reaches her this long after it played was skipped past: heard, not felt as music
const FIRST_PART_S = 40, PART_S = 120; // show time read for who says what and her moments at once (the first part short, so it's ready soon)
const BOARD_FRAMES = 9, BOARD_S = 27; // what she sees: a 3x3 storyboard for every 27 s of the show, a frame every 3 s (theater-sight.js)
const EYE_WAIT_MS = 60_000; // how long a part waits for the picture to arrive before it's read by sound alone
const STORY_BACK = 8;       // storyboards of the story so far shown when the next ones are told
const STORY_KEEP = 3500;    // characters of the story on screen kept in her prompt (the newest part, when it's longer)
const MOMENT_EVERY_S = 50; // at most one spoken reaction for every this much of the show
const MOMENT_LATE_S = 20;  // a moment not said within this long of its line (show time) is let go: it's no longer what just happened
const REACT_RESUME_MS = (text) => Math.min(14_000, 1_600 + String(text || '').length * 55); // how long she holds the pause while she talks
const KEEP_HEARD = 600; // stretches kept (about two and a half hours)
const ENDED_MS = 30 * 60_000; // how long a finished show stays in her prompt
const PAGE_WAIT_MS = 12_000, CONFIRM_MS = 4_000, SETTLE_MS = 3_000;
const MUSIC_READS = 3; // reads of different stretches that must all say a show is music before it's heard as a song
const QUIET = 0.015;   // a stretch quieter than this has nothing in it to hear as music (frequency-sense.js uses the same line)

export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
// A place in the show as people say it: 90, "1:30", "1:02:03", "1m30s". null when it isn't one.
export function seconds(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  const m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
  return m && (m[1] || m[2] || m[3]) ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

async function openOsUrl(url) {
  const { spawn } = await import('node:child_process');
  const { findBrowser } = await import('./browser-path.js');
  const exe = findBrowser(); // Brave first on this PC
  if (exe) {
    spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { url, browser: exe };
  }
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return { url };
}

// The tab in her browser: the theater page if it's already open, a new tab otherwise (never another dashboard page
// navigated away, which browser.open would do for a page on the same site). Without browser.js, open the theater
// page in the OS default browser so play still works.
async function openInBrowser() {
  const url = `http://127.0.0.1:${config.dashboard.port}/theater.html`;
  try {
    const { browser } = await import('./browser.js');
    const b = browser();
    try { return await b.switchTo('theater.html'); }
    catch { return b.open(url, { newTab: true }); }
  } catch {
    return openOsUrl(url);
  }
}

// When the owner disables embedding, the iframe can't play it — open youtube.com itself.
async function openYoutubeWatch(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    const { browser } = await import('./browser.js');
    return await browser().open(url, { newTab: true });
  } catch {
    return openOsUrl(url);
  }
}

// Theater reads (moments, story, music check, names): use her live brain (NVIDIA / OpenRouter / Ollama),
// not the Ollama-only json() helper — that fails with "fetch failed" when Ollama isn't running.
async function askTheater(messages) {
  const llm = await import('./llm.js');
  const out = await llm.quickJson(messages);
  if (!out || typeof out !== 'object') {
    throw new Error(`her brain (${config.brain}) returned no JSON for theater. Fix: check ${config.brain === 'nvidia' ? 'NVIDIA_API_KEY' : config.brain === 'openrouter' ? 'OPENROUTER_API_KEY' : 'Ollama'} and the internet.`);
  }
  return out;
}

// Who says each line — same brain as her other theater reads (names model override is optional later).
async function askForNames(messages) {
  return askTheater(messages);
}

export function createTheater({
  audio = showAudio,
  // A stretch's lines, each with where it starts and ends in the stretch: [{ start, end, text }]. transcribe (a stretch
  // as one piece of text, no timing) is still taken in its place; with it, there are no lines to tell voices apart in.
  transcribeLines = null,
  transcribe = null,
  // Who is talking (theater-voices.js): the voices of the show's lines, and her model's read of who says each one.
  voices = null,
  attributeLines = attribute,
  askNames = askForNames,
  ask = askTheater,
  openPage = openInBrowser,
  push = (read) => import('./pressure.js').then((p) => p.onShow(read)),
  interests = async () => (await import('./interests.js')).interests.top(3).map((t) => t.name),
  log = activity,
  now = Date.now,
  dir = path.join(DATA_DIR, 'theater'),
  // Her eyes (theater-sight.js): the show's picture is fetched once (audio.fetchVideo) into its own folder, and every
  // stretch of it is read as a storyboard (audio.storyboard) by see. null turns them off.
  videoDir = path.join(DATA_DIR, 'theater-video'),
  see = config.theaterSight?.model && config.theaterSight.model !== 'off' ? readBoard : null,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  watchedFile = path.join(DATA_DIR, 'theater-watched.json'), // what she heard of the last show; null keeps it in memory only
  // A song played in her theater (owner, 2026-11-15: "listen to other songs that I play and try to remember how they
  // sound and how they made her feel"). measure: a stretch of the show's sound as numbers (audio-sense.js), or null
  // when there's nothing in it to hear. song: a measured stretch of a show that is music reaches her feelings and her
  // memory of songs (sound-sense.js show, song-memory.js). songEnded: the music stopped, so she looks back on it.
  measure = async (pcm) => {
    const { analyze, effect, describe } = await import('./audio-sense.js');
    const profile = analyze(pcm, 48000);
    return profile && profile.loudness >= QUIET ? { profile, words: describe(profile, effect(profile)) } : null;
  },
  song = async (stretch) => (await import('./sound-sense.js')).soundSense.show(stretch.profile, stretch),
  songEnded = async (conversation) => (await import('./sound-sense.js')).soundSense.musicEnded(conversation),
} = {}) {
  const hearLines = transcribeLines ?? (transcribe
    ? async (pcm) => { const text = String(await transcribe(pcm) ?? ''); return text.trim() ? [{ start: 0, end: pcm.length / 2 / 48000, text }] : []; }
    : async (pcm) => (await import('./voice/stt.js')).transcribeShowLines(pcm));
  const ears = voices ?? (transcribe && !transcribeLines ? null : createShowVoices({ log }));
  const castNow = () => ears?.cast() ?? {};
  // What the show said, line by line with who said it: "[2:02] Lyra: Hello, James." A stretch heard before lines were
  // kept (or with no timing) is its text alone.
  const script = (stretches, cast) => stretches.map((h) => (h.lines?.length
    ? h.lines.map((l) => { const who = whoSaid(l, cast); return `[${clock(l.at)}] ${who ? `${who}: ` : ''}${l.text}`; }).join('\n')
    : `[${clock(h.start)}] ${h.text}`)).join('\n');
  const WHO_NOTE = 'Each line says who said it: a name is your best read from the dialogue and how the voices sound; "voice C" is a voice you can tell apart but can\'t name yet; a line with no name was too short to tell. This can be wrong, so if who said something matters and you\'re not sure, say so.';
  let show = null, seq = 0;
  // What she heard of the show she last watched, kept after it stops, ends or is replaced, and across her restarts.
  // (2026-11-15, live: she heard two minutes about sharks, the video was stopped, and asked "did you learn anything
  // about sharks?" she said the video never rolled, because stopping a show threw away everything she'd heard.)
  let last = null;
  try { if (watchedFile) last = JSON.parse(readFileSync(watchedFile, 'utf8')); } catch {}
  let keepFailed = false;
  function keepWatched(was, how) {
    if (!was) return;
    if (!was.heard.length && !was.said.length && last && last.id !== was.id) return; // nothing heard of it: the one before stays
    const upTo = was.state === 'playing' ? position() : was.position;
    last = { id: was.id, title: was.title, channel: was.channel, duration: was.duration, at: now(), upTo, how, seen: (was.sights ?? []).filter((s) => s.end <= upTo + 0.5),
      heard: was.heard, said: was.said, cast: castNow(), deaf: was.ear.status === 'ready' ? '' : was.ear.why || 'its sound was still being fetched' };
    if (!watchedFile) return;
    try { writeFileSync(watchedFile, JSON.stringify(last)); keepFailed = false; }
    catch (err) { if (!keepFailed) log('error', { where: 'theater', message: `What she heard of "${was.title}" couldn't be saved to ${watchedFile}: ${err.message}. She still has it until she restarts; after a restart she won't remember what this show said. Fix: check that the data folder can be written to.` }); keepFailed = true; }
  }
  let hearingNow = false;
  let reading = Promise.resolve(); // her reads of the show, one at a time, in the order it played
  let stopped = null; // { id, at }: the show she just stopped, so a report already on its way doesn't bring it back
  const viewers = new Set(); // open theater pages (each one's event stream)
  const send = (event) => { for (const v of viewers) { try { v(event); } catch {} } };
  const fail = (where, message) => log('error', { where, message });

  // Where the player is right now: its last report, carried forward a few seconds at most while it plays, so a page
  // that stopped reporting (closed, crashed) doesn't keep the show running in her head.
  const position = () => {
    if (!show) return 0;
    const on = show.state === 'playing' ? Math.min((now() - show.at) / 1000, 5) : 0;
    return Math.max(0, Math.min(show.duration || Infinity, show.position + on));
  };
  const known = () => (show ? show.read.filter((w) => w.text) : []);
  // What the page shows: the show, where it is, and the latest thing she heard.
  const view = () => (!show ? null : { id: show.id, title: show.title, channel: show.channel, state: show.state, position: +position().toFixed(1), duration: show.duration,
    pausedBy: show.pausedBy, question: show.question?.words ?? null, hearing: show.ear.status, hearingWhy: show.ear.why,
    caption: show.heard.at(-1) ? { at: clock(show.heard.at(-1).start), text: show.heard.at(-1).text } : null });
  const tell = () => send({ cmd: 'show', show: view() }); // the page's own picture of the show, kept current
  // The page reports about once a second while a show is on. Nothing from it for this long: it's closed or stuck.
  const GONE_MS = 15_000;
  const gone = () => Boolean(show) && show.state === 'playing' && show.seen > 0 && now() - show.seen > GONE_MS;

  // When the show is on youtube.com in Brave (embed blocked), nothing reports from theater.html —
  // keep her clock and senses moving on a wall-clock pulse.
  const sitePulse = () => {
    if (!show?.site || show.state !== 'playing') return;
    show.seen = now();
    release();
    hearOn();
  };
  const siteTimer = setInterval(sitePulse, 1000);
  if (typeof siteTimer.unref === 'function') siteTimer.unref();

  // file: the show's sound, already fetched (play fetches it before the player starts, so she hears it from its first
  // second). deaf: why it couldn't be fetched. Neither: it's fetched now, while the show plays (a show she picks up
  // after a restart), and she catches up from where she picked it up.
  // read: every stretch of the show read so far, in show order (ahead of the player and behind it). releasedTo: the show
  // time up to which what was read has reached her. partFrom: where the part of the show not yet read for who says what
  // and for her moments starts. moments: what she'll say and right after which line, planned a part at a time.
  function begin({ id, title, channel = '', duration = 0, live = false, start = 0, by = null, conversation = null, state = 'opening', file = null, deaf = '' }) {
    reading = Promise.resolve();
    if (show) { keepWatched(show, 'another video was put on'); songOver(show); ears?.keep(); }
    const status = live ? 'off' : file ? 'ready' : deaf ? 'failed' : 'fetching';
    // The same show again keeps what she'd heard of it, but its voices are learned again from what she hears next.
    const cast = ears?.start({ channel, title });
    if (cast?.kept) log('theater', { voices: cast.kept, from: 'earlier episodes on this channel', show: title });
    // The same show again (she restarted while it played, or it was put back on): what she'd already heard of it stays.
    const before = last?.id === id ? last : null;
    show = { seq: ++seq, id, title, channel, duration, live, state, position: start, at: now(), by, conversation, openedAt: now(),
      seen: 0, error: null, expect: null, pausedBy: null, question: null, reacting: false, reactionHold: false, endedAt: 0,
      ear: { status, why: live ? "it's a live stream, and only a finished video's sound can be read" : deaf, file, from: start, upTo: start, failures: 0 },
      eye: { status: live || !see ? 'off' : 'fetching', why: live ? "it's a live stream" : !see ? 'her eyes are off (THEATER_SIGHT_MODEL)' : '', file: null, ready: null, failed: false },
      sights: before?.seen ? before.seen.filter((s) => s.start < start) : [],
      heard: before ? before.heard.filter((h) => h.start < start) : [], read: [], releasedTo: start, partFrom: start, planning: Promise.resolve(),
      moments: [], thoughts: [], said: before ? [...before.said] : [] };
    if (status === 'fetching') startEar(show);
    if (show.eye.status === 'fetching') startEye(show);
    if (status === 'ready') { log('theater', { hearing: title, from: clock(start) }); hearOn(); } // the first stretches are read before the player starts
    return show;
  }

  // ---- her hearing ----

  function startEar(mine) {
    Promise.resolve().then(async () => {
      try {
        const file = await audio.fetchAudio(mine.id, dir);
        if (show !== mine) return;
        mine.ear.file = file; mine.ear.mode = 'audio'; mine.ear.status = 'ready';
        log('theater', { hearing: mine.title, from: clock(mine.ear.from), how: 'audio' });
      } catch (audioErr) {
        // Bot wall / no cookies: YouTube captions still let her follow what's said.
        try {
          const caps = await audio.fetchCaptions(mine.id, path.join(dir, 'captions'));
          if (show !== mine) return;
          mine.ear.mode = 'captions'; mine.ear.captions = caps.lines; mine.ear.file = caps.file;
          if (!mine.duration && caps.duration) mine.duration = caps.duration;
          mine.ear.status = 'ready';
          log('theater', { hearing: mine.title, from: clock(mine.ear.from), how: 'captions', lines: caps.lines.length });
        } catch (capErr) {
          if (show !== mine) return;
          mine.ear.status = 'failed';
          mine.ear.why = `${audioErr.message} Captions also failed: ${capErr.message}`;
          tell();
          fail('theater hearing', `She can't hear "${mine.title}": ${mine.ear.why} The show still plays for everyone; she just doesn't know what's said in it.`);
          return;
        }
      }
      tell();
      hearOn();
    });
  }

  // ---- her eyes ----

  // The show's picture, fetched beside its sound. Parts of the show read before it arrives wait for it a while
  // (EYE_WAIT_MS), then go by sound alone. If it can't be fetched she still hears everything, and the log says why.
  function startEye(mine) {
    const eye = mine.eye;
    eye.ready = Promise.resolve().then(async () => {
      try {
        eye.file = await audio.fetchVideo(mine.id, videoDir);
        eye.mode = 'video';
        eye.status = 'ready';
        log('theater', { seeing: mine.title, how: 'video' });
        return true;
      } catch (videoErr) {
        // Full video blocked: YouTube's own storyboard sprites still show what happens on screen.
        try {
          eye.sprites = await audio.fetchStoryboardSprites(mine.id, path.join(videoDir, 'sprites'));
          eye.mode = 'sprites';
          eye.status = 'ready';
          log('theater', { seeing: mine.title, how: 'storyboard', frames: eye.sprites.count });
          return true;
        } catch (sbErr) {
          eye.status = 'failed';
          eye.why = `${videoErr.message} Storyboard also failed: ${sbErr.message}`;
          fail('theater sight', `She can't see "${mine.title}": ${eye.why} She still hears all of it; she just doesn't know what's on screen.`);
          return false;
        }
      }
    });
  }

  // What the picture shows over a part of the show: one storyboard for every BOARD_S seconds, read with what's said
  // over those seconds, so she can tell who is who. Kept with where in the show it was. A storyboard that can't be read
  // is skipped (the first failure in a show is logged, with the fix); her hearing never waits on her eyes for long.
  async function sightsFor(mine, from, to) {
    const eye = mine.eye;
    if (eye.status === 'off' || eye.status === 'failed' || !eye.ready) return [];
    if (eye.status === 'fetching' && !(await Promise.race([eye.ready, wait(EYE_WAIT_MS).then(() => false)]))) {
      if (eye.status === 'fetching') log('theater', { sawNothing: `${clock(from)}-${clock(to)}`, why: `its picture hadn't arrived after ${EYE_WAIT_MS / 1000}s`, show: mine.title });
      return [];
    }
    if (eye.status !== 'ready') return [];
    const seen = [];
    for (let s = from; s < to - 1 && show === mine; s += BOARD_S) {
      const len = Math.min(BOARD_S, to - s);
      try {
        const jpeg = eye.mode === 'sprites'
          ? await audio.storyboardFromSprites(eye.sprites, s, len)
          : await audio.storyboard(eye.file, s, len, { frames: BOARD_FRAMES, cols: 3 });
        const text = await see({ jpeg, frames: BOARD_FRAMES, from: s, to: s + len });
        const sight = { start: s, end: s + len, text };
        mine.sights.push(sight); seen.push(sight);
        log('theater', { saw: clock(s), text: text.slice(0, 300), show: mine.title });
      } catch (err) {
        if (!eye.failed) fail('theater sight', `She couldn't see "${mine.title}" around ${clock(s)}: ${err.message} She still hears it.`);
        eye.failed = true;
      }
    }
    return seen;
  }
  // What the picture showed, for a prompt: "[1:00-1:27] …" lines.
  const sightLines = (sights) => sights.map((s) => `[${clock(s.start)}-${clock(s.end)}] ${s.story || s.text}`).join('\n');
  // The story on screen so far, whole, newest kept when it's long: "an ongoing kind of thread that you can follow
  // throughout the whole movie" (owner, 2026-11-16).
  const storySoFar = (sights) => { const all = sightLines(sights); return all.length > STORY_KEEP ? `…${all.slice(-STORY_KEEP)}` : all; };

  // The story of what happens on screen, one thread through the whole show (owner, 2026-11-16: "description about
  // what's going on. And an ongoing kind of thread that you can follow throughout the whole movie"). The vision model
  // sees each storyboard alone and knows no names; the model that works out who says what (THEATER_NAMES_MODEL), which
  // has the dialogue, who is who and the story so far, writes each new storyboard as what happened next, with the people
  // named when it can tell who they are. One call for a part's storyboards. If it fails, the vision model's own
  // descriptions stand (her eyes still work, the people just aren't named) and the log says why.
  async function story(mine, seen) {
    if (!seen.length) return;
    const before = mine.sights.filter((s) => !seen.includes(s) && s.end <= seen[0].start + 0.5).slice(-STORY_BACK);
    const said = script(mine.read.filter((h) => h.end > seen[0].start && h.start < seen.at(-1).end), castNow());
    const voices = ears?.describe?.() ?? '';
    let out;
    try {
      out = await askNames([
        { role: 'system', content: 'You keep the story of what happens on screen in a show, as one continuing thread, for someone who watches it with you. '
          + 'A vision model looked at each new stretch of the picture and described it; it saw only the picture and knows no names, so it describes people by how they look ("a man with curly hair and glasses", "a glowing blue woman"). '
          + 'For each new stretch, write what happens on screen as the next part of the story: the same events, in order, with the people named: someone on screen who is speaking, is spoken to by name, or is already named in the story so far is that person (the glowing woman the others call Lyra is Lyra); keep how they look only when nothing tells you who they are. Never mention frames, panels or a grid: tell it as the show. '
          + 'Keep everything visual it describes, above all anything striking (someone vanishing, dissolving, glowing, reaching out, a sudden change of place) and what faces and bodies show; and any writing on screen, like titles and credits. '
          + 'Add nothing it doesn\'t describe, and don\'t retell the dialogue: this is what is seen. One to four sentences each. '
          + 'Reply with JSON only: {"story": [{"n": 1, "text": ""}]}, one entry for each new stretch.' },
        { role: 'user', content: `The show: "${mine.title}".`
          + `${voices ? `\nThe voices so far, and who they are taken to be:\n${voices}` : ''}`
          + `${before.length ? `\nThe story on screen so far:\n${sightLines(before)}` : ''}`
          + `${said ? `\nWhat is said over the new stretches:\n${said}` : ''}`
          + `\nThe new stretches, as the vision model saw them:\n${seen.map((s, i) => `${i + 1}. [${clock(s.start)}-${clock(s.end)}] ${s.text}`).join('\n')}` },
      ]);
    } catch (err) {
      if (!mine.storyFailed) fail('theater sight', `The story of what's on screen in "${mine.title}" around ${clock(seen[0].start)} couldn't be told: ${err.message}. She still sees it, as her eyes described it, with nobody named. Fix: the model that names them (THEATER_NAMES_MODEL, ${config.theaterNames?.model || 'local'}) has to be reachable.`);
      mine.storyFailed = true;
      return;
    }
    for (const e of Array.isArray(out?.story) ? out.story : []) {
      const s = seen[Number(e?.n) - 1], text = String(e?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
      if (s && text) { s.story = text; log('theater', { story: clock(s.start), text: text.slice(0, 300), show: mine.title }); }
    }
  }

  // The stretch she has read that holds this place in the show, if any.
  const readAt = (mine, t) => mine.read.find((w) => w.start <= t + 0.5 && w.end > t);
  // Is the player somewhere she has read, or about to read? Otherwise someone skipped there, and she reads from there.
  const covered = (mine, t) => Boolean(readAt(mine, t)) || (t >= mine.ear.from - 2 && t <= mine.ear.upTo + JUMP_S);
  const allRead = (mine) => mine.ear.done || (mine.duration > 0 && mine.ear.upTo >= mine.duration - 0.5);

  // Reads the show's sound a stretch at a time, from where the player is to the end, without waiting for the player:
  // the whole show is read ahead of it. Every part of it, once read, is read again for who says what and her moments.
  async function hearOn() {
    const mine = show;
    if (!mine || mine.ear.status !== 'ready' || hearingNow) return;
    const ear = mine.ear, pos = position();
    if (!covered(mine, pos)) { // skipped somewhere she hasn't read: she reads from here
      ear.from = ear.upTo = Math.max(0, Math.floor(pos));
      ear.done = false;
      mine.partFrom = ear.from;
    }
    // What's already read from here on (she went back, then on again) isn't read twice.
    for (let w = readAt(mine, ear.upTo); w && w.end > ear.upTo; w = readAt(mine, ear.upTo)) ear.upTo = w.end;
    if (allRead(mine)) { planUpTo(mine, true); return; }
    hearingNow = true;
    let more = false;
    try {
      const start = ear.upTo;
      if (ear.mode === 'captions') {
        const until = start + WINDOW_MAX;
        const lines = (ear.captions || [])
          .filter((l) => l.end > start && l.start < until)
          .map((l) => ({ at: l.start, end: l.end, text: l.text }));
        if (!lines.length) {
          const next = (ear.captions || []).find((l) => l.start >= start);
          if (!next) { ear.done = true; return; }
          ear.upTo = next.start;
          more = true;
        } else {
          const end = Math.max(start + WINDOW_MIN, ...lines.map((l) => l.end));
          const text = lines.map((l) => l.text).join(' ');
          const w = { start, end, text, lines };
          const after = mine.read.findIndex((x) => x.start > start);
          if (after < 0) mine.read.push(w); else mine.read.splice(after, 0, w);
          ear.upTo = end;
          ear.failures = 0;
          more = true;
        }
      } else {
      const pcm = await audio.decodeWindow(ear.file, start, WINDOW_MAX);
      if (show !== mine) return;
      const length = pcm.length / 2 / 48000;
      if (length < 0.2) { ear.done = true; return; } // nothing left to read
      const cut = audio.quietCut(pcm, { from: WINDOW_MIN, to: WINDOW_MAX });
      const piece = audio.pcmSlice(pcm, cut);
      const lines = (await hearLines(piece)).map((l) => ({ at: start + l.start, end: start + l.end, text: String(l.text ?? '').replace(/\s+/g, ' ').trim(), from: l.start, to: l.end })).filter((l) => l.text);
      if (show !== mine) return;
      if (ears && lines.length) await voicesOf(mine, piece, lines);
      for (const l of lines) { delete l.from; delete l.to; }
      const text = lines.map((l) => l.text).join(' ');
      // The same stretch as sound, for when the show is a song: measured here, felt when the player reaches it.
      let sound = null;
      try { sound = await measure(audio.pcmSlice(pcm, cut)); }
      catch (err) { if (!mine.measureFailed) fail('theater hearing', `The sound of "${mine.title}" couldn't be measured (${err.message}), so if it's a song she hears its words but doesn't feel or remember how it sounds. Check audio-sense.js.`); mine.measureFailed = true; }
      if (show !== mine) return;
      const w = { start, end: start + cut, text, lines, ...(sound && { sound }) };
      const after = mine.read.findIndex((x) => x.start > start);
      if (after < 0) mine.read.push(w); else mine.read.splice(after, 0, w);
      ear.upTo = start + cut;
      ear.failures = 0;
      more = true;
      }
    } catch (err) {
      if (show !== mine) return;
      // One stretch that can't be read is skipped (she missed a few seconds); three in a row and her hearing is off.
      ear.failures++;
      ear.upTo += WINDOW_MIN + 5;
      if (ear.failures >= 3) {
        ear.status = 'failed'; ear.why = err.message;
        tell();
        fail('theater hearing', `She stopped hearing "${mine.title}" at ${clock(pos)}: three stretches in a row couldn't be read. Last reason: ${err.message}. The show still plays; putting it on again (theater play) starts her hearing over.`);
      } else fail('theater hearing', `She missed about ${WINDOW_MIN + 5} seconds of "${mine.title}" around ${clock(pos)}: ${err.message}. She keeps listening from the next stretch.`);
      more = ear.status === 'ready';
    } finally { hearingNow = false; }
    if (show === mine) planUpTo(mine, !more || allRead(mine));
    release();
    if (more) hearOn();
  }

  // Each line's voice, by sound, as it's read. A failure leaves the lines without voices; she still hears every word,
  // and her model still works out who said them from the dialogue.
  async function voicesOf(mine, piece, lines) {
    try { await ears.hear(piece, lines); }
    catch (err) { fail('theater voices', `The voices in "${mine.title}" around ${clock(lines[0].at)} couldn't be told apart: ${err.message}. She hears the words; her model still works out who said them from the dialogue.`); }
  }

  // A part of the show is read through (or all of it is): who says what in it, then her moments in it, one part after
  // another. The first part is short, so the opening has her moments before it plays.
  function planUpTo(mine, all) {
    const from = mine.partFrom, to = mine.ear.upTo;
    const size = mine.read.some((w) => w.end <= from + 0.5) ? PART_S : FIRST_PART_S;
    if (to <= from || (!all && to - from < size)) return;
    mine.partFrom = to;
    const part = mine.read.filter((w) => w.start >= from - 0.5 && w.start < to);
    if (!part.length) return;
    mine.planning = mine.planning.then(async () => {
      if (show !== mine) return;
      const seen = await sightsFor(mine, from, to);
      if (show !== mine) return;
      const lines = part.flatMap((w) => w.lines ?? []);
      if (ears && lines.length) await whose(mine, lines, seen);
      if (show !== mine) return;
      await story(mine, seen);
      if (show !== mine) return;
      await plan(mine, part, from, to, seen);
      if (show === mine) release(); // a moment whose line has already played goes out now, or is let go
    });
  }

  // Who says each line of a part, read with all of that part and what came before it in view.
  async function whose(mine, lines, seen = []) {
    try {
      const before = mine.read.flatMap((h) => h.lines ?? []).filter((l) => l.at < lines[0].at);
      await attributeLines({ ask: askNames, title: mine.title, voices: ears, before, lines, clock, seen: sightLines(seen) });
    } catch (err) {
      if (!mine.namesFailed) fail('theater voices', `She couldn't work out who says what in "${mine.title}" around ${clock(lines[0].at)}: ${err.message}. She hears the words, with voices told apart by sound but not named. Fix: the model that names them (THEATER_NAMES_MODEL, ${config.theaterNames?.model || 'local'}) has to be reachable: check OpenRouter and the internet, or set it to local.`);
      mine.namesFailed = true;
    }
  }

  // What the player has played by now reaches her: into what she's heard, onto the page as a caption; and a moment
  // she planned to speak up about, when its line has just played, reaches her pressure.
  function release() {
    if (!show) return;
    const pos = position();
    for (const r of show.read) {
      if (r.start < show.releasedTo - 0.5) continue;
      if (r.end > pos + 0.5) break;
      show.releasedTo = r.end;
      const { sound, ...w } = r;
      // A stretch with sound in it, played just now: if the show is a song, it reaches her as music (words or none).
      if (sound && pos - w.end < LATE_S) asSong(show, w, sound);
      if (!w.text) continue;
      show.heard.push(w);
      if (show.heard.length > KEEP_HEARD) show.heard.splice(0, show.heard.length - KEEP_HEARD);
      send({ cmd: 'caption', at: clock(w.start), text: w.text });
      log('theater', { heard: w.text.slice(0, 300), at: clock(w.start), show: show.title });
      keepWatched(show, 'it is still on'); // kept as she hears it, so a restart mid-show loses nothing
    }
    for (const m of show.moments) {
      if (m.out || m.at > pos + 0.5) continue;
      m.out = true;
      // Its line played too long ago (it was skipped past, or her read of that part came too late): it's let go.
      if (pos - m.at > MOMENT_LATE_S) { log('theater', { letGo: clock(m.at), thought: m.thought, why: `its line played ${Math.round(pos - m.at)}s ago`, show: show.title }); continue; }
      const mine = show;
      mine.thoughts.push({ at: m.at, pull: m.pull, pause: false, kind: m.kind, thought: m.thought, moment: m.line, said: false });
      if (mine.thoughts.length > 40) mine.thoughts.splice(0, mine.thoughts.length - 40);
      Promise.resolve(push({ pull: m.pull, pause: false, title: mine.title, at: clock(m.at), thought: m.thought }))
        .catch((err) => fail('theater watch', `Her reaction to "${mine.title}" couldn't reach her pressure: ${err.message}. The thought is kept; it just won't make her speak. Check pressure.js onShow.`));
    }
  }

  // The player jumped. Forward: what lay between was never played, so it isn't heard and nothing in it is reacted to.
  // Back: what comes after is heard again as it plays (what she already said about it isn't said again).
  function jumped(to) {
    const at = readAt(show, to);
    const from = at ? at.start : to;
    if (to < show.position) show.heard = show.heard.filter((h) => h.start < from);
    else for (const m of show.moments) if (m.at < from) m.out = true;
    show.releasedTo = from;
  }

  // ---- a song in her theater ----

  // Is this show a piece of music? Her own model's read, once per show, from what the video is and how its first
  // stretch sounds. null when the read failed (she reads it again on the next stretch).
  async function readMusic(mine, w, sound) {
    let read;
    try {
      read = await ask([
        { role: 'system', content: 'You are watching a video with people in a voice call. Decide whether this video is a piece of music, there to be listened to as a song (a music video, a lyric video, a live performance, an album track, an instrumental, a concert), or something else that may only have music in it (a documentary, the news, a talk, a tutorial, a vlog, a podcast, a film scene, someone playing a game). '
          + 'You have its title, who posted it, how its sound measured, and what your hearing made of the words in it; sung words are often heard wrongly, so weigh the title and the sound as well. '
          + 'The title counts most: a documentary, a film, an episode, a talk, an interview, a podcast, a trailer, a tutorial or a vlog is not music, however it opens (many open over a soundtrack). Say music only when the video itself is a song or a piece of music. '
          + 'Reply with JSON only: {"music": true or false, "why": "a few words"}' },
        { role: 'user', content: `The video: "${mine.title}"${mine.channel ? `, posted by ${mine.channel}` : ''}${mine.duration ? `, ${clock(mine.duration)} long` : ''}.\nHow it sounds from ${clock(w.start)}: ${sound.words}\nWords heard there: ${w.text || '(none)'}` },
      ]);
    } catch (err) {
      fail('theater hearing', `She couldn't tell whether "${mine.title}" is a song (${err.message}), so the stretch at ${clock(w.start)} wasn't felt or remembered as music; she judges again on the next stretch. Fix: her local model (Ollama) has to be running.`);
      return null;
    }
    const yes = read?.music === true;
    log('theater', { music: yes, why: String(read?.why ?? '').slice(0, 160), show: mine.title });
    return yes;
  }

  // One played stretch of a show that is music: it lands on her feelings as music and goes into her memory of the song.
  // Whether the show is music takes MUSIC_READS reads of different stretches all saying so; one "no" settles it as not
  // music. Owner, 2026-11-16: "AM I? | A Documentary About AI Consciousness" was called a song on one read of its
  // opening soundtrack, went into her memory of songs, and she made a vibraphone piece named after it, then said she
  // played "AM I?". Stretches that play while it's being decided wait, and reach her as music once it is.
  function asSong(mine, w, sound) {
    const m = (mine.musicCheck ??= { yes: 0, reading: 0, verdict: undefined, held: [] });
    const take = (s) => {
      mine.sang = true;
      Promise.resolve().then(() => song({ profile: s.sound.profile, conversation: mine.conversation ?? 'theater', title: mine.title, from: mine.by ?? null, words: s.w.text, at: s.w.start, seconds: mine.duration || null }))
        .catch((err) => fail('theater hearing', `A stretch of "${mine.title}" at ${clock(s.w.start)} couldn't reach her as music: ${err.message}. The show plays on and she still hears its words. Check sound-sense.js show.`));
    };
    if (m.verdict === false) return;
    if (m.verdict === true) { take({ w, sound }); return; }
    m.held.push({ w, sound });
    // A short video has fewer stretches to read: as many as it has, up to MUSIC_READS.
    const need = mine.duration && mine.duration < MUSIC_READS * WINDOW_MAX ? Math.max(1, Math.ceil(mine.duration / WINDOW_MAX)) : MUSIC_READS;
    if (m.yes + m.reading >= need) return;
    m.reading++;
    readMusic(mine, w, sound).then((yes) => {
      m.reading--;
      if (m.verdict !== undefined || show !== mine) return;
      if (yes === false) { m.verdict = false; m.held = []; return; }
      if (yes === true && ++m.yes >= need) { m.verdict = true; const held = m.held; m.held = []; for (const s of held) take(s); }
      // null: the read failed; the next stretch is read in its place.
    });
  }
  // The show stopped, ended or was replaced: if it was a song, she looks back on what she heard of it.
  function songOver(was) {
    if (!was?.sang || was.songOver) return;
    was.songOver = true;
    Promise.resolve().then(() => songEnded(was.conversation ?? 'theater')).catch((err) => fail('theater hearing', `"${was.title}" ended but she couldn't look back on it as a song: ${err.message}. What she heard of it is still kept. Check sound-sense.js musicEnded.`));
  }

  // ---- her read of what she hears ----

  // One part of the show, read as herself before it plays: the few moments in it she'd really say something about, and
  // right after which line. Each part gets a few at most (one for every MOMENT_EVERY_S of it), picked against each other
  // and ordered by how much she wants to say them, so the pull comes from that order, not a score given to one stretch
  // alone. The line each moment follows is cited by its number and has to be one of the part's lines.
  async function plan(mine, part, from, to, seen = []) {
    const cast = castNow();
    const lines = part.flatMap((w) => (w.lines?.length ? w.lines : [{ at: w.start, end: w.end, text: w.text }])).filter((l) => l.text);
    if (!lines.length) return;
    const most = Math.max(1, Math.round((to - from) / MOMENT_EVERY_S));
    let into = [];
    try { into = await interests(); } catch {}
    const before = script(mine.read.filter((h) => h.end <= from + 0.5 && h.start >= from - 90), cast);
    const planned = mine.moments.slice(-6).map((m) => `[${clock(m.at)}] ${m.thought}`).join('\n');
    const said = (l) => { const who = whoSaid(l, cast); return who ? `${who}: ${l.text}` : l.text; };
    let read;
    try {
      read = await ask([
        { role: 'system', content: `You are watching a show with people. The show keeps playing — you talk over it, you do not pause it. Below is the next part, every line numbered, plus what the picture shows (storyboard stills your eyes already read). `
          + `Pick moments where you'd really say something out loud from the dialogue AND/OR the stills: surprise, disagreement, a joke, a feeling, a hot take, or a real question. Prefer reactions that use what you can see on screen when the stills are interesting. Do not narrate or summarize the plot. Watching quietly is fine — at most ${most}; fewer or none is OK. Strongest first. `
          + `For each: "line" is the line number it comes right after; "thought" is 1–2 short spoken sentences in your own words (only from that line, earlier dialogue, and the stills — never what comes after); "kind" is "comment" or "question"; always set "pause": false (the show never stops for you). `
          + `Don't repeat what you've already planned to say. `
          + `Reply with JSON only: {"moments": [{"line": 1, "thought": "", "kind": "comment", "pause": false}]}` },
        { role: 'user', content: `The show: "${mine.title}"${mine.channel ? ` (${mine.channel})` : ''}.${into.length ? `\nWhat you're into these days: ${into.join(', ')}.` : ''}`
          + `${before ? `\nWhat it said just before this part:\n${before}` : ''}`
          + `${planned ? `\nWhat you've already planned to say earlier on:\n${planned}` : ''}`
          + `${seen.length ? `\nStills your eyes analyzed for this part (use these — describe what you notice, don't invent frames):\n${sightLines(seen)}` : '\n(No stills for this part yet — react from dialogue only.)'}`
          + `\nThis part, from ${clock(from)} to ${clock(to)}:\n${lines.map((l, i) => `${i + 1}. [${clock(l.at)}] ${said(l)}`).join('\n')}` },
      ]);
    } catch (err) {
      fail('theater watch', `Her read of "${mine.title}" from ${clock(from)} to ${clock(to)} failed: ${err.message}. She still hears all of it (it's in her transcript); she just won't speak up about anything in that part. Fix: her local model (Ollama) has to be running.`);
      return;
    }
    if (show !== mine) return;
    const picked = [];
    for (const m of Array.isArray(read?.moments) ? read.moments : []) {
      const n = Number(m?.line), line = Number.isInteger(n) ? lines[n - 1] : null;
      const thought = String(m?.thought ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!line || !thought || picked.some((p) => p.line === line)) continue;
      const kind = m?.kind === 'question' ? 'question' : 'comment';
      // Owner: never pause the show for reactions — she talks over it (audio ducks via herVoice).
      picked.push({ line, thought, kind, pause: false });
      if (picked.length >= most) break;
    }
    picked.forEach((p, rank) => {
      const at = p.line.end ?? p.line.at, pull = +(0.9 - (0.3 * rank) / Math.max(1, most - 1)).toFixed(2);
      mine.moments.push({ at, line: said(p.line), thought: p.thought, kind: p.kind, pause: false, pull, out: false });
      log('theater', { planned: clock(at), after: said(p.line).slice(0, 160), thought: p.thought, kind: p.kind, pause: false, pull, show: mine.title });
    });
    if (!picked.length) log('theater', { planned: 'nothing', part: `${clock(from)}-${clock(to)}`, show: mine.title });
  }

  // What she'd say now, if anything: her strongest unsaid thought about what just played, while the show is playing.
  function pending() {
    if (!show || show.state !== 'playing' || show.reacting) return null;
    const pos = position();
    return show.thoughts.filter((t) => !t.said && pos - t.at <= MOMENT_LATE_S).sort((a, b) => b.pull - a.pull)[0] ?? null;
  }

  // Her `watching` want fired (pressure.js): she says the thought over the show (no pause; audio ducks via herVoice).
  function take() {
    const t = pending();
    if (!t) return null;
    for (const x of show.thoughts) x.said = true;
    const lead = script(show.heard.filter((h) => h.end <= t.at + 0.5 && h.start >= t.at - 60), castNow());
    const nearStills = (show.sights || [])
      .filter((s) => s.end >= t.at - 20 && s.start <= t.at + 5)
      .sort((a, b) => a.start - b.start);
    const stills = nearStills.length ? sightLines(nearStills) : '';
    show.reacting = true;
    log('theater', { react: clock(t.at), thought: t.thought, stills: stills.slice(0, 160), show: show.title });
    return {
      title: show.title,
      at: clock(t.at),
      thought: t.thought,
      moment: t.moment,
      kind: t.kind,
      paused: false,
      hold: false,
      lead,
      stills,
    };
  }

  // After she finishes talking over the show: clear the reacting flag (show never stopped).
  async function reacted() {
    if (show) show.reacting = false;
    return true;
  }

  // ---- the player ----

  const confirm = async (state) => {
    const until = now() + CONFIRM_MS, mine = show;
    while (now() < until) { if (show !== mine || show.state === state) return true; await wait(100); }
    return show?.state === state;
  };
  const noPage = () => `the theater page didn't answer within ${CONFIRM_MS / 1000} seconds (${viewers.size ? 'it is open but its player is not responding' : 'it is not open in your browser'}). Fix: bring it back with the theater tool's show action, or put the video on again with play`;
  const needShow = () => { if (!show || show.state === 'ended') throw new Error(`Nothing is playing in your theater${show ? ` ("${show.title}" has ended)` : ''}. Put something on with the theater tool's play action and a YouTube address or search words.`); };

  async function order(cmd, state, extra = {}) {
    show.expect = { state, until: now() + SETTLE_MS };
    send({ cmd, ...extra });
    if (!(await confirm(state))) throw new Error(`The show didn't ${cmd}: ${noPage()}.`);
  }

  return {
    // The page's event stream: it's told the show as it stands, then every command and caption.
    attach(write) {
      viewers.add(write);
      try { write({ cmd: 'show', show: view() }); } catch {}
      return () => viewers.delete(write);
    },
    viewers: () => viewers.size,

    view,

    // Puts a video on: a YouTube address or id, or words to search for (the best match plays, and she's told the rest).
    async play({ video, by = null, conversation = null } = {}) {
      const asked = String(video ?? '').replace(/\s+/g, ' ').trim();
      if (!asked) throw new Error('No video was named. Give a YouTube address, or words to search YouTube for.');
      let id = audio.videoId(asked), info, others = [], fetching = null;
      if (id) {
        // An address: what the video is and its sound are fetched at the same time, so the wait before it starts is one wait.
        fetching = Promise.resolve().then(() => audio.fetchAudio(id, dir)).then((file) => ({ file }), (err) => ({ err }));
        try { info = await audio.lookUp(id); }
        catch (err) {
          // YouTube's bot wall often blocks yt-dlp metadata; the iframe player can still show the video.
          info = { id, title: `YouTube ${id}`, duration: 0, live: false, channel: '' };
          fail('theater lookup', `Couldn't read the title for ${id} (${err.message}). Putting it on anyway so the theater page can play it.`);
        }
      } else {
        const found = await audio.search(asked);
        if (!found.length) throw new Error(`YouTube found nothing for "${asked}". Try other words, or give the video's address.`);
        [info, ...others] = found;
        id = info.id;
      }
      const start = audio.videoId(asked) ? audio.startAt(asked) : 0;
      // Her hearing first, then the picture (owner, 2026-11-15: "we need to get the audio fixed so she can actually hear
      // what's going on with the video at the beginning… up front"). The sound takes a few seconds to fetch; the player
      // starts once it's in, so the first thing the show says is the first thing she hears. If it can't be fetched the
      // show still goes on, and she's told why she can't hear it.
      // Prefer real audio for STT; if that fails, begin() starts ear in "fetching" and falls back to captions.
      let file = null;
      if (!info.live) {
        try {
          const got = await (fetching ?? audio.fetchAudio(id, dir).then((f) => ({ file: f })));
          if (got.err) throw got.err;
          file = got.file;
        } catch {
          /* startEar will try captions — do not mark deaf here or captions never run */
        }
      }
      const mine = begin({ ...info, start, by, conversation, file, deaf: '' });
      send({ cmd: 'show', show: view() });
      try { await openPage(); }
      catch (err) {
        if (show === mine) show = null;
        throw new Error(`Your theater couldn't be opened in your browser, so "${info.title}" is not playing: ${err.message}. Fix: open http://127.0.0.1:${config.dashboard.port}/theater.html or check Brave.`);
      }
      const until = now() + PAGE_WAIT_MS;
      while (now() < until && show === mine && !mine.error && !['playing', 'paused', 'ended'].includes(mine.state)) await wait(150);
      if (show !== mine) throw new Error(`"${info.title}" was replaced or stopped before it started.`);

      const senseLine = () => {
        const hear = mine.ear.status === 'ready'
          ? (mine.ear.mode === 'captions'
            ? 'You are following what is said from captions (audio download was blocked), timed with the show.'
            : 'You can hear it: speech is transcribed as it plays.')
          : mine.ear.status === 'fetching'
            ? 'You are still getting the sound/captions so you can follow what is said.'
            : `You may not hear this one yet: ${mine.ear.why || 'sound not ready'}`;
        const seeLine = mine.eye.status === 'ready'
          ? (mine.eye.mode === 'sprites'
            ? 'You can see what happens on screen from YouTube storyboard frames.'
            : 'You can see what happens on screen from video frames.')
          : mine.eye.status === 'fetching'
            ? 'Your eyes are still loading the picture.'
            : mine.eye.status === 'off'
              ? 'Your eyes are off for this show.'
              : `You may not see this one: ${mine.eye.why || 'picture not ready'}`;
        return `${hear} ${seeLine} React to what you hear and see as it plays — don't invent moments you haven't gotten yet.`;
      };

      if (mine.error) {
        const why = mine.error;
        const embedBlocked = /doesn't allow it to play outside youtube\.com/i.test(why);
        if (embedBlocked) {
          // Keep watching: Brave shows youtube.com; she still transcribes + reads frames on a wall clock.
          mine.error = null;
          Object.assign(mine, { state: 'playing', position: start, at: now(), seen: now(), site: true, pausedBy: null });
          await openYoutubeWatch(id);
          tell();
          hearOn();
          log('theater', { playing: info.title, id, by, from: clock(start), where: 'youtube.com', site: true });
          return `"${info.title}" can't embed in the theater page, so it's open on YouTube in Brave. You are still watching it with them. ${senseLine()}`;
        }
        show = null; send({ cmd: 'stop' });
        throw new Error(`"${info.title}" won't play in your theater: ${why}`);
      }
      if (!['playing', 'paused', 'ended'].includes(mine.state)) {
        if (viewers.size) {
          log('theater', { cued: info.title, id, by, from: clock(start), state: mine.state });
          return `"${info.title}" is loaded in your theater${start ? ` (from ${clock(start)})` : ''}. The page is open; if it isn't playing yet, click once. ${senseLine()}`;
        }
        // No theater.html viewer — still put it on YouTube in Brave and keep her senses.
        Object.assign(mine, { state: 'playing', position: start, at: now(), seen: now(), site: true });
        await openYoutubeWatch(id);
        tell();
        hearOn();
        log('theater', { playing: info.title, id, by, from: clock(start), where: 'youtube.com', site: true });
        return `"${info.title}" is playing on YouTube in Brave (theater page wasn't connected). ${senseLine()}`;
      }
      log('theater', { playing: info.title, id, by, from: clock(start) });
      return `"${info.title}"${info.channel ? ` by ${info.channel}` : ''}${info.duration ? ` (${clock(info.duration)} long)` : ''} is ${mine.state} in your theater${start ? `, from ${clock(start)}` : ''}. ${senseLine()}`
        + `${others.length ? `\nYou searched for "${asked}" and this was the best match. The others: ${others.map((o) => `"${o.title}"${o.channel ? ` by ${o.channel}` : ''}${o.duration ? ` (${clock(o.duration)})` : ''}: https://youtu.be/${o.id}`).join('; ')}. If they meant one of those, play it by its address.` : ''}`;
    },

    // Videos matching some words, without playing anything.
    async find({ query } = {}) {
      const found = await audio.search(query);
      if (!found.length) return `YouTube found nothing for "${query}". Try other words.`;
      return `On YouTube for "${String(query).trim()}":\n${found.map((o, i) => `${i + 1}. "${o.title}"${o.channel ? ` by ${o.channel}` : ''}${o.duration ? ` (${clock(o.duration)})` : ''}${o.live ? ' (live)' : ''}: https://youtu.be/${o.id}`).join('\n')}\nPlay one with the play action and its address.`;
    },

    // Brings the theater page up in her browser (it shows whatever is on, or an empty screen).
    async bringUp() {
      try { await openPage(); }
      catch (err) { throw new Error(`Your theater couldn't be opened in your browser: ${err.message}. Fix: check that your browser can open (the browser tool's show action).`); }
      return show ? `Your theater is up, showing "${show.title}" (${show.state} at ${clock(position())}).` : 'Your theater is up, with nothing on yet. Put something on with play and a YouTube address or search words.';
    },

    async pause({ by = null } = {}) {
      needShow();
      if (show.state === 'paused') return `It's already paused at ${clock(position())}${show.pausedBy ? ` (paused by ${show.pausedBy === 'her' ? 'you' : show.pausedBy})` : ''}.`;
      await order('pause', 'paused');
      show.pausedBy = by ?? 'someone';
      log('theater', { paused: clock(position()), by: show.pausedBy, show: show.title });
      tell();
      return `Paused "${show.title}" at ${clock(position())}.`;
    },

    async resume({ by = null, why = '' } = {}) {
      needShow();
      if (show.state === 'playing') return `It's already playing (at ${clock(position())}).`;
      await order('play', 'playing');
      Object.assign(show, { pausedBy: null, question: null, reacting: false, reactionHold: false });
      log('theater', { resumed: clock(position()), by, ...(why && { why }), show: show.title });
      tell();
      hearOn();
      return `"${show.title}" is playing again from ${clock(position())}.`;
    },

    // After a spoken reaction (pressure watching): clear reacting; show was never paused.
    reacted,

    // Jumps to a place in the show (to: seconds, "1:30"), or by an amount from where it is (by: +30, -10).
    async seek({ to = null, by = null } = {}) {
      needShow();
      const target = to !== null && to !== '' ? seconds(to) : Number.isFinite(Number(by)) && Number(by) !== 0 ? position() + Number(by) : null;
      if (target === null || !Number.isFinite(target)) throw new Error(`Where to? "${to ?? by ?? ''}" isn't a place in the show. Give "to" as seconds or a time like 1:30, or "seconds" to skip by (30 forward, -30 back).`);
      const at = Math.max(0, show.duration ? Math.min(target, show.duration - 1) : target);
      send({ cmd: 'seek', to: at });
      const until = now() + CONFIRM_MS, mine = show;
      while (now() < until && show === mine && Math.abs(position() - at) > 3) await wait(100);
      if (show !== mine || Math.abs(position() - at) > 3) throw new Error(`The show didn't move to ${clock(at)}: ${noPage()}.`);
      log('theater', { moved: clock(at), show: show.title });
      hearOn();
      return `"${show.title}" is now at ${clock(at)}${show.duration ? ` of ${clock(show.duration)}` : ''} (${show.state}). You hear it from there.`;
    },

    async volume({ level } = {}) {
      needShow();
      const word = String(level ?? '').trim().toLowerCase();
      const have = show.volume ?? 100;
      const next = word === 'up' ? have + 15 : word === 'down' ? have - 15 : word === 'mute' ? 0 : Number(word) <= 1 && word !== '' ? Number(word) * 100 : Number(word);
      if (word === '' || !Number.isFinite(next)) throw new Error('Give level as a number from 0 (silent) to 1 (full), or the word up, down or mute.');
      show.volume = Math.max(0, Math.min(100, Math.round(next)));
      send({ cmd: 'volume', level: show.volume });
      return `The show's volume is ${show.volume}%${viewers.size ? '' : ' (the theater page is not open, so nothing is sounding right now)'}.`;
    },

    stop({ by = null } = {}) {
      if (!show) return 'Nothing was playing in your theater.';
      const was = show;
      keepWatched(was, `it was stopped${by ? ` by ${by}` : ''}`);
      songOver(was);
      ears?.keep();
      stopped = { id: was.id, at: now() };
      show = null;
      send({ cmd: 'stop' });
      audio.forget?.(dir);
      audio.forget?.(videoDir);
      log('theater', { stopped: was.title, at: clock(was.position), by, heard: was.heard.length });
      return `Stopped "${was.title}" at ${clock(last?.upTo ?? was.position)}. The theater screen is empty. ${was.heard.length ? `You still have everything you heard of it (${was.heard.length} stretches): it stays in your theater notes, and the transcript action reads it back.` : `You heard nothing of it${was.ear.status === 'ready' ? ' (nothing was said in the part that played)' : `: ${was.ear.why || 'its sound was still being fetched'}`}.`}`;
    },

    status() {
      if (!show) return `Nothing is on in your theater.${last ? ` The last thing you watched was "${last.title}" (${last.how}, at ${clock(last.upTo)}); ${last.heard.length ? `you still have what you heard of it (${last.heard.length} stretches): the transcript action reads it back` : 'you heard nothing of it'}.` : ''}`;
      const ear = show.ear;
      return `"${show.title}"${show.channel ? ` by ${show.channel}` : ''}: ${show.state} at ${clock(position())}${show.duration ? ` of ${clock(show.duration)}` : ''}${show.pausedBy ? `, paused by ${show.pausedBy === 'her' ? 'you' : show.pausedBy}` : ''}${show.by ? `, put on for ${show.by}` : ''}. `
        + `${ear.status === 'ready' ? `You're hearing it (${show.heard.length} stretches so far).` : ear.status === 'fetching' ? "Its sound is still being fetched, so you can't hear it yet." : `You can't hear it: ${ear.why}`} `
        + `${viewers.size ? 'The theater page is open.' : 'The theater page is not open in your browser right now (show brings it up).'}`;
    },

    // What the show said between two places, with where each stretch was.
    transcript({ from = null, to = null } = {}) {
      // The show that's on, or the last one she watched: what she heard outlives the show.
      const src = show ? { title: show.title, heard: show.heard, cast: castNow(), deaf: show.ear.status === 'ready' ? '' : show.ear.status === 'fetching' ? 'its sound is still being fetched' : `you can't hear it: ${show.ear.why}`, on: true } : last;
      if (!src) throw new Error("You haven't watched anything in your theater yet, so there's no transcript. Put something on with the theater tool's play action.");
      const a = from !== null && from !== '' ? seconds(from) ?? 0 : 0, b = to !== null && to !== '' ? seconds(to) ?? Infinity : Infinity;
      const lines = src.heard.filter((h) => h.end > a && h.start < b);
      if (!lines.length) return `You heard nothing ${from || to ? `between ${clock(a)} and ${b === Infinity ? (src.on ? 'now' : 'where it stopped') : clock(b)}` : src.on ? 'yet' : ''} in "${src.title}"${src.deaf ? ` (${src.deaf})` : ' (nothing was said there, or it was skipped past)'}.`;
      const sights = (show ? show.sights.filter((s) => s.end <= position() + 0.5) : src.seen ?? []).filter((s) => s.end > a && s.start < b);
      const text = [...lines.map((h) => ({ at: h.start, text: script([h], src.cast ?? {}) })), ...sights.map((s) => ({ at: s.start - 0.01, text: `[${clock(s.start)}-${clock(s.end)}] (on screen) ${s.story || s.text}` }))]
        .sort((x, y) => x.at - y.at).map((x) => x.text).join('\n');
      return `What you heard in "${src.title}"${src.on ? '' : ` (${last.how}, at ${clock(last.upTo)})`}${from || to ? ` from ${clock(a)}${b === Infinity ? '' : ` to ${clock(b)}`}` : ''}:\n${text.slice(0, 8000)}${text.length > 8000 ? '\n(More than fits here: ask again with from and to for a shorter stretch.)' : ''}`;
    },

    // The page says where the player is. This is the show's clock: what she hears and reads follows it.
    report(r = {}) {
      const id = String(r.id ?? '');
      if (stopped && id === stopped.id && now() - stopped.at < 5000) return { show: null };
      // A show already playing in the page she doesn't know about (she restarted; her browser didn't): she picks it up.
      if (!show && audio.videoId(id) && ['playing', 'paused'].includes(r.state)) {
        begin({ id, title: String(r.title || 'a video').slice(0, 200), duration: Number(r.duration) || 0, start: Number(r.position) || 0, state: r.state });
        log('theater', { pickedUp: show.title, at: clock(show.position), why: 'it was already playing in her theater page' });
      }
      if (!show || id !== show.id) return { show: view() };
      show.seen = now();
      if (r.error && !show.error) {
        show.error = String(r.error).slice(0, 300);
        fail('theater', `"${show.title}" won't play in her theater: ${show.error}`);
      }
      const state = ['playing', 'paused', 'ended'].includes(r.state) ? r.state : null;
      const settling = show.expect && now() < show.expect.until && state !== show.expect.state; // a report sent before the last command landed
      if (state && !settling) {
        show.expect = null;
        if (state !== show.state) {
          if (state === 'playing') Object.assign(show, { pausedBy: null, question: null });
          if (state === 'paused' && !show.pausedBy) show.pausedBy = 'someone at the screen';
          if (state === 'ended') { show.endedAt = now(); log('theater', { ended: show.title }); keepWatched(show, 'it finished'); songOver(show); ears?.keep(); }
          show.state = state;
        }
        if (Number.isFinite(Number(r.position))) {
          // The player jumped: forward further than the time since its last report could have played, even at double
          // speed, or back.
          const to = Number(r.position);
          if (to - show.position > ((now() - show.at) / 1000) * 2 + 5 || to < show.position - 2) jumped(to);
          show.position = to; show.at = now();
        }
      }
      if (Number(r.duration) > 0) show.duration = Number(r.duration);
      if (r.title && show.title === 'a video') show.title = String(r.title).slice(0, 200);
      release();
      hearOn();
      return { ok: true };
    },

    // ---- for her pressure (pressure.js setTheater) and the call (voice/session.js) ----
    pending,
    take,
    reactMs: REACT_RESUME_MS,
    showing: () => Boolean(show) && show.state !== 'ended',
    // Playing, as far as she can tell: the page said so and is still answering. A page that has gone quiet (closed,
    // reloaded, crashed) isn't a show she can count on being on.
    playing: () => show?.state === 'playing' && !gone(),
    waitingOnAnswer: () => show?.pausedBy === 'her' && Boolean(show.question),

    // What she actually said about the show, out loud. A question she paused for is kept as the one she's waiting on.
    said(line) {
      const text = String(line ?? '').replace(/\s+/g, ' ').trim();
      if (!show || !text) return;
      show.said.push({ at: position(), text: text.slice(0, 300) });
      if (show.said.length > 20) show.said.shift();
      if (show.question && !show.question.words) show.question.words = text.slice(0, 300);
    },

    // What she was going to say wasn't said (someone started talking first): if she'd paused the show for it, it goes on.
    async unsaid() {
      if (show?.pausedBy !== 'her') return;
      try { await this.resume({ by: 'herself', why: "her question wasn't asked: someone started talking first" }); }
      catch (err) { fail('theater', `She paused "${show?.title}" to ask something, didn't get to ask it, and couldn't start it again: ${err.message} It stays paused until someone resumes it.`); }
    },

    // Nobody picked her question up (pressure.js, the same uptake every spoken want has): she lets it go and the show goes on.
    async unanswered() {
      if (show?.pausedBy !== 'her') return;
      try { await this.resume({ by: 'herself', why: 'nobody picked her question up' }); }
      catch (err) { fail('theater', `Nobody answered her question and she couldn't start "${show?.title}" again: ${err.message} It stays paused until someone resumes it.`); }
    },

    // Someone spoke while the show is paused for her question: her model judges whether that means the show goes on.
    heardWhilePaused({ speaker, text } = {}) {
      const mine = show, q = mine?.question;
      if (mine?.pausedBy !== 'her' || !q?.words || !String(text ?? '').trim()) return Promise.resolve(false);
      q.replies.push(`${speaker}: ${String(text).replace(/\s+/g, ' ').slice(0, 240)}`);
      if (q.replies.length > 6) q.replies.shift();
      reading = reading.then(async () => {
        if (show !== mine || mine.question !== q || mine.state !== 'paused') return false;
        let read;
        try {
          read = await ask([
            { role: 'system', content: 'You are watching a show with people in a voice call, and you stopped it to ask them something. Decide whether what has been said since means the show should go on now. '
              + 'It goes on when they answered you, told you they don\'t know, or told you to carry on or play it. It stays stopped when they are still working out an answer, asked you something back, or said something that has nothing to do with your question. '
              + 'Reply with JSON only: {"resume": true or false, "why": "a few words"}' },
            { role: 'user', content: `The show: "${mine.title}", stopped at ${clock(q.at)}.\nWhat you asked: "${q.words}"\nSaid since then:\n${q.replies.join('\n')}` },
          ]);
        } catch (err) {
          fail('theater', `She couldn't judge whether "${String(text).slice(0, 80)}" answered the question she paused "${mine.title}" for: ${err.message}. The show stays paused until someone tells her to resume it. Fix: her local model (Ollama) has to be running.`);
          return false;
        }
        if (show !== mine || mine.question !== q || read?.resume !== true) return false;
        try { await this.resume({ by: 'herself', why: String(read.why ?? 'her question was answered').slice(0, 160) }); return true; }
        catch (err) { fail('theater', `Her question was answered but she couldn't start "${mine.title}" again: ${err.message}`); return false; }
      });
      return reading;
    },

    // A line that came through someone's microphone while the show plays: the show's own sound, or the person speaking?
    // Her model's judgment against what the show says around now. Unsure, or the judgment fails: it's the person.
    async isShowSound({ text, speaker = 'someone', stream = false } = {}) {
      const mine = show;
      if (!mine || mine.state !== 'playing') return false;
      const pos = position();
      const around = known().filter((w) => w.end >= pos - 40 && w.start <= pos + 15);
      // The owner's screen-share account is the desktop the show plays on, not a person (voice/session.js humans()).
      if (stream && !around.length) return { why: 'it came from the screen-share account while the show was playing' };
      if (!around.length) return false;
      let read;
      try {
        read = await ask([
          { role: 'system', content: 'A show is playing out loud where people are in a voice call. Microphones sometimes pick up the show\'s own sound, and it arrives looking like something a person said. Decide which this is. '
            + 'It is the show\'s sound when the words are what the show itself says around now; speech-to-text may differ by a few words, and it may be only a piece of what the show said. '
            + 'It is the person when they are talking about the show, reacting to it, answering someone, asking for something, or saying anything the show did not say. When unsure, it is the person. '
            + 'A line that is ABOUT what the show is saying (a question about it, "did you hear that", "oh wow") is the person, not the show. '
            + 'If it is the show\'s sound, "quote" must be the exact words, copied from the show\'s text below, that this line repeats; if you can\'t copy such words, it is the person. '
            + 'Reply with JSON only: {"show": true or false, "quote": "the show\'s exact words this line repeats, or empty", "why": "a few words"}' },
          { role: 'user', content: `The show ("${mine.title}") says around now:\n${around.map((w) => w.text).join('\n')}\n\nHeard through ${speaker}'s microphone${stream ? ' (this account is the screen share the show is playing on, not a person)' : ''}: "${String(text).slice(0, 600)}"` },
        ]);
      } catch (err) {
        fail('theater', `She couldn't tell whether "${String(text).slice(0, 80)}" (${speaker}) was the show's sound or ${speaker} talking: ${err.message}. It was taken as ${speaker} talking. Fix: her local model (Ollama) has to be running.`);
        return false;
      }
      // Her model has to show its evidence: the show's own words that this line repeats. They must really be in what the
      // show says around now, and really be most of what was heard. 2026-11-15: with only its say-so to go on, "Did you
      // hear about this news, Travis?" and "Oh, super." were taken as the show because they were about the show, and
      // two people's lines were thrown away. No evidence: it's the person.
      if (read?.show !== true) return false;
      const wordsOf = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim().split(' ').filter(Boolean);
      const quote = wordsOf(read.quote), heard = wordsOf(text), said = ` ${wordsOf(around.map((w) => w.text).join(' ')).join(' ')} `;
      const inShow = quote.length >= 3 && said.includes(` ${quote.join(' ')} `);
      const shared = heard.filter((w) => quote.includes(w)).length;
      if (!inShow || shared < 3 || shared < heard.length * 0.6) {
        log('theater', { echo: false, speaker, text: String(text).slice(0, 200), why: `her model called it the show's sound but couldn't back it with the show's words${read.quote ? ` (it gave "${String(read.quote).slice(0, 120)}")` : ''}: taken as ${speaker} talking` });
        return false;
      }
      return { why: `it repeats the show: "${String(read.quote).slice(0, 140)}"` };
    },

    // She's speaking in the call: the show dips under her, and comes back up when she's done.
    herVoice(on) { if (show?.state === 'playing') send({ cmd: 'duck', on: Boolean(on) }); },

    // Her prompt, whenever something is on: what it is, where it is, what it has said lately, and what she can do.
    promptBlock() {
      // Nothing on: what she heard of the last show stays with her for a couple of hours, so she can talk about it.
      if (!show) {
        if (!last || now() - last.at > 2 * 3600_000) return '';
        const mins = Math.round((now() - last.at) / 60_000);
        const head = `Nothing is on in your theater right now. The last thing you watched there, with the people in the call: "${last.title}"${last.channel ? ` (${last.channel})` : ''} on YouTube; ${last.how} at ${clock(last.upTo)}${last.duration ? ` of ${clock(last.duration)}` : ''}, ${mins < 1 ? 'just now' : `${mins} minute${mins === 1 ? '' : 's'} ago`}. It did play, and you heard it as it played.`;
        if (!last.heard.length) return `${head}\nYou heard nothing of what it said${last.deaf ? `: ${last.deaf}` : ' (nothing was said in the part that played)'}. If you're asked about it, say that plainly; never make up what it said.`;
        const all = script(last.heard, last.cast ?? {});
        const named = last.heard.some((h) => h.lines?.some((l) => l.who || l.voice));
        return `${head}\nWhat it said (the time is where in the show)${all.length > 6000 ? ', the last part; the transcript action reads the rest' : ''}:\n${all.slice(-6000)}${named ? `\n${WHO_NOTE}` : ''}`
          + `${last.seen?.length ? `\nWhat you saw happen on screen, the story as it went:\n${storySoFar([...last.seen].sort((a, b) => a.start - b.start))}` : ''}`
          + `${last.said.length ? `\nWhat you said about it: ${last.said.slice(-3).map((s) => `[${clock(s.at)}] "${s.text}"`).join(' ')}` : ''}`
          + '\nThis is what you actually heard. When someone asks what you learned or what was in it, answer from this, in your own words; never say it didn\'t play or that you have no transcript.';
      }
      if (show.state === 'ended' && now() - show.endedAt > ENDED_MS) return '';
      const pos = position(), ear = show.ear;
      const lines = [`You're in your theater, watching "${show.title}"${show.channel ? ` (${show.channel})` : ''} on YouTube with the people in the call${show.by ? `; ${show.by} asked for it` : ''}. `
        + `${show.state === 'ended' ? 'It has finished.' : show.state === 'opening' ? "It's still starting." : `It's ${show.state} at ${clock(pos)}${show.duration ? ` of ${clock(show.duration)}` : ''}.`}`];
      if (show.pausedBy) lines.push(`It was paused by ${show.pausedBy === 'her' ? 'you' : show.pausedBy}.`);
      if (gone()) lines.push(`The theater page stopped answering ${Math.round((now() - show.seen) / 1000)} seconds ago, at ${clock(show.position)}, so you don't know whether it's still playing: it may have been closed or reloaded. Say so if it comes up; the theater tool's show action brings it back, and play puts the video on again.`);
      if (!viewers.size && show.state !== 'ended') lines.push('The theater page is not open in your browser right now, so nobody can see or hear the show; the theater tool\'s show action brings it back.');
      if (ear.status === 'ready') {
        const lately = show.heard.filter((h) => h.end >= pos - 180).slice(-12);
        const recent = script(lately, castNow());
        const named = lately.some((h) => h.lines?.some((l) => l.who || l.voice));
        lines.push(recent ? `What you've heard it say lately (the time is where in the show):\n${recent.slice(-2400)}${named ? `\n${WHO_NOTE}` : ''}` : 'You are listening, and nothing has been said in it yet.');
      } else if (ear.status === 'fetching') lines.push("You can't hear it yet: its sound is still being fetched. Don't guess at what it's saying.");
      else lines.push(`You can't hear this show: ${ear.why}. If someone asks what was said in it, tell them that plainly; never make it up.`);
      const sawSoFar = show.sights.filter((s) => s.end <= pos + 0.5).sort((a, b) => a.start - b.start);
      if (sawSoFar.length) {
        lines.push(`What you've seen on screen from storyboard stills your eyes analyzed (times are where in the show — use these when people ask what's happening visually):\n${storySoFar(sawSoFar)}`);
        const recentStills = sawSoFar.filter((s) => s.end >= pos - 45);
        if (recentStills.length) lines.push(`Stills around now:\n${sightLines(recentStills)}`);
      } else if (show.eye.status === 'fetching') lines.push("You can't see it yet: its picture hasn't arrived. Don't guess at what's on screen.");
      else if (show.eye.status !== 'ready') lines.push(`You can't see what's on screen: ${String(show.eye.why).replace(/[.\s]+$/, '')}. If asked what's happening on screen, say so; never make it up.`);
      if (show.said.length) lines.push(`What you've said about it so far: ${show.said.slice(-3).map((s) => `[${clock(s.at)}] "${s.text}"`).join(' ')}`);
      lines.push("The show keeps playing while you talk — you react over it; you do not pause it for your own comments. That is the show's own sound, not anyone in the call talking to you: never answer it as if someone said it. With the theater tool you can pause/resume/skip/volume/stop or read the transcript if they ask you to.");
      return lines.join('\n');
    },
  };

}

let shared;
export const theater = () => {
  if (!shared) {
    shared = createTheater();
    // Pressure pulls pending thoughts via take() when watching fires (onShow).
    import('./pressure.js').then((p) => { try { p.setTheater(shared); } catch {} }).catch(() => {});
  }
  return shared;
};

// Eagerly register once the module loads so the first moment isn't lost to a race.
import('./pressure.js').then((p) => { try { p.setTheater(theater()); } catch {} }).catch(() => {});

// The dashboard's routes for the theater page (dashboard/server.js): the show as it stands, the page's reports of
// where its player is, and the stream of commands and captions the page listens to.
export function theaterRoutes(get = theater) {
  const r = (method, pattern, handler) => [method, new RegExp(`^${pattern}$`), handler];
  return [
    r('GET', '/api/theater', () => ({ show: get().view() })),
    r('POST', '/api/theater/report', ({ body }) => get().report(body)),
    // From the theater page's own link bar (theater.html): put a YouTube address or search words on.
    r('POST', '/api/theater/play', async ({ body }) => {
      const video = String(body?.video ?? body?.url ?? body?.q ?? '').trim();
      if (!video) {
        const err = new Error('Type a YouTube address or search words.');
        err.status = 400;
        throw err;
      }
      const result = await get().play({ video, by: String(body?.by || 'someone at the screen').slice(0, 80), conversation: body?.conversation || 'theater' });
      return { ok: true, show: get().view(), result: String(result ?? '').slice(0, 800) };
    }),
    r('GET', '/api/theater/events', ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const detach = get().attach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(keepAlive); detach(); });
      return undefined;
    }),
  ];
}
