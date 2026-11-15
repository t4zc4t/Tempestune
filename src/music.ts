import type { LavalinkManager, LavalinkNode, Player, Track, UnresolvedTrack } from 'lavalink-client';
import { config } from './config.js';
import { isApple, isDeezer, isSpotify, readDeezer, readSpotify, type SongInfo } from './links.js';
import { log } from './log.js';
import { best, canonFor, offOriginal, type Canon } from './rank.js';
import { listOf, relay, searchSoundCloud, searchYouTube, type RelayHit } from './relay.js';

export interface Requester {
  id: string;
  name: string;
}

// what a queued song needs so it can be found again when its turn comes
export interface Want extends SongInfo {
  how: 'relay' | 'youtube' | 'find';
  source: string;
  uri?: string;
  noYoutube?: boolean; // set after youtube already failed for this song
}

let manager: LavalinkManager;
export const useManager = (m: LavalinkManager) => (manager = m);

const node = (id: string) => manager.nodeManager.nodes.get(id);
// youtube now goes through yt-dlp like soundcloud, so every player lives on the one node
export const youtubeOn = () => config.youtube;
export const pickNode = () => 'main';

// straight to lavalink's rest api: the client's own search refuses our local relay links
// on a node without soundcloud, even though lavalink plays them fine
async function loadOne(on: LavalinkNode, query: string, requester: Requester) {
  const res = await on.request(`/loadtracks?identifier=${encodeURIComponent(query)}`);
  const data = res?.loadType === 'track' ? res.data : res?.loadType === 'search' ? res.data?.[0] : res?.loadType === 'playlist' ? res.data?.tracks?.[0] : null;
  if (!data?.encoded) throw new Error(res?.loadType === 'error' ? res.data?.message ?? 'load failed' : `nothing loaded for ${query}`);
  return manager.utils.buildTrack(data, requester);
}

// best match for a song we only know by name: youtube first when it's on (it has the full originals), soundcloud after
async function matchByName(q: string, canon: Canon | undefined, noYoutube = false): Promise<{ hit: RelayHit; source: string } | null> {
  if (youtubeOn() && !noYoutube) {
    const yt = await searchYouTube(q, 10).catch((e) => {
      log('youtube search failed:', e instanceof Error ? e.message : e);
      return [];
    });
    const hit = best(yt, q, canon);
    if (hit) return { hit, source: 'youtube' };
  }
  const sc = await searchSoundCloud(q, 10).catch(() => []);
  const hit = best(sc, q, canon);
  return hit ? { hit, source: 'soundcloud' } : null;
}

// finds the actual audio for a queued song
async function findAudio(want: Want, player: Player, requester: Requester): Promise<Track> {
  if (want.how !== 'find' && want.uri) return loadOne(player.node, await relay(want.uri), requester);
  // metadata only (spotify, apple, deezer) or a song whose own link failed: search by name
  const q = `${want.author} ${want.title}`.trim();
  const m = await matchByName(q, { title: want.title, author: want.author, duration: want.duration }, want.noYoutube);
  if (!m) throw new Error(`no audio found for ${q}`);
  return loadOne(player.node, await relay(m.hit.url), requester);
}

export function queued(want: Want, requester: Requester): UnresolvedTrack {
  const t = manager.utils.buildUnresolvedTrack(
    { title: want.title, author: want.author, duration: want.duration, uri: want.link ?? want.uri, artworkUrl: want.artwork, sourceName: want.source as any },
    requester,
  );
  t.userData = { want: { ...want } as Record<string, any> };
  // swaps this placeholder for the real track in place, so the queue keeps the same object
  t.resolve = async (player: Player) => {
    const real = await findAudio(want, player, requester);
    for (const sym of Object.getOwnPropertySymbols(t)) delete (t as any)[sym];
    for (const prop of Object.getOwnPropertyNames(t)) delete (t as any)[prop];
    for (const sym of Object.getOwnPropertySymbols(real)) Object.defineProperty(t, sym, { configurable: true, value: (real as any)[sym] });
    Object.assign(t, real, { requester: real.requester ?? requester });
    // keep the names we know, the relay file itself has none
    const info = (t as unknown as Track).info;
    if (want.title) info.title = want.title;
    if (want.author) info.author = want.author;
    if (want.artwork) info.artworkUrl = want.artwork;
    if (want.link) info.uri = want.link;
    if (want.duration && !info.duration) info.duration = want.duration;
    (t as unknown as Track).userData = { ...(real.userData ?? {}), want: { ...want } as Record<string, any> };
  };
  return t;
}

const fromSongs = (songs: SongInfo[], source: string, requester: Requester) =>
  songs.filter((s) => s.title).map((s) => queued({ ...s, how: 'find', source }, requester));

const fromHit = (h: RelayHit, source: string): Want => ({ title: h.title, author: h.author, duration: h.duration, artwork: h.artwork, uri: h.url, link: h.url, how: 'relay', source });

export interface Found {
  tracks: (Track | UnresolvedTrack)[];
  name?: string; // set when it was a playlist or album
  notOriginal?: boolean; // the free version found is a remix or a different cut
}

// turns whatever was typed into queue entries
export async function find(input: string, requester: Requester): Promise<Found> {
  const text = input.trim();
  const isUrl = /^https?:\/\//i.test(text);

  if (isUrl && isSpotify(text)) {
    const r = await readSpotify(text);
    return { tracks: fromSongs(r.songs, 'spotify', requester), name: r.name };
  }
  if (isUrl && isDeezer(text)) {
    const r = await readDeezer(text);
    return { tracks: fromSongs(r.songs, 'deezer', requester), name: r.name };
  }
  if (isUrl && isApple(text)) {
    // lavasrc reads apple music on the main node, we only keep the names
    const main = node('main');
    if (!main?.connected) throw new Error('main node is down');
    const res = await main.search({ query: text }, requester);
    const songs = (res.tracks ?? []).map((t) => ({ title: t.info.title, author: t.info.author, duration: t.info.duration, artwork: t.info.artworkUrl ?? undefined, link: t.info.uri ?? undefined }));
    return { tracks: fromSongs(songs, 'applemusic', requester), name: res.loadType === 'playlist' ? res.playlist?.name : undefined };
  }
  if (isUrl && /soundcloud\.com\/|bandcamp\.com\/|youtube\.com\/|youtu\.be\//i.test(text)) {
    const source = /bandcamp/i.test(text) ? 'bandcamp' : /soundcloud/i.test(text) ? 'soundcloud' : 'youtube';
    if (source === 'youtube' && !youtubeOn()) throw new Error('youtube is off');
    const list = await listOf(text);
    return { tracks: list.hits.map((h) => queued(fromHit(h, source), requester)), name: list.name };
  }
  if (isUrl) throw new Error('that link is not a supported source');

  // plain words: ranked against the real song when apple or deezer knows it
  const canon = await canonFor(text);
  const m = await matchByName(text, canon);
  if (!m) return { tracks: [] };
  return { tracks: [queued(fromHit(m.hit, m.source), requester)], notOriginal: offOriginal(m.hit, text, canon) };
}

// when a youtube download fails, look for the same song on soundcloud instead (once)
export function fallbackFor(track: Track | UnresolvedTrack, requester: Requester): UnresolvedTrack | null {
  const want = track.userData?.want as unknown as Want | undefined;
  if (!want || want.noYoutube || !track.info.title) return null;
  if (want.source !== 'youtube' && want.how !== 'find') return null;
  return queued({ title: want.title || track.info.title, author: want.author || track.info.author || '', duration: want.duration, artwork: want.artwork, link: want.link, how: 'find', source: 'soundcloud', noYoutube: true }, requester);
}

// fetch the next relay track early so there's no gap
export function warmNext(player: Player) {
  const want = player.queue.tracks[0]?.userData?.want as unknown as Want | undefined;
  if (want?.how === 'relay' && want.uri) relay(want.uri).catch(() => {});
}
