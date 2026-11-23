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
