import type { LavalinkManager, LavalinkNode, Player, Track, UnresolvedTrack } from 'lavalink-client';
import { config } from './config.js';
import { isApple, isDeezer, isSpotify, readDeezer, readSpotify, type SongInfo } from './links.js';
import { log } from './log.js';
import { notice } from './alerts.js';
import { isSaavn, readSaavn, sameSong, searchSaavn } from './saavn.js';
import { best, catalogue, guessSong, norm, offOriginal, type Canon } from './rank.js';
import { findStations, searchJamendo, splitTitle, type Station } from './extras.js';
import { listOf, relay, searchSoundCloud, searchYouTube, type RelayHit } from './relay.js';

export interface Requester {
  id: string;
  name: string;
}

// what a queued song needs so it can be found again when its turn comes
export interface Want extends SongInfo {
  how: 'relay' | 'youtube' | 'find' | 'direct'; // direct: lavalink can play the url itself (radio, jamendo)
  source: string;
  uri?: string;
  noYoutube?: boolean; // set after youtube already failed for this song
  noSaavn?: boolean; // set after jiosaavn already failed for this song
  song?: { title: string; author: string; duration?: number }; // the real song, when we worked it out (for lyrics)
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

interface Match {
  hit: RelayHit;
  source: string;
  notOriginal: boolean;
  song?: Canon;
}

const ytSearch = (q: string) =>
  searchYouTube(q, 10).catch((e) => {
    log('youtube search failed:', e instanceof Error ? e.message : e);
    return [] as RelayHit[];
  });

// a known song (title, artist, length): jiosaavn, then youtube, soundcloud as the last backup
async function matchSong(canon: Canon, asked: string, noYoutube = false, noSaavn = false): Promise<Match | null> {
  const q = `${canon.author} ${canon.title.replace(/\s*[([].*?[)\]]/g, '')}`.trim();
  // jiosaavn first: the label's own upload, so it's the original
  if (!noSaavn) {
    const hits = await searchSaavn(`${canon.title.replace(/\s*[([].*?[)\]]/g, '')} ${canon.author}`, 10);
    const hit = hits.find((h) => sameSong(h, canon) && !offOriginal(h, asked, canon));
    if (hit) return { hit, source: 'jiosaavn', notOriginal: false, song: canon };
  }
  let backup: Match | null = null;
  if (youtubeOn() && !noYoutube) {
    const hit = best(await ytSearch(`${q} audio`), asked, canon);
    if (hit) {
      const m: Match = { hit, source: 'youtube', notOriginal: offOriginal(hit, asked, canon), song: canon };
      if (!m.notOriginal) return m;
      backup = m;
    }
  }
  const hit = best(await searchSoundCloud(q, 10).catch(() => []), asked, canon);
  const sc: Match | null = hit ? { hit, source: 'soundcloud', notOriginal: offOriginal(hit, asked, canon), song: canon } : null;
  if (sc && (!sc.notOriginal || !backup)) return sc;
  return backup ?? sc;
}

// typed words: figure out the song first, then fetch it
async function matchWords(text: string): Promise<Match | null> {
  const [yt, songs] = await Promise.all([youtubeOn() ? ytSearch(text) : Promise.resolve([] as RelayHit[]), catalogue(text)]);
  const song = guessSong(text, songs, yt);
  if (song) {
    log(`"${text}" -> ${song.author} - ${song.title}`);
    const m = await matchSong(song, text);
    if (m) return m;
  }
  // not a song we know (a mix, a podcast, something niche): best of what youtube and soundcloud say
  const hit = best(yt, text);
  if (hit) return { hit, source: 'youtube', notOriginal: false };
  const sv = best(await searchSaavn(text, 10), text);
  if (sv && norm(`${sv.title} ${sv.author}`).includes(norm(text).split(' ')[0] ?? '')) return { hit: sv, source: 'jiosaavn', notOriginal: false };
  const sc = best(await searchSoundCloud(text, 10).catch(() => []), text);
  return sc ? { hit: sc, source: 'soundcloud', notOriginal: false } : null;
}

// finds the actual audio for a queued song
async function findAudio(want: Want, player: Player, requester: Requester): Promise<Track> {
  if (want.how === 'direct' && want.uri) return loadOne(player.node, want.uri, requester);
  if (want.how !== 'find' && want.uri) return loadOne(player.node, await relay(want.uri), requester);
  // metadata only (spotify, apple, deezer) or a song whose own link failed: search by name
  const m = await matchSong({ title: want.title, author: want.author, duration: want.duration }, `${want.author} ${want.title}`, want.noYoutube, want.noSaavn);
  if (!m) throw new Error(`no audio found for ${want.author} ${want.title}`);
  return loadOne(player.node, await relay(m.hit.url), requester);
}

// radio stations die all the time, so try a few and keep the first one lavalink can actually open
export async function workingStation(wants: Want[], requester: Requester): Promise<Want | null> {
  const node = manager.nodeManager.nodes.get(pickNode());
  if (!node) return null;
  for (const w of wants) {
    if (!w.uri) continue;
    const ok = await Promise.race([
      loadOne(node, w.uri, requester).then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 7000)),
    ]);
    if (ok) return w;
    log(`radio: ${w.title} did not open, trying the next one`);
  }
  return null;
}

export function queued(want: Want, requester: Requester): UnresolvedTrack {
  const t = manager.utils.buildUnresolvedTrack(
    { title: want.title, author: want.author, duration: want.duration, uri: want.link ?? want.uri, artworkUrl: want.artwork, sourceName: want.source as any },
    requester,
  );
  t.userData = { want: { ...want } as Record<string, any> };
  // swaps this placeholder for the real track in place, so the queue keeps the same object
  t.resolve = async (player: Player) => {
    const real = await findAudio(want, player, requester).catch(async (e) => {
      // jiosaavn refused it: look again everywhere else
      if (want.source === 'jiosaavn' && !want.noSaavn) {
        log(`jiosaavn failed for ${want.title}, looking elsewhere:`, e instanceof Error ? e.message.split('\n')[0] : e);
        return findAudio({ ...want, how: 'find', noSaavn: true }, player, requester);
      }
      // youtube refused it: same song from soundcloud instead
      if (want.noYoutube || (want.source !== 'youtube' && want.how !== 'find')) throw e;
      log(`youtube failed for ${want.title}, trying soundcloud:`, e instanceof Error ? e.message.split('\n')[0] : e);
      notice('youtube', e instanceof Error ? e.message.split('\n')[0] : String(e));
      return findAudio({ ...want, how: 'find', noYoutube: true }, player, requester);
    });
    for (const sym of Object.getOwnPropertySymbols(t)) delete (t as any)[sym];
    for (const prop of Object.getOwnPropertyNames(t)) delete (t as any)[prop];
    const file = real.info.uri; // the relay url, kept for the loudness lookup
    for (const sym of Object.getOwnPropertySymbols(real)) Object.defineProperty(t, sym, { configurable: true, value: (real as any)[sym] });
    Object.assign(t, real, { requester: real.requester ?? requester });
    // keep the names we know, the relay file itself has none
    const info = (t as unknown as Track).info;
    if (want.title) info.title = want.title;
    if (want.author) info.author = want.author;
    if (want.artwork) info.artworkUrl = want.artwork;
    if (want.link) info.uri = want.link;
    if (want.duration && !info.duration) info.duration = want.duration;
    (t as unknown as Track).userData = { ...(real.userData ?? {}), file, want: { ...want } as Record<string, any> };
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
  if (isUrl && isSaavn(text)) {
    const r = await readSaavn(text);
    return { tracks: r.hits.map((h) => queued(fromHit(h, 'jiosaavn'), requester)), name: r.name };
  }
  if (isUrl && /soundcloud\.com\/|bandcamp\.com\/|youtube\.com\/|youtu\.be\//i.test(text)) {
    const source = /bandcamp/i.test(text) ? 'bandcamp' : /soundcloud/i.test(text) ? 'soundcloud' : 'youtube';
    if (source === 'youtube' && !youtubeOn()) throw new Error('youtube is off');
    const list = await listOf(text);
    return { tracks: list.hits.map((h) => queued(fromHit(h, source), requester)), name: list.name };
  }
  if (isUrl) throw new Error('that link is not a supported source');

  // plain words
  const m = await matchWords(text);
  if (!m) return { tracks: [] };
  return { tracks: [queued({ ...fromHit(m.hit, m.source), song: m.song }, requester)], notOriginal: m.notOriginal };
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

// ---------- picking from a list (search menu) ----------

export interface Option {
  want: Want;
  label: string;
  detail: string;
}

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const SOURCE_NAME: Record<string, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud', radio: 'Radio', jamendo: 'Jamendo', jiosaavn: 'JioSaavn' };

export type Length = 'any' | 'short' | 'normal' | 'long';
const fitsLength = (ms: number, len: Length) =>
  len === 'any' || (len === 'short' && ms > 0 && ms < 3 * 60_000) || (len === 'normal' && ms >= 3 * 60_000 && ms <= 6 * 60_000) || (len === 'long' && ms > 6 * 60_000);

export const stationWant = (st: Station): Want => ({ title: st.name, author: [st.country, st.tags.split(',').slice(0, 2).join(', ')].filter(Boolean).join(' · ') || 'Internet radio', uri: st.url, link: st.url, artwork: st.favicon, how: 'direct', source: 'radio' });

// everything that matches, from every source that is on, for the search menu
export async function searchAll(text: string, source = 'all', length: Length = 'any'): Promise<Option[]> {
  const want = (s: string) => source === 'all' || source === s;
  const [sv, yt, sc, radio, jam] = await Promise.all([
    want('jiosaavn') ? searchSaavn(text, 10) : Promise.resolve([] as RelayHit[]),
    want('youtube') && youtubeOn() ? ytSearch(text) : Promise.resolve([] as RelayHit[]),
    want('soundcloud') ? searchSoundCloud(text, 10).catch(() => [] as RelayHit[]) : Promise.resolve([] as RelayHit[]),
    source === 'radio' ? findStations(text, 10) : Promise.resolve([] as Station[]),
    want('jamendo') ? searchJamendo(text, 5) : Promise.resolve([]),
  ]);
  const hits: Option[] = [
    ...sv.map((h) => ({ h, s: 'jiosaavn' })),
    ...yt.map((h) => ({ h, s: 'youtube' })),
    ...sc.map((h) => ({ h, s: 'soundcloud' })),
  ]
    .filter((x) => fitsLength(x.h.duration, length))
    .map(({ h, s }) => ({ want: fromHit(h, s), label: h.title, detail: `${SOURCE_NAME[s]} · ${h.author} · ${mmss(h.duration)}` }));
  // the sources take turns so each shows up near the top: jiosaavn, youtube, youtube, soundcloud
  const mixed: Option[] = [];
  const j = hits.filter((o) => o.want.source === 'jiosaavn');
  const a = hits.filter((o) => o.want.source === 'youtube');
  const b = hits.filter((o) => o.want.source === 'soundcloud');
  while (j.length || a.length || b.length) {
    if (j.length) mixed.push(j.shift()!);
    if (a.length) mixed.push(a.shift()!);
    if (a.length) mixed.push(a.shift()!);
    if (b.length) mixed.push(b.shift()!);
  }
  for (const st of radio) mixed.push({ want: stationWant(st), label: st.name, detail: `Radio · ${st.country || 'online'} · ${st.codec}` });
  for (const t of jam)
    if (fitsLength(t.duration, length))
      mixed.push({ want: { title: t.title, author: t.author, duration: t.duration, uri: t.url, link: t.link, artwork: t.artwork, how: 'direct', source: 'jamendo' }, label: t.title, detail: `Jamendo · ${t.author} · ${mmss(t.duration)}` });
  return mixed.slice(0, 25);
}

// a song known by name (from a lyrics line, a saved playlist...) as a queue entry
export const fromSong = (song: Canon & { artwork?: string; link?: string }, requester: Requester, source = 'search') =>
  queued({ title: song.title, author: song.author, duration: song.duration, artwork: song.artwork, link: song.link, how: 'find', source }, requester);

export const fromWant = (want: Want, requester: Requester) => queued({ ...want }, requester);

// ---------- autoplay: keep going with related songs when the queue runs out ----------

const ytId = (url?: string) => (url ? /(?:v=|youtu\.be\/)([\w-]{11})/.exec(url)?.[1] : undefined);

// autoplay ideas: last.fm's similar songs first (clean names, no youtube needed), youtube's mix as the backup.
// every idea is a plain name, so it gets found the usual way: jiosaavn, then youtube, then soundcloud
const JUNK = /\b(dance|choreo\w*|animatic|reaction|tutorial|cover|karaoke|shorts|trailer|teaser|making of|behind the scenes|amv|edit)\b/i;

async function similarOnLastfm(title: string, author: string): Promise<Canon[]> {
  if (!config.lastfmKey) return [];
  const q = new URLSearchParams({ method: 'track.getsimilar', artist: author, track: title, autocorrect: '1', limit: '30', api_key: config.lastfmKey, format: 'json' });
  const j = (await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`, { signal: AbortSignal.timeout(7000) }).then((r) => r.json()).catch(() => null)) as any;
  return (j?.similartracks?.track ?? []).map((t: any) => ({ title: String(t.name), author: String(t.artist?.name ?? ''), duration: Number(t.duration || 0) * 1000 || undefined }));
}

async function similarOnYouTube(last: Track): Promise<Canon[]> {
  if (!youtubeOn()) return [];
  const want = last.userData?.want as unknown as Want | undefined;
  const id = ytId(want?.uri) ?? ytId(last.info.uri);
  if (!id) return [];
  const mix = await listOf(`https://www.youtube.com/watch?v=${id}&list=RD${id}`).catch(() => null);
  return (mix?.hits ?? [])
    .filter((h) => h.duration > 90_000 && h.duration < 8 * 60_000 && !offOriginal(h, '', undefined))
    .map((h) => ({ ...splitTitle(h.title, h.author), duration: h.duration }));
}

const nameOf = (t: Track) => {
  const want = t.userData?.want as unknown as (Want & { song?: Canon }) | undefined;
  if (want?.song) return want.song;
  if (want?.how === 'find') return { title: want.title, author: want.author };
  return splitTitle(t.info.title, t.info.author ?? '');
};

export async function related(player: Player, requester: Requester, seed?: Track): Promise<Track | null> {
  const last = (seed ?? player.queue.previous[0] ?? player.queue.current) as Track | undefined;
  if (!last) return null;
  const { title, author } = nameOf(last);
  const seen = new Set<string>([...((player.get('played') as string[] | undefined) ?? []), ...recentlyPlayed(player.guildId)]);
  const fresh = (c: Canon) => c.title && !seen.has(norm(c.title).slice(0, 40)) && !JUNK.test(c.title) && norm(c.title) !== norm(title);
  let ideas = (await similarOnLastfm(title, author)).filter(fresh);
  if (ideas.length < 3) ideas = [...ideas, ...(await similarOnYouTube(last)).filter(fresh)];
  // still nothing (niche song and youtube blocked): more songs by the same artist from jiosaavn
  if (ideas.length < 3) ideas = [...ideas, ...(await searchSaavn(author.split(/,| & /)[0], 20)).map((h) => ({ title: h.title, author: h.author, duration: h.duration })).filter(fresh)];
  // a bit of variety: shuffle the first few, then try them in turn until one actually plays
  const top = ideas.slice(0, 6).sort(() => Math.random() - 0.5);
  for (const idea of [...top, ...ideas.slice(6, 10)].slice(0, 5)) {
    const t = queued({ title: idea.title, author: idea.author, duration: idea.duration, how: 'find', source: 'search' }, requester);
    const ok = await t.resolve(player).then(() => true, () => false);
    if (ok) return t as unknown as Track;
    seen.add(norm(idea.title).slice(0, 40));
  }
  log(`autoplay found nothing after ${title}`);
  return null;
}

// everything played in a server over the last hour, kept across stops and restarts of the player
const lastHour = new Map<string, { key: string; at: number }[]>();
const HOUR = 60 * 60_000;
function recentlyPlayed(guild: string) {
  const now = Date.now();
  const list = (lastHour.get(guild) ?? []).filter((x) => now - x.at < HOUR);
  lastHour.set(guild, list);
  return list.map((x) => x.key);
}

// songs people picked themselves, the anchor for autoplay so it doesn't wander off
export function noteSeed(player: Player, track: Track) {
  const seeds: Track[] = player.get('seeds') ?? [];
  player.set('seeds', [track, ...seeds.filter((t) => t.info.title !== track.info.title)].slice(0, 5));
}

// remembers what played, so autoplay doesn't loop back to it
export function notePlayed(player: Player, title: string) {
  const key = norm(title).slice(0, 40);
  const played: string[] = player.get('played') ?? [];
  played.unshift(key);
  player.set('played', played.slice(0, 100));
  recentlyPlayed(player.guildId);
  lastHour.get(player.guildId)!.push({ key, at: Date.now() });
}

// autoplay, ready ahead: while the last song plays, the next related one is found and fetched,
// but kept out of the queue until the queue actually runs out
export async function prepareAutoplay(player: Player, requester: Requester) {
  const current = player.queue.current as Track | null;
  if (!player.get('autoplay') || !current || player.queue.tracks.length) return;
  const seed = current.encoded ?? current.info.title;
  if (player.get('autoSeed') === seed) return; // already working on this one
  player.set('autoSeed', seed);
  player.set('autoNext', null);
  // after an autoplay song, go back to one of the songs people actually asked for
  const seeds: Track[] = player.get('seeds') ?? [];
  const byBot = (current.requester as Requester | undefined)?.id === requester.id;
  const from = byBot && seeds.length ? seeds[Math.floor(Math.random() * seeds.length)] : current;
  const next = await related(player, requester, from).catch(() => null);
  if (next && player.get('autoSeed') === seed) player.set('autoNext', next);
}

// takes the prepared song if it is still for the song that just ended
export function takeAutoplay(player: Player, ended?: Track | null) {
  const next = player.get('autoNext') as UnresolvedTrack | Track | null;
  const ready = !!next && !!ended && player.get('autoSeed') === (ended.encoded ?? ended.info.title);
  player.set('autoNext', null);
  player.set('autoSeed', null);
  return ready ? next : null;
}
