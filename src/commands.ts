import {
  InteractionContextType, MessageFlags, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember,
} from 'discord.js';
import type { LavalinkManager, Player } from 'lavalink-client';
import { cardButtons, cardEmbed, dropCard, refreshCard } from './card.js';
import { log } from './log.js';
import { find, pickNode, type Requester } from './music.js';
import { say } from './sage.js';

export const definitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song or add it to the queue')
    .addStringOption((o) => o.setName('query').setDescription('Song name or a SoundCloud, Bandcamp, Spotify, Apple Music, Deezer or YouTube link').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
  new SlashCommandBuilder().setName('resume').setDescription('Carry on playing'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave'),
  new SlashCommandBuilder().setName('volume').setDescription('Change the volume')
    .addIntegerOption((o) => o.setName('level').setDescription('0 to 150').setMinValue(0).setMaxValue(150).setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show what is playing'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

const quiet = (i: ChatInputCommandInteraction | ButtonInteraction, content: string) =>
  i.replied || i.deferred ? i.followUp({ content, flags: MessageFlags.Ephemeral }) : i.reply({ content, flags: MessageFlags.Ephemeral });

// same voice channel as the bot, or nothing
function sameVoice(i: ChatInputCommandInteraction | ButtonInteraction, player?: Player) {
  const vc = (i.member as GuildMember | null)?.voice?.channelId;
  if (!vc) return say('noVoice');
  if (player?.voiceChannelId && player.voiceChannelId !== vc) return say('otherVoice');
  return null;
}

export async function onCommand(i: ChatInputCommandInteraction, lavalink: LavalinkManager) {
  const gid = i.guildId!;
  let player = lavalink.getPlayer(gid);

  if (i.commandName === 'play') {
    const problem = sameVoice(i, player);
    if (problem) return quiet(i, problem);
    if (!lavalink.nodeManager.nodes.get('main')?.connected) return quiet(i, say('nodeDown'));
    await i.deferReply();
    const requester: Requester = { id: i.user.id, name: i.user.username };
    const found = await find(i.options.getString('query', true), requester).catch((e) => {
      log('play lookup failed:', e instanceof Error ? e.message : e);
      return e instanceof Error && e.message === 'youtube is off' ? 'youtube' : null;
    });
    if (found === 'youtube') return i.editReply('YouTube is switched off on this bot right now.');
    if (!found?.tracks.length) return i.editReply(say('notFound'));

    if (!player) {
      player = lavalink.createPlayer({
        guildId: gid,
        voiceChannelId: (i.member as GuildMember).voice.channelId!,
        textChannelId: i.channelId,
        selfDeaf: true,
        volume: 80,
        node: pickNode(),
      });
    }
    if (!player.connected) await player.connect();
    await player.queue.add(found.tracks);
    const first = found.tracks[0];
    if (!player.playing && !player.paused) await player.play();
    if (found.name || found.tracks.length > 1) return i.editReply(`${say('predator', { n: found.tracks.length })}${found.name ? ` (${found.name})` : ''}`);
    return i.editReply(player.queue.current === first ? say('loaded') : `${say('queued')} **${first.info.title}**`);
  }

  if (!player?.queue.current) return quiet(i, say('nothing'));
  const problem = sameVoice(i, player);
  if (problem) return quiet(i, problem);

  switch (i.commandName) {
    case 'pause':
      await player.pause();
      await refreshCard(player);
      return quiet(i, say('paused'));
    case 'resume':
      await player.resume();
      await refreshCard(player);
      return quiet(i, say('resumed'));
    case 'skip':
      await player.skip(0, false);
      return quiet(i, say('skipped'));
    case 'stop':
      await dropCard(gid);
      await player.destroy();
      return i.reply(say('stopped'));
    case 'volume': {
      await player.setVolume(i.options.getInteger('level', true));
      await refreshCard(player);
      return quiet(i, `Volume set to ${player.volume}%.`);
    }
    case 'nowplaying':
      return i.reply({ embeds: [cardEmbed(player)] });
  }
}

export async function onButton(i: ButtonInteraction, lavalink: LavalinkManager) {
  const player = lavalink.getPlayer(i.guildId!);
  if (!player?.queue.current) return i.update({ components: [] });
  const problem = sameVoice(i, player);
  if (problem) return quiet(i, problem);
  const what = i.customId.slice(3);
  if (what === 'pause') player.paused ? await player.resume() : await player.pause();
  if (what === 'vdown') await player.setVolume(Math.max(0, player.volume - 10));
  if (what === 'vup') await player.setVolume(Math.min(150, player.volume + 10));
  if (what === 'skip') {
    await i.deferUpdate();
    await player.skip(0, false);
    return;
  }
  if (what === 'stop') {
    await i.update({ components: [] });
    await dropCard(i.guildId!);
    await player.destroy();
    return;
  }
  return i.update({ embeds: [cardEmbed(player)], components: cardButtons(player) });
}
