import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
  type GuildMember,
} from 'discord.js';
import type { Player } from 'lavalink-client';
import { SLIME } from './card.js';
import { db, json } from './db.js';

// per server settings, all off by default except even volume

export interface Settings {
  djRole?: string;
  voteSkip: boolean;
  stay: boolean; // 24/7
  stayVoice?: string;
  stayText?: string;
  autoplay: boolean;
  normalise: boolean;
  requestChannel?: string;
  requestMessage?: string;
}

const DEFAULTS: Settings = { voteSkip: false, stay: false, autoplay: false, normalise: true };
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

export function settingsPanel(guild: string) {
  const s = settingsOf(guild);
  const onoff = (v: boolean) => (v ? 'on' : 'off');
  const e = new EmbedBuilder()
    .setColor(SLIME)
    .setAuthor({ name: 'Server settings' })
    .setDescription(
      [
        `**DJ role:** ${s.djRole ? `<@&${s.djRole}>` : 'none, everyone can control the music'}`,
        `**Vote skip:** ${onoff(s.voteSkip)}${s.voteSkip ? ' · half the listeners have to agree' : ''}`,
        `**24/7:** ${onoff(s.stay)}${s.stay && s.stayVoice ? ` · stays in <#${s.stayVoice}>` : ''}`,
        `**Autoplay by default:** ${onoff(s.autoplay)}`,
        `**Even volume:** ${onoff(s.normalise)}`,
        `**Request channel:** ${s.requestChannel ? `<#${s.requestChannel}> · type a song there to play it` : 'none'}`,
      ].join('\n'),
    )
    .setFooter({ text: '24/7 stays in the voice channel you are in when you turn it on' });
  const b = (id: string, label: string, on: boolean) =>
    new ButtonBuilder().setCustomId(`tt:set:${id}`).setLabel(label).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        b('vote', `Vote skip: ${onoff(s.voteSkip)}`, s.voteSkip),
        b('stay', `24/7: ${onoff(s.stay)}`, s.stay),
        b('auto', `Autoplay: ${onoff(s.autoplay)}`, s.autoplay),
        b('norm', `Even volume: ${onoff(s.normalise)}`, s.normalise),
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
