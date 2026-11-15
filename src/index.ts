import { Client, GatewayIntentBits } from 'discord.js';
import { LavalinkManager, type LavalinkNodeOptions } from 'lavalink-client';

const env = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
};

const password = env('LAVALINK_PASSWORD');
const youtube = process.env.YOUTUBE?.toLowerCase() === 'on';

const nodes: LavalinkNodeOptions[] = [
  { id: 'main', host: '127.0.0.1', port: 2333, authorization: password, retryAmount: Infinity, retryDelay: 5000 },
];
if (youtube) {
  nodes.push({ id: 'youtube', host: '127.0.0.1', port: 2334, authorization: password, retryAmount: Infinity, retryDelay: 15000 });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const lavalink = new LavalinkManager({
  nodes,
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  playerOptions: { defaultSearchPlatform: 'scsearch', onDisconnect: { autoReconnect: true, destroyPlayer: false } },
});

lavalink.nodeManager
  .on('connect', (node) => console.log(`node ${node.id} connected`))
  .on('disconnect', (node, reason) => console.log(`node ${node.id} dropped (${reason.reason ?? reason.code})`))
  .on('error', (node, error) => console.log(`node ${node.id} error: ${error.message}`));

client.on('raw', (d) => lavalink.sendRawData(d));

client.once('clientReady', async (c) => {
  await lavalink.init({ id: c.user.id, username: c.user.username });
  console.log(`${c.user.tag} is up, youtube ${youtube ? 'on' : 'off'}`);
});

process.on('unhandledRejection', (e) => console.error('unhandled', e));

client.login(env('DISCORD_TOKEN'));
