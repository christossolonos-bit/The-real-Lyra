// Chris's personal finance tracker (2026-11-21): Lyra keeps his spending as he tells her (typed, voice messages,
// receipt photos), his subscriptions and recurring bills, monthly budgets, and gives summaries and warnings.
// A bookkeeper, not an adviser: she records, totals, reminds and warns; she doesn't give investment advice and
// isn't connected to any bank. Everything stays on this PC (data/finance.json), in Cyprus time, in euros.
//
//  - money tool (owner only): spend, list, edit, delete, summary, budget, bill_add, bills, bill_edit, bill_paid, bill_cancel
//  - bills: a reminder the day before each one is due (her normal reminders: Discord DM, hologram), logged as spent
//    on the day (unless he set it to "ask"), then moved to the next due date
//  - budget warnings at 80% and 100% of a category's monthly budget (or the total)
//  - a short summary of last month on the 1st, in a DM
//  - the dashboard's Finance page reads and edits the same file (financeView, financeEdit)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

const FILE = path.join(DATA_DIR, 'finance.json');
export const CATEGORIES = ['groceries', 'eating out', 'fuel', 'transport', 'bills', 'subscriptions', 'home', 'health', 'shopping', 'fun', 'gifts', 'work', 'other'];
const EVERY = { week: [0, 7], month: [1, 0], '2 months': [2, 0], '3 months': [3, 0], '6 months': [6, 0], year: [12, 0] };

function load() {
  try { return { expenses: [], bills: [], budgets: {}, warned: {}, summarized: '', ...JSON.parse(readFileSync(FILE, 'utf8')) }; }
  catch { return { expenses: [], bills: [], budgets: {}, warned: {}, summarized: '' }; }
}
function save(d) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 1)); }
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const pad = (n) => String(n).padStart(2, '0');
// dates are Cyprus dates (the runtime runs on Europe/Nicosia)
export const today = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const monthOf = (date) => String(date).slice(0, 7);
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`; };
const monthName = (m) => new Date(`${m}-15T12:00`).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
const eur = (n) => `€${(Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '')}`;
const money = (x) => { const n = Math.round(Number(String(x ?? '').replace(/[€,\s]|eur(os?)?/gi, '')) * 100) / 100; return Number.isFinite(n) ? n : NaN; };
const category = (c) => {
  const t = String(c || '').trim().toLowerCase();
  if (!t) return 'other';
  const alias = { food: 'groceries', supermarket: 'groceries', restaurant: 'eating out', takeaway: 'eating out', coffee: 'eating out', lunch: 'eating out', dinner: 'eating out', petrol: 'fuel', gas: 'fuel', diesel: 'fuel', bus: 'transport', taxi: 'transport', parking: 'transport', rent: 'home', electricity: 'bills', water: 'bills', internet: 'bills', phone: 'bills', subscription: 'subscriptions', streaming: 'subscriptions', doctor: 'health', pharmacy: 'health', clothes: 'shopping' };
  return alias[t] || t.slice(0, 40);
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00`));
function addPeriod(date, every) {
  const [months, days] = EVERY[every] || EVERY.month;
  const d = new Date(`${date}T12:00`);
  if (months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  if (days) d.setDate(d.getDate() + days);
  return today(d);
}

// a bill's cost per month (weekly ones: 52 a year)
const perMonth = (b) => (b.every === 'week' ? b.amount * 52 / 12 : b.amount / EVERY[b.every][0]);

// ---------- totals ----------
function totals(d, month) {
  const by = {};
  let total = 0;
  for (const e of d.expenses) {
    if (monthOf(e.date) !== month) continue;
    by[e.category] = (by[e.category] || 0) + e.amount;
    total += e.amount;
  }
  return { by, total: Math.round(total * 100) / 100 };
}
// budget warnings crossed by the latest spending (each 80% / 100% once per month)
function warnings(d, month) {
  const { by, total } = totals(d, month);
  const out = [];
  for (const [cat, limit] of Object.entries(d.budgets)) {
    if (!(limit > 0)) continue;
    const spent = cat === 'total' ? total : (by[cat] || 0);
    for (const level of [100, 80]) {
      if (spent < limit * level / 100) continue;
      const key = `${month}:${cat}:${level}`;
      if (!d.warned[key]) {
        d.warned[key] = Date.now();
        out.push(level === 100
          ? `Over budget: ${cat === 'total' ? 'total spending' : cat} is at ${eur(spent)} of ${eur(limit)} this month.`
          : `Heads up: ${cat === 'total' ? 'total spending' : cat} is at ${eur(spent)}, ${Math.round(spent / limit * 100)}% of the ${eur(limit)} budget.`);
      }
      break;
    }
  }
  return out;
}
export function summaryText(month = monthOf(today())) {
  const d = load();
  const { by, total } = totals(d, month);
  const last = totals(d, prevMonth(month)).total;
  const cats = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (!cats.length) return `Nothing logged for ${monthName(month)}.`;
  const lines = cats.map(([c, v]) => `${c} ${eur(v)}${d.budgets[c] ? ` of ${eur(d.budgets[c])}` : ''}`);
  const left = d.budgets.total ? ` Budget: ${eur(d.budgets.total)} (${eur(d.budgets.total - total)} left).` : '';
  return `${monthName(month)}: ${eur(total)} spent${last ? ` (last month ${eur(last)})` : ''}.${left} By category: ${lines.join('; ')}.`;
}

// ---------- the tool ----------
function moneyTool(a) {
  const d = load();
  const act = a.action;
  if (act === 'spend') {
    const amount = money(a.amount);
    if (!(amount > 0)) return 'Error: amount must be a positive number of euros.';
    const date = a.date ? String(a.date).slice(0, 10) : today();
    if (!isDate(date)) return 'Error: date must be YYYY-MM-DD (Cyprus date), or leave it out for today.';
    const e = { id: nextId(d.expenses), amount, category: category(a.category), note: String(a.note || '').trim().slice(0, 200), date, at: Date.now(), source: a.source === 'receipt' ? 'receipt' : 'chat' };
    d.expenses.push(e);
    const warn = warnings(d, monthOf(date));
    save(d);
    activity('finance', { message: `Logged ${eur(amount)} ${e.category}${e.note ? ` (${e.note})` : ''}` });
    const { by } = totals(d, monthOf(date));
    return `Logged #${e.id}: ${eur(amount)} on ${e.category}${e.note ? `, ${e.note}` : ''}, ${date}. ${e.category} this month: ${eur(by[e.category])}${d.budgets[e.category] ? ` of ${eur(d.budgets[e.category])}` : ''}.` +
      (warn.length ? ` Tell him: ${warn.join(' ')}` : '') + ' Confirm briefly.';
  }
  if (act === 'list') {
    const month = /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : monthOf(today());
    const cat = a.category ? category(a.category) : '';
    const rows = d.expenses.filter((e) => monthOf(e.date) === month && (!cat || e.category === cat)).sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id);
    return rows.length ? `${monthName(month)}${cat ? `, ${cat}` : ''}:\n` + rows.slice(0, 40).map((e) => `#${e.id} ${e.date} ${eur(e.amount)} ${e.category}${e.note ? ` (${e.note})` : ''}`).join('\n') : `Nothing logged for ${monthName(month)}${cat ? ` in ${cat}` : ''}.`;
  }
  if (act === 'edit' || act === 'delete') {
    const e = d.expenses.find((x) => x.id === Number(a.id)) || (!a.id && d.expenses.at(-1));
    if (!e) return 'Error: no such expense. Use list to find its id.';
    if (act === 'delete') {
      d.expenses = d.expenses.filter((x) => x !== e);
      save(d);
      return `Deleted #${e.id}: ${eur(e.amount)} ${e.category} on ${e.date}.`;
    }
    if (a.amount !== undefined) { const n = money(a.amount); if (!(n > 0)) return 'Error: amount must be positive.'; e.amount = n; }
    if (a.category) e.category = category(a.category);
    if (a.note !== undefined) e.note = String(a.note).slice(0, 200);
    if (a.date) { if (!isDate(a.date)) return 'Error: date must be YYYY-MM-DD.'; e.date = a.date; }
    save(d);
    return `Updated #${e.id}: ${eur(e.amount)} ${e.category}${e.note ? ` (${e.note})` : ''}, ${e.date}.`;
  }
  if (act === 'summary') return summaryText(/^\d{4}-\d{2}$/.test(a.month || '') ? a.month : monthOf(today())) +
    ' Say it conversationally, point out what stands out (biggest category, changes from last month, budgets close to the limit).';
  if (act === 'budget') {
    const cat = String(a.category || '').trim().toLowerCase() === 'total' ? 'total' : category(a.category);
    const n = money(a.amount);
    if (!(n >= 0)) return 'Error: amount must be a number of euros per month (0 removes the budget).';
    if (n === 0) delete d.budgets[cat]; else d.budgets[cat] = n;
    save(d);
    const { by, total } = totals(d, monthOf(today()));
    return n ? `Budget for ${cat}: ${eur(n)} a month (so far this month ${eur(cat === 'total' ? total : by[cat] || 0)}).` : `Budget for ${cat} removed.`;
  }
  if (act === 'bill_add') {
    const amount = money(a.amount);
    if (!String(a.name || '').trim()) return 'Error: name the bill or subscription.';
    if (!(amount > 0)) return 'Error: amount must be positive (an estimate is fine for bills that vary).';
    const every = EVERY[a.every] ? a.every : 'month';
    let due = a.next_due && isDate(a.next_due) ? a.next_due : null;
    if (!due) return 'Error: next_due must be the next date it is charged, YYYY-MM-DD (work it out from today in your prompt, e.g. "on the 5th" = the coming 5th).';
    while (due < today()) due = addPeriod(due, every);
    const b = { id: nextId(d.bills), name: String(a.name).trim().slice(0, 80), amount, category: a.category ? category(a.category) : 'subscriptions', every, nextDue: due, log: a.log === 'ask' ? 'ask' : 'auto', active: true, reminded: '' };
    d.bills.push(b);
    save(d);
    return `Added #${b.id}: ${b.name}, ${eur(amount)} every ${every}, next on ${due}. You'll remind him the day before${b.log === 'auto' ? " and log it as spent on the day" : ', and ask him the amount on the day'}.`;
  }
  if (act === 'bills') {
    const open = d.bills.filter((b) => b.active).sort((x, y) => x.nextDue.localeCompare(y.nextDue));
    if (!open.length) return 'No bills or subscriptions set up.';
    const monthly = open.reduce((s, b) => s + perMonth(b), 0);
    return open.map((b) => `#${b.id} ${b.name}: ${eur(b.amount)} every ${b.every}, next ${b.nextDue} (${b.category})`).join('\n') + `\nAbout ${eur(monthly)} a month in total.`;
  }
  if (act === 'bill_edit' || act === 'bill_cancel' || act === 'bill_paid') {
    const b = d.bills.find((x) => x.id === Number(a.id) && x.active) || (a.name && d.bills.find((x) => x.active && x.name.toLowerCase().includes(String(a.name).toLowerCase())));
    if (!b) return 'Error: no such bill. Use bills to see them.';
    if (act === 'bill_cancel') { b.active = false; save(d); return `Stopped tracking ${b.name}. (Remind him to cancel it with the company too if he hasn't.)`; }
    if (act === 'bill_paid') {
      const amount = a.amount !== undefined ? money(a.amount) : b.amount;
      if (!(amount > 0)) return 'Error: amount must be positive.';
      const e = { id: nextId(d.expenses), amount, category: b.category, note: b.name, date: a.date && isDate(a.date) ? a.date : today(), at: Date.now(), source: 'bill', bill: b.id };
      d.expenses.push(e);
      if (b.waiting) delete b.waiting; else b.nextDue = addPeriod(b.nextDue, b.every);
      const warn = warnings(d, monthOf(e.date));
      save(d);
      return `Logged ${b.name}: ${eur(amount)} (#${e.id}). Next one ${b.nextDue}.` + (warn.length ? ` Tell him: ${warn.join(' ')}` : '');
    }
    if (a.amount !== undefined) { const n = money(a.amount); if (!(n > 0)) return 'Error: amount must be positive.'; b.amount = n; }
    if (a.name && a.id) b.name = String(a.name).slice(0, 80);
    if (a.category) b.category = category(a.category);
    if (a.every && EVERY[a.every]) b.every = a.every;
    if (a.next_due) { if (!isDate(a.next_due)) return 'Error: next_due must be YYYY-MM-DD.'; b.nextDue = a.next_due; b.reminded = ''; }
    if (a.log) b.log = a.log === 'ask' ? 'ask' : 'auto';
    save(d);
    return `Updated ${b.name}: ${eur(b.amount)} every ${b.every}, next ${b.nextDue}.`;
  }
  return 'Error: unknown action.';
}

export const FINANCE_TOOLS = {
  money: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'money',
      description: "Chris's spending tracker (you're his bookkeeper, not a financial adviser; euros, Cyprus dates). " +
        "spend = log something he spent (amount, category, note, date YYYY-MM-DD if not today; source 'receipt' if from a receipt photo he confirmed). Categories: " + CATEGORIES.join(', ') + '. ' +
        'list = expenses of a month (month YYYY-MM, category). edit / delete = by id (from list; no id = the last one logged). ' +
        'summary = a month\'s totals by category vs budgets and last month. budget = set a monthly budget (category or "total", amount; 0 removes). ' +
        'bill_add = a subscription or recurring bill (name, amount, every: week / month / 2 months / 3 months / 6 months / year, next_due YYYY-MM-DD, category, log "auto" to log it on the day or "ask" for bills that vary). ' +
        'bills = list them. bill_edit / bill_cancel = by id or name. bill_paid = log a bill now (amount if it differed). ' +
        "Log only what he actually tells you he spent; if a receipt or amount is unclear, ask before logging. Pass any budget warning on to him.",
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['spend', 'list', 'edit', 'delete', 'summary', 'budget', 'bill_add', 'bills', 'bill_edit', 'bill_cancel', 'bill_paid'] },
        amount: { type: 'number' }, category: { type: 'string' }, note: { type: 'string' }, date: { type: 'string' }, month: { type: 'string' },
        id: { type: 'number' }, name: { type: 'string' }, every: { type: 'string', enum: Object.keys(EVERY) }, next_due: { type: 'string' },
        log: { type: 'string', enum: ['auto', 'ask'] }, source: { type: 'string', enum: ['chat', 'receipt'] },
      }, required: ['action'] },
    } },
    run: moneyTool,
  },
};

// ---------- bills, warnings and the monthly summary, in the background ----------
// remind(text, dueMs): a normal reminder (personal.js); dm(text): a Discord DM to Chris
export function startFinance({ remind, dm }) {
  const tick = async () => {
    const d = load();
    const now = new Date();
    const t = today(now);
    let changed = false;
    const notes = [];
    for (const b of d.bills) {
      if (!b.active) continue;
      // the day before (from 10 am): a reminder through her normal reminders
      const before = today(new Date(new Date(`${b.nextDue}T12:00`).getTime() - 86_400_000));
      if (b.reminded !== b.nextDue && t >= before && now.getHours() >= 10) {
        b.reminded = b.nextDue;
        changed = true;
        try { await remind(`${b.name} (${eur(b.amount)}) is due ${t === b.nextDue ? 'today' : 'tomorrow'}`, Date.now()); } catch (err) { activity('error', { where: 'finance', message: err.message }); }
      }
      // on the day: logged as spent (or he's asked, for bills that vary), and moved to the next date
      if (t >= b.nextDue && !b.waiting) {
        if (b.log === 'auto') {
          d.expenses.push({ id: nextId(d.expenses), amount: b.amount, category: b.category, note: b.name, date: b.nextDue, at: Date.now(), source: 'bill', bill: b.id });
          notes.push(...warnings(d, monthOf(b.nextDue)));
          activity('finance', { message: `Logged ${b.name} ${eur(b.amount)} (due ${b.nextDue})` });
          b.nextDue = addPeriod(b.nextDue, b.every);
        } else {
          b.waiting = b.nextDue;
          b.nextDue = addPeriod(b.nextDue, b.every);
          notes.push(`${b.name} was due today. How much was it this time? (I'll log it when you tell me.)`);
        }
        changed = true;
      }
    }
    // the 1st, from 10 am: last month in a few lines
    const month = monthOf(t);
    if (t.endsWith('-01') && now.getHours() >= 10 && d.summarized !== month) {
      d.summarized = month;
      changed = true;
      if (d.expenses.some((e) => monthOf(e.date) === prevMonth(month))) notes.push(`📊 ${summaryText(prevMonth(month))}`);
    }
    if (changed) save(d);
    for (const n of notes) { try { await dm(n); } catch (err) { activity('error', { where: 'finance', message: err.message }); } }
  };
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 10 * 60_000).unref();
}

// ---------- the dashboard's Finance page ----------
export function financeView(month = monthOf(today())) {
  const d = load();
  if (!/^\d{4}-\d{2}$/.test(month)) month = monthOf(today());
  const { by, total } = totals(d, month);
  const months = [...new Set([monthOf(today()), ...d.expenses.map((e) => monthOf(e.date))])].sort().reverse();
  const last6 = [];
  for (let m = month, i = 0; i < 6; i++, m = prevMonth(m)) last6.unshift({ month: m, total: totals(d, m).total });
  return {
    month, monthName: monthName(month), months, categories: CATEGORIES, everyOptions: Object.keys(EVERY),
    expenses: d.expenses.filter((e) => monthOf(e.date) === month).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    byCategory: by, total, lastMonth: totals(d, prevMonth(month)).total, history: last6,
    budgets: d.budgets, bills: d.bills.filter((b) => b.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue)),
  };
}
// edits from the page go through the same checks as her tool
export function financeEdit(kind, op, id, body = {}) {
  const map = {
    expense: { add: 'spend', edit: 'edit', delete: 'delete' },
    bill: { add: 'bill_add', edit: 'bill_edit', delete: 'bill_cancel' },
    budget: { set: 'budget' },
  };
  const action = map[kind]?.[op];
  if (!action) throw Object.assign(new Error('unknown edit'), { status: 400 });
  if (kind === 'expense' && op !== 'add' && !(Number(id) > 0)) throw Object.assign(new Error('which expense?'), { status: 400 });
  const out = moneyTool({ ...body, action, id: id ? Number(id) : undefined, source: 'chat' });
  if (out.startsWith('Error')) throw Object.assign(new Error(out.replace(/^Error:\s*/, '')), { status: 400 });
  if (kind === 'expense' && op === 'add') {
    const d = load();
    const e = d.expenses.at(-1);
    if (e) { e.source = 'page'; save(d); }
  }
  return { ok: true, message: out.replace(/ (Tell him|Confirm briefly).*$/, '') };
}
