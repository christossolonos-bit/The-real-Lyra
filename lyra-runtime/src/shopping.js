// Chris's shopping list (2026-11-23): a list he adds to by talking ("add milk and eggs"); "I'm at the supermarket"
// sends it to his phone as a DM; a receipt photo ticks off what he bought. Kept on this PC (data/shopping.json).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';

const SHOP = path.join(DATA_DIR, 'shopping.json');
const load = () => { try { return { items: [], ...JSON.parse(readFileSync(SHOP, 'utf8')) }; } catch { return { items: [] }; } };
const save = (d) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SHOP, JSON.stringify(d, null, 1)); };
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const items = (x) => (Array.isArray(x) ? x : String(x || '').split(/\s*(?:,|;|\band\b|\n)\s*/i)).map((s) => String(s).trim().replace(/^(some|a|an|the)\s+/i, '')).filter(Boolean);
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))); };

async function shoppingTool(a, ctx) {
  const d = load();
  const open = () => d.items.filter((i) => !i.done);
  const listText = () => (open().length ? open().map((i) => `• ${i.text}`).join('\n') : '(empty)');
  if (a.action === 'add') {
    const add = items(a.items ?? a.item ?? a.text);
    if (!add.length) return 'Error: what should go on the list (items)?';
    const added = [];
    for (const t of add) {
      if (open().some((i) => same(i.text, t))) continue;
      d.items.push({ id: nextId(d.items), text: t.slice(0, 80), at: Date.now(), done: false });
      added.push(t);
    }
    save(d);
    return `${added.length ? `Added: ${added.join(', ')}.` : 'Those are already on the list.'} The list now: ${open().map((i) => i.text).join(', ')}.`;
  }
  if (a.action === 'list') return open().length ? `His shopping list (${open().length}):\n${listText()}` : 'The shopping list is empty.';
  if (a.action === 'done' || a.action === 'remove') {
    const names = items(a.items ?? a.item ?? a.text);
    const hit = [];
    for (const i of open()) if (names.some((n) => same(i.text, n))) { if (a.action === 'done') { i.done = true; i.doneAt = Date.now(); } else i.removed = true; hit.push(i.text); }
    if (a.action === 'remove') d.items = d.items.filter((i) => !i.removed);
    save(d);
    return hit.length ? `${a.action === 'done' ? 'Ticked off' : 'Removed'}: ${hit.join(', ')}. Still on the list: ${open().map((i) => i.text).join(', ') || 'nothing'}.` : `None of those are on the list. It has: ${open().map((i) => i.text).join(', ') || 'nothing'}.`;
  }
  if (a.action === 'clear') { d.items = []; save(d); return 'The shopping list is cleared.'; }
  if (a.action === 'send') {
    if (!open().length) return 'The list is empty, nothing to send.';
    if (Date.now() - (d.sentAt || 0) < 2 * 60_000) return `Already sent the list to his phone a moment ago (${open().length} items); not sending it twice. Tell him it's on his phone.`;
    const owner = config.ownerIds[0];
    if (!ctx?.client || !owner) return `Discord isn't connected, so tell him the list instead:\n${listText()}`;
    await (await ctx.client.users.fetch(owner)).send(`🛒 Shopping list:\n${listText()}`);
    d.sentAt = Date.now();
    save(d);
    return `Sent the list (${open().length} items) to his phone as a DM. Tell him you've sent it, briefly.`;
  }
  return 'Error: action must be add, list, done, remove, clear or send.';
}

export const SHOPPING_TOOLS = {
  shopping: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'shopping',
      description: "Chris's shopping list. add = items he wants (items: a list or comma-separated); list = what's on it; done = ticks off what he bought (items; e.g. from a receipt photo); remove = takes items off; clear = empty it; send = DM the list to his phone (do this when he says he's at or going to the supermarket / shop).",
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['add', 'list', 'done', 'remove', 'clear', 'send'] },
        items: { type: 'array', items: { type: 'string' } },
      }, required: ['action'] },
    } },
    run: (a, ctx) => shoppingTool(a, ctx),
  },
};

// the shopping list for her prompt when a receipt comes in (attachments.js)
export function shoppingLine() {
  const open = load().items.filter((i) => !i.done);
  return open.length ? `His shopping list: ${open.map((i) => i.text).join(', ')}.` : '';
}

// ---------- the Shopping page (dashboard /shopping.html, 2026-11-25): see and edit the list ----------
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function shoppingSnapshot() {
  const d = load();
  return {
    open: d.items.filter((i) => !i.done),
    bought: d.items.filter((i) => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 20),
    sentAt: d.sentAt || null,
  };
}
export function shoppingAdd(text) {
  const d = load();
  const add = items(text);
  if (!add.length) throw fail('Type what to add.');
  const added = [];
  for (const t of add) {
    if (d.items.some((i) => !i.done && same(i.text, t))) continue;
    d.items.push({ id: nextId(d.items), text: t.slice(0, 80), at: Date.now(), done: false });
    added.push(t);
  }
  save(d);
  return { ok: true, message: added.length ? `Added ${added.join(', ')}.` : 'Already on the list.' };
}
export function shoppingEdit(id, { text, done } = {}) {
  const d = load();
  const it = d.items.find((i) => i.id === Number(id));
  if (!it) throw fail('No such item.', 404);
  if (text !== undefined) {
    const t = String(text).trim().slice(0, 80);
    if (!t) throw fail('The item needs a name.');
    it.text = t;
  }
  if (done !== undefined) {
    it.done = Boolean(done);
    if (it.done) it.doneAt = Date.now(); else delete it.doneAt;
  }
  save(d);
  return { ok: true, message: done === true ? `Ticked off ${it.text}.` : done === false ? `${it.text} is back on the list.` : 'Saved.' };
}
export function shoppingRemove(id) {
  const d = load();
  const it = d.items.find((i) => i.id === Number(id));
  if (!it) throw fail('No such item.', 404);
  d.items = d.items.filter((i) => i !== it);
  save(d);
  return { ok: true, message: `Removed ${it.text}.` };
}
export function shoppingClearBought() {
  const d = load();
  const n = d.items.filter((i) => i.done).length;
  d.items = d.items.filter((i) => !i.done);
  save(d);
  return { ok: true, message: n ? `Cleared ${n} bought item${n > 1 ? 's' : ''}.` : 'Nothing bought to clear.' };
}
// "Send to my phone" from the page: the same DM as at the supermarket (Discord has to be online)
export async function shoppingSend(client) {
  const d = load();
  d.sentAt = 0; // he pressed it on purpose: don't hold it back as "sent a moment ago"
  save(d);
  const r = await shoppingTool({ action: 'send' }, { client });
  if (/isn't connected|empty/i.test(r)) throw fail(r.split('\n')[0], 409);
  return { ok: true, message: 'Sent to your phone.' };
}
