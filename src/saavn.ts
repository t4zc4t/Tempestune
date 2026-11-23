import type { Canon } from './rank.js';
import { norm } from './rank.js';
import type { RelayHit } from './relay.js';
import { log } from './log.js';

// jiosaavn: label uploads at 320kbps, so it's the first place to look for a known song.
// the site's own json api, no account needed. kept light: one search per song

const API = 'https://www.jiosaavn.com/api.php?_format=json&_marker=0&api_version=4&ctx=web6dot0';
export const isSaavn = (url: string) => /jiosaavn\.com\//i.test(url);

const clean = (s = '') =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function call(params: string) {
  const res = await fetch(`${API}&${params}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`jiosaavn ${res.status}`);
  return res.json() as Promise<any>;
}

const toHit = (r: any): RelayHit | null => {
  if (!r?.perma_url || r.type !== 'song') return null;
  const artists = (r.more_info?.artistMap?.primary_artists ?? []).map((a: any) => clean(a.name)).filter(Boolean);
  return {
    title: clean(r.title),
    author: artists.slice(0, 3).join(', ') || clean(r.more_info?.music) || 'Unknown artist',
    url: r.perma_url,
    duration: Number(r.more_info?.duration ?? 0) * 1000,
    artwork: typeof r.image === 'string' ? r.image.replace(/\d+x\d+(?=\.\w+$)/, '500x500') : undefined,
  };
};

export async function searchSaavn(q: string, n = 10): Promise<RelayHit[]> {
  try {
    const j = await call(`__call=search.getResults&n=${n}&p=1&q=${encodeURIComponent(q)}`);
    return (j.results ?? []).map(toHit).filter(Boolean) as RelayHit[];
  } catch (e) {
    log('jiosaavn search failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// a jiosaavn song, album or playlist link
export async function readSaavn(url: string): Promise<{ name?: string; hits: RelayHit[] }> {
  const m = /jiosaavn\.com\/(song|album|featured|s\/playlist)\/(?:[^/]+\/)*([\w-]+)\/?(?:\?|$)/i.exec(url);
  if (!m) throw new Error('not a jiosaavn song, album or playlist link');
  const type = m[1] === 'song' ? 'song' : m[1] === 'album' ? 'album' : 'playlist';
  const j = await call(`__call=webapi.get&token=${m[2]}&type=${type}&p=1&n=300&includeMetaTags=0`);
  const items = type === 'song' ? j.songs ?? [] : j.list ?? [];
  return { name: type === 'song' ? undefined : clean(j.title), hits: items.map(toHit).filter(Boolean) as RelayHit[] };
}

// is this jiosaavn result the song we're after? strict, a wrong song is worse than falling back to youtube
const bare = (t: string) => norm(t.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, ''));
export function sameSong(hit: RelayHit, canon: Canon) {
  const a = bare(hit.title);
  const b = bare(canon.title);
  if (!a || !b || (a !== b && !a.startsWith(b) && !b.startsWith(a))) return false;
  const theirs = new Set(norm(hit.author).split(' ').filter((w) => w.length > 2));
  const ours = norm(canon.author).split(' ').filter((w) => w.length > 2);
  if (ours.length && !ours.some((w) => theirs.has(w))) return false;
  return !(canon.duration && hit.duration && Math.abs(canon.duration - hit.duration) > 8000);
}
