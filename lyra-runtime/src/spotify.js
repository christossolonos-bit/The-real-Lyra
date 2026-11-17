/**
 * Spotify asks → a playable search (we can't stream Spotify DRM; resolve the track then YouTube it).
 * Spoken: "play soft cell on spotify", or a open.spotify.com link.
 */

const SPOTIFY_URL = /https?:\/\/open\.spotify\.com\/(track|album|playlist)\/[a-zA-Z0-9]+/i;

export function isSpotifyAsk(text) {
  const t = String(text || '');
  return SPOTIFY_URL.test(t) || /\bon spotify\b|\bspotify\b/i.test(t);
}

/** Pull a Spotify URL out of text, if any. */
export function spotifyUrlIn(text) {
  return String(text || '').match(SPOTIFY_URL)?.[0] || null;
}

/**
 * Resolve to { title, artist, search } for YouTube / library lookup.
 * Uses Spotify oEmbed for links; iTunes Search when they named a track "on Spotify".
 */
export async function resolveSpotify(query) {
  const raw = String(query || '').trim();
  if (!raw) throw new Error('empty Spotify query');

  const url = spotifyUrlIn(raw) || (SPOTIFY_URL.test(raw) ? raw : null);
  if (url) {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Spotify oEmbed failed (${res.status})`);
    const data = await res.json();
    const title = String(data.title || '').trim() || 'Spotify track';
    // oEmbed title is often "Song · Artist"
    const parts = title.split(/\s*[·|—-]\s*/).map((s) => s.trim()).filter(Boolean);
    const song = parts[0] || title;
    const artist = parts[1] || '';
    return { title: song, artist, search: artist ? `${song} ${artist}` : song, via: 'spotify-link' };
  }

  // Named track/artist — iTunes is a free metadata lookup that matches what people mean by "on Spotify".
  const term = raw
    .replace(/\b(on|from|via)\s+spotify\b/gi, ' ')
    .replace(/\bspotify\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!term) throw new Error('Say a song or artist with Spotify, e.g. "play Soft Cell on Spotify"');

  const itunes = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=1`,
    { headers: { Accept: 'application/json' } },
  );
  if (itunes.ok) {
    const data = await itunes.json();
    const hit = data.results?.[0];
    if (hit?.trackName) {
      const song = hit.trackName;
      const artist = hit.artistName || '';
      return { title: song, artist, search: artist ? `${song} ${artist}` : song, via: 'spotify-search' };
    }
  }
  // Fall through: still search YouTube with the cleaned phrase.
  return { title: term, artist: '', search: term, via: 'spotify-fallback' };
}
