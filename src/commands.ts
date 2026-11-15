import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder,
  type AutocompleteInteraction, type ButtonInteraction, type ChannelSelectMenuInteraction, type RoleSelectMenuInteraction, type StringSelectMenuInteraction, type ChatInputCommandInteraction, type GuildMember, type Message,
} from 'discord.js';
import type { LavalinkManager, Player, RepeatMode } from 'lavalink-client';
import { cardButtons, cardEmbed, clock, dropCard, idleBoard, refreshCard, setBoard, SLIME } from './card.js';
import { config } from './config.js';
import { icon } from './icons.js';
import { log } from './log.js';
import { didYouMean, findStations, songFromLine, suggestSongs } from './extras.js';
import { addToPlaylist, deletePlaylist, favourites, favouritesEmbed, getPlaylist, historyEmbed, playlistEmbed, playlistsEmbed, recent, savePlaylist, songOfTrack, songsOfQueue, toggleFavourite } from './library.js';
import { canControl, isManager, listeners, settingsOf, settingsPanel, updateSettings } from './settings.js';
import { applyPreset, filterPanel, onFilterControl, PRESETS, setPitch, setSpeed, showLyrics } from './sound.js';
import { find, fromSong, fromWant, pickNode, searchAll, stationWant, type Found, type Length, type Option, type Requester } from './music.js';
import { say } from './sage.js';

// one set of commands for both slash and the text prefix

type Payload = { content?: string; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<any>[] };

export interface Ctx {
  guildId: string;
  channelId: string;
  member: GuildMember;
  user: { id: string; username: string };
  str(name: string): string | null;
  int(name: string): number | null;
  // first answer; quiet ones are only seen by the person (slash) or vanish after a bit (prefix)
  reply(p: string | Payload, quiet?: boolean): Promise<Message | null>;
  // for slow commands: shows the bot is working, then the answer replaces it
  wait(note?: string): Promise<void>;
}

interface Command {
  name: string;
  aliases: string[];
  about: string;
  // how prefix words map to options, in order
  args?: { name: string; kind: 'text' | 'int'; about: string; required?: boolean; rest?: boolean; choices?: string[]; auto?: boolean }[];
  needsPlayer?: boolean;
  control?: boolean; // changes playback for everyone: dj role rules apply
  run(c: Ctx, lavalink: LavalinkManager, player: Player | undefined): Promise<unknown>;
}

const pageSize = 10;

export function queuePage(player: Player, page: number) {
  const tracks = player.queue.tracks;
  const pages = Math.max(1, Math.ceil(tracks.length / pageSize));
  page = Math.min(Math.max(0, page), pages - 1);
  const now = player.queue.current;
  const lines = tracks.slice(page * pageSize, page * pageSize + pageSize).map((t, i) => {
    const n = page * pageSize + i + 1;
    const len = t.info.duration ? ` \`${clock(t.info.duration)}\`` : '';
    return `\`${String(n).padStart(2, ' ')}.\` ${cut(t.info.title, 60)}${len}`;
  });
  const total = tracks.reduce((ms, t) => ms + (t.info.duration ?? 0), 0);
  const loop = player.repeatMode === 'off' ? '' : ` · looping ${player.repeatMode}`;
  const embed = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: 'Queue' })
    .setDescription(
      `**Now:** ${now ? cut(now.info.title, 80) : 'nothing'}\n\n${lines.join('\n') || 'The queue is empty. Add songs with play.'}`,
    )
    .setFooter({ text: `${tracks.length} songs · ${clock(total)} total${loop} · page ${page + 1}/${pages}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tt:q:${page - 1}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`tt:q:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    withIcon(new ButtonBuilder().setCustomId('tt:shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(tracks.length < 2), 'shuffle'),
  );
  return { embeds: [embed], components: [row] };
}

const withIcon = (b: ButtonBuilder, name: string) => {
  const e = icon(name);
  return e ? b.setEmoji(e) : b;
};

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// "1:30", "90", "1:02:03" -> ms
const toMs = (s: string) => {
  const parts = s.trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
};

function sameVoice(c: Ctx, player?: Player) {
  const vc = c.member.voice?.channelId;
  if (!vc) return say('noVoice');
  if (player?.voiceChannelId && player.voiceChannelId !== vc) return say('otherVoice');
  return null;
}

// joins voice if needed, fetches the first song right away, queues the rest
async function enqueue(c: Ctx, lavalink: LavalinkManager, player: Player | undefined, found: Found, intro = '') {
  if (!player) {
    const s = settingsOf(c.guildId);
    player = lavalink.createPlayer({
      guildId: c.guildId, voiceChannelId: c.member.voice.channelId!, textChannelId: c.channelId, selfDeaf: true, volume: 80, node: pickNode(),
    });
    player.set('autoplay', s.autoplay);
    player.set('normalise', s.normalise);
  }
  if (!player.connected) await player.connect();
  const lead = intro ? `${intro}\n` : '';

  // the first song is fetched right away, so a dead one says so instead of failing quietly later
  const first = found.tracks[0];
  if (lavalink.utils.isUnresolvedTrack(first)) {
    const ok = await first.resolve(player).then(() => true, (e: unknown) => {
      log('first song failed:', e instanceof Error ? e.message.split('\n')[0] : e);
      return false;
    });
    if (!ok) {
      found.tracks.shift();
      if (!found.tracks.length) {
        if (!player.queue.current) await player.destroy().catch(() => {});
        return c.reply(lead + say('failed'));
      }
    }
  }
  const idle = !player.queue.current;
  await player.queue.add(found.tracks);
  if (idle) {
    const started = await player.play().then(() => true, (e: unknown) => {
      log('play failed:', e instanceof Error ? e.message : e);
      return false;
    });
    if (!started) return c.reply(lead + say('failed'));
  }
  if (found.name || found.tracks.length > 1) return c.reply(`${lead}${say('predator', { n: found.tracks.length })}${found.name ? ` (${found.name})` : ''}`);
  const t = found.tracks[0];
  const note = found.notOriginal ? `\n-# ${say('notOriginal')}` : '';
  return c.reply(lead + (idle ? `${say('loaded')} **${t.info.title}**` : `${say('queued')} **${t.info.title}** (#${player.queue.tracks.length})`) + note);
}

// search menus remember their results for a while
const menus = new Map<string, { options: Option[]; requester: Requester; until: number }>();
function remember(options: Option[], requester: Requester) {
  const now = Date.now();
  for (const [k, v] of menus) if (v.until < now) menus.delete(k);
  const key = now.toString(36) + Math.random().toString(36).slice(2, 6);
  menus.set(key, { options, requester, until: now + 15 * 60_000 });
  return key;
}

const commands: Command[] = [
  {
    name: 'play', aliases: ['p'], about: 'Play a song, or add it to the queue',
    args: [{ name: 'query', kind: 'text', about: 'Song name, or a YouTube, Spotify, SoundCloud, Apple Music or Deezer link', required: true, rest: true, auto: true }],
    async run(c, lavalink, player) {
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      if (!lavalink.nodeManager.nodes.get('main')?.connected) return c.reply(say('nodeDown'), true);
      const query = c.str('query');
      if (!query) return c.reply('What should I play? Give me a song name or a link.', true);
      await c.wait(say('searching'));
      const requester: Requester = { id: c.user.id, name: c.user.username };
      const found = await find(query, requester).catch((e) => {
        log('play lookup failed:', e instanceof Error ? e.message : e);
        return e instanceof Error && e.message === 'youtube is off' ? 'youtube' : null;
      });
      if (found === 'youtube') return c.reply('YouTube is switched off on this bot right now.');
      if (!found?.tracks.length) {
        const dym = await didYouMean(query);
        return c.reply(dym ? `${say('notFound')}\nDid you mean **${dym}**? Try \`${config.prefix} p ${dym}\`` : say('notFound'));
      }
      return enqueue(c, lavalink, player, found);
    },
  },
  {
    name: 'search', aliases: ['find', 'f'], about: 'Search every source and pick the exact one',
    args: [
      { name: 'query', kind: 'text', about: 'What to look for (start with "lyrics:" to find a song by a line from it)', required: true, rest: true },
      { name: 'source', kind: 'text', about: 'Only one source', choices: ['all', 'youtube', 'soundcloud', 'radio', 'jamendo'] },
      { name: 'length', kind: 'text', about: 'Song length', choices: ['any', 'short', 'normal', 'long'] },
    ],
    async run(c, lavalink, player) {
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      let query = c.str('query') ?? '';
      // prefix users can add "source:radio" or "length:short" anywhere
      let source = c.str('source') ?? 'all';
      let length = (c.str('length') ?? 'any') as Length;
      query = query.replace(/\bsource:(\w+)/i, (_, v) => ((source = v.toLowerCase()), '')).replace(/\blength:(\w+)/i, (_, v) => ((length = v.toLowerCase() as Length), '')).trim();
      if (!query) return c.reply('What should I search for?', true);
      await c.wait(say('searching'));
      const requester: Requester = { id: c.user.id, name: c.user.username };

      // a line from the lyrics: find the song, then play it
      const line = /^lyrics?:\s*(.+)$/i.exec(query)?.[1];
      if (line) {
        const song = await songFromLine(line);
        if (!song) return c.reply('Great Sage: no song found with that line. Try a longer bit of it?');
        return enqueue(c, lavalink, player, { tracks: [fromSong(song, requester)] }, `Great Sage: that line is from **${song.title}** by ${song.author}.`);
      }

      const options = await searchAll(query, source, length);
      if (!options.length) {
        const dym = await didYouMean(query);
        return c.reply(dym ? `${say('notFound')}\nDid you mean **${dym}**?` : say('notFound'));
      }
      const key = remember(options, requester);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`tt:pick:${key}`)
        .setPlaceholder('Pick one to play')
        .addOptions(options.map((o, n) => ({ label: cut(o.label, 100), description: cut(o.detail, 100), value: String(n) })));
      const e = new EmbedBuilder().setColor(SLIME).setAuthor({ name: 'Great Sage: search results' }).setDescription(`**${cut(query, 80)}** · ${options.length} found. Pick one below.`);
      return c.reply({ embeds: [e], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
    },
  },
  {
    name: 'radio', aliases: ['fm'], about: 'Play an internet radio station',
    args: [{ name: 'station', kind: 'text', about: 'Station name, like lofi or bbc radio 1', required: true, rest: true }],
    async run(c, lavalink, player) {
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      const name = c.str('station') ?? '';
      await c.wait(say('searching'));
      const [st] = await findStations(name, 1);
      if (!st) return c.reply('Great Sage: no working station by that name.');
      const requester: Requester = { id: c.user.id, name: c.user.username };
      return enqueue(c, lavalink, player, { tracks: [fromWant(stationWant(st), requester)] });
    },
  },
  {
    name: 'autoplay', aliases: ['ap', 'auto'], about: 'Keep playing related songs when the queue ends', needsPlayer: true, control: true,
    async run(c, _l, player) {
      const on = !player!.get('autoplay');
      player!.set('autoplay', on);
      await refreshCard(player!);
      return c.reply(on ? 'Autoplay is on. When the queue ends I will keep going with related songs.' : 'Autoplay is off.');
    },
  },
  {
    name: 'pause', aliases: [], about: 'Pause the music', needsPlayer: true, control: true,
    async run(c, _l, player) {
      await player!.pause();
      await refreshCard(player!);
      return c.reply(say('paused'), true);
    },
  },
  {
    name: 'resume', aliases: ['unpause', 'r'], about: 'Carry on playing', needsPlayer: true, control: true,
    async run(c, _l, player) {
      await player!.resume();
      await refreshCard(player!);
      return c.reply(say('resumed'), true);
    },
  },
  {
    name: 'skip', aliases: ['s', 'next', 'n'], about: 'Skip to the next song', needsPlayer: true,
    async run(c, _l, player) {
      return c.reply(await trySkip(c, player!));
    },
  },
  {
    name: 'skipto', aliases: ['st', 'jump'], about: 'Jump to a song in the queue', needsPlayer: true, control: true,
    args: [{ name: 'position', kind: 'int', about: 'Its number in the queue', required: true }],
    async run(c, _l, player) {
      const n = c.int('position');
      if (!n || n < 1 || n > player!.queue.tracks.length) return c.reply(`Pick a number from 1 to ${player!.queue.tracks.length}.`, true);
      await player!.skip(n, false);
      return c.reply(`Jumped to #${n}.`, true);
    },
  },
  {
    name: 'stop', aliases: ['leave', 'dc', 'disconnect'], about: 'Stop, clear the queue and leave',
    async run(c, _l, player) {
      if (!player) return c.reply(say('nothing'), true);
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      if (!canControl(c.member, player)) return c.reply(say('djOnly'), true);
      await dropCard(c.guildId);
      await player.destroy();
      return c.reply(say('stopped'));
    },
  },
  {
    name: 'volume', aliases: ['vol', 'v'], about: 'Change the volume', needsPlayer: true, control: true,
    args: [{ name: 'level', kind: 'int', about: '0 to 150', required: true }],
    async run(c, _l, player) {
      const v = c.int('level');
      if (v === null || v < 0 || v > 150) return c.reply(`Volume is ${player!.volume}%. Give me 0 to 150 to change it.`, true);
      await player!.setVolume(v);
      await refreshCard(player!);
      return c.reply(`Volume set to ${v}%.`, true);
    },
  },
  {
    name: 'nowplaying', aliases: ['np', 'now'], about: 'Show what is playing', needsPlayer: true,
    async run(c, _l, player) {
      return c.reply({ embeds: [cardEmbed(player!)] });
    },
  },
  {
    name: 'queue', aliases: ['q', 'list'], about: 'Show the queue',
    args: [{ name: 'page', kind: 'int', about: 'Page number' }],
    async run(c, _l, player) {
      if (!player?.queue.current && !player?.queue.tracks.length) return c.reply('The queue is empty. Add songs with play.', true);
      return c.reply(queuePage(player, (c.int('page') ?? 1) - 1));
    },
  },
  {
    name: 'remove', aliases: ['rm', 'del'], about: 'Remove a song from the queue', needsPlayer: true, control: true,
    args: [{ name: 'position', kind: 'int', about: 'Its number in the queue', required: true }],
    async run(c, _l, player) {
      const n = c.int('position');
      const q = player!.queue;
      if (!n || n < 1 || n > q.tracks.length) return c.reply(`Pick a number from 1 to ${q.tracks.length}.`, true);
      const gone = q.tracks[n - 1];
      await q.splice(n - 1, 1);
      return c.reply(`Removed **${gone?.info.title ?? `#${n}`}**.`);
    },
  },
  {
    name: 'move', aliases: ['mv'], about: 'Move a song to another spot in the queue', needsPlayer: true, control: true,
    args: [
      { name: 'from', kind: 'int', about: 'Its number now', required: true },
      { name: 'to', kind: 'int', about: 'Where it should go', required: true },
    ],
    async run(c, _l, player) {
      const q = player!.queue;
      const from = c.int('from');
      const to = c.int('to');
      const ok = (n: number | null) => n !== null && n >= 1 && n <= q.tracks.length;
      if (!ok(from) || !ok(to)) return c.reply(`Both numbers need to be from 1 to ${q.tracks.length}.`, true);
      const t = q.tracks[from! - 1];
      await q.splice(from! - 1, 1);
      await q.splice(to! - 1, 0, t);
      return c.reply(`Moved **${t.info.title}** to #${to}.`);
    },
  },
  {
    name: 'clear', aliases: ['cl'], about: 'Clear the queue (keeps the current song)', needsPlayer: true, control: true,
    async run(c, _l, player) {
      const n = player!.queue.tracks.length;
      await player!.queue.splice(0, n);
      await refreshCard(player!);
      return c.reply(`Cleared ${n} songs from the queue.`);
    },
  },
  {
    name: 'shuffle', aliases: ['sh', 'mix'], about: 'Shuffle the queue', needsPlayer: true, control: true,
    async run(c, _l, player) {
      if (player!.queue.tracks.length < 2) return c.reply('Need at least two songs in the queue to shuffle.', true);
      await player!.queue.shuffle();
      await refreshCard(player!);
      return c.reply('Shuffled the queue.');
    },
  },
  {
    name: 'loop', aliases: ['l', 'repeat'], about: 'Loop the song or the queue', needsPlayer: true, control: true,
    args: [{ name: 'mode', kind: 'text', about: 'off, song or queue (leave empty to cycle)' }],
    async run(c, _l, player) {
      const asked = (c.str('mode') ?? '').toLowerCase();
      const order: RepeatMode[] = ['off', 'track', 'queue'];
      const mode: RepeatMode = /^(song|track|one|this)$/.test(asked) ? 'track' : /^(queue|all)$/.test(asked) ? 'queue' : /^(off|none|stop)$/.test(asked) ? 'off'
        : order[(order.indexOf(player!.repeatMode) + 1) % 3];
      await player!.setRepeatMode(mode);
      await refreshCard(player!);
      return c.reply(mode === 'off' ? 'Loop is off.' : mode === 'track' ? 'Looping this song.' : 'Looping the whole queue.');
    },
  },
  {
    name: 'seek', aliases: ['jumpto'], about: 'Jump to a time in the song', needsPlayer: true, control: true,
    args: [{ name: 'time', kind: 'text', about: 'Like 1:30 or 90', required: true }],
    async run(c, _l, player) {
      const ms = toMs(c.str('time') ?? '');
      const len = player!.queue.current?.info.duration ?? 0;
      if (ms === null || ms < 0 || (len && ms >= len)) return c.reply(`Give me a time inside the song, like 1:30${len ? ` (it is ${clock(len)} long)` : ''}.`, true);
      await player!.seek(ms);
      await refreshCard(player!);
      return c.reply(`Jumped to ${clock(ms)}.`, true);
    },
  },
  {
    name: 'lyrics', aliases: ['ly'], about: 'Lyrics for the song, following along as it plays', needsPlayer: true,
    async run(c, _l, player) {
      await c.wait(say('searching'));
      const problem = await showLyrics(player!, (p) => c.reply(p));
      return problem ? c.reply(problem) : null;
    },
  },
  {
    name: 'filter', aliases: ['fx', 'filters', 'effect'], about: 'Sound filters: bassboost, nightcore, vaporwave, 8d, karaoke and more', needsPlayer: true, control: true,
    args: [{ name: 'name', kind: 'text', about: 'Filter to use (leave empty for the panel)', choices: Object.keys(PRESETS) }],
    async run(c, _l, player) {
      const name = c.str('name')?.toLowerCase();
      if (name && !PRESETS[name]) return c.reply(`Filters: ${Object.keys(PRESETS).map((k) => `\`${k}\``).join(' ')}`, true);
      if (name) await applyPreset(player!, name);
      return c.reply(filterPanel(player!));
    },
  },
  {
    name: 'speed', aliases: ['sp'], about: 'Play faster or slower (0.5 to 2)', needsPlayer: true, control: true,
    args: [{ name: 'times', kind: 'text', about: 'Like 1.25 or 0.8', required: true }],
    async run(c, _l, player) {
      const v = Number(c.str('times'));
      if (!Number.isFinite(v) || v < 0.5 || v > 2) return c.reply('Give me a speed from 0.5 to 2, like 1.25.', true);
      await setSpeed(player!, v);
      return c.reply(`Speed set to ${v}x.`, true);
    },
  },
  {
    name: 'pitch', aliases: ['pt'], about: 'Higher or lower voice (0.5 to 2)', needsPlayer: true, control: true,
    args: [{ name: 'times', kind: 'text', about: 'Like 1.2 or 0.9', required: true }],
    async run(c, _l, player) {
      const v = Number(c.str('times'));
      if (!Number.isFinite(v) || v < 0.5 || v > 2) return c.reply('Give me a pitch from 0.5 to 2, like 1.2.', true);
      await setPitch(player!, v);
      return c.reply(`Pitch set to ${v}x.`, true);
    },
  },
  {
    name: 'playlist', aliases: ['pl', 'playlists'], about: 'Your saved playlists: save, load, list, show, add, delete, share, import',
    args: [
      { name: 'action', kind: 'text', about: 'What to do', choices: ['list', 'save', 'load', 'show', 'add', 'delete', 'share', 'import'] },
      { name: 'name', kind: 'text', about: 'Playlist name, share code, or a link to import', rest: true },
    ],
    async run(c, lavalink, player) {
      const action = (c.str('action') ?? 'list').toLowerCase();
      let name = (c.str('name') ?? '').trim();
      const me = c.user.id;
      const requester: Requester = { id: me, name: c.user.username };
      if (action === 'list' || !['save', 'load', 'show', 'add', 'delete', 'share', 'import'].includes(action)) return c.reply(playlistsEmbed(me, c.user.username));
      if (action === 'import') {
        const link = /https?:\/\/\S+/.exec(name)?.[0];
        if (!link) return c.reply('Give me a playlist link to import, like a Spotify, YouTube or SoundCloud playlist.', true);
        name = name.replace(link, '').trim();
        await c.wait(say('searching'));
        const found = await find(link, requester).catch(() => null);
        if (!found?.tracks.length) return c.reply('Great Sage: could not read that playlist.');
        const saved = savePlaylist(me, name || found.name || 'Imported', found.tracks.map(songOfTrack));
        return c.reply(`${say('predator', { n: saved.songs.length })} Saved as **${saved.name}** (code \`${saved.code}\`). Play it with \`${config.prefix} pl load ${saved.name}\`.`);
      }
      if (!name) return c.reply('Which playlist? Give me its name.', true);
      if (action === 'save') {
        if (!player?.queue.current) return c.reply('Nothing is playing, so there is nothing to save yet.', true);
        const saved = savePlaylist(me, name, songsOfQueue(player));
        return c.reply(`${saved.replaced ? 'Updated' : 'Saved'} **${saved.name}** with ${saved.songs.length} songs. Share code \`${saved.code}\`.`);
      }
      if (action === 'add') {
        if (!player?.queue.current) return c.reply(say('nothing'), true);
        const r = addToPlaylist(me, name, songOfTrack(player.queue.current));
        if (!r) return c.reply(`You have no playlist called **${name}**.`, true);
        if (r === 'full') return c.reply('That playlist is full (500 songs).', true);
        return c.reply(`Added **${player.queue.current.info.title}** to **${r.name}** (${r.songs.length} songs).`);
      }
      if (action === 'delete') return c.reply(deletePlaylist(me, name) ? `Deleted **${name}**.` : `You have no playlist called **${name}**.`, true);
      const list = getPlaylist(me, name);
      if (!list) return c.reply(`No playlist called **${name}** (or with that code).`, true);
      if (action === 'show') return c.reply({ embeds: [playlistEmbed(list)] });
      if (action === 'share') return c.reply(`Anyone can load **${list.name}** with \`${config.prefix} pl load ${list.code}\`.`);
      // load
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      if (!list.songs.length) return c.reply('That playlist is empty.', true);
      await c.wait(say('searching'));
      return enqueue(c, lavalink, player, { tracks: list.songs.map((s) => fromWant(s, requester)), name: list.name });
    },
  },
  {
    name: 'like', aliases: ['fav', 'heart'], about: 'Add the song to your favourites (again to remove it)', needsPlayer: true,
    async run(c, _l, player) {
      const added = toggleFavourite(c.user.id, songOfTrack(player!.queue.current!));
      return c.reply(added ? `Added **${player!.queue.current!.info.title}** to your favourites.` : 'Taken out of your favourites.', true);
    },
  },
  {
    name: 'favourites', aliases: ['favs', 'liked', 'favorites'], about: 'Your favourite songs',
    args: [{ name: 'play', kind: 'text', about: 'Type play to queue them all', choices: ['show', 'play'] }],
    async run(c, lavalink, player) {
      if ((c.str('play') ?? '').toLowerCase() !== 'play') return c.reply(favouritesEmbed(c.user.id, c.user.username));
      const songs = favourites(c.user.id);
      if (!songs.length) return c.reply('No favourites yet.', true);
      const problem = sameVoice(c, player);
      if (problem) return c.reply(problem, true);
      await c.wait(say('searching'));
      const requester: Requester = { id: c.user.id, name: c.user.username };
      return enqueue(c, lavalink, player, { tracks: songs.map((s) => fromWant(s, requester)), name: 'Favourites' });
    },
  },
  {
    name: 'history', aliases: ['hist', 'recent'], about: 'Songs you played recently',
    async run(c) {
      return c.reply(historyEmbed(c.user.id, c.user.username));
    },
  },
  {
    name: 'settings', aliases: ['setup', 'config'], about: 'Server settings: DJ role, vote skip, 24/7, request channel (Manage Server)',
    async run(c) {
      if (!isManager(c.member)) return c.reply('Only people with Manage Server can change the settings.', true);
      return c.reply(settingsPanel(c.guildId));
    },
  },
  {
    name: 'help', aliases: ['h', 'commands'], about: 'All commands',
    async run(c) {
      const lines = commands.filter((x) => x.name !== 'help').map((x) => {
        const args = (x.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
        const short = x.aliases.length ? ` · ${x.aliases.map((a) => `\`${a}\``).join(' ')}` : '';
        return `\`${x.name}${args ? ' ' + args : ''}\`${short}\n-# ${x.about}`;
      });
      const e = new EmbedBuilder()
        .setColor(SLIME)
        .setAuthor({ name: 'Tempestune' })
        .setDescription(`Use slash commands, or type **\`${config.prefix} \`** before any command, like \`${config.prefix} p faded\`.\n\n${lines.join('\n')}`);
      return c.reply({ embeds: [e] });
    },
  },
];

const byName = new Map<string, Command>();
for (const cmd of commands) for (const n of [cmd.name, ...cmd.aliases]) byName.set(n, cmd);

export const definitions = commands.map((cmd) => {
  const b = new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.about).setContexts(InteractionContextType.Guild);
  for (const a of cmd.args ?? []) {
    if (a.kind === 'int') b.addIntegerOption((o) => o.setName(a.name).setDescription(a.about).setRequired(!!a.required));
    else
      b.addStringOption((o) => {
        o.setName(a.name).setDescription(a.about).setRequired(!!a.required);
        if (a.choices) o.addChoices(...a.choices.map((ch) => ({ name: ch, value: ch })));
        if (a.auto) o.setAutocomplete(true);
        return o;
      });
  }
  return b.toJSON();
});

async function dispatch(cmd: Command, c: Ctx, lavalink: LavalinkManager) {
  const player = lavalink.getPlayer(c.guildId);
  if (cmd.needsPlayer) {
    if (!player?.queue.current) return c.reply(say('nothing'), true);
    const problem = sameVoice(c, player);
    if (problem) return c.reply(problem, true);
  }
  if (cmd.control && !canControl(c.member, player)) return c.reply(say('djOnly'), true);
  return cmd.run(c, lavalink, player);
}

// skipping: the dj, the person who asked for the song, or a vote when vote skip is on
async function trySkip(c: Ctx, player: Player): Promise<string> {
  const s = settingsOf(c.guildId);
  const mine = (player.queue.current?.requester as Requester | undefined)?.id === c.user.id;
  const free = s.voteSkip ? isManager(c.member) || (s.djRole && c.member.roles.cache.has(s.djRole)) || mine || listeners(c.member, player) <= 1 : canControl(c.member, player) || mine;
  if (free) {
    await player.skip(0, false);
    return say('skipped');
  }
  if (!s.voteSkip) return say('djOnly');
  const votes = new Set<string>(player.get('votes') ?? []);
  votes.add(c.user.id);
  player.set('votes', [...votes]);
  const need = Math.ceil(listeners(c.member, player) / 2);
  if (votes.size >= need) {
    await player.skip(0, false);
    return `Vote passed (${votes.size}/${need}). ${say('skipped')}`;
  }
  return `Vote to skip: ${votes.size}/${need}.`;
}

// ---------- slash ----------

export async function onCommand(i: ChatInputCommandInteraction, lavalink: LavalinkManager) {
  const cmd = byName.get(i.commandName);
  if (!cmd) return;
  const c = interactionCtx(i);
  return dispatch(cmd, c, lavalink);
}

// ---------- text prefix ----------

export async function onMessage(m: Message, lavalink: LavalinkManager) {
  if (m.author.bot || !m.inGuild() || !m.member) return;
  const content = m.content.trim();
  // the request channel: anything typed there is a song to play
  if (settingsOf(m.guildId).requestChannel === m.channelId && content && !content.toLowerCase().startsWith(config.prefix.toLowerCase() + ' ')) {
    return requestMessage(m, content, lavalink);
  }
  const mention = new RegExp(`^<@!?${m.client.user.id}>\\s*`);
  let body: string | null = null;
  if (mention.test(content)) body = content.replace(mention, '');
  else if (content.toLowerCase().startsWith(config.prefix.toLowerCase() + ' ')) body = content.slice(config.prefix.length + 1);
  if (body === null) return;
  const [word = '', ...rest] = body.trim().split(/\s+/);
  const cmd = byName.get(word.toLowerCase()) ?? (word ? undefined : byName.get('help'));
  if (!cmd) return;

  // prefix words become options in order, the last text one takes the rest of the line
  const values = new Map<string, string>();
  const specs = cmd.args ?? [];
  specs.forEach((a, idx) => {
    const v = a.rest || idx === specs.length - 1 && a.kind === 'text' ? rest.slice(idx).join(' ') : rest[idx];
    if (v) values.set(a.name, v);
  });

  let sent: Message | null = null;
  const c: Ctx = {
    guildId: m.guildId,
    channelId: m.channelId,
    member: m.member,
    user: m.author,
    str: (n) => values.get(n) ?? null,
    int: (n) => (values.has(n) && /^-?\d+$/.test(values.get(n)!) ? Number(values.get(n)) : null),
    async reply(p, quiet) {
      const payload = typeof p === 'string' ? { content: p } : p;
      if (sent) await sent.edit({ content: payload.content ?? '', embeds: payload.embeds ?? [], components: payload.components ?? [] });
      else sent = await m.reply({ ...payload, allowedMentions: { repliedUser: false } });
      // short notices tidy themselves away in busy channels
      if (quiet && sent) setTimeout(() => sent?.delete().catch(() => {}), 15_000);
      return sent;
    },
    async wait(note) {
      if (!sent) sent = await m.reply({ content: note ?? '…', allowedMentions: { repliedUser: false } });
    },
  };
  await dispatch(cmd, c, lavalink);
}

// ---------- buttons ----------

export async function onButton(i: ButtonInteraction, lavalink: LavalinkManager) {
  const player = lavalink.getPlayer(i.guildId!);
  const what = i.customId.slice(3);
  if (what.startsWith('fx')) {
    if (!player?.queue.current) return i.update({ components: [] });
    const vc = (i.member as GuildMember | null)?.voice?.channelId;
    if (!vc || vc !== player.voiceChannelId) return i.reply({ content: say('otherVoice'), flags: MessageFlags.Ephemeral });
    if (!canControl(i.member as GuildMember, player)) return i.reply({ content: say('djOnly'), flags: MessageFlags.Ephemeral });
    return i.update(await onFilterControl(player, i.customId));
  }
  if (what === 'lyrics') {
    if (!player?.queue.current) return i.reply({ content: say('nothing'), flags: MessageFlags.Ephemeral });
    await i.deferReply();
    const problem = await showLyrics(player, (p) => i.editReply(p).catch(() => null));
    if (problem) await i.editReply(problem);
    return;
  }
  if (what === 'filters') {
    if (!player?.queue.current) return i.reply({ content: say('nothing'), flags: MessageFlags.Ephemeral });
    return i.reply({ ...filterPanel(player), flags: MessageFlags.Ephemeral });
  }
  if (what.startsWith('fav:')) {
    const [, user, page] = what.split(':');
    if (user !== i.user.id) return i.reply({ ...favouritesEmbed(i.user.id, i.user.username), flags: MessageFlags.Ephemeral });
    return i.update(favouritesEmbed(user, i.user.username, Number(page)));
  }
  if (what.startsWith('favplay:')) {
    const songs = favourites(i.user.id);
    if (!songs.length) return i.reply({ content: 'No favourites yet.', flags: MessageFlags.Ephemeral });
    const c = interactionCtx(i);
    const problem = sameVoice(c, player);
    if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
    await i.deferReply();
    return enqueue(c, lavalink, player, { tracks: songs.map((s) => fromWant(s, { id: i.user.id, name: i.user.username })), name: 'Favourites' });
  }
  if (what === 'like') {
    if (!player?.queue.current) return i.reply({ content: say('nothing'), flags: MessageFlags.Ephemeral });
    const added = toggleFavourite(i.user.id, songOfTrack(player.queue.current));
    return i.reply({ content: added ? `Added **${player.queue.current.info.title}** to your favourites.` : 'Taken out of your favourites.', flags: MessageFlags.Ephemeral });
  }
  if (what.startsWith('q:')) {
    if (!player) return i.update({ components: [] });
    return i.update(queuePage(player, Number(what.slice(2))));
  }
  if (!player?.queue.current) return i.update({ components: [] });
  const vc = (i.member as GuildMember | null)?.voice?.channelId;
  if (!vc || vc !== player.voiceChannelId) return i.reply({ content: say('otherVoice'), flags: MessageFlags.Ephemeral });
  if (what === 'skip') {
    const note = await trySkip(interactionCtx(i), player);
    return i.reply({ content: note, flags: MessageFlags.Ephemeral });
  }
  if (!canControl(i.member as GuildMember, player)) return i.reply({ content: say('djOnly'), flags: MessageFlags.Ephemeral });
  if (what === 'shuffle') {
    await player.queue.shuffle();
    return i.update(queuePage(player, 0));
  }
  if (what === 'pause') player.paused ? await player.resume() : await player.pause();
  if (what === 'vdown') await player.setVolume(Math.max(0, player.volume - 10));
  if (what === 'vup') await player.setVolume(Math.min(150, player.volume + 10));
  if (what === 'auto') player.set('autoplay', !player.get('autoplay'));
  if (what === 'loop') {
    const order: RepeatMode[] = ['off', 'track', 'queue'];
    await player.setRepeatMode(order[(order.indexOf(player.repeatMode) + 1) % 3]);
  }
  if (what === 'stop') {
    await i.update({ components: [] });
    await dropCard(i.guildId!);
    await player.destroy();
    return;
  }
  return i.update({ embeds: [cardEmbed(player)], components: cardButtons(player) });
}

// ---------- typing suggestions for /play ----------

export async function onAutocomplete(i: AutocompleteInteraction) {
  const focused = i.options.getFocused(true);
  if (i.commandName !== 'play' || focused.name !== 'query') return i.respond([]);
  const list = await suggestSongs(String(focused.value)).catch(() => []);
  return i.respond(list).catch(() => {});
}

// ---------- a pick from the search menu ----------

export async function onPick(i: StringSelectMenuInteraction, lavalink: LavalinkManager) {
  const key = i.customId.split(':')[2];
  const menu = menus.get(key);
  if (!menu) return i.update({ content: 'That search has expired, run it again.', embeds: [], components: [] });
  const option = menu.options[Number(i.values[0])];
  if (!option) return i.update({ components: [] });
  const c = interactionCtx(i);
  const player = lavalink.getPlayer(c.guildId);
  const problem = sameVoice(c, player);
  if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
  await i.update({ content: `${say('searching')} **${cut(option.label, 80)}**`, embeds: [], components: [] });
  return enqueue(c, lavalink, player, { tracks: [fromWant(option.want, { id: i.user.id, name: i.user.username })] });
}

function interactionCtx(i: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction): Ctx {
  return {
    guildId: i.guildId!,
    channelId: i.channelId,
    member: i.member as GuildMember,
    user: i.user,
    str: (n) => (i.isChatInputCommand() ? i.options.getString(n) : null),
    int: (n) => (i.isChatInputCommand() ? i.options.getInteger(n) : null),
    async reply(p, quiet) {
      const body = typeof p === 'string' ? { content: p } : p;
      if (i.deferred || i.replied) return i.editReply(body).catch(() => null);
      const res = await i.reply({ ...body, ...(quiet ? { flags: MessageFlags.Ephemeral } : {}), withResponse: true }).catch(() => null);
      return (res?.resource?.message as Message | null | undefined) ?? null;
    },
    async wait() {
      if (!i.deferred && !i.replied) await i.deferReply();
    },
  };
}

// the filter menu
export async function onFilterPick(i: StringSelectMenuInteraction, lavalink: LavalinkManager) {
  const player = lavalink.getPlayer(i.guildId!);
  if (!player?.queue.current) return i.update({ components: [] });
  const vc = (i.member as GuildMember | null)?.voice?.channelId;
  if (!vc || vc !== player.voiceChannelId) return i.reply({ content: say('otherVoice'), flags: MessageFlags.Ephemeral });
  if (!canControl(i.member as GuildMember, player)) return i.reply({ content: say('djOnly'), flags: MessageFlags.Ephemeral });
  return i.update(await onFilterControl(player, 'tt:fx', i.values[0]));
}

// loading a playlist from the list menu, or replaying from history
export async function onLibraryPick(i: StringSelectMenuInteraction, lavalink: LavalinkManager) {
  const c = interactionCtx(i);
  const player = lavalink.getPlayer(c.guildId);
  const problem = sameVoice(c, player);
  if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
  const requester: Requester = { id: i.user.id, name: i.user.username };
  if (i.customId.startsWith('tt:plload:')) {
    const list = getPlaylist(i.user.id, i.values[0]);
    if (!list?.songs.length) return i.reply({ content: 'That playlist is gone or empty.', flags: MessageFlags.Ephemeral });
    await i.deferReply();
    return enqueue(c, lavalink, player, { tracks: list.songs.map((s) => fromWant(s, requester)), name: list.name });
  }
  const song = recent(i.customId.split(':')[2])[Number(i.values[0])];
  if (!song) return i.reply({ content: 'That one is not in the history anymore.', flags: MessageFlags.Ephemeral });
  await i.deferReply();
  return enqueue(c, lavalink, player, { tracks: [fromWant(song, requester)] });
}

// a song typed in the request channel: play it, keep the channel clean
async function requestMessage(m: Message<true>, text: string, lavalink: LavalinkManager) {
  let note: Message | null = null;
  const c: Ctx = {
    guildId: m.guildId,
    channelId: m.channelId,
    member: m.member!,
    user: m.author,
    str: (n) => (n === 'query' ? text : null),
    int: () => null,
    async reply(p) {
      const payload = typeof p === 'string' ? { content: p } : p;
      if (note) await note.edit({ content: payload.content ?? '', embeds: payload.embeds ?? [] }).catch(() => {});
      else note = await m.channel.send({ content: payload.content ?? '', embeds: payload.embeds ?? [] }).catch(() => null);
      return note;
    },
    async wait(n) {
      if (!note) note = await m.channel.send(n ?? '…').catch(() => null);
    },
  };
  await m.delete().catch(() => {});
  await dispatch(byName.get('play')!, c, lavalink);
  setTimeout(() => note?.delete().catch(() => {}), 8000);
}

// ---------- the settings panel ----------

export async function onSettings(i: ButtonInteraction | RoleSelectMenuInteraction | ChannelSelectMenuInteraction, lavalink: LavalinkManager) {
  const member = i.member as GuildMember;
  if (!isManager(member)) return i.reply({ content: 'Only people with Manage Server can change the settings.', flags: MessageFlags.Ephemeral });
  const gid = i.guildId!;
  const s = settingsOf(gid);
  const what = i.customId.split(':')[2];
  if (what === 'vote') updateSettings(gid, { voteSkip: !s.voteSkip });
  if (what === 'auto') updateSettings(gid, { autoplay: !s.autoplay });
  if (what === 'norm') updateSettings(gid, { normalise: !s.normalise });
  if (what === 'stay') {
    if (s.stay) updateSettings(gid, { stay: false, stayVoice: undefined, stayText: undefined });
    else {
      const vc = member.voice.channelId;
      if (!vc) return i.reply({ content: 'Join the voice channel I should stay in, then turn 24/7 on.', flags: MessageFlags.Ephemeral });
      updateSettings(gid, { stay: true, stayVoice: vc, stayText: i.channelId });
      await stayIn(lavalink, gid);
    }
  }
  if (what === 'dj' && i.isRoleSelectMenu()) updateSettings(gid, { djRole: i.values[0] });
  if (what === 'req' && i.isChannelSelectMenu()) {
    const old = s.requestChannel && s.requestMessage ? await i.client.channels.fetch(s.requestChannel).catch(() => null) : null;
    if (old?.isTextBased()) await old.messages.delete(s.requestMessage!).catch(() => {});
    setBoard(gid, null);
    const id = i.values[0];
    if (!id) updateSettings(gid, { requestChannel: undefined, requestMessage: undefined });
    else {
      const ch = await i.client.channels.fetch(id).catch(() => null);
      if (!ch?.isSendable()) return i.reply({ content: 'I cannot send messages there.', flags: MessageFlags.Ephemeral });
      const board = await ch.send({ embeds: [idleBoard()] });
      updateSettings(gid, { requestChannel: id, requestMessage: board.id });
      setBoard(gid, board);
      const player = lavalink.getPlayer(gid);
      if (player?.queue.current) await refreshCard(player);
    }
  }
  return i.update(settingsPanel(gid));
}

// 24/7: sit in the saved voice channel even with nothing playing
export async function stayIn(lavalink: LavalinkManager, gid: string) {
  const s = settingsOf(gid);
  if (!s.stay || !s.stayVoice) return;
  let player = lavalink.getPlayer(gid);
  if (!player) {
    player = lavalink.createPlayer({ guildId: gid, voiceChannelId: s.stayVoice, textChannelId: s.stayText ?? s.stayVoice, selfDeaf: true, volume: 80, node: pickNode() });
    player.set('autoplay', s.autoplay);
    player.set('normalise', s.normalise);
  }
  if (!player.connected) await player.connect().catch((e) => log('24/7 join failed', e));
}
