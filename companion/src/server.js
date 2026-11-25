// Lyra companion server: her brain (Nemotron), her voice (Fish Audio) and her mind (data/mind.json).
// Chris's rule: ONE model request and ONE voice request per turn. No retries, no second passes.
//
//   /            talk page (avatar + mic + chat)
//   /creator/    the character creator (same origin, so the saved look is shared)

// Lyra lives in Cyprus time (her standalone mind and anything time-stamped here)
process.env.TZ = process.env.LYRA_TIMEZONE || "Europe/Nicosia";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as mind from "./mind.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PUBLIC = path.join(ROOT, "public");
const CREATOR = path.resolve(ROOT, process.env.CREATOR_DIR || "../customizer");
const AUDIO = path.join(mind.DATA_DIR, "audio");
fs.mkdirSync(AUDIO, { recursive: true });

const PORT = Number(process.env.PORT || 8770);
const MODEL = process.env.LYRA_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";
// her webcam eyes: Nano Omni (as good as the 120B in tests, ~1 s), the 120B if it fails (2026-11-25)
const EYES_MODEL = process.env.LYRA_EYES_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const EYES_FALLBACK = process.env.LYRA_EYES_FALLBACK || "nvidia/nemotron-3.5-super-vl-120b-a12b";
const OWNER_KEY = process.env.OWNER_KEY || "";

// ---------- brain: exactly one request ----------
async function think(name, isOwner, userContent) {
  const messages = [
    { role: "system", content: mind.systemPrompt(name, isOwner) },
    ...mind.history(name),
    { role: "user", content: userContent },
  ];
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages, max_tokens: 450, temperature: 0.85, top_p: 0.95,
      chat_template_kwargs: { enable_thinking: false }, // thinking on = no reply on the free tier
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`brain ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// ---------- voice: exactly one request ----------
async function speak(text, voiceId = process.env.FISH_VOICE_LYRA) {
  if (!text || !process.env.FISH_API_KEY || !voiceId) return null;
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}`, "Content-Type": "application/json", model: process.env.FISH_MODEL || "s1" },
    body: JSON.stringify({ text, reference_id: voiceId, format: "mp3", prosody: { speed: 1, volume: 0 } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`voice ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const id = crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(path.join(AUDIO, `${id}.mp3`), Buffer.from(await res.arrayBuffer()));
  // keep only the last 40 clips
  const files = fs.readdirSync(AUDIO).map((f) => ({ f, t: fs.statSync(path.join(AUDIO, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(40)) fs.rmSync(path.join(AUDIO, f), { force: true });
  return `/audio/${id}.mp3`;
}

// ---------- one turn ----------
// One mind, many doors (page, PC mic, Discord): turns wait their turn instead of failing as "busy".
let busy = false;
let chain = Promise.resolve();
let waiting = 0;
function turn(args) {
  if (waiting >= 4) return Promise.resolve({ error: "busy" }); // don't let a flood build up
  waiting++;
  const run = chain.then(() => turnNow(args)).finally(() => { waiting--; });
  chain = run.catch(() => {});
  return run;
}
// ---------- one mind: Lyra's runtime (lyra-runtime, dashboard :3010) ----------
// Her full brain lives there (memory, contacts, feelings, wants, theater, tools) and Discord talks to it too.
// The hologram sends each turn there and speaks the reply itself. If the runtime isn't running, the
// standalone mind below answers instead, so the hologram still works on its own.
const RUNTIME = (process.env.LYRA_RUNTIME_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
// her runtime feelings -> the hologram's moods; her gestures -> the hologram's gestures
const FEEL_TO_MOOD = { joy: "happy", amused: "playful", fond: "tender", playful: "playful", smug: "proud", excited: "excited",
  flirty: "playful", confident: "proud", curious: "curious", pensive: "thoughtful", confused: "thoughtful", skeptical: "thoughtful",
  surprised: "excited", worried: "worried", sad: "sad", embarrassed: "shy", annoyed: "annoyed", angry: "annoyed",
  disgusted: "annoyed", bored: "calm", tired: "calm", determined: "proud", scared: "worried", calm: "calm" };
const GESTURE_MAP = { nod: "nod", shake: "shake", laugh: "laugh", shrug: "shrug", tilt: "think", eyeroll: "shake", wink: "laugh", gasp: null, sigh: null };
let runtimeUp = null; // last known: true / false

// ---------- her eyes (webcam, read in the page by public/eyes.js) ----------
// Faces she knows are stored as fingerprints only (128 numbers each), never pictures.
const FACES_FILE = path.join(mind.DATA_DIR, "faces.json");
const faces = { load() { try { return JSON.parse(fs.readFileSync(FACES_FILE, "utf8")); } catch { return { people: [] }; } },
  save(d) { fs.writeFileSync(FACES_FILE, JSON.stringify(d)); } };
// What she sees right now. The snapshot lives in memory only and is replaced every few seconds.
const vision = { cameraOn: false, present: [], unknown: false, main: null, at: 0, snapshot: null, snapshotAt: 0 };
const visionFresh = () => vision.cameraOn && Date.now() - vision.at < 15000;
const LOOK = /\b(look at|can you see|do you see|what do you see|what am i (holding|wearing|doing)|what('s| is) (this|that) in my hand|how do i look|check (this|me) out|see (this|me|my)|look\b)/i;

// Her vision model describes a snapshot (only when someone asks her to look).
async function describeSnapshot(question, who) {
  const age = Date.now() - vision.snapshotAt;
  if (!vision.snapshot || age > 7000) { console.log(`[eyes] asked to look, but no fresh picture (${vision.snapshot ? Math.round(age / 1000) + "s old" : "none"})`); return null; }
  console.log(`[eyes] looking at a ${Math.round(age / 1000)}s-old picture`);
  let last;
  for (const model of [EYES_MODEL, EYES_FALLBACK].filter((m, i, a) => m && a.indexOf(m) === i)) {
    try {
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: 220, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: "user", content: [
            { type: "text", text: `This is a live webcam picture of ${who} sitting in front of a computer. They just said: "${question}". ` +
              `Describe plainly and accurately what's visible that matters for that: what they're holding, wearing or doing, their expression, and anything notable around them. 2 to 4 short sentences. Don't guess beyond what you can see.` },
            { type: "image_url", image_url: { url: vision.snapshot } },
          ] }],
        }),
        signal: AbortSignal.timeout(model === EYES_MODEL ? 20000 : 45000),
      });
      if (!res.ok) throw new Error(`vision ${res.status}`);
      const text = ((await res.json()).choices?.[0]?.message?.content || "").trim();
      if (text) return text;
      throw new Error("vision: empty answer");
    } catch (e) { last = e; console.log(`[eyes] ${model} failed: ${e.message}`); }
  }
  throw last;
}

// "What you see" in plain words for her mind.
async function seesText(name, text) {
  if (!vision.cameraOn) return "";
  if (!visionFresh()) return "Your camera is on, but you've lost the picture for a moment.";
  const lines = [];
  const others = vision.present.filter((n) => n !== name);
  if (!vision.main) lines.push("Nobody is in front of the screen right now.");
  else {
    const who = vision.main.name || "someone you don't recognise";
    lines.push(`${who === name ? `${name} (who you're talking to)` : who} is in front of the screen: ${vision.main.expression}; ${vision.main.attention}.`);
  }
  if (others.length) lines.push(`Also here: ${others.join(", ")}.`);
  if (vision.unknown) lines.push("There's someone you don't recognise in view as well.");
  if (text && LOOK.test(text)) {
    try {
      const d = await describeSnapshot(text, name);
      lines.push(d ? `You just looked closely at the live picture, taken a moment ago. You see: ${d}
Trust this over anything you described earlier; things change.`
        : "You tried to look closely, but your camera hasn't sent a fresh picture. Say so honestly instead of guessing.");
    }
    catch (e) { lines.push(`(You tried to look closely, but the picture didn't come through: ${e.message}.)`); }
  }
  return lines.join("\n");
}

async function runtimeTurn({ name, isOwner, text, cue, files, thought }) {
  const sees = await seesText(name, text);
  const res = await fetch(`${RUNTIME}/api/lyra/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, isOwner, text, cue, sees, files, thought: Boolean(thought) }), signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`runtime ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const r = await res.json();
  const top = Object.entries(r.feelings || {}).sort((a, b) => b[1] - a[1])[0];
  const mood = top ? FEEL_TO_MOOD[top[0]] || "calm" : "calm";
  const gesture = (r.gestures || []).map((g) => GESTURE_MAP[g]).find(Boolean) || null;
  const speech = String(r.reply || "").trim();
  return { speech, thought: String(r.thought || "").trim(), mood, gesture, remembered: [], journal: null, grew: null, quiet: !speech,
    state: { name: mood, strength: top ? Math.min(1, top[1]) : 0.3 }, feelings: r.feelings, mind: "runtime" };
}

async function turnNow({ name, isOwner, content, logAs, voice = "page", text, cue, files, thought }) {
  busy = true;
  try {
    // her one mind first
    try {
      const out = await runtimeTurn({ name, isOwner, text: cue ? undefined : (text ?? content), cue: cue ? content : undefined, files, thought });
      if (runtimeUp !== true) { runtimeUp = true; console.log("Using Lyra's runtime mind (one memory with Discord)."); }
      let audio = null, voiceError = null;
      if (out.speech && voice === "page") { try { audio = await speak(out.speech); } catch (e) { voiceError = e.message; } }
      // a cast member may pop in after her (cast.js in the runtime): asked for, or now and then
      if (!cue && !thought && out.speech && voice === "page") castFollow({ name, isOwner, text: text ?? content, reply: out.speech });
      return { ...out, audio, voiceError };
    } catch (e) {
      if (runtimeUp !== false) { runtimeUp = false; console.log(`Lyra's runtime isn't reachable (${e.message}); using the standalone mind.`); }
    }
    // a quiet-moment thought without her runtime: nothing (the standalone mind would only say it out loud)
    if (thought) return { speech: "", thought: "", quiet: true, state: mind.moodState() };
    // Nemotron tends to drop the tag lines after a turn or two, so every turn carries a short reminder
    // (same single request; the reminder is not stored in her history).
    const reminder = `\n\n(Answer as Lyra, out loud. Then on new lines at the very end: always [[mood: word | strength]]. ` +
      `If ${isOwner ? "Chris" : name} told you anything new about themselves, add [[remember: ...]] for it. ` +
      `Add [[gesture: ...]], [[journal: ...]] or [[grow: ...]] only when they truly fit.)`;
    const raw = await think(name, isOwner, content + reminder);
    const out = mind.digest(name, raw);
    // store what was really said (with tags, so she keeps the habit) and what prompted it
    mind.addHistory(name, "user", logAs ?? content);
    mind.addHistory(name, "assistant", raw.trim() || "[[quiet]]");
    mind.commit();
    let audio = null, voiceError = null;
    if (out.speech && voice === "page") { try { audio = await speak(out.speech); } catch (e) { voiceError = e.message; } }
    return { ...out, audio, voiceError, state: mind.moodState() };
  } finally { busy = false; }
}

// Nova, Juno, Marcus or Patrik add a line in their own voice after Lyra (owner, 2026-11-25). Runs after her reply
// has gone to the page, so she's never slowed down; the page plays it once she has finished speaking.
async function castFollow({ name, isOwner, text, reply }) {
  try {
    const res = await fetch(`${RUNTIME}/api/lyra/popin`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, isOwner, text, reply }), signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return;
    const pop = (await res.json()).popIn;
    if (!pop?.text || !pop.voiceId) return;
    let audio = null;
    try { audio = await speak(pop.text, pop.voiceId); } catch (e) { console.log(`cast voice failed: ${e.message}`); }
    broadcast("popin", { name: pop.name, text: pop.text, audio });
  } catch { /* the runtime is optional here */ }
}

function who(body) {
  const isOwner = !!OWNER_KEY && body.ownerKey === OWNER_KEY;
  let name = isOwner ? mind.OWNER : String(body.name || "").trim().slice(0, 24) || "Visitor";
  if (!isOwner && name.toLowerCase() === mind.OWNER.toLowerCase()) name = `${name} (visitor)`;
  return { name, isOwner };
}
const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// ---------- live events to the page (the PC mic lives outside the browser) ----------
const clients = new Set();
function broadcast(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(msg);
}
// The ears (ears/ears.py) only pass on what they hear while she's not thinking or talking.
const ears = { micOn: true, lastPing: 0, speaking: false, speakEnd: 0 };
const earsConnected = () => Date.now() - ears.lastPing < 3000;
setInterval(() => broadcast("ears", { connected: earsConnected(), micOn: ears.micOn }), 2000);
function earsListen() {
  return ears.micOn && !busy && !ears.speaking && Date.now() - ears.speakEnd > 700;
}

// ---------- wellbeing check-ins (Chris, 2026-11-20) ----------
// Gentle, never naggy: after a long stretch without a break, very late at night (Cyprus time), or when her eyes
// see him looking tired for a few minutes. At most one every 45 minutes, each kind at most every couple of hours,
// never while either of them is talking, only with the hologram page open, and "not now" snoozes them (her
// wellbeing tool, kept in the runtime).
const care = {
  lastActive: 0, sessionStart: 0, lastSpoke: 0, tiredSince: 0, lastCheck: 0, lastBy: {},
  active() { const now = Date.now(); if (now - this.lastActive > 10 * 60e3) this.sessionStart = now; this.lastActive = now; this.lastSpoke = now; },
  seen(expression) {
    const now = Date.now();
    if (now - this.lastActive > 10 * 60e3) this.sessionStart = now;
    this.lastActive = now;
    if (/tired|drooping/i.test(expression || "")) { this.tiredSince ||= now; } else this.tiredSince = 0;
  },
};
async function careTick() {
  const now = Date.now();
  if (!clients.size || busy || ears.speaking || now - care.lastSpoke < 25e3 || now - care.lastActive > 10 * 60e3) return;
  if (now - care.lastCheck < 45 * 60e3) return;
  try {
    const r = await fetch(`${RUNTIME}/api/personal`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json());
    if ((r.wellbeing?.snoozeUntil || 0) > now || r.presence?.away) return; // snoozed, or he's out (on his phone)
  } catch {}
  const h = new Date().getHours(), mins = Math.round((now - care.sessionStart) / 60e3);
  const due = (kind, every) => now - (care.lastBy[kind] || 0) > every;
  let kind = null, why = "";
  if (h >= 1 && h < 5 && due("late", 2.5 * 3600e3)) { kind = "late"; why = `It's ${new Date().toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true })} in Cyprus and Chris is still up.`; }
  else if (care.tiredSince && now - care.tiredSince > 3 * 60e3 && due("tired", 2 * 3600e3)) { kind = "tired"; why = "For the last few minutes your camera has seen Chris looking tired (eyes drooping)."; }
  else if (mins >= 100 && due("long", 100 * 60e3)) { kind = "long"; why = `Chris has been at it for about ${mins >= 120 ? Math.round(mins / 60) + " hours" : mins + " minutes"} without a real break.`; }
  if (!kind) return;
  care.lastCheck = now; care.lastBy[kind] = now;
  const content = `[check-in] ${why} Check in on him gently, like a friend would, in one or two sentences: a break, some water, food, fresh air, or sleep, whatever fits the moment and what you know about his day. Don't lecture and don't repeat yourself. If he says not now or to stop checking on him, use your wellbeing tool to snooze.`;
  try {
    const r = await turn({ name: mind.OWNER, isOwner: true, content, cue: true, logAs: `[${clock()}] (check-in: ${kind})` });
    broadcast("reply", r);
    console.log(`[check-in] ${kind}: ${String(r.speech || "").slice(0, 80)}`);
  } catch (e) { console.log("[check-in] failed:", e.message); }
}
setInterval(() => careTick().catch(() => {}), 60e3).unref?.();

const routes = {
  // someone opens the page / says hello
  "POST /api/hello": async (b) => {
    const { name, isOwner } = who(b);
    const { first, gapH } = mind.arrive(name);
    const gap = first ? "This is the very first time you meet." : gapH === Infinity || gapH < 1 ? "You were just talking a moment ago." : `You last talked ${Math.round(gapH) > 48 ? Math.round(gapH / 24) + " days" : Math.round(gapH) + " hours"} ago.`;
    const content = `[moment] ${name} just ${isOwner ? "switched you on" : "walked up to your terminal"}. ${gap} Greet them in your own way, short.`;
    return turn({ name, isOwner, content, cue: true, logAs: `[${clock()}] (${name} arrives)` });
  },
  // they say something
  "POST /api/talk": async (b) => {
    const { name, isOwner } = who(b);
    if (isOwner) care.active();
    const text = String(b.text || "").trim().slice(0, 1200);
    // files pasted or dropped into the chat box (a schedule photo, a PDF): passed on to her runtime to read
    const files = Array.isArray(b.files) ? b.files.slice(0, 5).filter((f) => f && f.name && f.base64) : [];
    if (!text && !files.length) return { error: "empty" };
    mind.arrive(name);
    const shown = text || `(sent ${files.map((f) => f.name).join(", ")})`;
    return turn({ name, isOwner, text, files, content: `[${clock()}] ${shown}` });
  },
  // a quiet moment: she may have a thought of her own. Never spoken (Chris, 2026-11-25: "we don't need quiet moments
  // for the hologram spoken out loud; she can still think them"): the page shows it quietly as a thought
  "POST /api/idle": async (b) => {
    const { name, isOwner } = who(b);
    const mins = Math.max(1, Math.round(Number(b.quietMinutes) || 3));
    const content = `[quiet moment] Nobody has said anything for ${mins} minutes. ${name} is still here, quietly. What's on your mind? Think it to yourself: something you noticed, a feeling, a question you'd like to ask ${name} later, something from your journal or the episode.`;
    return turn({ name, isOwner, content, cue: true, thought: true, voice: "none", logAs: `[${clock()}] (quiet for ${mins} minutes)` });
  },
  // the PC mic heard Chris say something
  "POST /api/heard": async (b) => {
    if (!earsListen()) return { error: "not listening right now" };
    const text = String(b.text || "").trim().slice(0, 1200);
    if (!text) return { error: "empty" };
    let { name, isOwner } = who(b);
    if (isOwner) care.active();
    // The PC mic is Chris's, unless her eyes see someone she knows sitting there without him (Dad visiting...).
    if (visionFresh() && vision.main?.name && vision.main.name !== mind.OWNER && !vision.present.includes(mind.OWNER)) {
      name = vision.main.name; isOwner = false;
    }
    mind.arrive(name);
    broadcast("heard", { text, who: name });
    turn({ name, isOwner, text, content: `[${clock()}] ${text}` })
      .then((r) => broadcast("reply", r))
      .catch((e) => broadcast("reply", { error: e.message }));
    return { ok: true };
  },
  "POST /api/ears": async () => { ears.lastPing = Date.now(); return { listen: earsListen(), micOn: ears.micOn }; },
  "POST /api/ears/activity": async (b) => { broadcast("ears-activity", { state: String(b.state || "") }); return { ok: true }; },
  // the page tells us when her voice starts and stops, so the mic never hears her
  "POST /api/speaking": async (b) => { ears.speaking = !!b.on; if (!b.on) ears.speakEnd = Date.now(); return { ok: true }; },
  "POST /api/mic": async (b) => { ears.micOn = !!b.on; broadcast("ears", { connected: earsConnected(), micOn: ears.micOn }); return { micOn: ears.micOn }; },
  // ---- her eyes ----
  "POST /api/faces/list": async (b) => (who(b).isOwner ? { people: faces.load().people } : { error: "owner only" }),
  "POST /api/faces/add": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    const person = String(b.person || "").trim().slice(0, 30);
    const prints = Array.isArray(b.descriptors) ? b.descriptors.filter((d) => Array.isArray(d) && d.length === 128) : [];
    if (!person || prints.length < 3) return { error: "need a name and a clear look at the face" };
    const d = faces.load();
    const p = d.people.find((x) => x.name.toLowerCase() === person.toLowerCase());
    if (p) p.descriptors = [...p.descriptors, ...prints].slice(-24); // more angles over time
    else d.people.push({ name: person, descriptors: prints, addedAt: new Date().toISOString() });
    faces.save(d);
    return { ok: true, person, prints: prints.length };
  },
  "POST /api/faces/remove": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    const d = faces.load(); d.people = d.people.filter((x) => x.name.toLowerCase() !== String(b.person || "").toLowerCase());
    faces.save(d); return { ok: true };
  },
  "POST /api/seen": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    vision.cameraOn = b.cameraOn !== false; vision.at = Date.now();
    vision.present = Array.isArray(b.present) ? b.present.slice(0, 8).map(String) : [];
    vision.unknown = !!b.unknown; vision.main = b.main || null;
    if (vision.present.includes(mind.OWNER)) care.seen(vision.main?.name === mind.OWNER ? vision.main.expression : "");
    if (!vision.cameraOn) { vision.snapshot = null; vision.present = []; vision.main = null; }
    return { ok: true };
  },
  "POST /api/seen/snapshot": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    const img = String(b.image || "");
    if (vision.cameraOn && img.startsWith("data:image/jpeg;base64,") && img.length < 400000) { vision.snapshot = img; vision.snapshotAt = Date.now(); }
    return { ok: true };
  },
  // someone she knows (or a stranger) just came into view
  "POST /api/arrived": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    const seenName = b.person ? String(b.person).slice(0, 30) : null;
    const isOwner = seenName === mind.OWNER;
    const name = seenName || "Visitor";
    const content = seenName
      ? `[you see] ${seenName} just came into view of your camera${isOwner ? "" : ` (you know their face${b.firstTime ? " — you only just learned it" : ""})`}. Greet them warmly and naturally, by name, in a sentence or two.`
      : `[you see] Someone you don't recognise just came into view of your camera. Say hello in a friendly way and ask who they are, in a sentence or two.`;
    return turn({ name, isOwner, content, cue: true, logAs: `[${clock()}] (${name} came into view)` });
  },
  // Lyra speaks up on her own on this page: a reminder Chris asked for (from her runtime), or a check-in.
  "POST /api/announce": async (b) => {
    if (!who(b).isOwner) return { error: "owner only" };
    if (!clients.size) return { delivered: false, why: "the hologram page isn't open" };
    const text = String(b.text || "").slice(0, 400);
    const now = new Date().toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
    const content = b.kind === "reminder"
      ? `[reminder] It's ${now}. Chris asked you to remind him now: "${text}". ${b.again ? "You already reminded him and he hasn't answered; say it again, a little more insistently but kindly." : "Remind him now, warmly and briefly, in your own words."} One or two sentences.`
      : `[check-in] ${text}`;
    const r = await turn({ name: mind.OWNER, isOwner: true, content, cue: true, logAs: `[${clock()}] (${b.kind || "announce"})` });
    broadcast("reply", r);
    return { delivered: !r.quiet && !!r.speech };
  },
  "POST /api/runtime": async () => {
    const up = await fetch(`${RUNTIME}/api/status`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    return { up, url: `${RUNTIME}/` };
  },
  "POST /api/whoami": async (b) => ({ ...who(b), ownerConfigured: !!OWNER_KEY }),
  "POST /api/mind": async (b) => (who(b).isOwner ? mind.snapshot() : { error: "owner only" }),
};

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".svg": "image/svg+xml" };
function serveFile(res, base, rel) {
  const file = path.resolve(base, "." + decodeURIComponent(rel));
  if (!file.startsWith(path.resolve(base))) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    const f = st.isDirectory() ? path.join(file, "index.html") : file;
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(f).on("error", () => res.end()).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) {
    let body = "";
    // files in the chat box come as base64: 40 MB for /api/talk, 800 KB elsewhere
    const limit = req.url.startsWith("/api/talk") ? 40e6 : 800000;
    req.on("data", (c) => { body += c; if (body.length > limit) req.destroy(); });
    req.on("end", async () => {
      let out;
      try { out = await routes[key](JSON.parse(body || "{}")); } catch (e) { console.error(e); out = { error: e.message }; }
      res.writeHead(out?.error === "busy" ? 429 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "ears", connected: earsConnected(), micOn: ears.micOn })}\n\n`);
    clients.add(res); req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith("/audio/")) return serveFile(res, AUDIO, url.pathname.slice(6));
  if (url.pathname === "/creator") { res.writeHead(302, { Location: "/creator/" }).end(); return; }
  if (url.pathname.startsWith("/creator/")) return serveFile(res, CREATOR, url.pathname.slice(8));
  if (url.pathname.startsWith("/models/")) return serveFile(res, path.join(CREATOR, "models"), url.pathname.slice(7));
  serveFile(res, PUBLIC, url.pathname);
}).listen(PORT, () => {
  console.log(`Lyra is awake on http://localhost:${PORT}  (creator: /creator/)`);
  if (!OWNER_KEY) console.log("No OWNER_KEY set: everyone is a visitor.");
});

// ---------- Discord (lunabot's token): text, DMs, slash commands, voice ----------
// Logged in from the dashboard (/dashboard), or automatically with DISCORD_AUTOSTART=1.
let dc = null;
import("./discord.js").then(async ({ startDiscord }) => {
  dc = await startDiscord({ turn, mind, clock, broadcast }, { login: process.env.DISCORD_AUTOSTART === "1" });
  console.log(process.env.DISCORD_TOKEN ? "Discord ready: log her in from the dashboard." : "No DISCORD_TOKEN: Discord is off.");
}).catch((e) => console.error("Discord module failed:", e.message));
const ownerOnly = (fn) => async (b) => (who(b).isOwner ? (dc ? fn(b) : { error: "Discord is still loading" }) : { error: "owner only" });
Object.assign(routes, {
  "POST /api/discord/status": ownerOnly(() => dc.status()),
  "POST /api/discord/start": ownerOnly(() => dc.start()),
  "POST /api/discord/stop": ownerOnly(() => dc.stop()),
  "POST /api/discord/leave-voice": ownerOnly(() => dc.leaveVoice()),
  "POST /api/dashboard": async (b) => (who(b).isOwner ? { mind: mind.snapshot(), ears: { connected: earsConnected(), micOn: ears.micOn } } : { error: "owner only" }),
});
