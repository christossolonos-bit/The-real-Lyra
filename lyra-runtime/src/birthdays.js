// Birthdays and dates for Chris's family and friends (2026-11-23). He tells her ("my sister's birthday is 3 March",
// "dad was born 12/6/1965"); she reminds him a week before (time to get a gift: offer to add it to the shopping
// list), the day before, and on the day. Upcoming ones are in the morning brief. Kept on this PC (data/birthdays.json).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { addReminder } from './personal.js';

const FILE = path.join(DATA_DIR, 'birthdays.json');
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const load = () => { try { return { people: [], sent: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { people: [], sent: {} }; } };
const save = (d) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 1)); };
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const norm = (s) => String(s || '').toLowerCase().replace(/^(my|his|her)\s+/, '').trim();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "2026-03-03", "1965-06-12", "03-03", "3/3", "12/6/1965" (day first), "3 March", "March 3rd 1990"
export function parseDate(s) {
  const t = String(s || '').trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { month: +m[2], day: +m[3], year: +m[1] };
  m = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return { month: +m[1], day: +m[2] };
  m = t.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/);
  if (m) return { day: +m[1], month: +m[2], year: m[3] ? +(m[3].length === 2 ? `19${m[3]}` : m[3]) : undefined };
  const mon = MONTHS.findIndex((x) => t.includes(x)) + 1;
  const nums = t.match(/\d+/g)?.map(Number) || [];
  if (mon) {
    const day = nums.find((n) => n >= 1 && n <= 31), year = nums.find((n) => n > 1900);
    if (day) return { month: mon, day, year };
  }
  return null;
}
const valid = (p) => p && p.month >= 1 && p.month <= 12 && p.day >= 1 && p.day <= new Date(2024, p.month, 0).getDate();

// days until this person's next birthday (0 = today), and the age they turn
function next(p, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let year = today.getFullYear();
  const on = (y) => new Date(y, p.month - 1, p.month === 2 && p.day === 29 && new Date(y, 1, 29).getMonth() !== 1 ? 28 : p.day);
  if (on(year) < today) year += 1;
  const days = Math.round((on(year) - today) / 86_400_000);
  return { days, date: dayOf(on(year)), age: p.year ? year - p.year : null };
}
const label = (p) => `${p.name}${p.relation && norm(p.relation) !== norm(p.name) ? ` (his ${norm(p.relation)})` : ''}`;
const when = (n) => (n.days === 0 ? 'today' : n.days === 1 ? 'tomorrow' : `in ${n.days} days`);
const dateText = (p) => `${p.day} ${new Date(2024, p.month - 1, 1).toLocaleDateString('en-GB', { month: 'long' })}${p.year ? ` ${p.year}` : ''}`;

async function birthdaysTool(a) {
  const d = load();
  const who = String(a.name || '').trim();
  if (a.action === 'add') {
    if (!who) return "Error: name = whose birthday (their name, or 'dad' / 'sister' if that's what he calls them).";
    const p = parseDate(a.date);
    if (!valid(p)) return `Error: couldn't read the date "${a.date ?? ''}". Ask him the day and month.`;
    const kind = String(a.kind || 'birthday').trim().toLowerCase().slice(0, 40) || 'birthday';
    const old = d.people.find((x) => norm(x.name) === norm(who) && (x.kind || 'birthday') === kind);
    const entry = { id: old?.id || nextId(d.people), name: who.slice(0, 60), relation: String(a.relation || '').trim().slice(0, 40), kind, month: p.month, day: p.day, ...(p.year ? { year: p.year } : {}) };
    d.people = [...d.people.filter((x) => x !== old), entry];
    save(d);
    const n = next(entry);
    // the soonest one, worked out here (2026-11-23: asked "whose is next?" in the same message, she guessed wrong)
    const first = d.people.map((p) => ({ p, n: next(p) })).sort((x, y) => x.n.days - y.n.days)[0];
    return `${old ? 'Updated' : 'Saved'}: ${label(entry)}'s ${kind} is ${dateText(entry)} (${when(n)}${n.age && kind === 'birthday' ? `, turning ${n.age}` : ''}). You'll remind him a week before, the day before, and on the day. ` +
      `The next one coming up of all saved: ${label(first.p)}'s ${first.p.kind || 'birthday'} ${when(first.n)}.`;
  }
  if (a.action === 'list') {
    if (!d.people.length) return 'No birthdays saved yet.';
    const rows = d.people.map((p) => ({ p, n: next(p) })).sort((x, y) => x.n.days - y.n.days);
    return `Birthdays and dates, soonest first:\n${rows.map(({ p, n }) => `• ${label(p)}: ${p.kind || 'birthday'} ${dateText(p)}, ${when(n)}${n.age && (p.kind || 'birthday') === 'birthday' ? ` (turning ${n.age})` : ''}`).join('\n')}`;
  }
  if (a.action === 'remove') {
    const hit = d.people.filter((p) => norm(p.name) === norm(who) || norm(p.relation) === norm(who));
    if (!hit.length) return `No one called "${who}" is saved.`;
    d.people = d.people.filter((p) => !hit.includes(p));
    save(d);
    return `Removed: ${hit.map(label).join(', ')}.`;
  }
  return 'Error: action must be add, list or remove.';
}

export const BIRTHDAY_TOOLS = {
  birthdays: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'birthdays',
      description: "Birthdays and other dates (anniversaries, name days) of Chris's family and friends. add = save one (name: their name or what he calls them, like 'dad'; relation: e.g. sister; date: as he said it, e.g. '3 March' or '12/6/1965'; kind: birthday unless he says otherwise). " +
        'list = all of them, soonest first (also for "when is X\'s birthday"). remove = by name.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        name: { type: 'string' }, relation: { type: 'string' }, date: { type: 'string' }, kind: { type: 'string' },
      }, required: ['action'] },
    } },
    run: (a) => birthdaysTool(a),
  },
};

// ---------- the Birthdays page (dashboard /birthdays.html) ----------
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function birthdaysAll() {
  return load().people.map((p) => ({ ...p, kind: p.kind || 'birthday', next: next(p) })).sort((x, y) => x.next.days - y.next.days);
}
// add (no id) or edit one from the page: { name, relation, kind, month, day, year }
export function birthdayPut(id, b = {}) {
  const d = load();
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw fail('A name is needed.');
  const p = { month: Number(b.month), day: Number(b.day) };
  if (!valid(p)) throw fail('That date doesn\'t exist.');
  const year = Number(b.year);
  if (b.year && !(year > 1900 && year <= new Date().getFullYear())) throw fail('The birth year looks wrong.');
  const old = id ? d.people.find((x) => x.id === Number(id)) : null;
  if (id && !old) throw fail('No such birthday.', 404);
  const entry = { id: old?.id || nextId(d.people), name, relation: String(b.relation || '').trim().slice(0, 40), kind: String(b.kind || 'birthday').trim().toLowerCase().slice(0, 40) || 'birthday', ...p, ...(year ? { year } : {}) };
  d.people = [...d.people.filter((x) => x !== old), entry];
  save(d);
  return { ok: true, message: `${old ? 'Updated' : 'Saved'} ${name}'s ${entry.kind}.` };
}
export function birthdayDelete(id) {
  const d = load();
  const p = d.people.find((x) => x.id === Number(id));
  if (!p) throw fail('No such birthday.', 404);
  d.people = d.people.filter((x) => x !== p);
  save(d);
  return { ok: true, message: `Removed ${p.name}'s ${p.kind || 'birthday'}.` };
}

// for the morning brief: anything in the next two weeks
export function birthdaysSoon(days = 14) {
  return load().people.map((p) => ({ p, n: next(p) })).filter(({ n }) => n.days <= days).sort((x, y) => x.n.days - y.n.days)
    .map(({ p, n }) => `${label(p)}'s ${p.kind || 'birthday'} ${when(n)}${n.age && (p.kind || 'birthday') === 'birthday' ? ` (turning ${n.age})` : ''}`);
}

// once a minute (daily.js): from 9 am, a reminder a week before, the day before and on the day
export function birthdayTick(now = new Date()) {
  if (now.getHours() < 9) return;
  const d = load();
  let changed = false;
  for (const p of d.people) {
    const n = next(p, now);
    if (![7, 1, 0].includes(n.days)) continue;
    const key = `${p.id}:${n.date}:${n.days}`;
    if (d.sent[key]) continue;
    d.sent[key] = Date.now();
    changed = true;
    const what = `${label(p)}'s ${p.kind || 'birthday'}${n.age && (p.kind || 'birthday') === 'birthday' ? ` (turning ${n.age})` : ''}`;
    addReminder(n.days === 7 ? `${what} is in a week: time to think about a gift or card (offer to put it on his shopping list)`
      : n.days === 1 ? `${what} is tomorrow: gift and card ready?` : `It's ${what} today: remind him to call or message them`, Date.now());
  }
  // old marks go after a year
  for (const k of Object.keys(d.sent)) if (Date.now() - d.sent[k] > 370 * 86_400_000) { delete d.sent[k]; changed = true; }
  if (changed) save(d);
}
