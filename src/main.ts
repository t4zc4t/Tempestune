import { watchFile, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, MessageFlags, type Guild } from 'discord.js';
import { LavalinkManager, type LavalinkNodeOptions } from 'lavalink-client';
import { dropCard, idleBoard, isCard, setBoard, showCard } from './card.js';
import { definitions, onAutocomplete, onButton, onHelp, onCommand, onFilterPick, onLibraryPick, onMessage, onPick, onSettings, queuePage, stayIn } from './commands.js';
import { allSettings, settingsOf } from './settings.js';
import { forgetQueue, keepOnDestroy, restoreAll, saveAll, saveQueue } from './keep.js';
import { noteHistory, songOfTrack } from './library.js';
import { applyEq, normalise, stopLyrics } from './sound.js';
import { notePlay, weeklyRecap } from './stats.js';
import { config } from './config.js';
import { syncIcons } from './icons.js';
import { log } from './log.js';
import { fallbackFor, notePlayed, noteSeed, prepareAutoplay, related, takeAutoplay, useManager, warmNext, type Requester } from './music.js';
import { startRelay } from './relay.js';
import { notice, useAlerts } from './alerts.js';
import { dailyJobs, showStatus, watchVoice } from './upkeep.js';
import { say } from './sage.js';

const nodes: LavalinkNodeOptions[] = [
  { id: 'main', host: '127.0.0.1', port: 2333, authorization: config.password, retryAmount: Infinity, retryDelay: 5000 },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const lavalink = new LavalinkManager({
  nodes,
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  autoSkipOnResolveError: true,
  catchLifeCycleRejections: true,
  playerOptions: {
    defaultSearchPlatform: 'scsearch',
    useUnresolvedData: true,
    // a manual disconnect means leave, not come straight back
    onDisconnect: { autoReconnect: false, destroyPlayer: true },
  },
});
useManager(lavalink);

lavalink.nodeManager
  .on('connect', (node) => {
    log(`node ${node.id} connected`);
    // after a lavalink restart (or the bot's own), bring back whatever was playing
    if (client.isReady()) setTimeout(() => restoreAll(lavalink, client.user!.id), 3000);
  })
  .on('disconnect', (node, reason) => {
    log(`node ${node.id} dropped (${reason.reason ?? reason.code})`);
    notice('node');
  })
  .on('error', (node, error) => log(`node ${node.id} error: ${error.message}`));

lavalink
  .on('trackStart', (player, track) => {
    player.set('votes:skip', []);
    player.set('votes:stop', []);
    if (track) {
      notePlayed(player, track.info.title);
      const who = (track.requester as Requester | undefined)?.id;
      if (who && who !== client.user?.id) {
        noteSeed(player, track);
        try {
          noteHistory(who, player.guildId, songOfTrack(track));
        } catch (e) {
          log('history write failed', e);
        }
      }
    }
    if (track) notePlay(player.guildId, track, (track.requester as Requester | undefined)?.id ?? client.user!.id);
    applyEq(player).catch(() => {});
    normalise(player).catch(() => {});
    showCard(client, player);
    showStatus(client, lavalink);
    warmNext(player);
    saveQueue(player);
    // the last song in the queue: get the autoplay one ready now, so there is no wait later
    prepareAutoplay(player, { id: client.user!.id, name: 'autoplay' }).catch((e) => log('autoplay prep failed', e instanceof Error ? e.message : e));
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
  .on('queueEnd', async (player, track) => {
    // autoplay: one related song at a time, as long as it stays on
    if (player.get('autoplay')) {
      const ready = takeAutoplay(player, track as any);
      const next = ready ?? (await related(player, { id: client.user!.id, name: 'autoplay' }, (track as any) ?? undefined).catch((e) => {
        log('autoplay failed:', e instanceof Error ? e.message : e);
        return null;
      }));
      if (next) {
        await player.queue.add(next);
        await player.play().catch((e: unknown) => log('autoplay play failed', e));
        return;
      }
    }
    await dropCard(player.guildId);
    showStatus(client, lavalink);
    const ch = player.textChannelId ? await client.channels.fetch(player.textChannelId).catch(() => null) : null;
    if (ch?.isSendable() && settingsOf(player.guildId).requestChannel !== player.textChannelId) ch.send(say('queueEnd')).catch(() => {});
    // leave after a few quiet minutes, unless the server has 24/7 on
    if (!settingsOf(player.guildId).stay) {
      setTimeout(() => {
        const p = lavalink.getPlayer(player.guildId);
        if (p && !p.queue.current && !p.playing && !settingsOf(p.guildId).stay) p.destroy().catch(() => {});
      }, 5 * 60_000);
    }
  })
  .on('playerDestroy', (player, reason) => {
    dropCard(player.guildId);
    setTimeout(() => showStatus(client, lavalink), 500);
    stopLyrics(player.guildId);
    // stopped on purpose: forget it. broken by a node: keep it for when lavalink is back
    if (!keepOnDestroy(reason)) forgetQueue(player.guildId);
  });

client.on('raw', (d) => lavalink.sendRawData(d));

// slash commands per server, so new ones show up straight away
const register = (g: Guild) => g.commands.set(definitions).catch((e) => log(`commands for ${g.name} failed`, e));
client.on('guildCreate', register);

client.once('clientReady', async (c) => {
  await lavalink.init({ id: c.user.id, username: c.user.username });
  for (const g of c.guilds.cache.values()) await register(g);
  await syncIcons(c);
  // request channel boards and 24/7 servers come back after a restart
  for (const { guild, s } of allSettings()) {
    if (!c.guilds.cache.has(guild)) continue;
    if (s.requestChannel && s.requestMessage) {
      const ch = await c.channels.fetch(s.requestChannel).catch(() => null);
      const board = ch?.isTextBased() ? await ch.messages.fetch(s.requestMessage).catch(() => null) : null;
      if (board) {
        setBoard(guild, board);
        await board.edit({ content: '', embeds: [idleBoard()], components: [] }).catch(() => {});
      }
    }
    if (s.stay) await stayIn(lavalink, guild);
  }
  log(`${c.user.tag} is up, youtube ${config.youtube ? 'on' : 'off'}`);
  showStatus(c, lavalink);
  weeklyRecap(c);
  // the node usually connects before discord is ready, so restore here as well
  setTimeout(() => restoreAll(lavalink, c.user.id), 4000);
});

client.on('messageCreate', (m) => {
  onMessage(m, lavalink).catch((e) => log('text command failed', e));
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) return void (await onAutocomplete(i));
    if (i.isChatInputCommand() && i.inGuild()) await onCommand(i, lavalink);
    else if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('tt:help')) await onHelp(i);
    else if (i.isStringSelectMenu() && i.customId.startsWith('tt:pick:') && i.inGuild()) await onPick(i, lavalink);
    else if (i.isStringSelectMenu() && i.customId === 'tt:fx' && i.inGuild()) await onFilterPick(i, lavalink);
    else if (i.isStringSelectMenu() && /^tt:(plload|hist):/.test(i.customId) && i.inGuild()) await onLibraryPick(i, lavalink);
    else if ((i.isButton() || i.isRoleSelectMenu() || i.isChannelSelectMenu() || i.isStringSelectMenu()) && i.customId.startsWith('tt:set:') && i.inGuild()) await onSettings(i, lavalink);
    else if (i.isButton() && i.customId.startsWith('tt:') && i.inGuild()) {
      const id = i.customId;
      if (id === 'tt:queue') {
        const player = lavalink.getPlayer(i.guildId);
        if (!player) return void (await i.reply({ content: say('nothing'), flags: MessageFlags.Ephemeral }));
        return void (await i.reply({ ...queuePage(player, 0), flags: MessageFlags.Ephemeral }));
      }
      // old cards lose their buttons, queue pages can be flicked through anywhere
      const anywhere = id.startsWith('tt:q:') || id.startsWith('tt:fx') || id.startsWith('tt:fav') || id.startsWith('tt:eq:') || id === 'tt:shuffle';
      if (!anywhere && !isCard(i.guildId, i.message.id)) return void (await i.update({ components: [] }));
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
  saveAll(lavalink);
  const n = (id: string) => lavalink.nodeManager.nodes.get(id)?.connected ?? null;
  const beat = { t: client.isReady() ? Date.now() : 0, main: n('main'), youtube: config.youtube, players: lavalink.players.size };
  try {
    writeFileSync(alive, JSON.stringify(beat));
  } catch {
    // no tray then
  }
}, 15_000).unref();

process.on('unhandledRejection', (e) => {
  log('unhandled', e);
  notice('crash', e instanceof Error ? e.message : String(e));
});
client.on('error', (e) => log('discord error', e));

// a fresh build replaces the running one: exit and let the tray start it again
const self = fileURLToPath(import.meta.url);
watchFile(self, { interval: 3000 }, (now, before) => {
  if (now.mtimeMs === before.mtimeMs) return;
  log('new build found, restarting');
  saveAll(lavalink);
  setTimeout(() => process.exit(0), 2000);
});

useAlerts(client);
watchVoice(client, lavalink);
dailyJobs();
startRelay();
client.login(config.token);
