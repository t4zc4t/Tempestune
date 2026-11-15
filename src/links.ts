import { log } from './log.js';

// Spotify, Apple Music and Deezer links only tell us what the song is.
// The audio is found on another source when it plays.

export interface SongInfo {
  title: string;
  author: string;
  duration?: number;
  artwork?: string;
  link?: string;
}

export interface LinkResult {
  name?: string; // playlist or album name, when it is one
  songs: SongInfo[];
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

async function getText(url: string) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

// ---------- spotify: the public embed page carries the track list ----------

const SPOTIFY = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/;

export const isSpotify = (url: string) => SPOTIFY.test(url);

export async function readSpotify(url: string): Promise<LinkResult> {
  const [, kind, id] = SPOTIFY.exec(url)!;
  const html = await getText(`https://open.spotify.com/embed/${kind}/${id}`);
  const raw = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!raw) throw new Error('spotify embed had no data');
  const e = JSON.parse(raw)?.props?.pageProps?.state?.data?.entity;
  if (!e) throw new Error('spotify embed changed shape');
  const art = (e.visualIdentity?.image ?? e.coverArt?.sources ?? []).sort((a: any, b: any) => (b.maxWidth ?? b.width ?? 0) - (a.maxWidth ?? a.width ?? 0))[0]?.url;
  if (kind === 'track') {
    return {
      songs: [{ title: e.title ?? e.name, author: (e.artists ?? []).map((a: any) => a.name).join(', '), duration: e.duration, artwork: art, link: url }],
    };
  }
  const songs = (e.trackList ?? []).map((t: any) => ({
    title: t.title,
    author: String(t.subtitle ?? '').replace(/ /g, ' '),
    duration: t.duration,
    artwork: art,
    link: t.uri ? `https://open.spotify.com/track/${String(t.uri).split(':').pop()}` : undefined,
  }));
  // the embed page only lists the first 100 songs of a playlist
  const name = e.title ?? e.name;
  return { name: songs.length >= 100 && kind === 'playlist' ? `${name}, first 100 songs` : name, songs };
}

// ---------- deezer: open api, no key ----------

const DEEZER = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/;

export const isDeezer = (url: string) => DEEZER.test(url) || /deezer\.page\.link|link\.deezer\.com/.test(url);

export async function readDeezer(url: string): Promise<LinkResult> {
  let full = url;
  if (!DEEZER.test(full)) {
    // short share links redirect to the real one
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    full = res.url;
  }
  const m = DEEZER.exec(full);
  if (!m) throw new Error('not a deezer track, album or playlist');
  const [, kind, id] = m;
  const api = async (path: string) => {
    const j = await (await fetch(`https://api.deezer.com/${path}`, { signal: AbortSignal.timeout(15_000) })).json();
    if (j.error) throw new Error(j.error.message ?? 'deezer error');
    return j;
  };
  const toSong = (t: any, cover?: string): SongInfo => ({
    title: t.title,
    author: t.artist?.name ?? '',
    duration: (t.duration ?? 0) * 1000,
    artwork: t.album?.cover_xl ?? cover,
    link: t.link,
  });
  if (kind === 'track') return { songs: [toSong(await api(`track/${id}`))] };
  const head = await api(`${kind}/${id}`);
  const tracks = await api(`${kind}/${id}/tracks?limit=200`);
  return { name: head.title, songs: (tracks.data ?? []).map((t: any) => toSong(t, head.cover_xl ?? head.picture_xl)) };
}

export const isApple = (url: string) => /music\.apple\.com\//.test(url);

export function logLinkError(what: string, e: unknown) {
  log(`${what} link failed:`, e instanceof Error ? e.message : e);
}
