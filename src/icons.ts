import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { log } from './log.js';

// Tempestune's own icons (Lucide, in the slime glow colours), uploaded as the app's emojis.
// until they are in, buttons simply show their text label

const dir = fileURLToPath(new URL('../assets/icons/', import.meta.url));
// which picture each uploaded emoji has, so a redrawn icon replaces the old one
const sumsFile = fileURLToPath(new URL('../cache/icons.json', import.meta.url));
const ids = new Map<string, string>();

export async function syncIcons(client: Client) {
  const app = client.application;
  if (!app) return;
  try {
    const have = await app.emojis.fetch();
    for (const e of have.values()) if (e.name?.startsWith('tt_')) ids.set(e.name.slice(3), e.id);
    const sums: Record<string, string> = existsSync(sumsFile) ? JSON.parse(readFileSync(sumsFile, 'utf8')) : {};
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
      const name = f.slice(0, -4);
      const png = readFileSync(dir + f);
      const sum = createHash('sha1').update(png).digest('hex');
      if (ids.has(name) && sums[name] === sum) continue;
      if (ids.has(name)) {
        await app.emojis.delete(ids.get(name)!).catch(() => {});
        ids.delete(name);
      }
      const made = await app.emojis.create({ attachment: png, name: `tt_${name}` }).catch((e) => {
        log(`icon ${name} upload failed`, e instanceof Error ? e.message : e);
        return null;
      });
      if (made) {
        ids.set(name, made.id);
        sums[name] = sum;
      }
    }
    mkdirSync(fileURLToPath(new URL('../cache/', import.meta.url)), { recursive: true });
    writeFileSync(sumsFile, JSON.stringify(sums));
    log(`icons ready: ${ids.size}`);
  } catch (e) {
    log('icons failed', e);
  }
}

// for buttons and menus
export const icon = (name: string) => (ids.has(name) ? { id: ids.get(name)!, name: `tt_${name}` } : undefined);
// for text
export const ic = (name: string) => (ids.has(name) ? `<:tt_${name}:${ids.get(name)}> ` : '');
