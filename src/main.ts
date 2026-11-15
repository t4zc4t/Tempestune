import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, MessageFlags, type Guild } from 'discord.js';
import { LavalinkManager, type LavalinkNodeOptions } from 'lavalink-client';
import { dropCard, isCard, showCard } from './card.js';
import { definitions, onButton, onCommand } from './commands.js';
import { config } from './config.js';
import { log } from './log.js';
import { fallbackFor, useManager, warmNext, type Requester } from './music.js';
import { startRelay } from './relay.js';
import { say } from './sage.js';

const nodes: LavalinkNodeOptions[] = [
  { id: 'main', host: '127.0.0.1', port: 2333, authorization: config.password, retryAmount: Infinity, retryDelay: 5000 },
];
if (config.youtube) {
  nodes.push({ id: 'youtube', host: '127.0.0.1', port: 2334, authorization: config.password, retryAmount: Infinity, retryDelay: 15000 });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const lavalink = new LavalinkManager({
  nodes,
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  autoSkipOnResolveError: true,
  // if the youtube node falls over, its players carry on from the main node
  autoMove: true,
  catchLifeCycleRejections: true,
  playerOptions: {
    defaultSearchPlatform: 'scsearch',
    useUnresolvedData: true,
    onDisconnect: { autoReconnect: true, destroyPlayer: false },
    onEmptyQueue: { destroyAfterMs: 5 * 60_000 },
  },
});
useManager(lavalink);

lavalink.nodeManager
  .on('connect', (node) => log(`node ${node.id} connected`))
  .on('disconnect', (node, reason) => log(`node ${node.id} dropped (${reason.reason ?? reason.code})`))
  .on('error', (node, error) => log(`node ${node.id} error: ${error.message}`));

lavalink
  .on('trackStart', (player) => {
    showCard(client, player);
    warmNext(player);
  })
  .on('trackError', async (player, track, payload) => {
    log(`track failed: ${track?.info?.title}`, String((payload as any)?.exception?.message ?? (payload as any)?.message ?? '').split('\n')[0]);
    // a youtube song gets one more try on soundcloud, slotted in as the next song
    const retry = track ? fallbackFor(track, (track.requester as Requester) ?? { id: '', name: '' }) : null;
    if (retry) {
      await player.queue.add(retry, 0);
      // if the queue had already run out, start it again
      setTimeout(() => {
        if (!player.playing && !player.paused && player.queue.tracks.length) player.play().catch(() => {});
      }, 1500);
      return;
    }
    const ch = player.textChannelId ? await client.channels.fetch(player.textChannelId).catch(() => null) : null;
    if (ch?.isSendable()) ch.send(say('failed')).catch(() => {});
  })
  .on('trackStuck', (_player, track) => log(`track stuck: ${track?.info?.title}`))
  .on('queueEnd', async (player) => {
    await dropCard(player.guildId);
    const ch = player.textChannelId ? await client.channels.fetch(player.textChannelId).catch(() => null) : null;
    if (ch?.isSendable()) ch.send(say('queueEnd')).catch(() => {});
  })
  .on('playerDestroy', (player) => dropCard(player.guildId));

client.on('raw', (d) => lavalink.sendRawData(d));

// slash commands per server, so new ones show up straight away
const register = (g: Guild) => g.commands.set(definitions).catch((e) => log(`commands for ${g.name} failed`, e));
client.on('guildCreate', register);

client.once('clientReady', async (c) => {
  await lavalink.init({ id: c.user.id, username: c.user.username });
  for (const g of c.guilds.cache.values()) await register(g);
  log(`${c.user.tag} is up, youtube ${config.youtube ? 'on' : 'off'}`);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand() && i.inGuild()) await onCommand(i, lavalink);
    else if (i.isButton() && i.customId.startsWith('tt:') && i.inGuild()) {
      if (!isCard(i.guildId, i.message.id)) return void (await i.update({ components: [] }));
      await onButton(i, lavalink);
    }
  } catch (e) {
    log('interaction failed', e);
    if (i.isRepliable() && !i.replied) {
      const content = 'Great Sage: something went wrong there. It is in the log.';
      (i.deferred ? i.editReply(content) : i.reply({ content, flags: MessageFlags.Ephemeral })).catch(() => {});
    }
  }
});

// heartbeat for the tray: when, and which nodes are up
const alive = fileURLToPath(new URL('../logs/.alive', import.meta.url));
setInterval(() => {
  const n = (id: string) => lavalink.nodeManager.nodes.get(id)?.connected ?? null;
  const beat = { t: client.isReady() ? Date.now() : 0, main: n('main'), youtube: config.youtube ? n('youtube') : null, players: lavalink.players.size };
  try {
    writeFileSync(alive, JSON.stringify(beat));
  } catch {
    // no tray then
  }
}, 15_000).unref();

process.on('unhandledRejection', (e) => log('unhandled', e));
client.on('error', (e) => log('discord error', e));

startRelay();
client.login(config.token);
