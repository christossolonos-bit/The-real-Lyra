// Lyra's own singing voice on any song (2026-11-22): her singing voice (a Fish Audio voice) on a song's vocals with
// Seed-VC (https://github.com/Plachtaa/seed-vc), run on this PC's GPU from D:\Lyra Real AI\singing (lyra_sing.py:
// Demucs splits vocals from music, Seed-VC's 44 kHz singing model turns the voice into hers, they're mixed back).
// One at a time (the GPU), each job with a time limit. Not on GitHub: the singing folder is local only.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './config.js';
import { activity } from './events.js';

const DIR = process.env.LYRA_SINGING_DIR || path.join(ROOT, '..', 'singing');
const PY = path.join(DIR, 'venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(DIR, 'lyra_sing.py');
const REF = path.join(DIR, 'lyra_singing_ref.wav');

export const herVoiceReady = () => existsSync(PY) && existsSync(SCRIPT) && existsSync(REF);

let chain = Promise.resolve();
// songs waiting or being sung, and the one running now (so "stop singing" can cancel them, 2026-11-22)
let running = null, cancelledUpTo = 0, nextJob = 0;
const pending = new Set(); // job ids waiting or being sung
// songs still to come (cancelled ones don't count, even while their process is shutting down)
export const singingNow = () => [...pending].filter((id) => id > cancelledUpTo).length;
export class Cancelled extends Error { constructor() { super('cancelled'); this.cancelled = true; } }
// stop everything she's singing in her voice: the running job is killed, the waiting ones are dropped
export function stopSinging() {
  const n = singingNow();
  cancelledUpTo = nextJob;
  if (running) { running.cancelled = true; running.kill(); }
  if (n) activity('singing', { message: `Stopped singing (${n} song${n > 1 ? 's' : ''} cancelled)` });
  return n;
}

// song bytes (mp3 or any audio) -> the same song with her singing; { start, length } in seconds to do only part
export function inHerVoice(bytes, { ext = 'mp3', start = 0, length = 0, minutes = 20 } = {}) {
  const id = ++nextJob;
  pending.add(id);
  const job = chain.then(() => {
    if (id <= cancelledUpTo) throw new Cancelled();
    return convert(bytes, { ext, start, length, minutes });
  }).finally(() => pending.delete(id));
  chain = job.catch(() => {});
  return job;
}

function convert(bytes, { ext, start, length, minutes }) {
  if (!herVoiceReady()) return Promise.reject(new Error('her singing voice (Seed-VC) is not set up on this PC'));
  const dir = mkdtempSync(path.join(tmpdir(), 'lyra-voice-'));
  const src = path.join(dir, `song.${ext.replace(/[^a-z0-9]/gi, '') || 'mp3'}`);
  const out = path.join(dir, 'lyra.mp3');
  writeFileSync(src, bytes);
  const args = [SCRIPT, src, out, ...(start ? ['--start', String(start)] : []), ...(length ? ['--length', String(length)] : [])];
  const started = Date.now();
  activity('singing', { message: `Singing a song in her own voice (${(bytes.length / 1048576).toFixed(1)} MB)` });
  return new Promise((resolve, reject) => {
    // Windows: the whole process tree (Demucs and Seed-VC run as children of the script)
    const p = spawn(PY, args, { cwd: DIR, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    running = { cancelled: false, kill: () => { try { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { p.kill(); } } };
    const me = running;
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
    const timer = setTimeout(() => { me.kill(); }, minutes * 60_000);
    p.on('error', (err) => { clearTimeout(timer); running = null; rmSync(dir, { recursive: true, force: true }); reject(err); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (running === me) running = null;
      try {
        if (me.cancelled) throw new Cancelled();
        if (code !== 0 || !existsSync(out)) throw new Error(`her voice couldn't be put on it (${code ?? 'timed out'}): ${log.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
        const result = readFileSync(out);
        activity('singing', { message: `Sung in her voice in ${Math.round((Date.now() - started) / 1000)} s` });
        resolve(result);
      } catch (err) {
        if (!err.cancelled) activity('error', { where: 'singing voice', message: err.message });
        reject(err);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
