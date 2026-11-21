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
//  - accounts (2026-11-21):
//    a balance he gives her, then his spending comes off his spending account (Bank, unless he says otherwise),
//    money in goes onto it, moving money between accounts moves it; savings and investing keep the value he gives
//    until he tells her a new one (she doesn't track markets or advise on them)
//  - add / take (2026-11-22): money put into or taken out of an account that
//    isn't spending or income (cash he put in the jar, cash he moved out), kept as adjustments
//  - the card account (2026-11-22): one
//    account can carry the card mark; spending comes off it unless he says cash or names another, and "card"
//    in what he says means it. Without a card mark, his spending-type account is used.
//  - the dashboard's Finance page reads and edits the same file (financeView, financeEdit)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

const FILE = path.join(DATA_DIR, 'finance.json');
export const CATEGORIES = ['groceries', 'eating out', 'fuel', 'transport', 'bills', 'subscriptions', 'home', 'health', 'shopping', 'fun', 'gifts', 'work', 'other'];
const EVERY = { week: [0, 7], month: [1, 0], '2 months': [2, 0], '3 months': [3, 0], '6 months': [6, 0], year: [12, 0] };

function load() {
  const blank = { expenses: [], bills: [], budgets: {}, warned: {}, summarized: '', accounts: [], income: [], transfers: [], adjustments: [] };
  try { return { ...blank, ...JSON.parse(readFileSync(FILE, 'utf8')) }; }
  catch { return blank; }
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

// ---------- accounts ----------
const KINDS = ['spending', 'savings', 'investing'];
const kindOf = (name, kind) => (KINDS.includes(kind) ? kind : /sav/i.test(name) ? 'savings' : /invest|stock|crypto|shares|etf/i.test(name) ? 'investing' : 'spending');
const open = (d) => d.accounts.filter((a) => a.active !== false);
function findAccount(d, x) {
  if (x === undefined || x === null || x === '') return null;
  const t = String(x).trim().toLowerCase().replace(/^(my|the)\s+/, '').replace(/\s+(account|acc)$/, '') || String(x).trim().toLowerCase();
  if (/^(debit |bank )?card$/.test(t)) return open(d).find((a) => a.card) || open(d).find((a) => a.name.toLowerCase().includes('card')) || null;
  return open(d).find((a) => a.id === Number(x)) || open(d).find((a) => a.name.toLowerCase() === t) || open(d).find((a) => a.name.toLowerCase().includes(t)) || null;
}
const spendingAccount = (d) => open(d).find((a) => a.card) || open(d).find((a) => a.kind === 'spending') || null;
// The model sometimes fills every field and carries "cash" over from an earlier message. When his message is
// known (ctx.userText) and doesn't mention the account she picked, the default (his card) is used.
function saidAccount(acc, text) {
  if (!acc || text === undefined || text === null) return true;
  const t = String(text).toLowerCase();
  if (acc.card && /\bcard\b/.test(t)) return true;
  return acc.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 3 && t.includes(w));
}
function markCard(d, acc, on) {
  for (const a of d.accounts) if (on && a !== acc) delete a.card;
  if (on) acc.card = true; else delete acc.card;
}
// the balance he gave, then everything recorded after it
export function balanceOf(d, a) {
  let b = a.balance;
  const after = (x) => (x.at || 0) >= a.asOf; // >=: something logged in the same millisecond still counts
  for (const e of d.expenses) if (e.account === a.id && after(e)) b -= e.amount;
  for (const i of d.income) if (i.account === a.id && after(i)) b += i.amount;
  for (const t of d.transfers) if (after(t)) { if (t.from === a.id) b -= t.amount; if (t.to === a.id) b += t.amount; }
  for (const x of d.adjustments) if (x.account === a.id && after(x)) b += x.amount;
  return Math.round(b * 100) / 100;
}
const accountsLine = (d) => {
  const list = open(d);
  if (!list.length) return '';
  const total = list.reduce((s, a) => s + balanceOf(d, a), 0);
  return `${list.map((a) => `${a.name} ${eur(balanceOf(d, a))}`).join(', ')} (${eur(total)} in all)`;
};
const accountName = (d, id) => d.accounts.find((a) => a.id === id)?.name || '';

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
  if (!cats.length) { const acc = accountsLine(d); return `Nothing spent logged for ${monthName(month)} yet.${acc ? ` Accounts now: ${acc}.` : ''}`; }
  const lines = cats.map(([c, v]) => `${c} ${eur(v)}${d.budgets[c] ? ` of ${eur(d.budgets[c])}` : ''}`);
  const left = d.budgets.total ? ` Budget: ${eur(d.budgets.total)} (${eur(d.budgets.total - total)} left).` : '';
  const income = d.income.filter((i) => monthOf(i.date) === month).reduce((s, i) => s + i.amount, 0);
  const accounts = accountsLine(d);
  return `${monthName(month)}: ${eur(total)} spent${last ? ` (last month ${eur(last)})` : ''}${income ? `, ${eur(income)} came in` : ''}.${left} By category: ${lines.join('; ')}.${accounts ? ` Accounts now: ${accounts}.` : ''}`;
}

// ---------- the tool ----------
function moneyTool(a, ctx) {
  const d = load();
  const act = a.action;
  // she often names the account in "account": for the account actions that's the name
  if (['account_set', 'account_remove'].includes(act) && !a.name && !a.id && a.account) a = { ...a, name: a.account };
  if (act === 'add' || act === 'take') {
    const amount = Math.abs(money(a.amount));
    if (!(amount > 0)) return 'Error: amount must be a number of euros.';
    const acc = findAccount(d, a.account || a.name);
    if (!acc) return `Error: ${a.account || a.name ? `no account called "${a.account || a.name}"` : 'which account (account)?'}. His accounts: ${open(d).map((x) => x.name).join(', ') || 'none yet'}.`;
    const x = { id: nextId(d.adjustments), account: acc.id, amount: act === 'add' ? amount : -amount, note: String(a.note || '').trim().slice(0, 200), date: a.date && isDate(a.date) ? a.date : today(), at: Date.now() };
    d.adjustments.push(x);
    save(d);
    return `${act === 'add' ? 'Added' : 'Took'} ${eur(amount)} ${act === 'add' ? 'to' : 'from'} ${acc.name}${x.note ? ` (${x.note})` : ''}: now ${eur(balanceOf(d, acc))}.`;
  }
  if (act === 'adjust_delete') {
    const x = d.adjustments.find((y) => y.id === Number(a.id));
    if (!x) return 'Error: no such entry.';
    d.adjustments = d.adjustments.filter((y) => y !== x);
    save(d);
    return `Undid ${x.amount > 0 ? 'adding' : 'taking'} ${eur(Math.abs(x.amount))} ${x.amount > 0 ? 'to' : 'from'} ${accountName(d, x.account)}.`;
  }
  if (act === 'spend') {
    const amount = money(a.amount);
    if (!(amount > 0)) return 'Error: amount must be a positive number of euros.';
    const date = a.date ? String(a.date).slice(0, 10) : today();
    if (!isDate(date)) return 'Error: date must be YYYY-MM-DD (Cyprus date), or leave it out for today.';
    const none = a.account === 'none'; // the page's "—": not from any account
    let acc = none ? null : a.account ? findAccount(d, a.account) : spendingAccount(d);
    if (a.account && !none && !acc) return `Error: no account called "${a.account}". Use accounts to see them.`;
    if (a.account && acc && !saidAccount(acc, ctx?.userText)) acc = spendingAccount(d); // he didn't say it this time
    const e = { id: nextId(d.expenses), amount, category: category(a.category), note: String(a.note || '').trim().slice(0, 200), date, at: Date.now(), source: a.source === 'receipt' ? 'receipt' : 'chat', account: acc?.id ?? null };
    d.expenses.push(e);
    const warn = warnings(d, monthOf(date));
    save(d);
    const left = acc ? ` ${acc.name} now ${eur(balanceOf(d, acc))}.` : '';
    activity('finance', { message: `Logged ${eur(amount)} ${e.category}${e.note ? ` (${e.note})` : ''}` });
    const { by } = totals(d, monthOf(date));
    return `Logged #${e.id}: ${eur(amount)} on ${e.category}${e.note ? `, ${e.note}` : ''}, ${date}${acc ? `, from ${acc.name}` : ''}. ${e.category} this month: ${eur(by[e.category])}${d.budgets[e.category] ? ` of ${eur(d.budgets[e.category])}` : ''}.${left}` +
      (warn.length ? ` Tell him: ${warn.join(' ')}` : '') + ' Confirm briefly.';
  }
  if (act === 'list') {
    const month = /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : monthOf(today());
    const cat = a.category ? category(a.category) : '';
    const rows = d.expenses.filter((e) => monthOf(e.date) === month && (!cat || e.category === cat)).sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id);
    const ins = cat ? [] : d.income.filter((i) => monthOf(i.date) === month);
    const out = rows.length ? `${monthName(month)}${cat ? `, ${cat}` : ''}:\n` + rows.slice(0, 40).map((e) => `#${e.id} ${e.date} ${eur(e.amount)} ${e.category}${e.note ? ` (${e.note})` : ''}`).join('\n') : `Nothing logged for ${monthName(month)}${cat ? ` in ${cat}` : ''}.`;
    return out + (ins.length ? `\nMoney in: ${ins.map((i) => `${i.date} ${eur(i.amount)}${i.note ? ` (${i.note})` : ''}`).join('; ')}` : '');
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
    if (a.account !== undefined) {
      if (a.account === '' || a.account === 0 || a.account === 'none') e.account = null;
      else { const acc = findAccount(d, a.account); if (!acc) return `Error: no account "${a.account}".`; e.account = acc.id; }
    }
    save(d);
    return `Updated #${e.id}: ${eur(e.amount)} ${e.category}${e.note ? ` (${e.note})` : ''}, ${e.date}${e.account ? `, from ${accountName(d, e.account)}` : ''}.`;
  }
  if (act === 'account_set') {
    const amount = money(a.amount);
    if (!Number.isFinite(amount)) return 'Error: amount = what is in the account now, in euros.';
    let acc = a.id ? d.accounts.find((x) => x.id === Number(a.id) && x.active !== false) : findAccount(d, a.name);
    if (a.id && !acc) return 'Error: no such account.';
    if (!acc) {
      const name = String(a.name || '').trim().slice(0, 60);
      if (!name) return 'Error: name the account (Bank, Revolut Savings...).';
      acc = { id: nextId(d.accounts), name, kind: kindOf(name, a.kind), balance: amount, asOf: Date.now(), date: today(), active: true };
      d.accounts.push(acc);
      save(d);
      return `Added ${acc.name} (${acc.kind}) with ${eur(amount)}.${acc.kind === 'spending' && spendingAccount(d) === acc ? ' His spending comes off this one unless he says otherwise.' : ''} Accounts: ${accountsLine(d)}.`;
    }
    if (a.id && a.name) acc.name = String(a.name).trim().slice(0, 60);
    if (a.kind && KINDS.includes(a.kind)) acc.kind = a.kind;
    if (a.card !== undefined) markCard(d, acc, a.card === true || a.card === 'true');
    acc.balance = amount;
    acc.asOf = Date.now();
    acc.date = today();
    save(d);
    return `${acc.name} set to ${eur(amount)}. Accounts: ${accountsLine(d)}.`;
  }
  if (act === 'card') {
    const acc = findAccount(d, a.account || a.name);
    if (!acc) return `Error: which account is his card on? His accounts: ${open(d).map((x) => x.name).join(', ')}.`;
    markCard(d, acc, true);
    save(d);
    return `His card is on ${acc.name}: card spending comes off it from now on.`;
  }
  if (act === 'accounts') {
    const list = open(d);
    return list.length ? list.map((a) => `${a.name} (${a.kind}${a.card ? ', his card' : ''}): ${eur(balanceOf(d, a))}`).join('\n') + `\nIn all: ${eur(list.reduce((s, a) => s + balanceOf(d, a), 0))}.` : 'No accounts yet. Ask him what he has (account_set).';
  }
  if (act === 'account_remove') {
    const acc = a.id ? d.accounts.find((x) => x.id === Number(a.id) && x.active !== false) : findAccount(d, a.name);
    if (!acc) return 'Error: no such account.';
    acc.active = false;
    save(d);
    return `Removed ${acc.name} from the accounts (its past spending stays logged).`;
  }
  if (act === 'income') {
    const amount = money(a.amount);
    if (!(amount > 0)) return 'Error: amount must be positive.';
    let acc = a.account ? findAccount(d, a.account) : spendingAccount(d);
    if (a.account && acc && !saidAccount(acc, ctx?.userText)) acc = spendingAccount(d) || acc;
    if (!acc) return a.account ? `Error: no account called "${a.account}".` : 'Error: set up his accounts first (account_set).';
    const date = a.date && isDate(a.date) ? a.date : today();
    const i = { id: nextId(d.income), amount, account: acc.id, note: String(a.note || '').trim().slice(0, 200), date, at: Date.now() };
    d.income.push(i);
    save(d);
    return `Money in #${i.id}: ${eur(amount)}${i.note ? ` (${i.note})` : ''} to ${acc.name}, now ${eur(balanceOf(d, acc))}.`;
  }
  if (act === 'income_delete') {
    const i = d.income.find((x) => x.id === Number(a.id));
    if (!i) return 'Error: no such money-in entry.';
    d.income = d.income.filter((x) => x !== i);
    save(d);
    return `Deleted money in #${i.id}: ${eur(i.amount)}${i.note ? ` (${i.note})` : ''}.`;
  }
  if (act === 'transfer') {
    const amount = money(a.amount);
    if (!(amount > 0)) return 'Error: amount must be positive.';
    const from = findAccount(d, a.from), to = findAccount(d, a.to);
    if (!from || !to || from === to) return 'Error: from and to must be two of his accounts (accounts lists them).';
    const t = { id: nextId(d.transfers), amount, from: from.id, to: to.id, note: String(a.note || '').trim().slice(0, 200), date: today(), at: Date.now() };
    d.transfers.push(t);
    save(d);
    return `Moved ${eur(amount)} from ${from.name} (now ${eur(balanceOf(d, from))}) to ${to.name} (now ${eur(balanceOf(d, to))}).`;
  }
  if (act === 'transfer_delete') {
    const t = d.transfers.find((x) => x.id === Number(a.id));
    if (!t) return 'Error: no such transfer.';
    d.transfers = d.transfers.filter((x) => x !== t);
    save(d);
    return `Undid the move of ${eur(t.amount)} from ${accountName(d, t.from)} to ${accountName(d, t.to)}.`;
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
      const e = { id: nextId(d.expenses), amount, category: b.category, note: b.name, date: a.date && isDate(a.date) ? a.date : today(), at: Date.now(), source: 'bill', bill: b.id, account: spendingAccount(d)?.id ?? null };
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
        "Accounts: account_set = what's in an account now (name, amount, kind spending / savings / investing; new name = new account); accounts = balances; account_remove. " +
        "Spending comes off the account his card is on unless he says cash (account 'cash') or names another; account 'card' = his card's account. Pass account ONLY when this message says how he paid (cash, card, an account name); never carry it over from an earlier message - left out, it's his card. card = which account his card is on (account). income = money he received (amount, note, account; default his card's account). " +
        "transfer = he moved money between his accounts (from, to, amount). " +
        "add / take = put money into or take it out of one account (account, amount, note), e.g. 'add 20 to my cash', 'take 50 out of savings' - not spending (that's spend) and not pay (that's income). " +
        "account_set is only for 'X is now N' (the new total, never the difference). Savings and investing keep the value he last gave you. " +
        "You don't track markets or give investment advice. " +
        "Log only what he actually tells you he spent; if a receipt or amount is unclear, ask before logging. Pass any budget warning on to him.",
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['spend', 'list', 'edit', 'delete', 'summary', 'budget', 'bill_add', 'bills', 'bill_edit', 'bill_cancel', 'bill_paid', 'account_set', 'accounts', 'account_remove', 'income', 'transfer', 'add', 'take', 'card'] },
        account: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string', enum: KINDS },
        amount: { type: 'number' }, category: { type: 'string' }, note: { type: 'string' }, date: { type: 'string' }, month: { type: 'string' },
        id: { type: 'number' }, name: { type: 'string' }, every: { type: 'string', enum: Object.keys(EVERY) }, next_due: { type: 'string' },
        log: { type: 'string', enum: ['auto', 'ask'] }, source: { type: 'string', enum: ['chat', 'receipt'] },
      }, required: ['action'] },
    } },
    run: (args, ctx) => moneyTool(args, ctx),
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
          d.expenses.push({ id: nextId(d.expenses), amount: b.amount, category: b.category, note: b.name, date: b.nextDue, at: Date.now(), source: 'bill', bill: b.id, account: spendingAccount(d)?.id ?? null });
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
    accounts: open(d).map((a) => ({ id: a.id, name: a.name, kind: a.kind, card: Boolean(a.card), balance: balanceOf(d, a), date: a.date })), kinds: KINDS,
    income: d.income.filter((i) => monthOf(i.date) === month).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).map((i) => ({ ...i, accountName: accountName(d, i.account) })),
    transfers: d.transfers.filter((t) => monthOf(t.date) === month).map((t) => ({ ...t, fromName: accountName(d, t.from), toName: accountName(d, t.to) })),
    adjustments: d.adjustments.filter((x) => monthOf(x.date) === month).map((x) => ({ ...x, accountName: accountName(d, x.account) })),
  };
}
// edits from the page go through the same checks as her tool
export function financeEdit(kind, op, id, body = {}) {
  const map = {
    expense: { add: 'spend', edit: 'edit', delete: 'delete' },
    bill: { add: 'bill_add', edit: 'bill_edit', delete: 'bill_cancel' },
    budget: { set: 'budget' },
    account: { add: 'account_set', edit: 'account_set', delete: 'account_remove' },
    income: { add: 'income', delete: 'income_delete' },
    transfer: { add: 'transfer', delete: 'transfer_delete' },
    adjust: { add: 'add', take: 'take', delete: 'adjust_delete' },
  };
  const action = map[kind]?.[op];
  if (!action) throw Object.assign(new Error('unknown edit'), { status: 400 });
  if (op !== 'add' && op !== 'set' && !(Number(id) > 0)) throw Object.assign(new Error('which expense?'), { status: 400 });
  const out = moneyTool({ ...body, action, id: id ? Number(id) : undefined, source: 'chat' });
  if (out.startsWith('Error')) throw Object.assign(new Error(out.replace(/^Error:\s*/, '')), { status: 400 });
  if (kind === 'expense' && op === 'add') {
    const d = load();
    const e = d.expenses.at(-1);
    if (e) { e.source = 'page'; save(d); }
  }
  return { ok: true, message: out.replace(/ (Tell him|Confirm briefly).*$/, '') };
}
