import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { log } from './log.js';

// Tempestune's own icons (Lucide, recoloured), uploaded once as the app's emojis.
// until they are in, buttons simply show their text label

const dir = fileURLToPath(new URL('../assets/icons/', import.meta.url));
const ids = new Map<string, string>();

export async function syncIcons(client: Client) {
  const app = client.application;
  if (!app) return;
  try {
    const have = await app.emojis.fetch();
    for (const e of have.values()) if (e.name?.startsWith('tt_')) ids.set(e.name.slice(3), e.id);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
      const name = f.slice(0, -4);
      if (ids.has(name)) continue;
      const made = await app.emojis.create({ attachment: readFileSync(dir + f), name: `tt_${name}` }).catch((e) => {
        log(`icon ${name} upload failed`, e instanceof Error ? e.message : e);
        return null;
      });
      if (made) ids.set(name, made.id);
    }
    log(`icons ready: ${ids.size}`);
  } catch (e) {
    log('icons failed', e);
  }
}

// for buttons and menus
export const icon = (name: string) => (ids.has(name) ? { id: ids.get(name)!, name: `tt_${name}` } : undefined);
// for text
export const ic = (name: string) => (ids.has(name) ? `<:tt_${name}:${ids.get(name)}> ` : '');
