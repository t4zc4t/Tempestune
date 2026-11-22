import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ActivityType, type Client } from 'discord.js';
import type { LavalinkManager } from 'lavalink-client';
import { dropCard } from './card.js';
import { db } from './db.js';
import { forgetQueue } from './keep.js';
import { log } from './log.js';
import { updateYtdlp } from './relay.js';
import { settingsOf } from './settings.js';

// ---------- leave empty voice channels ----------

// checked on a timer rather than on voice events alone, so it also catches a queue restored
// into an empty channel, or the bot left sitting in a channel with no player
const EMPTY_FOR = 2 * 60_000;
const emptySince = new Map<string, number>();

export function watchVoice(client: Client, lavalink: LavalinkManager) {
  setInterval(() => {
    for (const g of client.guilds.cache.values()) {
      const me = g.members.me;
      const channel = me?.voice.channel;
      const people = channel ? channel.members.filter((m) => !m.user.bot).size : 0;
      if (!channel || people || settingsOf(g.id).stay) {
        emptySince.delete(g.id);
        continue;
      }
      const since = emptySince.get(g.id) ?? Date.now();
      emptySince.set(g.id, since);
      if (Date.now() - since < EMPTY_FOR) continue;
      emptySince.delete(g.id);
      log(`left ${channel.name} in ${g.name}: nobody listening`);
      forgetQueue(g.id);
      dropCard(g.id).catch(() => {});
      const player = lavalink.getPlayer(g.id);
      if (player) player.destroy('nobody listening').catch(() => me!.voice.disconnect().catch(() => {}));
      else me!.voice.disconnect().catch(() => {});
    }
  }, 20_000).unref();
}

// ---------- what's playing, as the bot's status ----------

export function showStatus(client: Client, lavalink: LavalinkManager) {
  if (!client.isReady()) return;
  const playing = [...lavalink.players.values()].filter((p) => p.queue.current && p.playing);
  const name =
    playing.length === 1
      ? `${playing[0].queue.current!.info.title} · ${playing[0].queue.current!.info.author}`.slice(0, 120)
      : playing.length
        ? `music in ${playing.length} servers`
        : 'tt help';
  client.user.setActivity({ name, type: ActivityType.Listening });
}

// ---------- daily jobs: database backup and yt-dlp update ----------

const backups = fileURLToPath(new URL('../backups/', import.meta.url));
const KEEP = 7;

function backup() {
  try {
    mkdirSync(backups, { recursive: true });
    const day = new Date().toLocaleDateString('sv-SE'); // yyyy-mm-dd in local time
    const file = `${backups}tempestune-${day}.db`;
    rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const old = readdirSync(backups).filter((f) => /^tempestune-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().reverse().slice(KEEP);
    for (const f of old) rmSync(backups + f, { force: true });
    log(`backup saved: tempestune-${day}.db`);
  } catch (e) {
    log('backup failed', e);
  }
}

export function dailyJobs() {
  const day = () => {
    backup();
    updateYtdlp().catch((e) => log('yt-dlp update failed', e));
  };
  setTimeout(day, 2 * 60_000).unref();
  setInterval(day, 24 * 60 * 60_000).unref();
}
