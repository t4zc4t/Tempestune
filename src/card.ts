import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type Message } from 'discord.js';
import type { Player, Track } from 'lavalink-client';
import { icon } from './icons.js';
import { log } from './log.js';

// the now-playing card: one message per server, edited in place, never reposted by buttons
export const SLIME = 0x4fb8e0;

const SOURCES: Record<string, string> = {
  soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', youtube: 'YouTube', spotify: 'Spotify', applemusic: 'Apple Music',
  deezer: 'Deezer', http: 'Web', jamendo: 'Jamendo', radio: 'Radio',
};

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const bar = (pos: number, len: number, size = 18) => {
  const at = len > 0 ? Math.min(size - 1, Math.round((pos / len) * (size - 1))) : 0;
  return '━'.repeat(at) + '●' + '─'.repeat(size - 1 - at);
};

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function cardEmbed(player: Player) {
  const t = player.queue.current as Track | null;
  if (!t) return new EmbedBuilder().setColor(SLIME).setDescription('Nothing is playing right now.');
  const want = t.userData?.want as { source?: string } | undefined;
  const source = SOURCES[want?.source ?? t.info.sourceName] ?? t.info.sourceName;
  const len = t.info.isStream ? 0 : t.info.duration;
  const time = t.info.isStream ? '`LIVE`' : `\`${clock(player.position)} / ${clock(len)}\``;
  const next = player.queue.tracks[0];
  const requester = (t.requester as any)?.id;
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: player.paused ? 'Paused' : 'Now playing' })
    .setTitle(cut(t.info.title, 256))
    .setDescription(`${cut(t.info.author || 'Unknown artist', 200)}\n\n${len ? bar(player.position, len) : bar(1, 1)}  ${time}`)
    .addFields(
      { name: 'Requested by', value: requester ? `<@${requester}>` : '—', inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Up next', value: next ? cut(next.info.title, 60) : 'Nothing yet', inline: true },
    )
    .setFooter({ text: `${source} · ${player.queue.tracks.length} in queue${player.repeatMode === 'off' ? '' : ` · looping ${player.repeatMode === 'track' ? 'song' : 'queue'}`}` });
  const link = t.info.uri && /^https?:\/\//.test(t.info.uri) && !t.info.uri.includes('127.0.0.1') ? t.info.uri : null;
  if (link) e.setURL(link);
  if (t.info.artworkUrl) e.setThumbnail(t.info.artworkUrl);
  return e;
}

export function cardButtons(player: Player, off = false) {
  const b = (id: string, label: string, emoji: string, style = ButtonStyle.Secondary) => {
    const btn = new ButtonBuilder().setCustomId(`tt:${id}`).setLabel(label).setStyle(style).setDisabled(off);
    const e = icon(emoji);
    return e ? btn.setEmoji(e) : btn;
  };
  const loop = player.repeatMode === 'track' ? 'Loop: song' : player.repeatMode === 'queue' ? 'Loop: queue' : 'Loop: off';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b('pause', player.paused ? 'Resume' : 'Pause', player.paused ? 'play' : 'pause', ButtonStyle.Primary),
      b('skip', 'Skip', 'skip'),
      b('stop', 'Stop', 'stop', ButtonStyle.Danger),
      b('loop', loop, player.repeatMode === 'track' ? 'loopone' : 'loop'),
      b('queue', 'Queue', 'queue'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b('vdown', 'Vol', 'voldown'),
      b('vup', 'Vol', 'volup'),
      b('auto', player.get('autoplay') ? 'Autoplay: on' : 'Autoplay: off', 'autoplay'),
      b('lyrics', 'Lyrics', 'lyrics'),
      b('filters', 'Filters', 'filters'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(b('like', 'Like', 'like', ButtonStyle.Success)),
  ];
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
    .setAuthor({ name: 'Tempestune' })
    .setTitle('Nothing is playing')
    .setDescription('Type a song name or paste a link in this channel and I will play it.\nJoin a voice channel first.');
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
