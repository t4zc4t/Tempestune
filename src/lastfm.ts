import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from 'discord.js';
import type { LavalinkManager, Player, Track } from 'lavalink-client';
import { SLIME } from './card.js';
import { config } from './config.js';
import { db } from './db.js';
import { log } from './log.js';
import { songOf } from './sound.js';

// last.fm: each person connects once, then every song they hear in voice with the bot is
// shown as now playing and scrobbled, like other music bots do

const API = 'https://ws.audioscrobbler.com/2.0/';
export const lastfmOn = () => !!(config.lastfmKey && config.lastfmSecret);

interface Link { user: string; name: string; session: string; scrobble: number }
const linkOf = (user: string) => db.prepare('SELECT * FROM lastfm WHERE user = ?').get(user) as unknown as Link | undefined;

function sign(params: Record<string, string>) {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHash('md5').update(base + config.lastfmSecret, 'utf8').digest('hex');
}

async function call(method: string, params: Record<string, string> = {}, post = false) {
  const all: Record<string, string> = { method, api_key: config.lastfmKey, ...params };
  all.api_sig = sign(all);
  const body = new URLSearchParams({ ...all, format: 'json' });
  const res = await fetch(post ? API : `${API}?${body}`, {
    method: post ? 'POST' : 'GET',
    body: post ? body : undefined,
    headers: { 'user-agent': 'Tempestune' },
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (j.error) throw Object.assign(new Error(j.message ?? `last.fm error ${j.error}`), { code: j.error });
  return j;
}

// ---------- connecting ----------

const waiting = new Map<string, NodeJS.Timeout>();

// gives back the approve link, then keeps checking until the person approves (5 minutes at most)
export async function startLink(user: string, done: (name: string | null) => void) {
  const { token } = await call('auth.getToken');
  clearInterval(waiting.get(user));
  const until = Date.now() + 5 * 60_000;
  const timer = setInterval(async () => {
    if (Date.now() > until) {
      clearInterval(timer);
      waiting.delete(user);
      return done(null);
    }
    try {
      const { session } = await call('auth.getSession', { token });
      clearInterval(timer);
      waiting.delete(user);
      db.prepare('INSERT INTO lastfm (user, name, session, scrobble) VALUES (?, ?, ?, 1) ON CONFLICT (user) DO UPDATE SET name = excluded.name, session = excluded.session, scrobble = 1')
        .run(user, session.name, session.key);
      done(session.name);
    } catch (e: any) {
      // 14 means not approved yet, anything else is a real problem
      if (e?.code !== 14) {
        clearInterval(timer);
        waiting.delete(user);
        log('last.fm link failed', e?.message ?? e);
        done(null);
      }
    }
  }, 4000);
  waiting.set(user, timer);
  return `https://www.last.fm/api/auth/?api_key=${config.lastfmKey}&token=${token}`;
}

export const unlink = (user: string) => Number(db.prepare('DELETE FROM lastfm WHERE user = ?').run(user).changes) > 0;
export const setScrobble = (user: string, on: boolean) => db.prepare('UPDATE lastfm SET scrobble = ? WHERE user = ?').run(on ? 1 : 0, user);

export function fmPanel(user: string, displayName: string) {
  const link = linkOf(user);
  const e = new EmbedBuilder().setColor(SLIME).setAuthor({ name: '《Great Sage》 Last.fm' });
  const b = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`tt:fm:${id}`).setLabel(label).setStyle(style);
  if (!lastfmOn()) return { embeds: [e.setDescription('Last.fm is not set up on this bot yet.')], components: [] };
  if (!link) {
    e.setDescription(`${displayName}, connect your Last.fm once and every song you hear here gets scrobbled for you.`);
    return { embeds: [e], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(b('connect', 'Connect Last.fm', ButtonStyle.Primary))] };
  }
  e.setDescription(
    [
      `Connected as **[${link.name}](https://www.last.fm/user/${encodeURIComponent(link.name)})**.`,
      link.scrobble ? 'Scrobbling is **on**: songs you hear in voice with me go to your profile.' : 'Scrobbling is **off** for now.',
    ].join('\n'),
  );
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        link.scrobble ? b('off', 'Pause scrobbling') : b('on', 'Resume scrobbling', ButtonStyle.Success),
        b('unlink', 'Disconnect', ButtonStyle.Danger),
      ),
    ],
  };
}

// ---------- scrobbling ----------

interface Now { key: string; start: number; song: { title: string; author: string; duration?: number }; done: boolean; told: Set<string> }
const now = new Map<string, Now>();

// last.fm only counts songs over 30 seconds, after half of it or 4 minutes
const enough = (len: number) => Math.min(len / 2, 4 * 60_000);
const firstArtist = (a: string) => a.split(/,| & | x | feat\.? | ft\.? /i)[0].trim() || a;

function listenersOf(client: Client, player: Player): Link[] {
  const channel = player.voiceChannelId ? client.channels.cache.get(player.voiceChannelId) : null;
  if (!channel?.isVoiceBased()) return [];
  return [...channel.members.values()]
    .filter((m) => !m.user.bot && !m.voice.deaf)
    .map((m) => linkOf(m.id))
    .filter((l): l is Link => !!l && !!l.scrobble);
}

export function fmTrackStart(client: Client, player: Player, track: Track) {
  if (!lastfmOn()) return;
  if (track.info.isStream || (track.info.duration ?? 0) < 30_000) return void now.delete(player.guildId);
  const song = songOf(track);
  now.set(player.guildId, { key: track.encoded ?? track.info.title, start: Math.floor(Date.now() / 1000), song, done: false, told: new Set() });
  tellNowPlaying(client, player);
}

function tellNowPlaying(client: Client, player: Player) {
  const n = now.get(player.guildId);
  if (!n) return;
  for (const l of listenersOf(client, player)) {
    if (n.told.has(l.user)) continue;
    n.told.add(l.user);
    const p: Record<string, string> = { artist: firstArtist(n.song.author), track: n.song.title, sk: l.session };
    if (n.song.duration) p.duration = String(Math.round(n.song.duration / 1000));
    call('track.updateNowPlaying', p, true).catch((e) => log(`now playing for ${l.name} failed:`, e.message));
  }
}

// checked every 10 seconds: people who joined late get now playing, and once enough is heard it scrobbles
export function watchScrobbles(client: Client, lavalink: LavalinkManager) {
  if (!lastfmOn()) return;
  setInterval(() => {
    for (const player of lavalink.players.values()) {
      const n = now.get(player.guildId);
      const t = player.queue.current;
      if (!n || !t || n.done || (t.encoded ?? t.info.title) !== n.key) continue;
      if (!player.paused) tellNowPlaying(client, player);
      if (player.position < enough(t.info.duration)) continue;
      n.done = true;
      for (const l of listenersOf(client, player)) {
        call('track.scrobble', { artist: firstArtist(n.song.author), track: n.song.title, timestamp: String(n.start), sk: l.session }, true)
          .catch((e) => {
            log(`scrobble for ${l.name} failed:`, e.message);
            // 9: the session was revoked on last.fm's side
            if (e.code === 9) unlink(l.user);
          });
      }
    }
  }, 10_000).unref();
}
