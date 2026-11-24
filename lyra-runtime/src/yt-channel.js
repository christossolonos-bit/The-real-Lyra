// Lyra on YouTube (2026-11-24): signed in as her own channel, she watches Chris's channel for new comments and new
// videos, drafts a reply (or her own first comment on a new video) in her voice, and DMs it to him. Nothing is posted
// until he says so in his own message ("post it", "change it to …", "skip"). Official YouTube Data API v3 with OAuth.
// (youtube.js is something else: songs from YouTube for her music.)
//
// Setup (once): data/youtube/client.json = the OAuth client (Desktop app) from Google Cloud Console; then
// `node src/youtube-signin.js` (Sign in Lyra YouTube.bat), where he signs in with Lyra's Google account. His channel is
// set by telling her the link (youtube tool, channel). Quota: a check costs ~3 units of 10,000 a day; a post 50.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

export const YT_DIR = path.join(DATA_DIR, 'youtube');
const CLIENT = path.join(YT_DIR, 'client.json');
const TOKEN = path.join(YT_DIR, 'token.json');
const STATE = path.join(YT_DIR, 'state.json');
export const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const API = 'https://www.googleapis.com/youtube/v3';
const CHECK_MS = 15 * 60_000;
const FIRST_LOOK_DAYS = 3;   // on the first check, only comments this recent get a draft (no flood of old ones)
const MAX_DRAFTS_PER_CHECK = 5;
const DRAFT_DAYS = 3;        // a draft he never answered expires

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(YT_DIR, { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };
const load = () => ({ channel: null, me: null, seen: {}, videos: {}, drafts: [], started: 0, ...readJson(STATE, {}) });
const save = (s) => writeJson(STATE, s);
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const clean = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export function oauthClient() {
  const j = readJson(CLIENT, null);
  const c = j?.installed || j?.web;
  if (!c?.client_id || !c?.client_secret) throw new Error(`no OAuth client: put the "Desktop app" OAuth client JSON from Google Cloud Console at ${CLIENT}`);
  return c;
}
export function saveToken(t) { writeJson(TOKEN, { ...readJson(TOKEN, {}), ...t, saved: Date.now() }); }
export const signedIn = () => Boolean(readJson(TOKEN, {})?.refresh_token);

async function accessToken() {
  const t = readJson(TOKEN, null);
  if (!t?.refresh_token) throw new Error("Lyra isn't signed in to YouTube yet: run Sign in Lyra YouTube.bat");
  if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
  const c = oauthClient();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`YouTube sign-in expired or was revoked (${j.error || res.status}): run Sign in Lyra YouTube.bat again`);
  saveToken({ access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

// the API itself; tests swap it (setApi)
let api = async (method, route, params = {}, body) => {
  const url = `${API}/${route}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube ${route}: ${j.error?.message || res.status}`);
  return j;
};
export function setApi(fn) { api = fn; }

// "https://www.youtube.com/@name", "@name", "youtube.com/channel/UC…", "UC…"
function channelRef(s) {
  const t = String(s || '').trim();
  const id = t.match(/(?:channel\/)?(UC[\w-]{22})/)?.[1];
  if (id) return { id };
  const handle = t.match(/@([\w.-]{3,})/)?.[1];
  return handle ? { forHandle: `@${handle}` } : null;
}

async function whoAmI(s) {
  if (s.me?.id) return s.me;
  const j = await api('GET', 'channels', { part: 'snippet', mine: 'true' });
  const c = j.items?.[0];
  if (!c) throw new Error('the signed-in Google account has no YouTube channel');
  s.me = { id: c.id, title: c.snippet.title };
  return s.me;
}

export async function setChannel(link) {
  const ref = channelRef(link);
  if (!ref) throw new Error(`"${link}" isn't a YouTube channel link (like https://www.youtube.com/@name)`);
  const j = await api('GET', 'channels', { part: 'snippet,contentDetails', ...ref });
  const c = j.items?.[0];
  if (!c) throw new Error(`no YouTube channel found for "${link}"`);
  const s = load();
  s.channel = { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || '', uploads: c.contentDetails?.relatedPlaylists?.uploads || '' };
  s.started = 0; // first look again: recent comments only
  delete s.wantChannel;
  save(s);
  return s.channel;
}
// before she's signed in, the link is kept and looked up on her first check (startYoutube)
export function setChannelLater(link) {
  if (!channelRef(link)) throw new Error(`"${link}" isn't a YouTube channel link (like https://www.youtube.com/@name)`);
  const s = load();
  s.wantChannel = String(link).trim();
  save(s);
  return s.wantChannel;
}
const chooseChannel = (link) => (signedIn() ? setChannel(link) : Promise.resolve({ title: setChannelLater(link), later: true }));

const videoInfo = async (id) => {
  const v = (await api('GET', 'videos', { part: 'snippet', id })).items?.[0]?.snippet;
  return { title: v?.title || '(a video)', description: clean(v?.description).slice(0, 1200) };
};
async function captionsText(id) {
  try {
    const { fetchCaptions } = await import('./theater-audio.js');
    const caps = await fetchCaptions(id, path.join(YT_DIR, 'captions'));
    const text = caps.lines.map((l) => l.text).join(' ');
    return text.length > 5000 ? `${text.slice(0, 5000)}…` : text;
  } catch { return ''; }
}

// ---------- the watcher ----------
// draft(cue) -> her words for it (index.js: respond with a cue); dm(text) -> a DM to Chris
export async function checkNow({ draft, dm, captions = captionsText }) {
  const s = load();
  if (!s.channel?.id) return 'No channel to watch yet: he has to give you his channel link.';
  const me = await whoAmI(s);
  const first = !s.started;
  const since = first ? Date.now() - FIRST_LOOK_DAYS * 86_400_000 : s.started - 60_000;
  const made = [];
  const context = new Map();
  const about = async (videoId) => {
    if (!context.has(videoId)) context.set(videoId, { ...(await videoInfo(videoId)), captions: await captions(videoId) });
    return context.get(videoId);
  };
  const talk = async (kind, v, extra) => {
    const out = String(await draft(
      `You're on YouTube as Lyra, on your own channel's account (${me.title}). ${kind}\n` +
      `The video: "${v.title}".${v.description ? `\nIts description: ${v.description}` : ''}${v.captions ? `\nWhat's said in it: ${v.captions}` : ''}\n${extra}\n` +
      'Write only the comment text itself: 1 to 3 short sentences in your own voice, warm and in character, about this video. No hashtags, no links, no emoji spam, never ask for subscribes. This is public: never use your creator\'s real name or anything private about him (say "my creator" if you need to).',
    ) || '').replace(/^["“]|["”]$/g, '').trim();
    return out && !/\[\[quiet\]\]/i.test(out) ? out.slice(0, 600) : '';
  };

  // new comments on his videos, and people answering her
  const threads = (await api('GET', 'commentThreads', { part: 'snippet,replies', allThreadsRelatedToChannelId: s.channel.id, maxResults: '50', order: 'time', textFormat: 'plainText' })).items || [];
  for (const t of threads) {
    if (made.length >= MAX_DRAFTS_PER_CHECK) break;
    const top = t.snippet.topLevelComment;
    const videoId = t.snippet.videoId;
    const replies = t.replies?.comments || [];
    const mine = (c) => c.snippet.authorChannelId?.value === me.id;
    const fresh = (c) => !s.seen[c.id] && Date.parse(c.snippet.publishedAt) >= since && !mine(c);
    // a reply to her in a thread she's in (the newest reply isn't hers), else a new top-level comment she hasn't answered
    const lastReply = replies.slice().sort((a, b) => Date.parse(a.snippet.publishedAt) - Date.parse(b.snippet.publishedAt)).at(-1);
    const inThread = mine(top) || replies.some(mine);
    const target = inThread ? (lastReply && fresh(lastReply) ? lastReply : null) : (fresh(top) ? top : null);
    for (const c of [top, ...replies]) s.seen[c.id] = 1;
    if (!target || !videoId) continue;
    const v = await about(videoId);
    const who = target.snippet.authorDisplayName;
    const said = clean(target.snippet.textDisplay || target.snippet.textOriginal);
    const text = await talk(inThread ? `${who} answered in a thread you're in.` : `${who} left a comment on one of Chris's videos.`, v,
      `${inThread ? `The thread starts: "${clean(top.snippet.textOriginal)}"\n` : ''}${who} wrote: "${said}"\nReply to ${who}.`);
    if (!text) continue;
    const d = { id: nextId(s.drafts), kind: 'reply', videoId, videoTitle: v.title, parentId: top.id, author: who, comment: said.slice(0, 500), text, at: Date.now(), status: 'pending' };
    s.drafts.push(d);
    made.push(d);
  }

  // a new video on his channel: her own first comment
  if (s.channel.uploads) {
    const items = (await api('GET', 'playlistItems', { part: 'snippet', playlistId: s.channel.uploads, maxResults: '5' })).items || [];
    for (const it of items) {
      const videoId = it.snippet.resourceId?.videoId;
      if (!videoId || s.videos[videoId]) continue;
      s.videos[videoId] = 1;
      if (first || Date.parse(it.snippet.publishedAt) < since || made.length >= MAX_DRAFTS_PER_CHECK) continue;
      const v = await about(videoId);
      const text = await talk('Chris just posted a new video on his channel. Leave the first comment on it as Lyra.', v, 'Say something real about this video.');
      if (!text) continue;
      const d = { id: nextId(s.drafts), kind: 'comment', videoId, videoTitle: v.title, text, at: Date.now(), status: 'pending' };
      s.drafts.push(d);
      made.push(d);
    }
  }

  // expire old drafts; keep the seen list small
  for (const d of s.drafts) if (d.status === 'pending' && Date.now() - d.at > DRAFT_DAYS * 86_400_000) d.status = 'expired';
  s.drafts = s.drafts.slice(-200);
  const keys = Object.keys(s.seen);
  if (keys.length > 3000) s.seen = Object.fromEntries(keys.slice(-2000).map((k) => [k, 1]));
  s.started = Date.now();
  save(s);
  for (const d of made) {
    try { await dm(draftCard(d)); } catch (err) { activity('error', { where: 'youtube dm', message: err.message }); }
  }
  if (made.length) activity('youtube', { message: `${made.length} YouTube draft${made.length > 1 ? 's' : ''} sent to Chris for approval` });
  return made.length ? `Drafted ${made.length} and sent them to him for approval.` : 'No new comments or videos.';
}

const draftCard = (d) => (d.kind === 'reply'
  ? `💬 New comment on **${d.videoTitle}** from **${d.author}**:\n> ${d.comment.replace(/\n/g, '\n> ')}\n\nMy reply (#${d.id}):\n> ${d.text.replace(/\n/g, '\n> ')}\n\nSay **post it**, **change it to …**, or **skip** (or accept / deny it on the dashboard's YouTube page).`
  : `🎬 New video: **${d.videoTitle}**. My first comment (#${d.id}):\n> ${d.text.replace(/\n/g, '\n> ')}\n\nSay **post it**, **change it to …**, or **skip** (or accept / deny it on the dashboard's YouTube page).`);

let checkHook = null;
export function startYoutube({ draft, dm }) {
  let busy = false;
  const tick = async () => {
    if (busy || !signedIn()) return 'Not set up yet: she isn\'t signed in to YouTube.';
    const want = load();
    if (!want.channel?.id && want.wantChannel) {
      try { await setChannel(want.wantChannel); } catch (err) { activity('error', { where: 'youtube', message: `channel ${want.wantChannel}: ${err.message}` }); return `Error: ${err.message}`; }
    }
    if (!load().channel?.id) return 'Not set up yet: no channel to watch.';
    busy = true;
    try { return await checkNow({ draft, dm }); } catch (err) { activity('error', { where: 'youtube', message: err.message }); return `Error: ${err.message}`; } finally { busy = false; }
  };
  checkHook = tick;
  setTimeout(() => tick(), 60_000).unref();
  setInterval(() => tick(), CHECK_MS).unref();
  return { tick };
}

// ---------- posting (only with his OK) ----------
async function post(d, text) {
  if (d.kind === 'reply') return (await api('POST', 'comments', { part: 'snippet' }, { snippet: { parentId: d.parentId, textOriginal: text } })).id;
  return (await api('POST', 'commentThreads', { part: 'snippet' }, { snippet: { videoId: d.videoId, topLevelComment: { snippet: { textOriginal: text } } } })).id;
}

const pendingList = () => load().drafts.filter((d) => d.status === 'pending');
// his own words this turn have to say yes (or give the new text): she can't approve her own drafts
const APPROVES = /\b(yes|yeah|yep|yup|sure|ok(ay)?|post|send|go ahead|do it|approved?|looks good|perfect|fine|change|instead|say|reply with|write)\b/i;

async function youtubeTool(a, ctx) {
  const s = load();
  if (a.action === 'pending') {
    const p = pendingList();
    return p.length ? `Drafts waiting for his OK:\n${p.map((d) => `#${d.id} ${d.kind === 'reply' ? `reply to ${d.author} on "${d.videoTitle}" (they wrote: "${d.comment.slice(0, 160)}")` : `first comment on "${d.videoTitle}"`}: "${d.text}"`).join('\n')}` : 'No YouTube drafts waiting.';
  }
  if (a.action === 'post' || a.action === 'skip') {
    const p = pendingList();
    const d = a.id ? p.find((x) => x.id === Number(a.id)) : (p.length === 1 ? p[0] : null);
    if (!d) return p.length ? `Error: which draft? Waiting: ${p.map((x) => `#${x.id}`).join(', ')}.` : 'Error: no YouTube drafts are waiting.';
    const mine = s.drafts.find((x) => x.id === d.id);
    if (a.action === 'skip') { mine.status = 'skipped'; save(s); return `Skipped draft #${d.id}; nothing was posted.`; }
    if (!ctx?.perms?.owner || ctx?.userText === undefined || !APPROVES.test(String(ctx.userText))) return "Error: nothing posted. Only Chris's own OK in this message can post it; ask him first.";
    const text = String(a.text || '').trim() || d.text;
    try {
      const id = await post(d, text.slice(0, 1500));
      Object.assign(mine, { status: 'posted', posted: text, postedId: id, postedAt: Date.now() });
      save(s);
      activity('youtube', { message: `Posted on YouTube (${d.kind} on "${d.videoTitle}")` });
      return `Posted on YouTube as ${s.me?.title || 'Lyra'}: "${text}". Tell him briefly.`;
    } catch (err) { return `Error: YouTube didn't take it: ${err.message}`; }
  }
  if (a.action === 'channel') {
    try {
      const c = await chooseChannel(a.link);
      return c.later ? `Saved ${c.title} as the channel to watch. You'll start once you're signed in to YouTube (he runs Sign in Lyra YouTube.bat).`
        : `Watching ${c.title}${c.handle ? ` (${c.handle})` : ''} for new comments and videos, every 15 minutes. Drafts go to him to approve first.`;
    }
    catch (err) { return `Error: ${err.message}`; }
  }
  if (a.action === 'status') {
    return `Signed in: ${signedIn() ? `yes${s.me ? ` (as ${s.me.title})` : ''}` : 'no (he needs to run Sign in Lyra YouTube.bat)'}. Watching: ${s.channel ? s.channel.title : 'no channel yet'}. Drafts waiting: ${pendingList().length}. Posted so far: ${s.drafts.filter((d) => d.status === 'posted').length}.`;
  }
  if (a.action === 'check') return checkHook ? await checkHook() : 'Error: the YouTube watcher is not running.';
  return 'Error: action must be pending, post, skip, channel, status or check.';
}

export const YOUTUBE_TOOLS = {
  youtube: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'youtube',
      description: "Your YouTube account (your own channel) on Chris's channel: you draft replies to his viewers' comments and first comments on his new videos, and he approves them. " +
        'pending = drafts waiting for his OK. post = post a draft ONLY when his message says yes / post it (id; text = his changed wording if he changed it). skip = drop a draft. ' +
        'channel = the channel to watch (link). status = signed in / watching what. check = look for new comments now.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['pending', 'post', 'skip', 'channel', 'status', 'check'] },
        id: { type: 'number' }, text: { type: 'string' }, link: { type: 'string' },
      }, required: ['action'] },
    } },
    run: (a, ctx) => youtubeTool(a, ctx),
  },
};

// ---------- the YouTube page (dashboard /youtube.html): he sees every draft and accepts or denies it ----------
// The dashboard only listens on this PC, so a press there is his OK.
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function youtubeSnapshot() {
  const s = load();
  return {
    ready: { client: existsSync(CLIENT), signedIn: signedIn(), me: s.me, channel: s.channel, wantChannel: s.wantChannel || null, watching: Boolean(checkHook) },
    drafts: s.drafts.slice().sort((a, b) => b.at - a.at),
  };
}
export async function acceptDraft(id, text) {
  const s = load();
  const d = s.drafts.find((x) => x.id === Number(id));
  if (!d) throw fail('No such draft.', 404);
  if (d.status !== 'pending') throw fail(`That one is already ${d.status}.`, 409);
  const words = String(text ?? d.text).trim().slice(0, 1500);
  if (!words) throw fail('The comment is empty.');
  const postedId = await post(d, words).catch((err) => { throw fail(`YouTube didn't take it: ${err.message}`, 502); });
  Object.assign(d, { status: 'posted', posted: words, postedId, postedAt: Date.now() });
  save(s);
  activity('youtube', { message: `Posted on YouTube from the dashboard (${d.kind} on "${d.videoTitle}")` });
  return { ok: true, message: 'Posted on YouTube.' };
}
export function denyDraft(id) {
  const s = load();
  const d = s.drafts.find((x) => x.id === Number(id));
  if (!d) throw fail('No such draft.', 404);
  if (d.status !== 'pending') throw fail(`That one is already ${d.status}.`, 409);
  d.status = 'skipped';
  save(s);
  return { ok: true, message: 'Denied: nothing was posted.' };
}
export async function checkFromPage() {
  if (!checkHook) throw fail('The YouTube watcher is not running.', 409);
  return { ok: true, message: await checkHook() };
}
export async function channelFromPage(link) {
  const c = await chooseChannel(link).catch((err) => { throw fail(err.message); });
  return { ok: true, message: c.later ? `Saved ${c.title}: she'll watch it once she's signed in.` : `Watching ${c.title}.` };
}

// for her prompt, when drafts wait for him
export function youtubePrompt() {
  const p = pendingList();
  if (!p.length) return '';
  return `YOUTUBE DRAFTS WAITING FOR HIS OK (you DMed them to him): ${p.map((d) => `#${d.id} ${d.kind === 'reply' ? `reply to ${d.author} on "${d.videoTitle}"` : `first comment on "${d.videoTitle}"`}: "${d.text}"`).join(' | ')}. ` +
    "If his message approves one (\"post it\", \"yes\"), post it with your youtube tool (post, its id). If he gives new wording, post that as text. \"skip\" drops it. Never post one he hasn't OK'd in this message.";
}
export const youtubePending = () => pendingList().length;
export const youtubeReady = () => existsSync(CLIENT) && signedIn();
