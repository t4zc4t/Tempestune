import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type Message } from 'discord.js';
import type { Player, Track } from 'lavalink-client';
import { icon } from './icons.js';
import { log } from './log.js';

// the now-playing card: one message per server, edited in place, never reposted by buttons
export const SLIME = 0x4fb8e0;

const SOURCES: Record<string, string> = {
  soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', youtube: 'YouTube', jiosaavn: 'JioSaavn', spotify: 'Spotify', applemusic: 'Apple Music',
  deezer: 'Deezer', http: 'Web', jamendo: 'Jamendo', radio: 'Radio',
};

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// magicule gauge
const bar = (pos: number, len: number, size = 15) => {
  const at = len > 0 ? Math.min(size, Math.round((pos / len) * size)) : size;
  return '▰'.repeat(at) + '▱'.repeat(size - at);
};

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function cardEmbed(player: Player) {
  const t = player.queue.current as Track | null;
  if (!t) return new EmbedBuilder().setColor(SLIME).setAuthor({ name: '《Great Sage》 Nothing is playing.' });
  const want = t.userData?.want as { source?: string } | undefined;
  const src = want?.source ?? t.info.sourceName;
  const source = (SOURCES[src] ?? src) + (src === 'jiosaavn' ? ' 320k' : '');
  const len = t.info.isStream ? 0 : t.info.duration;
  const time = t.info.isStream ? 'LIVE' : `${clock(player.position)} / ${clock(len)}`;
  const requester = (t.requester as { id?: string } | undefined)?.id;
  const loop = player.repeatMode === 'track' ? 'Looping song' : player.repeatMode === 'queue' ? 'Looping queue' : '';
  const info = [
    requester ? `Summoned by <@${requester}>` : '',
    source,
    `Vol ${player.volume}`,
    player.get('autoplay') ? 'Autoplay on' : '',
    loop,
  ].filter(Boolean).join(' · ');
  const next = player.queue.tracks[0];
  const more = player.queue.tracks.length - 1;
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: player.paused ? '《Great Sage》 Playback suspended.' : '《Great Sage》 Analysis complete.' })
    .setTitle(cut(t.info.title, 256))
    .setDescription(
      [
        cut(t.info.author || 'Unknown artist', 200),
        '',
        `${bar(player.position, len)}  \`${time}\``,
        `-# ${info}`,
        next ? `-# Next › ${cut(next.info.title, 60)}${more > 0 ? ` +${more}` : ''}` : '',
      ].filter((l, i) => l || i === 1).join('\n'),
    );
  const link = t.info.uri && /^https?:\/\//.test(t.info.uri) && !t.info.uri.includes('127.0.0.1') ? t.info.uri : null;
  if (link) e.setURL(link);
  if (t.info.artworkUrl) e.setThumbnail(t.info.artworkUrl);
  return e;
}

// icon plus one short word, so it's clear what each button does
const button = (id: string, emoji: string, label: string, style = ButtonStyle.Secondary, off = false) => {
  const btn = new ButtonBuilder().setCustomId(`tt:${id}`).setStyle(style).setDisabled(off).setLabel(label);
  const e = icon(emoji);
  return e ? btn.setEmoji(e) : btn;
};

export function cardButtons(player: Player, off = false) {
  const looping = player.repeatMode !== 'off';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('pause', player.paused ? 'play' : 'pause', player.paused ? 'Resume' : 'Pause', ButtonStyle.Primary, off),
      button('skip', 'skip', 'Skip', ButtonStyle.Secondary, off),
      button('stop', 'stop', 'Stop', ButtonStyle.Secondary, off),
      button('loop', player.repeatMode === 'track' ? 'loopone' : 'loop', 'Loop', looping ? ButtonStyle.Success : ButtonStyle.Secondary, off),
      button('like', 'like', 'Like', ButtonStyle.Secondary, off),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('vdown', 'voldown', 'Vol', ButtonStyle.Secondary, off),
      button('vup', 'volup', 'Vol', ButtonStyle.Secondary, off),
      button('lyrics', 'lyrics', 'Lyrics', ButtonStyle.Secondary, off),
      button('queue', 'queue', 'Queue', ButtonStyle.Secondary, off),
      button('skills', 'skills', 'Skills', ButtonStyle.Secondary, off),
    ),
  ];
}

// the private panel behind the skills button
export function skillsPanel(player: Player) {
  const auto = !!player.get('autoplay');
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: '《Great Sage》 Skills' })
    .setDescription(
      [
        `Autoplay is **${auto ? 'on' : 'off'}**${auto ? ', related songs keep coming when the queue runs out' : ''}.`,
        '-# Autoplay · shuffle · filters · equalizer · Predator (save this song to a playlist)',
      ].join('\n'),
    );
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('sk:auto', 'autoplay', 'Autoplay', auto ? ButtonStyle.Success : ButtonStyle.Secondary),
        button('sk:shuffle', 'shuffle', 'Shuffle'),
        button('sk:filters', 'filters', 'Filters'),
        button('sk:eq', 'eq', 'Equalizer'),
        button('sk:save', 'save', 'Predator'),
      ),
    ],
  };
}

interface Live {
  message: Message;
  timer: NodeJS.Timeout;
}
const live = new Map<string, Live>();

// request channel boards: one pinned player message per server that always shows what's on
const boards = new Map<string, Message>();
export const setBoard = (guildId: string, message: Message | null) => (message ? boards.set(guildId, message) : boards.delete(guildId));

export function idleBoard() {
  return new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: '《Great Sage》 Standing by.' })
    .setTitle('Nothing is playing')
    .setDescription('Type a song name or paste a link here and I will play it.\n-# Join a voice channel first.');
}

async function updateBoard(player: Player | null, guildId: string) {
  const board = boards.get(guildId);
  if (!board) return;
  const playing = player?.queue.current;
  await board
    .edit(playing ? { content: '', embeds: [cardEmbed(player!)], components: cardButtons(player!) } : { content: '', embeds: [idleBoard()], components: [] })
    .catch(() => boards.delete(guildId));
}

export async function showCard(client: Client, player: Player) {
  await dropCard(player.guildId, true);
  await updateBoard(player, player.guildId);
  // with a request channel, the board is the card: no extra message in that channel
  const board = boards.get(player.guildId);
  if (board && board.channelId === player.textChannelId) {
    const timer = setInterval(() => {
      if (!player.paused) updateBoard(player, player.guildId);
    }, 15_000);
    live.set(player.guildId, { message: board, timer });
    return;
  }
  const channel = player.textChannelId ? await client.channels.fetch(player.textChannelId).catch(() => null) : null;
  if (!channel?.isSendable()) return;
  const message = await channel.send({ embeds: [cardEmbed(player)], components: cardButtons(player) }).catch((e) => {
    log('card send failed', e);
    return null;
  });
  if (!message) return;
  // progress bar refresh, slow enough to stay clear of rate limits
  const timer = setInterval(() => {
    if (player.paused) return;
    message.edit({ embeds: [cardEmbed(player)], components: cardButtons(player) }).catch(() => {});
  }, 15_000);
  live.set(player.guildId, { message, timer });
}

export async function refreshCard(player: Player) {
  await updateBoard(player, player.guildId);
  const l = live.get(player.guildId);
  if (l && boards.get(player.guildId)?.id === l.message.id) return;
  if (l) await l.message.edit({ embeds: [cardEmbed(player)], components: cardButtons(player) }).catch(() => {});
}

// the old card loses its buttons, or goes away when a new one replaces it
export async function dropCard(guildId: string, remove = false) {
  const l = live.get(guildId);
  if (!remove) await updateBoard(null, guildId);
  if (!l) return;
  clearInterval(l.timer);
  live.delete(guildId);
  if (boards.get(guildId)?.id === l.message.id) return;
  if (remove) await l.message.delete().catch(() => {});
  else await l.message.edit({ components: [] }).catch(() => {});
}

export const isCard = (guildId: string, messageId: string) => live.get(guildId)?.message.id === messageId || boards.get(guildId)?.id === messageId;
