import type { LavalinkManager, LavalinkNode, Player, Track, UnresolvedTrack } from 'lavalink-client';
import { config } from './config.js';
import { isApple, isDeezer, isSpotify, readDeezer, readSpotify, type SongInfo } from './links.js';
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

async function loadOne(on: LavalinkNode, query: string, requester: Requester) {
  const res = await on.search({ query }, requester);
  const track = res.tracks?.[0];
  if (!track?.encoded) throw new Error(`nothing loaded for ${query}`);
  return track;
}

const nearest = <T>(items: T[], len: (x: T) => number, want?: number) =>
  want ? [...items].sort((a, b) => Math.abs(len(a) - want) - Math.abs(len(b) - want)).find((x) => Math.abs(len(x) - want) < 8000) ?? items[0] : items[0];

// finds the actual audio for a queued song, on whatever node the player is on
async function findAudio(want: Want, player: Player, requester: Requester): Promise<string> {
  if (want.how === 'relay' && want.uri) return (await loadOne(player.node, await relay(want.uri), requester)).encoded!;
  if (want.how === 'youtube' && want.uri && player.node.id === 'youtube') return (await loadOne(player.node, want.uri, requester)).encoded!;
  // metadata only (spotify, apple, deezer) or a youtube song that failed: soundcloud first, it is the reliable one
  const q = `${want.author} ${want.title}`.trim();
  const hits = await searchSoundCloud(q, 8).catch(() => []);
  const hit = nearest(hits, (h) => h.duration, want.duration);
  if (hit) return (await loadOne(player.node, await relay(hit.url), requester)).encoded!;
  if (player.node.id === 'youtube' && !want.noYoutube) {
    const res = await player.node.search({ query: q, source: 'ytmsearch' }, requester).catch(() => null);
    const best = nearest(res?.tracks ?? [], (t) => t.info.duration, want.duration);
    if (best?.encoded) return best.encoded;
  }
  throw new Error(`no audio found for ${q}`);
}

export function queued(want: Want, requester: Requester): UnresolvedTrack {
  const t = manager.utils.buildUnresolvedTrack(
    { title: want.title, author: want.author, duration: want.duration, uri: want.link ?? want.uri, artworkUrl: want.artwork, sourceName: want.source as any },
    requester,
  );
  t.userData = { want: { ...want } as Record<string, any> };
  const base = t.resolve.bind(t);
  t.resolve = async (player: Player) => {
    t.encoded = await findAudio(want, player, requester);
    await base(player);
  };
  return t;
}

const fromSongs = (songs: SongInfo[], source: string, requester: Requester) =>
  songs.filter((s) => s.title).map((s) => queued({ ...s, how: 'find', source }, requester));

const fromHit = (h: RelayHit, source: string): Want => ({ title: h.title, author: h.author, duration: h.duration, artwork: h.artwork, uri: h.url, link: h.url, how: 'relay', source });

export interface Found {
  tracks: (Track | UnresolvedTrack)[];
  name?: string; // set when it was a playlist or album
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

  // plain words: soundcloud, since youtube keeps asking for a login
  const hits = await searchSoundCloud(text, 5);
  return { tracks: hits.slice(0, 1).map((h) => queued(fromHit(h, 'soundcloud'), requester)) };
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
