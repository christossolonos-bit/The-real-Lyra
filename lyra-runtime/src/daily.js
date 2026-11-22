// Chris's day with Lyra (2026-11-22): work shifts, a morning brief and a night wrap-up.
//
//  - shifts: he tells her ("work Friday 6 to 2") or sends a photo of the work schedule and she reads his row
//    (the name he's under on it). Before a shift: a reminder to get ready. During it: he counts as out (her
//    check-ins pause, reminders go to his phone). After it: she asks how work was, once.
//  - morning brief: the first time he talks to her in the morning (or as a Discord DM at a time he sets): today's
//    shifts, reminders and to-dos, bills due this week, the weather in his town, and a line from last night's wrap-up.
//  - night wrap-up: late in the evening (or when he says good night) she asks how the day went, saves a short
//    journal entry with how he felt (her memory, kind "day"), ticks off the to-dos he did; the rest carry over.
// Everything stays on this PC (data/daily.json). Weather: Open-Meteo (free, no key; only the town name is sent).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { personalSnapshot, presence, setAway, addReminder, finishTodos } from './personal.js';
import { billsDue } from './finance.js';

const FILE = path.join(DATA_DIR, 'daily.json');
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const addDays = (date, n) => { const t = new Date(`${date}T12:00`); t.setDate(t.getDate() + n); return dayOf(t); };
const weekday = (date) => new Date(`${date}T12:00`).toLocaleDateString('en-GB', { weekday: 'long' });
const nice = (date) => new Date(`${date}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00`));
const hhmm = (s) => {
  const m = String(s ?? '').trim().toLowerCase().match(/^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
};
// a shift's start and end as times (an end before the start is the next morning)
function span(s) {
  const start = new Date(`${s.date}T${s.start}`).getTime();
  let end = new Date(`${s.date}T${s.end}`).getTime();
  if (end <= start) end += 86_400_000;
  return { start, end };
}
// the evening a late-night moment belongs to (1 am on Sunday is still Saturday's night)
const nightOf = (t = new Date()) => (t.getHours() < 5 ? addDays(dayOf(t), -1) : dayOf(t));

function load() {
  const blank = { town: null, scheduleName: '', shifts: [], brief: { time: null, last: '' }, wrap: { asked: '', saved: '' }, journal: [], leaveMinutes: 60 };
  try { return { ...blank, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return blank; }
}
function save(d) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 1)); }
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;

// ---------- weather (Open-Meteo) ----------
const WMO = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };
let weatherCache = { at: 0, key: '', text: '' };
async function findTown(name) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  // a town or village (not a country or region) whose name is the one asked for; one in Cyprus first
  const want = String(name).trim().toLowerCase();
  const ok = (j.results || []).filter((x) => /^PPL/.test(x.feature_code || '') && String(x.name).toLowerCase().startsWith(want.slice(0, Math.max(4, want.length - 2))));
  const hit = ok.find((x) => x.country_code === 'CY') || ok[0];
  return hit ? { name: hit.name, lat: hit.latitude, lon: hit.longitude, country: hit.country } : null;
}
export async function weatherLine() {
  const d = load();
  if (!d.town) return '';
  const key = `${d.town.lat},${d.town.lon}`;
  if (weatherCache.key === key && Date.now() - weatherCache.at < 30 * 60_000) return weatherCache.text;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${d.town.lat}&longitude=${d.town.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max&timezone=Europe%2FNicosia&forecast_days=2`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json();
    const i = new Date().getHours() >= 20 ? 1 : 0; // late evening: tomorrow's weather
    const day = j.daily;
    const text = `Weather in ${d.town.name} ${i ? 'tomorrow' : 'today'}: ${WMO[day.weather_code[i]] || 'mixed'}, ${Math.round(day.temperature_2m_min[i])} to ${Math.round(day.temperature_2m_max[i])}°C` +
      `${day.precipitation_probability_max[i] >= 20 ? `, ${day.precipitation_probability_max[i]}% chance of rain` : ''}${day.wind_speed_10m_max[i] >= 35 ? `, windy (${Math.round(day.wind_speed_10m_max[i])} km/h)` : ''}` +
      `${i ? '' : `; now ${Math.round(j.current.temperature_2m)}°C, ${WMO[j.current.weather_code] || ''}`}.`;
    weatherCache = { at: Date.now(), key, text };
    return text;
  } catch (err) {
    activity('error', { where: 'weather', message: err.message });
    return '';
  }
}

// ---------- shifts ----------
const ampm = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? `:${pad(m)}` : ''} ${h < 12 ? 'am' : 'pm'}`; };
const shiftLine = (s) => `${nice(s.date)} ${s.start} to ${s.end} (${ampm(s.start)} to ${ampm(s.end)})${s.note ? ` (${s.note})` : ''}`;
export function shiftsBetween(from, to) {
  return load().shifts.filter((s) => s.date >= from && s.date <= to).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
export function atWork(now = Date.now()) {
  return load().shifts.find((s) => { const { start, end } = span(s); return now >= start && now < end; }) || null;
}
function addShift(d, { date, start, end, note = '', source = 'chat' }) {
  const st = hhmm(start), en = hhmm(end);
  if (!isDate(date)) return `Error: date must be YYYY-MM-DD (work it out from today in your prompt).`;
  if (!st || !en) return 'Error: start and end must be times like 06:00 and 14:00.';
  const prev = d.shifts.find((s) => s.date === date);
  if (prev && source === 'chat' && prev.source === 'schedule photo' && Date.now() - (prev.at || 0) < 10 * 60_000 && (prev.start !== st || prev.end !== en)) {
    return `Error: ${nice(date)} was just read off his schedule as ${prev.start} to ${prev.end} (${ampm(prev.start)} to ${ampm(prev.end)}). Don't change it unless he tells you it's wrong.`;
  }
  d.shifts = d.shifts.filter((s) => s.date !== date); // one shift a day: a new one replaces it
  const s = { id: nextId(d.shifts), date, start: st, end: en, note: String(note || '').slice(0, 100), source, at: Date.now(), reminded: false, asked: false };
  d.shifts.push(s);
  return s;
}

// read his row off a photo of the work schedule
// Reading a schedule (2026-11-22): asked for one person's row, the vision model slipped to the row above on a
// dense, tilted rota (and did so every time). Copying the whole table line by line keeps the rows straight, so she
// transcribes it, and his row, the dates and the times are picked out here in code.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const nameWords = (x) => String(x).toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1 || /^\p{L}$/u.test(w));
// every word of his name has to match a word of theirs ("Andreas Petrou" never matches "Andronikos Pavlou";
// a short "Andre" matches "Andreas"; a misspelt "Petrouu" still matches "Petrou")
const wordFits = (a, b) => a === b || (a.startsWith(b.slice(0, 4)) && (b.length <= 5 || a.startsWith(b) || b.startsWith(a) || Math.abs(a.length - b.length) <= 1));
const nameMatches = (who, n) => nameWords(who).every((w) => nameWords(n).some((x) => wordFits(x, w) || wordFits(w, x)));
// a header cell to a date: "Mon 16- Nov", "16/11", "Mon"
function headerDate(cell, t) {
  const c = String(cell).toLowerCase();
  const dayName = DAYS.findIndex((x) => c.includes(x));
  const num = c.match(/\b(\d{1,2})\s*[-/. ]?\s*(\d{1,2})?\b/);
  const mon = MONTHS.findIndex((m) => c.includes(m));
  const today = new Date(`${t}T12:00`);
  if (num && (mon >= 0 || num[2])) {
    const day = Number(num[1]), month = mon >= 0 ? mon : Number(num[2]) - 1;
    // the year that puts it nearest today (a rota across New Year)
    const options = [-1, 0, 1].map((k) => new Date(today.getFullYear() + k, month, day, 12));
    const best = options.sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0];
    return day >= 1 && day <= 31 ? dayOf(best) : null;
  }
  if (dayName >= 0) {
    // weekdays only: this week (Monday to Sunday), or next week once this one is over
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const offset = (dayName + 6) % 7;
    return dayOf(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset, 12));
  }
  return null;
}
// a cell to a shift: "14:00-23:00", "18-02", "15:00-24:00"; DO / OFF / x / empty is a day off.
// Handwritten rotas use short 12-hour times (like "10-6", "3-11", "8-4", with "22-6" written for nights):
// with no minutes and both hours 12 or under, a start of 1 to 5 is the afternoon, and an end before the start is
// the same afternoon or evening ("8-5" = 08:00-17:00, "2-11" = 14:00-23:00, "6-2" = 06:00-14:00).
function cellShift(cell) {
  const c = String(cell || '').trim();
  const m = c.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|to)\s*(\d{1,2})(?:[:.](\d{2}))?/i);
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[3]);
  const short = !m[2] && !m[4] && !/^0/.test(m[1]) && !/^0/.test(m[3]) && a <= 12 && b <= 12;
  if (short) {
    if (a >= 1 && a <= 5) a += 12;
    if (b <= a % 24 && b + 12 > a && b + 12 <= 24) b += 12;
  }
  const t = (h, mm) => `${pad(h % 24)}:${mm || '00'}`;
  return { start: t(a, m[2]), end: t(b, m[4]) };
}

async function shiftsFromPhoto(d, { id, name }) {
  const { lookAtKept } = await import('./attachments.js');
  const who = String(name || d.scheduleName || '').trim();
  if (!who) return "Error: which name is he under on the schedule? Ask him once (it's saved for next time), then try again with name.";
  const t = dayOf();
  const raw = await lookAtKept(id, 'This is a work rota. Transcribe the table exactly, one line per person, in the order they appear top to bottom: NAME | day1 | day2 | ... using the cell text (times like 14:00-23:00, or DO). Keep empty cells as empty between the bars. First line: the day headers, with the same columns. Plain text only, no commentary.', 4000);
  const lines = String(raw).split('\n').map((l) => l.trim()).filter((l) => l.includes('|'));
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
  const headerLine = lines.find((l) => cells(l).filter((c) => DAYS.some((x) => c.toLowerCase().includes(x))).length >= 3);
  if (!headerLine) return `Error: couldn't make out the days on the schedule. What she saw: ${String(raw).slice(0, 300)}`;
  const header = cells(headerLine);
  const cols = header.map((c, i) => ({ i, date: DAYS.some((x) => c.toLowerCase().includes(x)) ? headerDate(c, t) : null })).filter((c) => c.date);
  // weekday names only, and most of that week already gone (a rota for next week, sent at the weekend): next week
  if (cols.length && cols.every((c) => !/\d/.test(header[c.i])) && cols.filter((c) => c.date < t).length * 2 > cols.length) {
    for (const c of cols) c.date = addDays(c.date, 7);
  }
  const rows = lines.filter((l) => l !== headerLine && !/^name\b/i.test(l));
  const mine = rows.filter((l) => nameMatches(who, cells(l)[0]));
  if (!mine.length) {
    const names = rows.map((l) => cells(l)[0]).filter((n) => n && /\p{L}/u.test(n) && !/total|signation|gnation/i.test(n));
    return `Error: "${who}" isn't on that schedule. Names on it: ${names.slice(0, 40).join(', ') || 'none readable'}. Ask him which one he is (then shifts name, and from_photo again).`;
  }
  // the name as he gave it (her eyes sometimes misspell it a little); what's on the rota only when none is saved
  if (!d.scheduleName) d.scheduleName = cells(mine[0])[0].slice(0, 60);
  const nameFound = d.scheduleName;
  const added = [];
  for (const col of cols) {
    // a split row (the same person twice): the first one with a shift that day
    const shift = mine.map((l) => cellShift(cells(l)[col.i])).find(Boolean);
    if (!shift) { d.shifts = d.shifts.filter((x) => !(x.date === col.date && x.source === 'schedule photo')); continue; }
    const r = addShift(d, { date: col.date, start: shift.start, end: shift.end, source: 'schedule photo' });
    if (typeof r !== 'string') added.push(r);
  }
  save(d);
  activity('daily', { message: `Read ${added.length} shifts for ${nameFound} off the schedule photo` });
  const past = added.filter((x) => x.date < t).length;
  return added.length
    ? `Read and saved ${added.length} shifts for "${nameFound}": ${added.map(shiftLine).join('; ')}.${past === added.length ? ' (That whole schedule is already in the past: tell him, and ask for the new one.)' : ''} They're saved: don't add them again. Read them back to him briefly, in these exact times, so he can correct anything.`
    : `Found "${nameFound}" but no shifts on it (all days off?). Tell him what you saw.`;
}

// a schedule photo he just sent (attachments.js): read straight away, under his saved name or as "Chris"
export async function readSchedule(id) {
  const d = load();
  return shiftsFromPhoto(d, { id, name: d.scheduleName ? '' : 'Chris' });
}

// ---------- the brief and the wrap-up ----------
export async function briefFacts() {
  const d = load();
  const t = dayOf();
  const p = personalSnapshot();
  const end = new Date(`${t}T23:59`).getTime();
  const lines = [];
  const today = shiftsBetween(t, t), tomorrow = shiftsBetween(addDays(t, 1), addDays(t, 1));
  lines.push(today.length ? `Work today: ${today.map((s) => `${ampm(s.start)} to ${ampm(s.end)}`).join(', ')}.` : 'No work today.');
  if (tomorrow.length) lines.push(`Work tomorrow: ${tomorrow.map((s) => `${ampm(s.start)} to ${ampm(s.end)}`).join(', ')}.`);
  const startOfDay = new Date(`${t}T00:00`).getTime();
  const rem = p.reminders.filter((r) => r.due >= startOfDay && r.due <= end).sort((a, b) => a.due - b.due);
  if (rem.length) lines.push(`Reminders today: ${rem.map((r) => `${new Date(r.due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${r.text}`).join('; ')}.`);
  if (p.todos.length) {
    lines.push(`To-do list: ${p.todos.map((x) => {
      const days = Math.floor((Date.now() - x.created) / 86_400_000);
      return `${x.text}${days >= 1 ? ` (on the list ${days} day${days > 1 ? 's' : ''})` : ''}`;
    }).join('; ')}.`);
  }
  try {
    const bills = billsDue(7);
    if (bills.length) lines.push(`Bills this week: ${bills.map((b) => `${b.name} €${b.amount} on ${nice(b.nextDue)}`).join('; ')}.`);
  } catch {}
  const w = await weatherLine();
  lines.push(w || (d.town ? '' : "Weather: you don't know his town yet; ask him once which town he's in (then your day tool, town)."));
  const last = d.journal.filter((j) => j.date < t).at(-1);
  if (last) lines.push(`Last wrap-up (${nice(last.date)}): ${last.summary}`);
  return lines.filter(Boolean).join('\n');
}

// What she should know this turn about his day (called for Chris's own messages, not cues)
export async function dayPrompt(text = '') {
  const d = load();
  const now = new Date();
  const t = dayOf(now);
  const h = now.getHours();
  const out = [];
  let changed = false;
  const shift = atWork();
  if (shift) out.push(`RIGHT NOW CHRIS IS AT WORK: his shift is ${ampm(shift.start)} to ${ampm(shift.end)} and he's messaging you from work. Keep it short, ask how the shift is going if it fits, and don't ask whether he's going to work.`);
  // after a shift: ask how work was, once (within 8 hours of it ending)
  const done = d.shifts.find((s) => { const { end } = span(s); return !s.asked && Date.now() >= end && Date.now() - end < 8 * 3_600_000; });
  if (done && !shift) {
    out.push(`He finished work at ${done.end} (${done.start}–${done.end} shift). Ask how work was, once, naturally. If he mentions tips, log them with your money tool as income.`);
    done.asked = true;
    changed = true;
  }
  // morning brief: the first time he talks to her between 5 am and 1 pm
  if (h >= 5 && h < 13 && d.brief.last !== t) {
    out.push(`MORNING BRIEF: this is the first time Chris has talked to you today. Before anything else, greet him and give a short spoken morning brief in your own words (not a list read out): what's on today, anything due, the weather, and one line about what he was doing yesterday if you know it. Then answer what he said.\n${await briefFacts()}`);
    d.brief.last = t;
    changed = true;
  }
  // night wrap-up: from 9:30 pm, or when he says good night; once per night
  const night = nightOf(now);
  const late = (h === 21 && now.getMinutes() >= 30) || h >= 22 || h < 4;
  const bed = /\b(good ?night|night night|going to (bed|sleep)|off to (bed|sleep)|heading to bed|gn)\b/i.test(text);
  if ((late || bed) && d.wrap.asked !== night && d.wrap.saved !== night) {
    const p = personalSnapshot();
    out.push(`NIGHT WRAP-UP (${bed ? "he's heading to bed" : "it's late"}): first answer what he actually said, fully. Then, at the end of your reply, ask how his day went (one warm question, not a form). Don't save anything yet; when he answers that question, save it with your day tool (wrapup: a 1–3 sentence summary in his terms, how he felt, and the ids of to-dos he says he did). ` +
      (p.todos.length ? `Open to-dos (ask which got done; the rest move to tomorrow): ${p.todos.map((x) => `#${x.id} ${x.text}`).join('; ')}.` : 'His to-do list is empty.'));
    d.wrap.asked = night;
    changed = true;
  } else if (d.wrap.asked === night && d.wrap.saved !== night) {
    out.push(`You asked him about his day tonight: only if this message actually tells you how his day went, save it with your day tool (wrapup). Otherwise just answer him.`);
  }
  if (changed) save(d);
  return out.join('\n\n');
}

// ---------- the tools ----------
async function shiftsTool(a) {
  const d = load();
  if (a.action === 'add') {
    const r = addShift(d, a);
    if (typeof r === 'string') return r;
    save(d);
    return `Saved: work ${shiftLine(r)}. You'll remind him ${d.leaveMinutes} minutes before.`;
  }
  if (a.action === 'list') {
    const t = dayOf();
    const list = shiftsBetween(t, addDays(t, Math.max(1, Math.min(31, Number(a.days) || 14))));
    return list.length ? list.map((s) => `#${s.id} ${shiftLine(s)}`).join('\n') : 'No shifts saved from today on.';
  }
  if (a.action === 'remove') {
    const before = d.shifts.length;
    d.shifts = d.shifts.filter((s) => !(s.id === Number(a.id) || (a.date && s.date === a.date)));
    save(d);
    return before === d.shifts.length ? 'Error: no such shift (list shows them).' : 'Removed.';
  }
  if (a.action === 'from_photo') return shiftsFromPhoto(d, a);
  if (a.action === 'name') { d.scheduleName = String(a.name || '').trim().slice(0, 60); save(d); return `His name on the schedule: "${d.scheduleName}".`; }
  if (a.action === 'remind_before') { d.leaveMinutes = Math.max(0, Math.min(240, Number(a.minutes) || 60)); save(d); return `You'll remind him ${d.leaveMinutes} minutes before each shift.`; }
  return 'Error: unknown action.';
}

// places named in what he said, most likely first: "I live in Paphos", "my town is Larnaca", then "... in Kyrenia"
const NOT_PLACES = /^(a|an|the|my|your|his|her|bed|work|town|home|love|trouble|pain|charge|time|cyprus|greece|europe)\b/i;
function townsFromWords(text) {
  const t = String(text || '');
  const end = String.raw`(?=[.,!?]|\s+(?:and|but|now|so|right|today|tonight|the|you|for|at|with)\b|$)`;
  const clear = [...t.matchAll(new RegExp(String.raw`\b(?:live in|living in|i'?m in|i am in|based in|town is|city is|village is|move[ds]? to)\s+([\p{L}][\p{L}' -]{1,40}?)` + end, 'giu'))].map((m) => m[1]);
  const named = [...t.matchAll(/\b(?:in|at|from|to)\s+(\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)?)/gu)].map((m) => m[1]);
  return [...new Set([...clear, ...named].map((x) => x.trim()).filter((x) => x && !NOT_PLACES.test(x)))];
}
async function townFromWords(text) {
  const found = [];
  for (const name of townsFromWords(text)) {
    const town = await findTown(name).catch(() => null);
    if (town) found.push(town);
  }
  return found.find((t) => t.country === 'Cyprus') || found[0] || null; // a Cyprus town first
}

async function dayTool(a, ctx) {
  const d = load();
  // no town yet and his message names one: saved, whatever she called the tool for (2026-11-23: "I'm in <his town>"
  // was answered with "I'll remember" while the town was never saved)
  if (!d.town && a.action !== 'town') {
    const t = await townFromWords(ctx?.userText);
    if (t) { d.town = t; save(d); weatherCache = { at: 0, key: '', text: '' }; activity('daily', { message: `Saved his town: ${t.name}` }); }
  }
  if (a.action === 'town') {
    // the town in whichever field she put it, or from his own words (she once sent it in another field, the tool
    // got an empty name, and the town was never saved)
    const wanted = [a.town, a.name, a.city, a.place, a.location].map((x) => String(x || '').trim()).find(Boolean);
    const town = (wanted && await findTown(wanted).catch(() => null)) || await townFromWords(ctx?.userText);
    if (!town) return wanted ? `Error: couldn't find a town called "${wanted}". Ask him how it's spelled.` : "Error: which town? Pass it as town (e.g. town: 'Paphos').";
    d.town = town;
    save(d);
    weatherCache = { at: 0, key: '', text: '' };
    return `His town: ${town.name}, ${town.country}. ${await weatherLine()}`;
  }
  if (a.action === 'brief_time') {
    const off = /^(off|none|no|stop)$/i.test(String(a.time || '').trim());
    const t = off ? null : hhmm(a.time);
    if (!off && !t) return 'Error: time like 08:00, or "off".';
    d.brief.time = t;
    save(d);
    return t ? `You'll DM him his morning brief at ${t} every day (unless he's already talked to you that morning).` : "No more morning brief DMs; he gets it when he first talks to you in the morning.";
  }
  if (a.action === 'brief') return `${await briefFacts()}\n(Give it in your own words.)`;
  if (a.action === 'weather') return (await weatherLine()) || "You don't know his town yet: ask him which town he's in.";
  if (a.action === 'wrapup') {
    const summary = String(a.summary || '').trim().slice(0, 600);
    if (!summary) return 'Error: summary = his day in 1–3 sentences.';
    const night = nightOf();
    const entry = { date: night, summary, feeling: String(a.feeling || '').slice(0, 60), at: Date.now() };
    d.journal = [...d.journal.filter((j) => j.date !== night), entry].slice(-120);
    d.wrap.saved = night;
    save(d);
    const owner = ctx?.speaker?.id || config.ownerIds[0];
    try {
      const { remember } = await import('./memory.js');
      await remember(owner, [{ text: `Chris's day (${nice(night)}): ${summary}`, feeling: entry.feeling || undefined, moment: nice(night), kind: 'day' }]);
    } catch (err) { activity('error', { where: 'wrap-up memory', message: err.message }); }
    const ids = (Array.isArray(a.done_todos) ? a.done_todos : String(a.done_todos || '').split(/[ ,]+/)).map(Number).filter(Boolean);
    // to-dos his day mentions doing ("finally did the laundry" ticks "do the laundry"), if she didn't name them
    const said = `${summary} ${ctx?.userText || ''}`.toLowerCase();
    const STOP = new Set(['about', 'with', 'from', 'that', 'this', 'have', 'some', 'call', 'make', 'buy', 'send', 'get', 'the', 'and', 'for', 'into']);
    if (!/\b(didn'?t|did not|never|forgot|still need)\b/.test(said)) {
      for (const t of personalSnapshot().todos) {
        const words = t.text.toLowerCase().match(/[\p{L}]{4,}/gu)?.filter((w) => !STOP.has(w)) || [];
        if (words.length && words.filter((w) => said.includes(w)).length / words.length >= 0.5 && !ids.includes(t.id)) ids.push(t.id);
      }
    }
    const finished = ids.length ? finishTodos(ids) : [];
    const left = personalSnapshot().todos;
    activity('daily', { message: `Wrap-up saved for ${night}${entry.feeling ? ` (${entry.feeling})` : ''}` });
    return `Saved tonight's wrap-up.${finished.length ? ` Ticked off: ${finished.join('; ')}.` : ''}${left.length ? ` Still on the list for tomorrow: ${left.map((x) => x.text).join('; ')}.` : ''} Say good night warmly.`;
  }
  return 'Error: unknown action.';
}

export const DAILY_TOOLS = {
  shifts: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'shifts',
      description: "Chris's work shifts. add = a shift he tells you (date YYYY-MM-DD worked out from today, start and end like 06:00 / 14:00; an end before the start is overnight). " +
        'from_photo = read his shifts off a photo of the work schedule he sent (id = the photo\'s document number; name = the name he\'s under on it, only if he just told you). ' +
        'list = upcoming shifts. remove = by id or date. name = the name he\'s under on the schedule. remind_before = minutes before a shift to remind him (default 60).',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['add', 'from_photo', 'list', 'remove', 'name', 'remind_before'] },
        date: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, note: { type: 'string' },
        id: { type: 'number' }, name: { type: 'string' }, days: { type: 'number' }, minutes: { type: 'number' },
      }, required: ['action'] },
    } },
    run: (a) => shiftsTool(a),
  },
  day: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'day',
      description: "Chris's day. wrapup = save tonight's wrap-up after he tells you how his day went (summary in 1-3 sentences, feeling, done_todos = ids of to-dos he did). " +
        'brief = the facts for a morning brief (say it in your own words). weather = the weather in his town. town = save his town when he tells you where he lives (town: the name of the town). ' +
        'brief_time = DM him the morning brief at a time each day (time like 08:00, or "off").',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['wrapup', 'brief', 'weather', 'town', 'brief_time'] },
        summary: { type: 'string' }, feeling: { type: 'string' }, done_todos: { type: 'array', items: { type: 'number' } },
        town: { type: 'string', description: 'His town, for town' }, name: { type: 'string' }, time: { type: 'string' },
      }, required: ['action'] },
    } },
    run: (a, ctx) => dayTool(a, ctx),
  },
};

// ---------- in the background: shift reminders, out at work, the brief DM ----------
// sendBrief(facts): word it and DM it to him
export function startDaily({ sendBrief }) {
  const tick = async () => {
    const d = load();
    const now = Date.now();
    let changed = false;
    for (const s of d.shifts) {
      const { start, end } = span(s);
      // a reminder before the shift
      if (!s.reminded && d.leaveMinutes > 0 && now >= start - d.leaveMinutes * 60_000 && now < start) {
        s.reminded = true;
        changed = true;
        addReminder(`work at ${s.start} (until ${s.end}): time to get ready`, now);
      }
      // during it: out (check-ins pause, reminders go to his phone); after it: back
      if (now >= start && now < end && !presence().away) { setAway(true, 'at work'); s.away = true; changed = true; }
      if (now >= end && s.away) { if (presence().how === 'at work') setAway(false, 'finished work'); s.away = false; changed = true; }
    }
    // old shifts go after 60 days
    const cut = addDays(dayOf(), -60);
    if (d.shifts.some((s) => s.date < cut)) { d.shifts = d.shifts.filter((s) => s.date >= cut); changed = true; }
    // the brief as a DM at his time, unless he's already talked to her this morning
    const t = dayOf();
    const at = new Date();
    if (d.brief.time && d.brief.last !== t && `${pad(at.getHours())}:${pad(at.getMinutes())}` >= d.brief.time && at.getHours() < 13) {
      d.brief.last = t;
      changed = true;
      save(d);
      try { await sendBrief(await briefFacts()); } catch (err) { activity('error', { where: 'morning brief', message: err.message }); }
      return;
    }
    if (changed) save(d);
  };
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 60_000).unref();
}

export function dailySnapshot() {
  const d = load();
  const t = dayOf();
  return { town: d.town?.name || null, scheduleName: d.scheduleName, briefTime: d.brief.time, atWork: atWork(), shifts: shiftsBetween(addDays(t, -1), addDays(t, 14)), journal: d.journal.slice(-14) };
}
