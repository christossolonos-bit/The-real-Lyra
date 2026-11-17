/**
 * Live radio via the community Radio Browser directory (no API key).
 * Spoken: "play BBC Radio 1", "put on a jazz radio station".
 */

const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];

async function radioFetch(path) {
  let last = null;
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { 'User-Agent': 'HalMini-amy-smith/1.0', Accept: 'application/json' },
      });
      if (!res.ok) {
        last = new Error(`Radio Browser ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error('Radio Browser unreachable');
}

export function isRadioAsk(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(radio station|fm radio|am radio)\b/.test(t)) return true;
  if (/\bradio\b/.test(t) && /\b(play|put on|tune|listen|station)\b/.test(t)) return true;
  return false;
}

function scoreStation(station, needles) {
  const name = String(station.name || '').toLowerCase();
  const tags = String(station.tags || '').toLowerCase();
  let score = 0;
  for (const n of needles) {
    if (name === n) score += 50;
    else if (name.startsWith(n)) score += 20;
    else if (name.includes(n)) score += 10;
    if (tags.includes(n)) score += 3;
  }
  // Prefer popular, unbroken, higher-bitrate streams.
  score += Math.min(15, Math.log10((station.clickcount || 0) + 1) * 4);
  if (station.bitrate >= 128) score += 2;
  if (/tv\b/i.test(name) && !needles.includes('tv')) score -= 25;
  return score;
}

/**
 * Find a working station. Returns { name, url, country, tags, bitrate }.
 */
export async function findStation(query) {
  const raw = String(query || '').replace(/\s+/g, ' ').trim();
  if (!raw) throw new Error('Say which station or genre, e.g. "play BBC Radio 1" or "put on jazz radio"');

  // Try the full phrase first ("BBC Radio 1"), then a cleaned form without filler.
  const cleaned = raw
    .replace(/\b(on|from)\s+(the\s+)?radio\b/gi, ' ')
    .replace(/\b(a|the)\s+radio\s+station\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const attempts = [...new Set([raw, cleaned].filter((s) => s.length >= 2))];

  let stations = [];
  for (const name of attempts) {
    const params = new URLSearchParams({
      name,
      limit: '12',
      hidebroken: 'true',
      order: 'clickcount',
      reverse: 'true',
    });
    const batch = await radioFetch(`/json/stations/search?${params}`);
    if (Array.isArray(batch) && batch.length) {
      stations = batch;
      break;
    }
  }
  if (!stations.length) {
    // Genre-style ask: "jazz radio" → tag search.
    const tag = cleaned.replace(/\bradio\b/gi, ' ').replace(/\s+/g, ' ').trim().split(/\s+/)[0];
    if (tag) {
      const tagParams = new URLSearchParams({
        tag,
        limit: '12',
        hidebroken: 'true',
        order: 'clickcount',
        reverse: 'true',
      });
      stations = await radioFetch(`/json/stations/search?${tagParams}`);
    }
  }
  if (!Array.isArray(stations) || !stations.length) {
    throw new Error(`No radio station matched "${raw}"`);
  }

  const needles = cleaned.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const ranked = stations
    .filter((s) => s.url_resolved || s.url)
    .map((s) => ({ s, score: scoreStation(s, needles) }))
    .sort((a, b) => b.score - a.score);
  const pick = ranked[0]?.s || stations[0];
  const url = String(pick.url_resolved || pick.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new Error(`Station "${pick.name}" has no stream URL`);

  return {
    name: String(pick.name || raw).trim(),
    url,
    country: pick.country || '',
    tags: pick.tags || '',
    bitrate: pick.bitrate || 0,
  };
}
