import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type Message } from 'discord.js';
import { EQList, type EQBand, type Player, type Track } from 'lavalink-client';
import { SLIME } from './card.js';
import { db } from './db.js';
import { lyricsFor, splitTitle, type Lyrics } from './extras.js';
import { log } from './log.js';
import { gainFor } from './relay.js';

// ---------- filters ----------

export const PRESETS: Record<string, string> = {
  off: 'No filter',
  bassboost: 'Heavier bass',
  nightcore: 'Faster and higher',
  vaporwave: 'Slower and lower',
  '8d': 'Sound moving around your head (best with headphones)',
  karaoke: 'Tries to remove the vocals',
  soft: 'Muffled, like from the next room',
  tremolo: 'Wobbling volume',
  vibrato: 'Wobbling pitch',
  rock: 'Rock EQ',
  pop: 'Pop EQ',
  electronic: 'Electronic EQ',
  classic: 'Classical EQ',
  fullsound: 'Full, rich EQ',
};

// one preset at a time: clear what was there, then apply the new one
export async function applyPreset(player: Player, name: string) {
  const f = player.filterManager;
  await f.resetFilters();
  switch (name) {
    case 'nightcore': await f.toggleNightcore(); break;
    case 'vaporwave': await f.toggleVaporwave(); break;
    case '8d': await f.toggleRotation(0.2); break;
    case 'karaoke': await f.toggleKaraoke(); break;
    case 'soft': await f.toggleLowPass(20); break;
    case 'tremolo': await f.toggleTremolo(); break;
    case 'vibrato': await f.toggleVibrato(); break;
  }
  player.set('filter', name);
  player.set('speed', 1);
  player.set('pitch', 1);
  await applyEq(player);
  await normalise(player);
}

// ---------- everyone's own equalizer: bass, mid and treble, saved per person ----------

// presets that are just an eq, so they can be mixed with a person's own levels
const PRESET_EQ: Record<string, keyof typeof EQList> = {
  bassboost: 'BassboostMedium', rock: 'Rock', pop: 'Pop', electronic: 'Electronic', classic: 'Classic', fullsound: 'FullSound',
};
export interface Eq { bass: number; mid: number; treble: number }
const FLAT: Eq = { bass: 0, mid: 0, treble: 0 };
const BANDS: Record<keyof Eq, number[]> = { bass: [0, 1, 2, 3], mid: [4, 5, 6, 7, 8], treble: [9, 10, 11, 12, 13, 14] };
const STEP = 0.05; // one level, levels go from -4 to +6
export const EQ_RANGE = { min: -4, max: 6 };

export const eqOf = (user?: string): Eq =>
  (user ? (db.prepare('SELECT bass, mid, treble FROM eq WHERE user = ?').get(user) as unknown as Eq | undefined) : undefined) ?? { ...FLAT };

export function changeEq(user: string, band: keyof Eq | 'reset', by = 0) {
  const now = band === 'reset' ? { ...FLAT } : { ...eqOf(user), [band]: Math.max(EQ_RANGE.min, Math.min(EQ_RANGE.max, eqOf(user)[band] + by)) };
  if (!now.bass && !now.mid && !now.treble) db.prepare('DELETE FROM eq WHERE user = ?').run(user);
  else db.prepare('INSERT INTO eq (user, bass, mid, treble) VALUES (?, ?, ?, ?) ON CONFLICT (user) DO UPDATE SET bass = excluded.bass, mid = excluded.mid, treble = excluded.treble').run(user, now.bass, now.mid, now.treble);
  return now;
}

// the preset's eq plus the eq of whoever asked for the song that is playing
export async function applyEq(player: Player) {
  const base = PRESET_EQ[(player.get('filter') as string) ?? 'off'];
  const who = (player.queue.current?.requester as { id?: string } | undefined)?.id;
  const mine = eqOf(who);
  const gains = new Array<number>(15).fill(0);
  for (const b of base ? EQList[base] : []) gains[b.band] = b.gain;
  for (const k of Object.keys(BANDS) as (keyof Eq)[]) for (const band of BANDS[k]) gains[band] += mine[k] * STEP;
  const bands: EQBand[] = gains.map((gain, band) => ({ band, gain: Math.max(-0.25, Math.min(1, Math.round(gain * 1000) / 1000)) }));
  if (bands.every((b) => b.gain === 0)) await player.filterManager.clearEQ().catch(() => {});
  else await player.filterManager.setEQ(bands).catch(() => {});
}

const bar = (n: number) => '▰'.repeat(n - EQ_RANGE.min) + '▱'.repeat(EQ_RANGE.max - n);

export function eqPanel(user: string, name: string, live: boolean) {
  const q = eqOf(user);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: `${name}'s equalizer` })
    .setDescription(
      [
        `**Bass** \`${bar(q.bass)}\` ${sign(q.bass)}`,
        `**Mid** \`${bar(q.mid)}\` ${sign(q.mid)}`,
        `**Treble** \`${bar(q.treble)}\` ${sign(q.treble)}`,
        '',
        live ? '-# Playing now, since this song is yours.' : '-# Saved. It plays on every song you add, on top of any filter.',
      ].join('\n'),
    );
  const b = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`tt:eq:${id}`).setLabel(label).setStyle(style);
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(b('bass:-1', 'Bass −'), b('bass:1', 'Bass +'), b('mid:-1', 'Mid −'), b('mid:1', 'Mid +')),
      new ActionRowBuilder<ButtonBuilder>().addComponents(b('treble:-1', 'Treble −'), b('treble:1', 'Treble +'), b('reset:0', 'Flat', ButtonStyle.Danger)),
    ],
  };
}

export async function setSpeed(player: Player, speed: number) {
  player.set('speed', speed);
  await player.filterManager.setSpeed(speed);
}

export async function setPitch(player: Player, pitch: number) {
  player.set('pitch', pitch);
  await player.filterManager.setPitch(pitch);
}

// evens out loud and quiet uploads, on unless a server turns it off
export async function normalise(player: Player) {
  if (player.get('normalise') === false) return;
  const t = player.queue.current as Track | null;
  const gain = gainFor(t?.userData?.file as string | undefined) ?? 1;
  await player.filterManager.setVolume(gain).catch(() => {});
}

export function filterPanel(player: Player) {
  const current = (player.get('filter') as string) ?? 'off';
  const speed = (player.get('speed') as number) ?? 1;
  const pitch = (player.get('pitch') as number) ?? 1;
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: 'Sound' })
    .setDescription(`**Filter:** ${current} · ${PRESETS[current] ?? ''}\n**Speed:** ${speed.toFixed(2)}x · **Pitch:** ${pitch.toFixed(2)}x\n**Even volume:** ${player.get('normalise') === false ? 'off' : 'on'}`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tt:fx')
    .setPlaceholder('Pick a filter')
    .addOptions(Object.entries(PRESETS).map(([value, description]) => ({ label: value, value, description, default: value === current })));
  const b = (id: string, label: string) => new ButtonBuilder().setCustomId(`tt:fx:${id}`).setLabel(label).setStyle(ButtonStyle.Secondary);
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(b('slower', 'Speed −'), b('faster', 'Speed +'), b('lower', 'Pitch −'), b('higher', 'Pitch +'), b('norm', 'Even volume')),
    ],
  };
}

export async function onFilterControl(player: Player, id: string, value?: string) {
  const speed = (player.get('speed') as number) ?? 1;
  const pitch = (player.get('pitch') as number) ?? 1;
  const step = (x: number, d: number) => Math.round(Math.min(2, Math.max(0.5, x + d)) * 100) / 100;
  if (id === 'tt:fx' && value) await applyPreset(player, value);
  if (id === 'tt:fx:slower') await setSpeed(player, step(speed, -0.1));
  if (id === 'tt:fx:faster') await setSpeed(player, step(speed, 0.1));
  if (id === 'tt:fx:lower') await setPitch(player, step(pitch, -0.1));
  if (id === 'tt:fx:higher') await setPitch(player, step(pitch, 0.1));
  if (id === 'tt:fx:norm') {
    player.set('normalise', player.get('normalise') === false);
    if (player.get('normalise') === false) await player.filterManager.setVolume(1);
    else await normalise(player);
  }
  return filterPanel(player);
}

// ---------- lyrics ----------

// the real song name for a track: worked out earlier, known from spotify and co, or read off a youtube title
export function songOf(t: Track) {
  const want = t.userData?.want as any;
  if (want?.song) return want.song as { title: string; author: string; duration?: number };
  if (want?.how === 'find') return { title: want.title, author: want.author, duration: want.duration };
  return { ...splitTitle(t.info.title, t.info.author ?? ''), duration: t.info.duration };
}

const live = new Map<string, { timer: NodeJS.Timeout; message: Message; track: string }>();

export function stopLyrics(guildId: string) {
  const l = live.get(guildId);
  if (!l) return;
  clearInterval(l.timer);
  live.delete(guildId);
}

function lyricsEmbed(t: Track, lyr: Lyrics, at: number) {
  const e = new EmbedBuilder().setColor(SLIME).setAuthor({ name: 'Lyrics' }).setTitle(`${lyr.title} · ${lyr.author}`.slice(0, 256)).setFooter({ text: 'Lyrics from LRCLIB' });
  if (!lyr.synced.length) return e.setDescription(lyr.plain.slice(0, 3900) || 'No lyrics text.');
  let i = lyr.synced.findIndex((l) => l.at > at) - 1;
  if (i < -1) i = lyr.synced.length - 1;
  const from = Math.max(0, i - 3);
  const lines = lyr.synced.slice(from, from + 9).map((l, n) => {
    const text = l.line || '♪';
    return from + n === i ? `**${text}**` : `-# ${text}`;
  });
  return e.setDescription(lines.join('\n'));
}

// one lyrics message per server; synced lyrics follow the song as it plays
export async function showLyrics(player: Player, send: (p: { embeds: EmbedBuilder[] }) => Promise<Message | null>) {
  const t = player.queue.current as Track | null;
  if (!t) return 'Nothing is playing right now.';
  const song = songOf(t);
  const lyr = await lyricsFor(song.title, song.author, song.duration).catch(() => null);
  if (!lyr) return `Great Sage: no lyrics found for **${song.title}**.`;
  stopLyrics(player.guildId);
  const message = await send({ embeds: [lyricsEmbed(t, lyr, player.position)] });
  if (!message || !lyr.synced.length) return null;
  const track = t.encoded ?? t.info.title;
  const started = Date.now();
  const timer = setInterval(() => {
    const now = player.queue.current as Track | null;
    if (!now || (now.encoded ?? now.info.title) !== track || Date.now() - started > 15 * 60_000) {
      stopLyrics(player.guildId);
      message.edit({ embeds: [lyricsEmbed(t, lyr, Number.MAX_SAFE_INTEGER).setFooter({ text: 'Lyrics from LRCLIB · song finished' })] }).catch(() => {});
      return;
    }
    if (!player.paused) message.edit({ embeds: [lyricsEmbed(t, lyr, player.position + 400)] }).catch((e) => log('lyrics edit failed', e));
  }, 3000);
  live.set(player.guildId, { timer, message, track });
  return null;
}
