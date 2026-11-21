// Lyra's personal skills for Chris (2026-11-20): spoken reminders and a to-do list, an idea catcher, and her
// wellbeing check-ins' snooze. Everything is kept on this PC (data/personal.json, data/ideas/*.md), in Cyprus time.
//
// Reminders: at the time, she says it out loud on the hologram page (her hologram server words it in her own
// voice); failing that, in a Discord voice call he's in; failing that, a Discord DM. If he doesn't answer, she
// asks again 10 minutes later, at most three times. Him talking to her after a reminder counts as an answer.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config } from './config.js';
import { activity } from './events.js';
import { momentLabel } from './time.js';

const FILE = path.join(DATA_DIR, 'personal.json');
const IDEAS = path.join(DATA_DIR, 'ideas');
const REPEAT_MS = 10 * 60_000;
const MAX_TIMES = 3;

function load() {
  try { return { reminders: [], todos: [], wellbeing: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) }; }
  catch { return { reminders: [], todos: [], wellbeing: {} }; }
}
function save(d) { writeFileSync(FILE, JSON.stringify(d, null, 1)); }
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const when = (ts) => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

// ---------- "when": "in 20 minutes", "in 2 hours", or a local Cyprus date-time like 2026-11-20T18:00 ----------
export function parseWhen(s, now = Date.now()) {
  const t = String(s ?? '').trim().toLowerCase();
  const rel = t.match(/^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (rel) {
    const n = Number(rel[1]), u = rel[2][0];
    return now + n * (u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : 86_400_000);
  }
  // a date-time without a zone is read as Cyprus time (the runtime runs on Europe/Nicosia)
  const ts = Date.parse(t.replace(' ', 'T').replace(/z$/i, ''));
  return Number.isNaN(ts) ? null : ts;
}

// ---------- reminders ----------
let ownerSpokeAt = 0;
export function noteOwnerTurn() { ownerSpokeAt = Date.now(); }

function reminderTool({ action, text = '', when: w = '', id = 0 }, ctx) {
  const d = load();
  if (action === 'set') {
    if (!text.trim()) return 'Error: say what to remind him about (text).';
    const due = parseWhen(w);
    if (!due) return 'Error: "when" must be like "in 20 minutes", "in 2 hours", or a Cyprus date-time like 2026-11-21T18:00.';
    if (due < Date.now() - 60_000) return `Error: ${when(due)} has already passed. Check today's date and time in your prompt.`;
    const r = { id: nextId(d.reminders), text: text.trim().slice(0, 300), due, created: Date.now(), by: ctx?.speaker?.name || 'Chris', times: 0, announcedAt: 0, done: false };
    d.reminders.push(r);
    save(d);
    activity('reminder', { message: `Reminder #${r.id} set for ${when(due)}: ${r.text}` });
    return `Reminder #${r.id} set for ${when(due)} (Cyprus time): "${r.text}". Tell him when you'll remind him.`;
  }
  if (action === 'list') {
    const open = d.reminders.filter((r) => !r.done).sort((a, b) => a.due - b.due);
    return open.length ? open.map((r) => `#${r.id} ${when(r.due)}: ${r.text}${r.times ? ` (reminded ${r.times}x, not answered yet)` : ''}`).join('\n') : 'No reminders set.';
  }
  if (action === 'cancel' || action === 'done') {
    const r = d.reminders.find((x) => x.id === Number(id) && !x.done) || (!id && d.reminders.filter((x) => !x.done && x.times > 0).at(-1));
    if (!r) return 'Error: no such open reminder. Use list to see them.';
    r.done = action;
    save(d);
    return `Reminder #${r.id} ${action === 'cancel' ? 'cancelled' : 'marked done'}: ${r.text}`;
  }
  return 'Error: action must be set, list, cancel or done.';
}

// a reminder set by her other skills (a bill due tomorrow, finance.js)
export function addReminder(text, due = Date.now()) {
  const d = load();
  const r = { id: nextId(d.reminders), text: String(text).slice(0, 300), due, created: Date.now(), by: 'Lyra', times: 0, announcedAt: 0, done: false };
  d.reminders.push(r);
  save(d);
  return r;
}

// every 15 s: anything due goes out (and comes back if he didn't answer)
export function startReminders(deliver) {
  const tick = async () => {
    const d = load();
    let changed = false;
    for (const r of d.reminders) {
      if (r.done || r.due > Date.now()) continue;
      if (r.times && ownerSpokeAt > r.announcedAt) { r.done = 'answered'; changed = true; continue; } // he talked to her since
      if (r.times >= MAX_TIMES) { r.done = 'unanswered'; changed = true; continue; }
      if (r.times && Date.now() - r.announcedAt < REPEAT_MS) continue;
      try {
        const how = await deliver(r);
        r.times += 1;
        r.announcedAt = Date.now();
        changed = true;
        activity('reminder', { message: `Reminded Chris (${how}, time ${r.times}): ${r.text}` });
      } catch (err) {
        activity('error', { where: 'reminder', message: err.message });
      }
    }
    if (changed) save(d);
  };
  setInterval(() => tick().catch(() => {}), 15_000).unref();
}

// ---------- to-do list ----------
function todoTool({ action, text = '', id = 0 }) {
  const d = load();
  if (action === 'add') {
    if (!text.trim()) return 'Error: what should go on the list (text)?';
    const t = { id: nextId(d.todos), text: text.trim().slice(0, 300), created: Date.now(), done: false };
    d.todos.push(t);
    save(d);
    return `Added to his list (#${t.id}): ${t.text}`;
  }
  if (action === 'list') {
    const open = d.todos.filter((t) => !t.done);
    return open.length ? open.map((t) => `#${t.id} ${t.text}`).join('\n') : 'His to-do list is empty.';
  }
  if (action === 'done' || action === 'remove') {
    const needle = String(text || '').toLowerCase().trim();
    const t = d.todos.find((x) => !x.done && (x.id === Number(id) || (needle && x.text.toLowerCase().includes(needle))));
    if (!t) return 'Error: no matching open item. Use list to see them.';
    t.done = action === 'done' ? Date.now() : 'removed';
    save(d);
    return `${action === 'done' ? 'Ticked off' : 'Removed'}: ${t.text}`;
  }
  return 'Error: action must be add, list, done or remove.';
}

// ---------- idea catcher: one markdown file per project ----------
const fileFor = (project) => path.join(IDEAS, `${String(project || 'General').replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'General'}.md`);
function ideaTool({ action, project = '', text = '', query = '' }) {
  mkdirSync(IDEAS, { recursive: true });
  if (action === 'note') {
    if (!text.trim()) return 'Error: what is the idea (text)?';
    const f = fileFor(project);
    if (!existsSync(f)) writeFileSync(f, `# Ideas: ${path.basename(f, '.md')}\n\n`);
    appendFileSync(f, `- ${momentLabel()}: ${text.trim().replace(/\s+/g, ' ')}\n`);
    return `Saved under ${path.basename(f, '.md')}.`;
  }
  const files = readdirSync(IDEAS).filter((f) => f.endsWith('.md'));
  if (action === 'projects') return files.length ? files.map((f) => f.replace(/\.md$/, '')).join(', ') : 'No ideas saved yet.';
  if (action === 'list') {
    const f = fileFor(project);
    if (!project || !existsSync(f)) return files.length ? `Projects with ideas: ${files.map((x) => x.replace(/\.md$/, '')).join(', ')}` : 'No ideas saved yet.';
    return readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('- ')).slice(-25).join('\n') || 'No ideas there yet.';
  }
  if (action === 'search') {
    const words = String(query || text).toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    if (!words.length) return 'Error: what should I look for (query)?';
    const hits = [];
    for (const f of files) {
      for (const l of readFileSync(path.join(IDEAS, f), 'utf8').split('\n')) {
        if (l.startsWith('- ') && words.some((w) => l.toLowerCase().includes(w))) hits.push(`[${f.replace(/\.md$/, '')}] ${l.slice(2)}`);
      }
    }
    return hits.length ? hits.slice(-20).join('\n') : 'No ideas match that.';
  }
  return 'Error: action must be note, list, projects or search.';
}

// ---------- wellbeing check-ins: he can tell her to back off for a while ----------
export const wellbeingState = () => load().wellbeing || {};
function wellbeingTool({ action, hours = 0 }) {
  const d = load();
  d.wellbeing ||= {};
  if (action === 'snooze') {
    const h = Math.max(1, Math.min(48, Number(hours) || 3));
    d.wellbeing.snoozeUntil = Date.now() + h * 3_600_000;
    save(d);
    return `Check-ins paused for ${h} hours (until ${when(d.wellbeing.snoozeUntil)}).`;
  }
  if (action === 'resume') {
    d.wellbeing.snoozeUntil = 0;
    save(d);
    return 'Check-ins are back on.';
  }
  const s = d.wellbeing.snoozeUntil || 0;
  return s > Date.now() ? `Check-ins are paused until ${when(s)}.` : 'Check-ins are on.';
}

// ---------- "I'm out" / "I'm back" (Chris, 2026-11-20) ----------
// Out: he's away from the PC on his phone. Her check-ins on the hologram stop, and she keeps replies phone-sized.
// Back: by telling her, or simply by talking to her on the hologram page again.
export const presence = () => load().presence || { away: false };
export function setAway(away, how = 'told her') {
  const d = load();
  const was = d.presence?.away || false;
  d.presence = { away: Boolean(away), since: Date.now(), how };
  save(d);
  if (was !== Boolean(away)) activity('presence', { message: `Chris is ${away ? 'out' : 'back'} (${how})` });
}
export function presenceLine() {
  const p = presence();
  if (!p.away) return '';
  const mins = Math.round((Date.now() - (p.since || Date.now())) / 60_000);
  return `Chris is out: away from his PC since ${when(p.since)} (${mins < 90 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`} ago), messaging you from his phone. Keep replies phone-sized. When he tells you he's back home, use your presence tool.`;
}
function presenceTool({ action }) {
  if (action === 'out') { setAway(true); return "Marked as out: you'll message him on his phone, and no check-ins on the hologram until he's back."; }
  if (action === 'back') { setAway(false); return 'Marked as back home.'; }
  const p = presence();
  return p.away ? `He's out (since ${when(p.since)}).` : "He's home (or hasn't said he's out).";
}

// ---------- the tools, for tools.js ----------
const owner = (ctx) => Boolean(ctx?.perms?.owner);
const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const PERSONAL_TOOLS = {
  presence: {
    enabled: owner,
    definition: fn('presence',
      "Whether Chris is out or at home. out = he's leaving / out / away from the PC (\"I'm heading out\", \"I'm at the shop\"); back = he's home / back at the PC. status = which.",
      { action: { type: 'string', enum: ['out', 'back', 'status'] } },
      ['action']),
    run: presenceTool,
  },
  reminder: {
    enabled: owner,
    definition: fn('reminder',
      "Chris's spoken reminders. set = remind him later (when: 'in 20 minutes', 'in 2 hours', or a Cyprus date-time like 2026-11-21T18:00 worked out from the current Cyprus time in your prompt); at that time you'll say it out loud to him. list = what's set. cancel / done = by id (done with no id = the last one you reminded him about). Confirm the time back to him in plain words.",
      { action: { type: 'string', enum: ['set', 'list', 'cancel', 'done'] }, text: { type: 'string', description: 'What to remind him about, as he would want to hear it' }, when: { type: 'string' }, id: { type: 'number' } },
      ['action']),
    run: reminderTool,
  },
  todo: {
    enabled: owner,
    definition: fn('todo',
      "Chris's to-do list. add (text), list, done or remove (id or a few words of the item). Read it back conversationally, not as a raw list.",
      { action: { type: 'string', enum: ['add', 'list', 'done', 'remove'] }, text: { type: 'string' }, id: { type: 'number' } },
      ['action']),
    run: todoTool,
  },
  idea: {
    enabled: owner,
    definition: fn('idea',
      "Chris's idea catcher. note = save an idea he tells you (\"note this idea\", \"idea for...\") under its project: Lyra series, CityPal, AuthorHub, Cadence, Luna, Lyra (you yourself), or a short new project name; General if none fits. list = a project's ideas; projects = which projects have ideas; search = find ideas by words. Keep his wording; confirm briefly where you saved it.",
      { action: { type: 'string', enum: ['note', 'list', 'projects', 'search'] }, project: { type: 'string' }, text: { type: 'string' }, query: { type: 'string' } },
      ['action']),
    run: ideaTool,
  },
  wellbeing: {
    enabled: owner,
    definition: fn('wellbeing',
      "Your check-ins on how Chris is doing (breaks, late nights, looking tired). If he says not now / stop checking on me / leave it, snooze (hours, default 3). resume = he wants them back. status = whether they're on.",
      { action: { type: 'string', enum: ['snooze', 'resume', 'status'] }, hours: { type: 'number' } },
      ['action']),
    run: wellbeingTool,
  },
};

// for the dashboard / hologram server
export function personalSnapshot() {
  const d = load();
  return { reminders: d.reminders.filter((r) => !r.done), todos: d.todos.filter((t) => !t.done), wellbeing: d.wellbeing || {}, presence: d.presence || { away: false } };
}
