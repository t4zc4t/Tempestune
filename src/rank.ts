import type { RelayHit } from './relay.js';

// picks the soundcloud upload most likely to be the actual song, not a remix of it

export interface Canon {
  title: string;
  author: string;
  duration?: number;
}

// words that mean "a different version", only fine when the request has them too
const VERSIONS = ['remix', 'bootleg', 'nightcore', 'sped up', 'speed up', 'spedup', 'slowed', 'reverb', '8d', 'cover', 'karaoke',
  'instrumental', 'extended', 'mashup', 'lofi', 'lo-fi', 'acoustic', 'live', 'edit', 'flip', 'vip', 'mix'];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`´]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const has = (text: string, word: string) => ` ${text} `.includes(` ${word} `);

export function score(hit: RelayHit, asked: string, canon?: Canon) {
  const t = norm(`${hit.title} ${hit.author}`);
  const q = norm(asked);
  let s = 0;
  for (const v of VERSIONS) if (has(t, v) && !has(q, v)) s -= 40;
  // youtube: plain audio uploads beat music videos, which often have intros and skits
  if (/\b(official audio|audio|topic|lyrics?|lyric video)\b/.test(t)) s += 8;
  if (/\b(official video|music video|official mv|fan video|visualizer)\b/.test(t)) s -= 6;
  if (canon) {
    const artist = norm(canon.author).split(' ').filter((w) => w.length > 2);
    const title = norm(canon.title).split(' ').filter((w) => w.length > 1);
    if (artist.length && artist.every((w) => t.includes(w))) s += 25;
    s += 20 * (title.filter((w) => t.includes(w)).length / Math.max(1, title.length));
    if (canon.duration && hit.duration) s -= Math.min(60, Math.abs(hit.duration - canon.duration) / 1000);
  } else {
    const words = q.split(' ').filter((w) => w.length > 1);
    s += 30 * (words.filter((w) => t.includes(w)).length / Math.max(1, words.length));
    // a 12 minute "song" is usually a loop or a mix, not the track
    if (hit.duration > 8 * 60_000 && !/\b(mix|hour|extended|loop|set)\b/.test(q)) s -= 25;
  }
  return s;
}

export function best(hits: RelayHit[], asked: string, canon?: Canon) {
  // keep soundcloud's own order as the tie breaker
  return hits
    .map((h, i) => ({ h, s: score(h, asked, canon) - i * 0.5 }))
    .sort((a, b) => b.s - a.s)[0]?.h;
}

// is the pick probably not the original? (a remix or clearly a different length)
export function offOriginal(hit: RelayHit, asked: string, canon?: Canon) {
  const t = norm(hit.title);
  const q = norm(asked);
  if (VERSIONS.some((v) => has(t, v) && !has(q, v))) return true;
  return !!(canon?.duration && hit.duration && Math.abs(hit.duration - canon.duration) > 20_000);
}

// apple's free song search (deezer as a backup) knows the real song: proper title, artist and length.
// only trusted when what was typed has the song's title and its artist, so a bare title isn't guessed at
async function lookup(url: string, pick: (j: any) => Canon[]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return pick(await res.json());
  } catch {
    return [];
  }
}

export async function canonFor(query: string): Promise<Canon | undefined> {
  const q = norm(query);
  const fits = (c: Canon) => {
    const title = norm(c.title).split(' ').filter(Boolean);
    const artist = norm(c.author).split(' ').filter((w) => w.length > 2);
    return title.length > 0 && title.every((w) => has(q, w)) && artist.some((w) => has(q, w));
  };
  const apple = await lookup(`https://itunes.apple.com/search?entity=song&limit=8&term=${encodeURIComponent(query)}`, (j) =>
    (j.results ?? []).map((r: any) => ({ title: r.trackName, author: r.artistName, duration: r.trackTimeMillis })),
  );
  const fromApple = apple.find(fits);
  if (fromApple) return fromApple;
  const deezer = await lookup(`https://api.deezer.com/search?limit=8&q=${encodeURIComponent(query)}`, (j) =>
    (j.data ?? []).map((d: any) => ({ title: d.title_short ?? d.title, author: d.artist?.name ?? '', duration: (d.duration ?? 0) * 1000 })),
  );
  return deezer.find(fits);
}
