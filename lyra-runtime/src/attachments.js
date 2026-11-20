// What Chris sends Lyra on Discord besides words (2026-11-20):
//  - voice messages: transcribed with her own speech-to-text, then answered as if he'd said it
//  - photos: looked at with her vision model (the same one as her webcam eyes)
//  - documents (PDF, Word, PowerPoint, Excel, text, code...): read, kept for follow-up questions
//    (data/documents, on this PC only; the documents tool reads or searches them later). Owner only.
// Python runs with -P -E: no stray files from the working folder, no environment overrides, but it still finds
// the packages installed for this user (pypdf), which -I would hide.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { transcribeSpeech } from './voice/stt.js';
import { momentLabel } from './time.js';

const DOCS = path.join(DATA_DIR, 'documents');
const INDEX = path.join(DOCS, 'index.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 25 * 1024 * 1024;
const IN_TURN = 24_000; // characters of a new document she reads straight away (the rest via the documents tool)
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|tsx|jsx|py|html?|css|xml|ya?ml|ini|toml|log|srt|vtt|sql|sh|bat|ps1|java|c|cpp|h|cs|go|rs|rb|php)$/i;
const DOC_EXT = /\.(pdf|docx|pptx|xlsx)$/i;

const index = () => { try { return JSON.parse(readFileSync(INDEX, 'utf8')); } catch { return []; } };
const saveIndex = (x) => { mkdirSync(DOCS, { recursive: true }); writeFileSync(INDEX, JSON.stringify(x, null, 1)); };

async function download(att) {
  if (att.size > MAX_BYTES) throw new Error(`${att.name} is ${(att.size / 1048576).toFixed(0)} MB; the limit is ${MAX_BYTES / 1048576} MB`);
  const res = await fetch(att.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`couldn't download ${att.name} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- voice messages ----------
function toPcm48k(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg couldn't read the voice message (${code})`))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}
export async function transcribeVoiceMessage(att) {
  const pcm = await toPcm48k(await download(att));
  return (await transcribeSpeech(pcm)) || '';
}

// ---------- photos ----------
async function lookAt(att, question) {
  const buf = await download(att);
  const mime = att.contentType?.split(';')[0] || 'image/jpeg';
  const res = await fetch(`${config.nvidia.baseUrl}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${config.nvidia.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.nvidia.model, max_tokens: 350, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Chris sent this photo${question ? ` with the message: "${question}"` : ''}. Describe plainly what's in it, read out any text in it, and note anything that matters for his message. 2 to 6 short sentences. Don't guess beyond what's visible.` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`vision ${res.status}`);
  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

// ---------- documents ----------
async function extract(att) {
  const buf = await download(att);
  if (TEXT_EXT.test(att.name)) return buf.toString('utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'lyra-doc-'));
  const file = path.join(dir, path.basename(att.name).replace(/[^\w.-]/g, '_'));
  writeFileSync(file, buf);
  try {
    const r = spawnSync(process.env.PYTHON || 'python', ['-P', '-E', path.join(HERE, 'docs_extract.py'), file], { encoding: 'utf8', maxBuffer: 1 << 27, timeout: 90_000, windowsHide: true });
    if (r.status !== 0) throw new Error(String(r.stderr || r.error?.message || 'unreadable').trim().split('\n').at(-1).slice(0, 200));
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function keep(att, text, conversation) {
  const list = index();
  const id = (list.reduce((m, d) => Math.max(m, d.id), 0) || 0) + 1;
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(path.join(DOCS, `${id}.txt`), text);
  const doc = { id, name: att.name, chars: text.length, words: (text.match(/\S+/g) || []).length, at: Date.now(), when: momentLabel(), conversation };
  list.push(doc);
  saveIndex(list);
  return doc;
}

// Everything attached to one message: { said: text to add to what he said, extra: what she reads this turn }
export async function readAttachments(message, { owner, conversation }) {
  const said = [], extra = [];
  const question = message.content?.trim() || '';
  for (const att of message.attachments.values()) {
    const type = att.contentType || '';
    try {
      if (type.startsWith('audio/') || message.flags?.has?.(1 << 13) /* IsVoiceMessage */) {
        const t = await transcribeVoiceMessage(att);
        said.push(t || '(a voice message she couldn\'t make out)');
        activity('heard', { voice: true, speaker: message.author.username, text: t, via: 'voice message' });
      } else if (type.startsWith('image/')) {
        const seen = await lookAt(att, question);
        said.push('(sent a photo)');
        extra.push(`He sent a photo. What you see in it (your own eyes, just now):\n${seen}`);
      } else if (TEXT_EXT.test(att.name) || DOC_EXT.test(att.name)) {
        if (!owner) { extra.push(`They sent a file ("${att.name}"). You only read files from Chris; say so kindly.`); continue; }
        const text = (await extract(att)).replace(/\r/g, '').trim();
        if (!text) { extra.push(`He sent "${att.name}" but there's no readable text in it (it may be scanned images). Tell him.`); continue; }
        const doc = keep(att, text, conversation);
        said.push(`(sent the file "${att.name}")`);
        extra.push(`Chris sent you a file: "${doc.name}" (about ${doc.words} words). ` +
          `${question ? 'Answer what he asked about it.' : "He didn't ask anything specific: tell him briefly what it's about and what stands out."} ` +
          `It's saved as document #${doc.id}; later you can read more or search it with your documents tool. Its text:\n<<<\n${text.slice(0, IN_TURN)}\n>>>` +
          (text.length > IN_TURN ? `\n(That's the first ${IN_TURN} characters of ${text.length}; use the documents tool for the rest.)` : ''));
        activity('document', { message: `Read "${doc.name}" (${doc.words} words) from ${message.author.username}` });
      } else {
        extra.push(`They attached "${att.name}" (${type || 'unknown type'}), which you can't open.`);
      }
    } catch (err) {
      extra.push(`They attached "${att.name}" but it couldn't be read: ${err.message}. Tell them plainly.`);
      activity('error', { where: 'attachment', message: `${att.name}: ${err.message}` });
    }
  }
  return { said: said.join(' '), extra: extra.join('\n\n') };
}

// files he's given her lately (named in her prompt, so she knows to look)
export function recentDocumentsLine(limit = 5) {
  const list = index().filter((d) => Date.now() - d.at < 14 * 86_400_000).slice(-limit);
  return list.length ? `Files Chris has given you lately (look inside with your documents tool): ${list.map((d) => `#${d.id} "${d.name}" (${d.when})`).join('; ')}.` : '';
}

// ---------- the documents tool ----------
function documentsTool({ action, id = 0, name = '', query = '', part = 0 }) {
  const list = index();
  if (action === 'search') return searchDocuments({ id, name, query });
  if (action === 'list') return list.length ? list.slice(-20).map((d) => `#${d.id} "${d.name}" ${d.words} words (${d.when})`).join('\n') : 'No files yet.';
  const doc = list.find((d) => d.id === Number(id)) || (name && [...list].reverse().find((d) => d.name.toLowerCase().includes(String(name).toLowerCase()))) || list.at(-1);
  if (!doc) return 'Error: no such file. Use list.';
  const text = readFileSync(path.join(DOCS, `${doc.id}.txt`), 'utf8');
  if (action === 'read') {
    const size = 20_000, n = Math.max(0, Number(part) || 0), parts = Math.ceil(text.length / size);
    return `"${doc.name}" part ${n + 1} of ${parts}:\n${text.slice(n * size, (n + 1) * size)}`;
  }
  return 'Error: action must be list, read or search.';
}

// Search: in the file he named, or across all his files when he didn't (newest first).
// Texts are cut into ~700-character passages on line breaks, scored by how many of the query's words they hold.
function searchDocuments({ id = 0, name = '', query = '' }) {
  const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [])];
  if (!words.length) return 'Error: search for what (query)?';
  const list = index();
  const named = list.find((d) => d.id === Number(id)) || (name && [...list].reverse().find((d) => d.name.toLowerCase().includes(String(name).toLowerCase())));
  const docs = named ? [named] : [...list].reverse();
  const hits = [];
  for (const doc of docs) {
    let text = '';
    try { text = readFileSync(path.join(DOCS, `${doc.id}.txt`), 'utf8'); } catch { continue; }
    const passages = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if (cur.length + line.length > 700 && cur) { passages.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) passages.push(cur);
    for (const p of passages) {
      const low = p.toLowerCase();
      const score = words.reduce((s, w) => s + (low.includes(w) ? 1 : 0), 0);
      if (score) hits.push({ doc, p: p.trim(), score });
    }
  }
  if (!hits.length) return named ? `Nothing in "${named.name}" matches that.` : `None of his ${list.length} files match that.`;
  return hits.sort((a, b) => b.score - a.score).slice(0, 6).map((h) => `From #${h.doc.id} "${h.doc.name}":\n${h.p.slice(0, 1500)}`).join('\n---\n');
}

export const DOCUMENT_TOOLS = {
  documents: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'documents',
      description: "Files Chris has sent you (PDFs, Word, slides, spreadsheets, text, code). list = what you have; read = a file's text, 20,000 characters per part (id or name, part 0, 1, 2...); search = the passages that match his question, across all his files unless he means a particular one (then id or name). read defaults to the latest file. Answer from what it actually says; quote briefly when it helps.",
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'read', 'search'] }, id: { type: 'number' }, name: { type: 'string' },
        query: { type: 'string' }, part: { type: 'number' },
      }, required: ['action'] },
    } },
    run: documentsTool,
  },
};
