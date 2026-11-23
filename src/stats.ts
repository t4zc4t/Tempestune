import { EmbedBuilder, type Client } from 'discord.js';
import type { Track } from 'lavalink-client';
import { SLIME } from './card.js';
import { db } from './db.js';
import { log } from './log.js';
import { allSettings, updateSettings } from './settings.js';

// every song that starts is counted, for the stats command and the weekly recap

export function notePlay(guild: string, track: Track, user: string) {
  try {
    db.prepare('INSERT INTO plays (guild, user, title, author, ms, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      guild, user, track.info.title.slice(0, 200), (track.info.author ?? '').slice(0, 120), track.info.duration ?? 0, Date.now(),
    );
  } catch (e) {
    log('play count failed', e);
  }
}

export type Period = 'week' | 'month' | 'all';
const SINCE: Record<Period, number> = { week: 7, month: 30, all: 0 };

export function statsEmbed(guild: string, guildName: string, period: Period, botId: string, title?: string) {
  const days = SINCE[period];
  const from = days ? Date.now() - days * 86_400_000 : 0;
  const songs = db.prepare(
    'SELECT title, author, COUNT(*) AS n FROM plays WHERE guild = ? AND at >= ? GROUP BY lower(title) ORDER BY n DESC, MAX(at) DESC LIMIT 10',
  ).all(guild, from) as { title: string; author: string; n: number }[];
  const people = db.prepare(
    'SELECT user, COUNT(*) AS n FROM plays WHERE guild = ? AND at >= ? AND user != ? GROUP BY user ORDER BY n DESC LIMIT 5',
  ).all(guild, from, botId) as { user: string; n: number }[];
  const total = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(ms), 0) AS ms FROM plays WHERE guild = ? AND at >= ?').get(guild, from) as { n: number; ms: number };

  const when = period === 'all' ? 'since I started counting' : `in the last ${days} days`;
  const e = new EmbedBuilder().setColor(SLIME).setAuthor({ name: title ?? `《Great Sage》 ${guildName} · most played` });
  if (!total.n) return e.setDescription(`Nothing played ${when} yet.`);
  const hours = total.ms / 3_600_000;
  e.setDescription(`**${total.n}** songs, about **${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours** of music ${when}.`)
    .addFields(
      { name: 'Top songs', value: songs.map((s, i) => `\`${i + 1}.\` ${s.title} · ${s.author} (${s.n})`).join('\n').slice(0, 1024) },
      { name: 'Top requesters', value: people.length ? people.map((p, i) => `\`${i + 1}.\` <@${p.user}> · ${p.n} ${p.n === 1 ? "song" : "songs"}`).join('\n') : 'Only autoplay so far.' },
    );
  return e;
}

// monday morning, local time: last week's card in the channel each server picked
const weekKey = (d: Date) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-w${Math.ceil(((+t - +start) / 86_400_000 + 1) / 7)}`;
};

export function weeklyRecap(client: Client) {
  const tick = async () => {
    const now = new Date();
    if (now.getDay() !== 1 || now.getHours() < 10) return;
    const key = weekKey(now);
    for (const { guild, s } of allSettings()) {
      if (!s.recapChannel || s.lastRecap === key) continue;
      const g = client.guilds.cache.get(guild);
      const ch = g ? await client.channels.fetch(s.recapChannel).catch(() => null) : null;
      updateSettings(guild, { lastRecap: key });
      if (!g || !ch?.isSendable()) continue;
      await ch.send({ embeds: [statsEmbed(guild, g.name, 'week', client.user!.id, '《Great Sage》 This week in music')] }).catch((e) => log('recap failed', e));
    }
  };
  setInterval(() => void tick(), 10 * 60_000).unref();
}
