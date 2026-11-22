import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  type GuildMember,
} from 'discord.js';
import type { Player } from 'lavalink-client';
import { SLIME } from './card.js';
import { db, json } from './db.js';

// per server settings, all off by default except even volume

export interface Settings {
  djRole?: string;
  stay: boolean; // 24/7
  stayVoice?: string;
  stayText?: string;
  autoplay: boolean;
  normalise: boolean;
  requestChannel?: string;
  requestMessage?: string;
  perUser: number; // songs one person can have waiting, 0 for no limit
  playlistCap: number; // most songs taken from one playlist, 0 for no limit
  recapChannel?: string; // weekly most-played card
  lastRecap?: string;
}

const DEFAULTS: Settings = { stay: false, autoplay: false, normalise: true, perUser: 0, playlistCap: 0 };
const cache = new Map<string, Settings>();

export function settingsOf(guild: string): Settings {
  const hit = cache.get(guild);
  if (hit) return hit;
  const row = db.prepare('SELECT data FROM settings WHERE guild = ?').get(guild) as { data: string } | undefined;
  const s = { ...DEFAULTS, ...json<Partial<Settings>>(row?.data, {}) };
  cache.set(guild, s);
  return s;
}

export function updateSettings(guild: string, patch: Partial<Settings>) {
  const s = { ...settingsOf(guild), ...patch };
  cache.set(guild, s);
  db.prepare('INSERT INTO settings (guild, data) VALUES (?, ?) ON CONFLICT (guild) DO UPDATE SET data = excluded.data').run(guild, JSON.stringify(s));
  return s;
}

export const allSettings = () =>
  (db.prepare('SELECT guild, data FROM settings').all() as { guild: string; data: string }[]).map((r) => ({ guild: r.guild, s: { ...DEFAULTS, ...json<Partial<Settings>>(r.data, {}) } }));

export const isManager = (m: GuildMember) => m.permissions.has(PermissionFlagsBits.ManageGuild);

// who may control playback: everyone, unless a dj role is set. managers, the dj role,
// and anyone alone with the bot always can
export function canControl(m: GuildMember, player?: Player) {
  const s = settingsOf(m.guild.id);
  if (!s.djRole || isManager(m) || m.roles.cache.has(s.djRole)) return true;
  const vc = player?.voiceChannelId ? m.guild.channels.cache.get(player.voiceChannelId) : null;
  if (vc?.isVoiceBased() && vc.members.filter((x) => !x.user.bot).size <= 1) return true;
  return false;
}

export const listeners = (m: GuildMember, player: Player) => {
  const vc = player.voiceChannelId ? m.guild.channels.cache.get(player.voiceChannelId) : null;
  return vc?.isVoiceBased() ? vc.members.filter((x) => !x.user.bot).size : 1;
};

export const isDj = (m: GuildMember) => {
  const s = settingsOf(m.guild.id);
  return isManager(m) || (!!s.djRole && m.roles.cache.has(s.djRole));
};

const limit = (n: number, unit: string) => (n ? `${n} ${unit}` : 'no limit');

export function settingsPanel(guild: string, page = 0) {
  const s = settingsOf(guild);
  const onoff = (v: boolean) => (v ? 'on' : 'off');
  const b = (id: string, label: string, on: boolean) =>
    new ButtonBuilder().setCustomId(`tt:set:${id}`).setLabel(label).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  const nav = (to: number, label: string) => new ButtonBuilder().setCustomId(`tt:set:page:${to}`).setLabel(label).setStyle(ButtonStyle.Primary);

  if (page === 1) {
    const e = new EmbedBuilder()
      .setColor(SLIME)
      .setAuthor({ name: 'Server settings · queue and recap' })
      .setDescription(
        [
          `**Songs per person:** ${limit(s.perUser, 'waiting at once')}`,
          `**Playlist size:** ${limit(s.playlistCap, 'songs taken from one playlist')}`,
          '-# Admins and the DJ role skip both limits.',
          `**Weekly recap:** ${s.recapChannel ? `<#${s.recapChannel}> · every Monday, the week's most played` : 'off'}`,
        ].join('\n'),
      );
    const pick = (id: string, placeholder: string, values: number[], now: number, unit: string) =>
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`tt:set:${id}`).setPlaceholder(placeholder).addOptions(
          values.map((v) => ({ label: v ? `${v} ${unit}` : 'No limit', value: String(v), default: v === now })),
        ),
      );
    return {
      embeds: [e],
      components: [
        pick('peruser', 'Songs per person', [0, 5, 10, 20, 30, 50], s.perUser, 'songs each'),
        pick('plcap', 'Playlist size', [0, 25, 50, 100, 200], s.playlistCap, 'songs'),
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          new ChannelSelectMenuBuilder().setCustomId('tt:set:recap').setPlaceholder('Weekly recap channel (leave empty for off)').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(nav(0, 'Back')),
      ],
    };
  }

  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: 'Server settings' })
    .setDescription(
      [
        `**DJ role:** ${s.djRole ? `<@&${s.djRole}>` : 'none, everyone can control the music'}`,
        '**Skip and stop:** whoever asked for the song, the DJ role and admins do it straight away, everyone else votes (half the listeners)',
        `**24/7:** ${onoff(s.stay)}${s.stay && s.stayVoice ? ` · stays in <#${s.stayVoice}>` : ''}`,
        `**Autoplay by default:** ${onoff(s.autoplay)}`,
        `**Even volume:** ${onoff(s.normalise)}`,
        `**Request channel:** ${s.requestChannel ? `<#${s.requestChannel}> · type a song there to play it` : 'none'}`,
      ].join('\n'),
    )
    .setFooter({ text: '24/7 stays in the voice channel you are in when you turn it on' });
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        b('stay', `24/7: ${onoff(s.stay)}`, s.stay),
        b('auto', `Autoplay: ${onoff(s.autoplay)}`, s.autoplay),
        b('norm', `Even volume: ${onoff(s.normalise)}`, s.normalise),
        nav(1, 'Queue limits and recap'),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder().setCustomId('tt:set:dj').setPlaceholder('DJ role (leave empty for none)').setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('tt:set:req').setPlaceholder('Request channel (leave empty for none)').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1),
      ),
    ],
  };
}
