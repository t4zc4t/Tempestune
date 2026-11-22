import type { Client } from 'discord.js';
import { log } from './log.js';

// when something keeps breaking, the bot's owner gets a dm instead of having to read the logs

const RULES = {
  node: { count: 3, within: 10 * 60_000, text: 'Lavalink dropped {n} times in the last 10 minutes. Music may keep cutting out.' },
  youtube: { count: 6, within: 15 * 60_000, text: 'YouTube failed {n} times in the last 15 minutes. Songs are falling back to SoundCloud. Last error: {last}' },
  crash: { count: 3, within: 10 * 60_000, text: 'Hit {n} errors nobody caught in the last 10 minutes. Last one: {last}' },
} as const;

type Kind = keyof typeof RULES;
const seen = new Map<Kind, number[]>();
const quietUntil = new Map<Kind, number>();
let client: Client | null = null;

export const useAlerts = (c: Client) => (client = c);

export function notice(kind: Kind, last = '') {
  const rule = RULES[kind];
  const now = Date.now();
  const times = (seen.get(kind) ?? []).filter((t) => now - t < rule.within);
  times.push(now);
  seen.set(kind, times);
  if (times.length < rule.count || (quietUntil.get(kind) ?? 0) > now) return;
  quietUntil.set(kind, now + 60 * 60_000); // one dm an hour at most for each kind
  seen.set(kind, []);
  void tellOwner(rule.text.replace('{n}', String(times.length)).replace('{last}', last.slice(0, 300) || 'none'));
}

async function tellOwner(text: string) {
  if (!client?.isReady()) return;
  try {
    const app = await client.application.fetch();
    const owner = app.owner && 'ownerId' in app.owner ? await client.users.fetch(app.owner.ownerId!) : app.owner;
    if (owner && 'send' in owner) await owner.send(`Great Sage: ${text}`);
  } catch (e) {
    log('could not dm the owner', e instanceof Error ? e.message : e);
  }
}
