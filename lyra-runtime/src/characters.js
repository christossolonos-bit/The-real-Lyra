import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, updateSettings } from './config.js';
import { setPersona } from './persona.js';
import { activity } from './events.js';

// The avatar studio's cast. "main" is the bot itself: its name, persona and voice are the normal
// settings, so Discord and the dashboard stay in sync with it. Every other character lives in
// data/characters.json with its own name, persona, Fish voice and model (relative to data/).
const file = path.join(DATA_DIR, 'characters.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const MAX_MODEL_BYTES = 40 * 1024 * 1024;
const DEFAULT_EXTRAS = [{ id: 'leo', name: 'Leo', persona: '', voiceId: '', model: 'characters/leo.glb' }];

mkdirSync(AVATARS_DIR, { recursive: true });

let extras = DEFAULT_EXTRAS;
try {
  if (existsSync(file)) extras = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.warn('Ignoring unreadable data/characters.json:', err.message);
}
const saveExtras = () => writeFileSync(file, JSON.stringify(extras, null, 2));

function normalizeLook(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const key of ['skin', 'eyes', 'hair', 'clothes']) {
    const c = v[key];
    if (typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c.trim())) {
      out[key] = c.trim().startsWith('#') ? c.trim() : `#${c.trim()}`;
    }
  }
  return out;
}

export function list() {
  return [
    {
      id: 'main',
      main: true,
      name: config.botName,
      persona: config.persona,
      voiceId: config.fish.voiceId || '',
      modelPath: config.avatar.path,
      look: { ...config.avatar.look },
    },
    ...extras.map((c) => ({
      ...c,
      main: false,
      modelPath: path.join(DATA_DIR, c.model),
      look: { ...(c.look || {}) },
    })),
  ];
}

export const get = (id) => list().find((c) => c.id === id) ?? null;

export function update(id, { name, persona, voiceId, look, model }, changedBy = 'dashboard') {
  if (id === 'main') {
    setPersona({ name, persona, reason: 'Edited in avatar studio', changedBy });
    const patch = {};
    if (voiceId !== undefined) patch.fishVoiceId = voiceId;
    if (look !== undefined) patch.avatarLook = normalizeLook(look);
    if (typeof model === 'string' && model.trim()) patch.avatarPath = model.trim().replace(/\\/g, '/');
    if (Object.keys(patch).length) updateSettings(patch);
    return get('main');
  }
  const c = extras.find((x) => x.id === id);
  if (!c) return null;
  if (typeof name === 'string' && name.trim()) c.name = name.trim();
  if (typeof persona === 'string') c.persona = persona.trim();
  if (typeof voiceId === 'string') c.voiceId = voiceId.trim();
  if (look !== undefined) c.look = normalizeLook(look);
  if (typeof model === 'string' && model.trim() && !model.includes('..')) {
    c.model = model.trim().replace(/\\/g, '/');
  }
  saveExtras();
  activity('persona', { reason: `${c.name} edited`, changedBy, name: c.name });
  return get(id);
}

function safeAvatarName(name) {
  const base = path.basename(String(name || 'avatar')).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const stem = base.replace(/\.gl(?:tf|b)$/i, '') || 'avatar';
  return `${stem}.glb`;
}

export function library() {
  const files = [];
  // Include the classic default if present.
  const def = path.join(DATA_DIR, 'avatar.glb');
  if (existsSync(def)) {
    const st = statSync(def);
    files.push({ file: 'avatar.glb', bytes: st.size, mtime: st.mtimeMs });
  }
  for (const name of readdirSync(AVATARS_DIR)) {
    if (!/\.glb$/i.test(name)) continue;
    const full = path.join(AVATARS_DIR, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    files.push({ file: `avatars/${name}`, bytes: st.size, mtime: st.mtimeMs });
  }
  // Also list character folder models so they can be reused.
  const charsDir = path.join(DATA_DIR, 'characters');
  if (existsSync(charsDir)) {
    for (const name of readdirSync(charsDir)) {
      if (!/\.glb$/i.test(name)) continue;
      const full = path.join(charsDir, name);
      const st = statSync(full);
      if (!st.isFile()) continue;
      files.push({ file: `characters/${name}`, bytes: st.size, mtime: st.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

// Save a .glb into data/avatars/ and point the character at it.
export function saveModel(id, buffer, filename = 'upload.glb') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error('Empty model upload'), { status: 400 });
  }
  if (buffer.length > MAX_MODEL_BYTES) {
    throw Object.assign(new Error(`Model too large (max ${MAX_MODEL_BYTES / 1024 / 1024} MB)`), { status: 413 });
  }
  // glTF binary magic "glTF"
  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw Object.assign(new Error('Not a .glb file'), { status: 400 });
  }
  const c = get(id);
  if (!c) throw Object.assign(new Error('No such character'), { status: 404 });

  let name = safeAvatarName(filename);
  let dest = path.join(AVATARS_DIR, name);
  if (existsSync(dest)) {
    const stamp = Date.now().toString(36);
    name = safeAvatarName(name.replace(/\.glb$/i, `-${stamp}.glb`));
    dest = path.join(AVATARS_DIR, name);
  }
  writeFileSync(dest, buffer);
  const rel = `avatars/${name}`;
  if (id === 'main') {
    updateSettings({ avatarPath: rel });
  } else {
    const row = extras.find((x) => x.id === id);
    if (!row) throw Object.assign(new Error('No such character'), { status: 404 });
    row.model = rel;
    saveExtras();
  }
  activity('settings', { message: `Avatar model saved for ${c.name}: ${rel}` });
  return get(id);
}

export function useLibraryModel(id, relFile) {
  const rel = String(relFile || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || !/\.glb$/i.test(rel)) {
    throw Object.assign(new Error('Invalid library file'), { status: 400 });
  }
  const full = path.join(DATA_DIR, rel);
  if (!existsSync(full)) throw Object.assign(new Error('No such library file'), { status: 404 });
  const c = get(id);
  if (!c) throw Object.assign(new Error('No such character'), { status: 404 });
  if (id === 'main') updateSettings({ avatarPath: rel });
  else {
    const row = extras.find((x) => x.id === id);
    if (!row) throw Object.assign(new Error('No such character'), { status: 404 });
    row.model = rel;
    saveExtras();
  }
  activity('settings', { message: `Avatar model switched for ${c.name}: ${rel}` });
  return get(id);
}

export { MAX_MODEL_BYTES, AVATARS_DIR };

// Who a message is for: the character named earliest in it ("Leo, what do you think?"),
// otherwise whoever the person was already talking to.
export function addressee(text, fallbackId) {
  let best = null;
  for (const c of list()) {
    const name = c.name?.trim();
    if (!name || c.solo) continue; // solo characters are only talked to on their own page
    const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(text);
    if (m && (!best || m.index < best.index)) best = { id: c.id, index: m.index };
  }
  return best?.id ?? (get(fallbackId) ? fallbackId : 'main');
}

// Each character's emotional state is kept separately; "avatar" is the main one's (from before
// there was a cast) so her existing mood carries over.
export const emotionKey = (id) => (id === 'main' ? 'avatar' : `avatar:${id}`);
