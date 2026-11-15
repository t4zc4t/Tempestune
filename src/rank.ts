import type { RelayHit } from './relay.js';

// works out which song was meant, then which upload of it is the real thing

export interface Canon {
  title: string;
  author: string;
  duration?: number;
}

// words that mean "a different version", only fine when the request has them too
const VERSIONS = ['remix', 'bootleg', 'nightcore', 'sped up', 'speed up', 'spedup', 'slowed', 'reverb', '8d', 'cover', 'karaoke',
  'instrumental', 'extended', 'mashup', 'lofi', 'lo fi', 'acoustic', 'live', 'edit', 'flip', 'vip', 'mix', 'lyrical', 'status',
  'bass boosted', 'ringtone', 'whatsapp', 'tiktok', 'version', 'loop', 'hour', 'piano', 'guitar', 'chill', 'unplugged', 'reprise'];

export const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`´]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const has = (text: string, word: string) => ` ${text} `.includes(` ${word} `);
const words = (s: string, min = 1) => norm(s).split(' ').filter((w) => w.length >= min);
// "Tum Hi Ho (From "Aashiqui 2")" -> "tum hi ho"
const bareTitle = (t: string) => norm(t.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, ''));
const isVersion = (text: string, asked: string) => VERSIONS.some((v) => has(norm(text), v) && !has(norm(asked), v));

export function score(hit: RelayHit, asked: string, canon?: Canon) {
  const t = norm(`${hit.title} ${hit.author}`);
  let s = 0;
  for (const v of VERSIONS) if (has(t, v) && !has(norm(asked), v)) s -= 40;
  // plain audio uploads beat music videos (intros, skits) and lyric edits
  if (/\b(official audio|audio|topic|provided to youtube)\b/.test(t)) s += 10;
  if (/\b(official video|music video|official mv|fan video|visualizer|lyric video|lyrics?)\b/.test(t)) s -= 4;
  if (canon) {
    const artist = words(canon.author, 3);
    if (artist.length && artist.some((w) => t.includes(w))) s += 25;
    const title = words(bareTitle(canon.title));
    s += 20 * (title.filter((w) => has(t, w)).length / Math.max(1, title.length));
    if (canon.duration && hit.duration) s -= Math.min(60, Math.abs(hit.duration - canon.duration) / 1000) * 1.5;
  } else {
    const q = words(asked, 2);
    s += 30 * (q.filter((w) => t.includes(w)).length / Math.max(1, q.length));
    // a 12 minute "song" is usually a loop or a mix
    if (hit.duration > 8 * 60_000 && !/\b(mix|hour|extended|loop|set)\b/.test(norm(asked))) s -= 25;
  }
  return s;
}

export function best(hits: RelayHit[], asked: string, canon?: Canon) {
  // keep the site's own order as the tie breaker
  return hits
    .map((h, i) => ({ h, s: score(h, asked, canon) - i * 0.7 }))
    .sort((a, b) => b.s - a.s)[0]?.h;
}

// is the pick probably not the original? (a remix, or clearly a different length)
export function offOriginal(hit: RelayHit, asked: string, canon?: Canon) {
  if (isVersion(hit.title, asked)) return true;
  return !!(canon?.duration && hit.duration && Math.abs(hit.duration - canon.duration) > 20_000);
}

async function lookup(url: string, pick: (j: any) => Canon[]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return pick(await res.json());
  } catch {
    return [];
  }
}

// apple's free catalogue (deezer as a backup): real titles, artists and lengths, roughly by popularity
export async function catalogue(query: string): Promise<Canon[]> {
  const apple = await lookup(`https://itunes.apple.com/search?entity=song&limit=15&term=${encodeURIComponent(query)}`, (j) =>
    (j.results ?? []).map((r: any) => ({ title: r.trackName, author: r.artistName, duration: r.trackTimeMillis })),
  );
  if (apple.length) return apple;
  return lookup(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(query)}`, (j) =>
    (j.data ?? []).map((d: any) => ({ title: d.title_short ?? d.title, author: d.artist?.name ?? '', duration: (d.duration ?? 0) * 1000 })),
  );
}

// which song did they mean? the catalogue says what exists, youtube's top results say what people actually play
export function guessSong(query: string, songs: Canon[], ytTop: RelayHit[]): Canon | undefined {
  const q = norm(query);
  const titleFits = (c: Canon) => {
    const t = words(bareTitle(c.title));
    return t.length > 0 && t.every((w) => has(q, w));
  };
  const named = (c: Canon) => words(c.author, 3).some((w) => has(q, w));
  const candidates = songs.filter((c) => titleFits(c) && !isVersion(c.title, query));
  // the artist was typed: that settles it
  const typed = candidates.find(named);
  if (typed) return typed;
  // the leftover words must all be the title, or it's not a song lookup
  const exact = candidates.filter((c) => bareTitle(c.title) === q);
  if (!exact.length) return undefined;
  const top = ytTop.slice(0, 6).map((h) => norm(`${h.title} ${h.author}`));
  const presence = (c: Canon) => top.filter((t) => words(c.author, 3).some((w) => t.includes(w))).length;
  return [...exact].sort((a, b) => presence(b) - presence(a))[0];
}
