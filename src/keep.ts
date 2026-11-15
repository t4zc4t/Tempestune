import type { LavalinkManager, Player, Track } from 'lavalink-client';
import { db, json } from './db.js';
import { songOfTrack, type Song } from './library.js';
import { log } from './log.js';
import { fromWant, pickNode, type Requester } from './music.js';
import { settingsOf } from './settings.js';
import { applyPreset, setPitch, setSpeed } from './sound.js';

// the queue survives restarts: the bot, lavalink, or the whole pc

interface Saved {
  voice: string;
  text: string;
  position: number;
  current: (Song & { by?: Requester }) | null;
  tracks: (Song & { by?: Requester })[];
  volume: number;
  repeat: 'off' | 'track' | 'queue';
  autoplay: boolean;
  filter?: string;
  speed?: number;
  pitch?: number;
}

const MAX_AGE = 6 * 60 * 60_000;

const withBy = (t: Track | { requester?: unknown } & Parameters<typeof songOfTrack>[0]) => ({ ...songOfTrack(t as any), by: (t as any).requester as Requester | undefined });

export function saveQueue(player: Player) {
  if (!player.voiceChannelId) return;
  const current = player.queue.current;
  const data: Saved = {
    voice: player.voiceChannelId,
    text: player.textChannelId ?? player.voiceChannelId,
    position: current && !current.info.isStream ? player.position : 0,
    current: current ? withBy(current) : null,
    tracks: player.queue.tracks.slice(0, 300).map(withBy),
    volume: player.volume,
    repeat: player.repeatMode,
    autoplay: !!player.get('autoplay'),
    filter: player.get('filter'),
    speed: player.get('speed'),
    pitch: player.get('pitch'),
  };
  if (!data.current && !data.tracks.length) return forgetQueue(player.guildId);
  db.prepare('INSERT INTO queues (guild, data, at) VALUES (?, ?, ?) ON CONFLICT (guild) DO UPDATE SET data = excluded.data, at = excluded.at').run(player.guildId, JSON.stringify(data), Date.now());
}

export const forgetQueue = (guild: string) => db.prepare('DELETE FROM queues WHERE guild = ?').run(guild);

export const saveAll = (lavalink: LavalinkManager) => {
  for (const p of lavalink.players.values()) {
    try {
      saveQueue(p);
    } catch (e) {
      log('queue save failed', e);
    }
  }
};

// reasons that mean "something broke", where the queue should come back later
const KEEP = new Set(['NodeDestroy', 'NodeDeleted', 'NodeReconnectFail', 'DisconnectAllNodes', 'ReconnectAllNodes', 'PlayerChangeNodeFail', 'PlayerChangeNodeFailNoEligibleNode', 'LavalinkNoVoice']);
export const keepOnDestroy = (reason?: string) => !!reason && KEEP.has(reason);

let restoring = false;
export async function restoreAll(lavalink: LavalinkManager, botId: string) {
  if (restoring) return;
  restoring = true;
  try {
    const rows = db.prepare('SELECT guild, data, at FROM queues').all() as { guild: string; data: string; at: number }[];
    for (const row of rows) {
      if (lavalink.getPlayer(row.guild)?.queue.current) continue;
      if (Date.now() - row.at > MAX_AGE && !settingsOf(row.guild).stay) {
        forgetQueue(row.guild);
        continue;
      }
      const saved = json<Saved | null>(row.data, null);
      if (!saved?.current && !saved?.tracks.length) continue;
      await restoreOne(lavalink, row.guild, saved, botId).catch((e) => log(`queue restore failed for ${row.guild}`, e));
    }
  } finally {
    restoring = false;
  }
}

async function restoreOne(lavalink: LavalinkManager, guild: string, saved: Saved, botId: string) {
  let player = lavalink.getPlayer(guild);
  if (!player) player = lavalink.createPlayer({ guildId: guild, voiceChannelId: saved.voice, textChannelId: saved.text, selfDeaf: true, volume: saved.volume, node: pickNode() });
  if (!player.connected) await player.connect();
  const fallback: Requester = { id: botId, name: 'restore' };
  const songs = [saved.current, ...saved.tracks].filter((s): s is Song & { by?: Requester } => !!s);
  await player.queue.add(songs.map((s) => fromWant(s, s.by ?? fallback)));
  player.set('autoplay', saved.autoplay);
  player.set('normalise', settingsOf(guild).normalise);
  await player.setRepeatMode(saved.repeat ?? 'off').catch(() => {});
  await player.play({ position: saved.position > 5000 ? saved.position - 2000 : 0 }).catch(async (e: unknown) => {
    log('restored queue could not start at the saved spot, starting fresh', e instanceof Error ? e.message : e);
    await player!.play().catch(() => {});
  });
  if (saved.filter && saved.filter !== 'off') await applyPreset(player, saved.filter).catch(() => {});
  if (saved.speed && saved.speed !== 1) await setSpeed(player, saved.speed).catch(() => {});
  if (saved.pitch && saved.pitch !== 1) await setPitch(player, saved.pitch).catch(() => {});
  log(`restored the queue in ${guild}: ${songs.length} songs`);
}
