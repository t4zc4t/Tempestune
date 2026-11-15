import type { LavalinkManager, LavalinkNode, Player, Track, UnresolvedTrack } from 'lavalink-client';
import { config } from './config.js';
import { isApple, isDeezer, isSpotify, readDeezer, readSpotify, type SongInfo } from './links.js';
import { best, canonFor, offOriginal } from './rank.js';
import { listOf, relay, searchSoundCloud, type RelayHit } from './relay.js';

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
export const youtubeUp = () => config.youtube && !!node('youtube')?.connected;
// youtube needs its own node, everything else plays anywhere
export const pickNode = () => (youtubeUp() ? 'youtube' : 'main');

// straight to lavalink's rest api: the client's own search refuses our local relay links
// on a node without soundcloud, even though lavalink plays them fine
async function loadOne(on: LavalinkNode, query: string, requester: Requester) {
  const res = await on.request(`/loadtracks?identifier=${encodeURIComponent(query)}`);
  const data = res?.loadType === 'track' ? res.data : res?.loadType === 'search' ? res.data?.[0] : res?.loadType === 'playlist' ? res.data?.tracks?.[0] : null;
  if (!data?.encoded) throw new Error(res?.loadType === 'error' ? res.data?.message ?? 'load failed' : `nothing loaded for ${query}`);
  return manager.utils.buildTrack(data, requester);
}

const nearest = <T>(items: T[], len: (x: T) => number, want?: number) =>
  want ? [...items].sort((a, b) => Math.abs(len(a) - want) - Math.abs(len(b) - want)).find((x) => Math.abs(len(x) - want) < 8000) ?? items[0] : items[0];

// finds the actual audio for a queued song, on whatever node the player is on
async function findAudio(want: Want, player: Player, requester: Requester): Promise<Track> {
  if (want.how === 'relay' && want.uri) return loadOne(player.node, await relay(want.uri), requester);
  if (want.how === 'youtube' && want.uri && player.node.id === 'youtube') return loadOne(player.node, want.uri, requester);
  // metadata only (spotify, apple, deezer) or a youtube song that failed: soundcloud first, it is the reliable one
  const q = `${want.author} ${want.title}`.trim();
  const hits = await searchSoundCloud(q, 10).catch(() => []);
  const hit = best(hits, q, { title: want.title, author: want.author, duration: want.duration });
  if (hit) return loadOne(player.node, await relay(hit.url), requester);
  if (player.node.id === 'youtube' && !want.noYoutube) {
    const res = await player.node.search({ query: q, source: 'ytmsearch' }, requester).catch(() => null);
    const best = nearest(res?.tracks ?? [], (t) => t.info.duration, want.duration);
    if (best?.encoded) return best;
  }
  throw new Error(`no audio found for ${q}`);
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
  if (isUrl && /soundcloud\.com\/|bandcamp\.com\//i.test(text)) {
    const source = /bandcamp/i.test(text) ? 'bandcamp' : 'soundcloud';
    const list = await listOf(text);
    return { tracks: list.hits.map((h) => queued(fromHit(h, source), requester)), name: list.name };
  }
  if (isUrl && /youtube\.com\/|youtu\.be\//i.test(text)) {
    if (!youtubeUp()) throw new Error('youtube is off');
    const res = await node('youtube')!.search({ query: text }, requester);
    return { tracks: res.tracks ?? [], name: res.loadType === 'playlist' ? res.playlist?.name : undefined };
  }
  if (isUrl) throw new Error('that link is not a supported source');

  // plain words: soundcloud, ranked against the real song when deezer knows it
  const [hits, canon] = await Promise.all([searchSoundCloud(text, 10), canonFor(text)]);
  const hit = best(hits, text, canon);
  if (!hit) return { tracks: [] };
  return { tracks: [queued(fromHit(hit, 'soundcloud'), requester)], notOriginal: offOriginal(hit, text, canon) };
}

// when youtube refuses a song, look for the same song on soundcloud instead
export function fallbackFor(track: Track | UnresolvedTrack, requester: Requester): UnresolvedTrack | null {
  const want = track.userData?.want as unknown as Want | undefined;
  if (want?.noYoutube) return null; // already tried once
  const fromYoutube = track.info.sourceName === 'youtube' || want?.how === 'youtube' || (want?.how === 'find' && !want?.noYoutube);
  if (!fromYoutube || !track.info.title) return null;
  return queued({ title: track.info.title, author: track.info.author ?? '', duration: track.info.duration, artwork: track.info.artworkUrl ?? undefined, link: track.info.uri ?? undefined, how: 'find', source: want?.source ?? 'youtube', noYoutube: true }, requester);
}

// fetch the next relay track early so there's no gap
export function warmNext(player: Player) {
  const want = player.queue.tracks[0]?.userData?.want as unknown as Want | undefined;
  if (want?.how === 'relay' && want.uri) relay(want.uri).catch(() => {});
}
