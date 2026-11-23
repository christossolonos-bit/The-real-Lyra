// Chris's diary (2026-11-23): the nightly wrap-up is one entry a day (daily.js); he can also tell her things to
// write in it any time ("write in my diary…"). He can read it back ("what did I do last Tuesday", "read me this
// week"), search it, and on Sunday nights she gives him a short recap of his week. Kept on this PC (data/diary.json).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { journalEntries } from './daily.js';

const FILE = path.join(DATA_DIR, 'diary.json');
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const addDays = (date, n) => { const t = new Date(`${date}T12:00`); t.setDate(t.getDate() + n); return dayOf(t); };
const nice = (date) => new Date(`${date}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00`));
const load = () => { try { return { entries: [], ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { entries: [] }; } };
const save = (d) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 1)); };

// every entry, oldest first: his own notes and the nightly wrap-ups
function all() {
  const notes = load().entries.map((e) => ({ date: e.date, text: e.text, kind: 'note', at: e.at }));
  const wraps = journalEntries().map((j) => ({ date: j.date, text: `${j.summary}${j.feeling ? ` (felt ${j.feeling})` : ''}`, kind: 'day', at: j.at || 0 }));
  return [...notes, ...wraps].sort((a, b) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1));
}
const show = (list) => {
  const byDay = new Map();
  for (const e of list) byDay.set(e.date, [...(byDay.get(e.date) || []), e.text]);
  return [...byDay].map(([date, texts]) => `${nice(date)}: ${texts.join(' / ')}`).join('\n');
};

export function weekDiary(end = dayOf()) {
  const from = addDays(end, -6);
  return all().filter((e) => e.date >= from && e.date <= end);
}

async function diaryTool(a) {
  if (a.action === 'write') {
    const text = String(a.text || '').trim().slice(0, 1500);
    if (!text) return 'Error: text = what to write in his diary, in his words.';
    const date = isDate(a.date) ? a.date : dayOf();
    const d = load();
    d.entries.push({ date, text, at: Date.now() });
    save(d);
    return `Written in his diary for ${nice(date)}. Tell him briefly.`;
  }
  if (a.action === 'read') {
    let from, to;
    if (isDate(a.date)) from = to = a.date;
    else { to = dayOf(); from = addDays(to, -Math.max(1, Math.min(60, Number(a.days) || 7)) + 1); }
    if (isDate(a.to)) to = a.to;
    const list = all().filter((e) => e.date >= from && e.date <= to);
    return list.length ? `His diary, ${nice(from)}${from !== to ? ` to ${nice(to)}` : ''}:\n${show(list)}\n(Tell him in your own words, warmly; don't read it out like a list.)`
      : `Nothing in his diary for ${from === to ? nice(from) : `${nice(from)} to ${nice(to)}`}.`;
  }
  if (a.action === 'search') {
    const words = String(a.text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    if (!words.length) return 'Error: text = what to look for.';
    const hits = all().filter((e) => words.some((w) => e.text.toLowerCase().includes(w))).slice(-15);
    return hits.length ? `Diary entries about "${a.text}":\n${show(hits)}` : `Nothing in his diary about "${a.text}".`;
  }
  if (a.action === 'week') {
    const list = weekDiary();
    return list.length ? `His diary this past week:\n${show(list)}\n(Give him a short, warm recap of his week: the highs, the lows, anything that came up more than once.)` : 'His diary is empty for the past week.';
  }
  return 'Error: action must be write, read, search or week.';
}

export const DIARY_TOOLS = {
  diary: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'diary',
      description: "Chris's diary (his nightly wrap-ups plus anything he asks you to write in it). write = add an entry (text in his words; date YYYY-MM-DD if it's about another day, else today); " +
        'read = entries for a day (date) or the last N days (days); search = entries mentioning something (text); week = the past 7 days, for a recap of his week.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['write', 'read', 'search', 'week'] },
        text: { type: 'string' }, date: { type: 'string' }, to: { type: 'string' }, days: { type: 'number' },
      }, required: ['action'] },
    } },
    run: (a) => diaryTool(a),
  },
};
