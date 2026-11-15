import { config } from './config.js';
import type { Canon } from './rank.js';

// small free lookups: suggestions while typing, "did you mean", lyrics, internet radio, jamendo

const getJson = async (url: string, ms = 8000) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Tempestune/0.1 (discord music bot)' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

// apple's catalogue answers fast enough for discord's 3 second autocomplete window
export async function suggestSongs(text: string): Promise<{ name: string; value: string }[]> {
  if (text.trim().length < 2 || /^https?:\/\//i.test(text)) return [];
  const j = await getJson(`https://itunes.apple.com/search?entity=song&limit=10&term=${encodeURIComponent(text)}`, 2200).catch(() => null);
  const seen = new Set<string>();
  const out: { name: string; value: string }[] = [];
  for (const r of j?.results ?? []) {
    const value = `${r.artistName} - ${r.trackName}`.slice(0, 100);
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const mins = r.trackTimeMillis ? ` (${Math.floor(r.trackTimeMillis / 60000)}:${String(Math.floor((r.trackTimeMillis % 60000) / 1000)).padStart(2, '0')})` : '';
    out.push({ name: `${r.trackName} · ${r.artistName}${mins}`.slice(0, 100), value });
  }
  return out.slice(0, 8);
}

// spelling help for when nothing matched: youtube's suggestions, or the closest real song apple knows
export async function didYouMean(text: string): Promise<string | null> {
  const j = await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(text)}`, 4000).catch(() => null);
  const first: string | undefined = j?.[1]?.[0];
  if (first && first.toLowerCase() !== text.toLowerCase().trim()) return first;
  const apple = await getJson(`https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(text)}`, 4000).catch(() => null);
  const r = apple?.results?.[0];
  return r ? `${r.artistName} - ${r.trackName}` : null;
}

// ---------- lyrics from lrclib (free, no key) ----------

export interface Lyrics {
  title: string;
  author: string;
  duration?: number;
  synced: { at: number; line: string }[];
  plain: string;
}

const parseLrc = (lrc: string) =>
  lrc
    .split('\n')
    .map((l) => /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ at: (Number(m[1]) * 60 + Number(m[2])) * 1000, line: m[3].trim() }));

const toLyrics = (r: any): Lyrics => ({
  title: r.trackName,
  author: r.artistName,
  duration: r.duration ? r.duration * 1000 : undefined,
  synced: r.syncedLyrics ? parseLrc(r.syncedLyrics) : [],
  plain: r.plainLyrics ?? '',
});

export async function lyricsFor(title: string, author: string, duration?: number): Promise<Lyrics | null> {
  const clean = title.replace(/\s*[([].*?[)\]]/g, '').replace(/^.*?\s-\s/, (m) => (author && m.toLowerCase().includes(author.toLowerCase()) ? '' : m)).trim();
  const p = new URLSearchParams({ track_name: clean, artist_name: author });
  if (duration) p.set('duration', String(Math.round(duration / 1000)));
  const exact = await getJson(`https://lrclib.net/api/get?${p}`).catch(() => null);
  if (exact && (exact.syncedLyrics || exact.plainLyrics)) return toLyrics(exact);
  const list: any[] = (await getJson(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${author} ${clean}` })}`).catch(() => [])) ?? [];
  const hit = list.find((r) => r.syncedLyrics) ?? list.find((r) => r.plainLyrics);
  return hit ? toLyrics(hit) : null;
}

// a remembered line -> the song it is from. youtube search finds lyric videos for the line,
// each candidate is then confirmed by checking its real lyrics actually contain the line
const flat = (x: string) => x.toLowerCase().replace(/[’'`´]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function containsLine(lyrics: string, line: string) {
  const text = flat(lyrics);
  const want = flat(line);
  if (text.includes(want)) return true;
  const words = want.split(' ').filter((w) => w.length > 2);
  return words.length > 2 && words.filter((w) => text.includes(w)).length >= Math.ceil(words.length * 0.85);
}

// "Justin Bieber - Sorry (Lyrics)" -> artist and title
export function splitTitle(t: string, uploader: string) {
  const clean = t.replace(/\s*[([][^)\]]*(lyrics?|official|audio|video|visuali[sz]er|hd|4k)[^)\]]*[)\]]/gi, '').replace(/\s*\|.*$/, '').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean);
  return m ? { author: m[1].trim(), title: m[2].replace(/\s*\((ft|feat)\.?.*\)$/i, '').trim() } : { author: uploader.replace(/\s*-\s*topic$/i, ''), title: clean };
}

export async function songFromLine(line: string): Promise<Canon | null> {
  const { searchYouTube } = await import('./relay.js');
  const hits = config.youtube ? await searchYouTube(`${line} lyrics`, 6).catch(() => []) : [];
  for (const h of hits.slice(0, 5)) {
    const guess = splitTitle(h.title, h.author);
    const lyr = await lyricsFor(guess.title, guess.author).catch(() => null);
    if (lyr && containsLine(lyr.plain || lyr.synced.map((x) => x.line).join(' '), line)) {
      return { title: lyr.title, author: lyr.author, duration: lyr.duration };
    }
  }
  // no youtube, or nothing confirmed: lrclib's own search, most repeated song wins (covers appear once)
  const list: any[] = (await getJson(`https://lrclib.net/api/search?${new URLSearchParams({ q: line })}`).catch(() => [])) ?? [];
  const groups = new Map<string, { r: any; n: number }>();
  for (const r of list.filter((r) => containsLine(String(r.plainLyrics ?? ''), line))) {
    const key = `${flat(r.artistName)}|${flat(r.trackName)}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { r, n: 1 });
  }
  const hit = [...groups.values()].sort((a, b) => b.n - a.n)[0]?.r;
  return hit ? { title: hit.trackName, author: hit.artistName, duration: hit.duration ? hit.duration * 1000 : undefined } : null;
}

// ---------- internet radio (radio-browser.info) ----------

export interface Station {
  name: string;
  url: string;
  tags: string;
  country: string;
  codec: string;
  favicon?: string;
}

export async function findStations(text: string, limit = 10): Promise<Station[]> {
  const q = new URLSearchParams({ name: text, limit: String(limit * 3), hidebroken: 'true', order: 'votes', reverse: 'true' });
  const list: any[] = (await getJson(`https://all.api.radio-browser.info/json/stations/search?${q}`).catch(() => [])) ?? [];
  return list
    // lavalink plays plain mp3 / aac / ogg streams, not hls playlists
    .filter((s) => s.url_resolved && /^(mp3|aac|aac\+|ogg)$/i.test(s.codec) && !/\.m3u8/i.test(s.url_resolved))
    .slice(0, limit)
    .map((s) => ({ name: s.name.trim(), url: s.url_resolved, tags: s.tags ?? '', country: s.country ?? '', codec: s.codec, favicon: s.favicon || undefined }));
}

// ---------- jamendo (free client id, only when one is set) ----------

export interface JamendoTrack {
  title: string;
  author: string;
  duration: number;
  url: string;
  artwork?: string;
  link: string;
}

export async function searchJamendo(text: string, limit = 10): Promise<JamendoTrack[]> {
  if (!config.jamendo) return [];
  const q = new URLSearchParams({ client_id: config.jamendo, format: 'json', limit: String(limit), search: text, audioformat: 'mp32', include: 'musicinfo' });
  const j = await getJson(`https://api.jamendo.com/v3.0/tracks/?${q}`).catch(() => null);
  return (j?.results ?? []).map((t: any) => ({
    title: t.name,
    author: t.artist_name,
    duration: (t.duration ?? 0) * 1000,
    url: t.audio,
    artwork: t.image || undefined,
    link: t.shareurl,
  }));
}
