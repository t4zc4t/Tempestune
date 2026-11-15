import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { Player, Track, UnresolvedTrack } from 'lavalink-client';
import { SLIME, clock } from './card.js';
import { db, json } from './db.js';
import type { Want } from './music.js';
import { norm } from './rank.js';

// playlists, favourites and history, all stored as the "want" of each song (enough to find it again)

export type Song = Want;

export function songOfTrack(t: Track | UnresolvedTrack): Song {
  const want = t.userData?.want as unknown as Want | undefined;
  if (want) return { ...want };
  return { title: t.info.title, author: t.info.author ?? '', duration: t.info.duration, artwork: t.info.artworkUrl ?? undefined, link: t.info.uri ?? undefined, how: 'find', source: t.info.sourceName ?? 'search' };
}

const keyOf = (s: Song) => norm(`${s.author} ${s.title}`).slice(0, 120);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- playlists ----------

export interface Playlist {
  id: number;
  owner: string;
  name: string;
  code: string;
  songs: Song[];
  created: number;
}

const rowToList = (r: any): Playlist => ({ id: r.id, owner: r.owner, name: r.name, code: r.code, songs: json<Song[]>(r.songs, []), created: r.created });

export const MAX_SONGS = 500;

export function savePlaylist(owner: string, name: string, songs: Song[]) {
  const existing = getPlaylist(owner, name);
  const list = songs.slice(0, MAX_SONGS);
  if (existing) {
    db.prepare('UPDATE playlists SET songs = ? WHERE id = ?').run(JSON.stringify(list), existing.id);
    return { ...existing, songs: list, replaced: true };
  }
  const code = randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toUpperCase();
  db.prepare('INSERT INTO playlists (owner, name, code, songs, created) VALUES (?, ?, ?, ?, ?)').run(owner, name, code, JSON.stringify(list), Date.now());
  return { ...getPlaylist(owner, name)!, replaced: false };
}

export function getPlaylist(owner: string, nameOrCode: string): Playlist | null {
  const r = db.prepare('SELECT * FROM playlists WHERE owner = ? AND name = ?').get(owner, nameOrCode.trim());
  if (r) return rowToList(r);
  // anyone's playlist by its share code
  const shared = db.prepare('SELECT * FROM playlists WHERE code = ?').get(nameOrCode.trim().toUpperCase());
  return shared ? rowToList(shared) : null;
}

export const listPlaylists = (owner: string) => db.prepare('SELECT * FROM playlists WHERE owner = ? ORDER BY created DESC').all(owner).map(rowToList);

export const deletePlaylist = (owner: string, name: string) => Number(db.prepare('DELETE FROM playlists WHERE owner = ? AND name = ?').run(owner, name.trim()).changes) > 0;

export function addToPlaylist(owner: string, name: string, song: Song) {
  const p = getPlaylist(owner, name);
  if (!p || p.owner !== owner) return null;
  if (p.songs.length >= MAX_SONGS) return 'full';
  p.songs.push(song);
  db.prepare('UPDATE playlists SET songs = ? WHERE id = ?').run(JSON.stringify(p.songs), p.id);
  return p;
}

export function playlistsEmbed(owner: string, ownerName: string) {
  const lists = listPlaylists(owner);
  const e = new EmbedBuilder().setColor(SLIME).setAuthor({ name: `${ownerName}'s playlists` });
  if (!lists.length) return { embeds: [e.setDescription('No playlists yet. Save the current queue with `playlist save <name>`, or import one with `playlist import <link>`.')], components: [] };
  e.setDescription(lists.map((p) => `**${p.name}** · ${p.songs.length} songs · code \`${p.code}\``).join('\n'));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tt:plload:${owner}`)
    .setPlaceholder('Load one into the queue')
    .addOptions(lists.slice(0, 25).map((p) => ({ label: cut(p.name, 100), description: `${p.songs.length} songs`, value: p.code })));
  return { embeds: [e], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export function playlistEmbed(p: Playlist) {
  const total = p.songs.reduce((ms, s) => ms + (s.duration ?? 0), 0);
  const lines = p.songs.slice(0, 20).map((s, i) => `\`${String(i + 1).padStart(2, ' ')}.\` ${cut(s.title, 55)}${s.author ? ` · ${cut(s.author, 25)}` : ''}`);
  const more = p.songs.length > 20 ? `\n…and ${p.songs.length - 20} more` : '';
  return new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: `Playlist · ${p.name}` })
    .setDescription((lines.join('\n') || 'Empty.') + more)
    .setFooter({ text: `${p.songs.length} songs · ${clock(total)} · share code ${p.code}` });
}

// ---------- favourites ----------

// adds the song, or takes it out if it was already a favourite
export function toggleFavourite(user: string, song: Song) {
  const key = keyOf(song);
  const had = Number(db.prepare('DELETE FROM favourites WHERE user = ? AND key = ?').run(user, key).changes) > 0;
  if (!had) db.prepare('INSERT INTO favourites (user, key, song, added) VALUES (?, ?, ?, ?)').run(user, key, JSON.stringify(song), Date.now());
  return !had;
}

export const favourites = (user: string): Song[] =>
  db.prepare('SELECT song FROM favourites WHERE user = ? ORDER BY added DESC').all(user).map((r: any) => json<Song>(r.song, null as any)).filter(Boolean);

export function favouritesEmbed(user: string, name: string, page = 0) {
  const all = favourites(user);
  const pages = Math.max(1, Math.ceil(all.length / 10));
  page = Math.min(Math.max(0, page), pages - 1);
  const lines = all.slice(page * 10, page * 10 + 10).map((s, i) => `\`${String(page * 10 + i + 1).padStart(2, ' ')}.\` ${cut(s.title, 55)}${s.author ? ` · ${cut(s.author, 25)}` : ''}`);
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: `${name}'s favourites` })
    .setDescription(lines.join('\n') || 'No favourites yet. Press Like on the player, or use `like` while a song plays.')
    .setFooter({ text: `${all.length} songs · page ${page + 1}/${pages}` });
  const b = (id: string, label: string, off = false, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(off);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    b(`tt:fav:${user}:${page - 1}`, 'Back', page === 0),
    b(`tt:fav:${user}:${page + 1}`, 'Next', page >= pages - 1),
    b(`tt:favplay:${user}`, 'Play all', !all.length, ButtonStyle.Primary),
  );
  return { embeds: [e], components: [row] };
}

// ---------- history ----------

export function noteHistory(user: string, guild: string, song: Song) {
  db.prepare('INSERT INTO history (user, guild, song, at) VALUES (?, ?, ?, ?)').run(user, guild, JSON.stringify(song), Date.now());
  // keep the last 200 per person
  db.prepare('DELETE FROM history WHERE user = ? AND id NOT IN (SELECT id FROM history WHERE user = ? ORDER BY at DESC LIMIT 200)').run(user, user);
}

export function recent(user: string, limit = 15): (Song & { at: number })[] {
  const rows = db.prepare('SELECT song, at FROM history WHERE user = ? ORDER BY at DESC LIMIT 60').all(user) as any[];
  const seen = new Set<string>();
  const out: (Song & { at: number })[] = [];
  for (const r of rows) {
    const s = json<Song | null>(r.song, null);
    if (!s || seen.has(keyOf(s))) continue;
    seen.add(keyOf(s));
    out.push({ ...s, at: r.at });
    if (out.length >= limit) break;
  }
  return out;
}

export function historyEmbed(user: string, name: string) {
  const list = recent(user);
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: `${name}'s recent songs` })
    .setDescription(list.map((s, i) => `\`${String(i + 1).padStart(2, ' ')}.\` ${cut(s.title, 55)} · -# ${ago(s.at)}`).join('\n') || 'Nothing played yet.');
  if (!list.length) return { embeds: [e], components: [] };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tt:hist:${user}`)
    .setPlaceholder('Play one again')
    .addOptions(list.map((s, i) => ({ label: cut(s.title, 100), description: cut(s.author || '—', 100), value: String(i) })));
  return { embeds: [e], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export const songsOfQueue = (player: Player): Song[] =>
  [player.queue.current, ...player.queue.tracks].filter((t): t is Track | UnresolvedTrack => !!t).map(songOfTrack);
