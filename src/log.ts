import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// logs/ sits next to dist/, whatever folder the bot was started from
const dir = fileURLToPath(new URL('../logs/', import.meta.url));
mkdirSync(dir, { recursive: true });
const file = dir + 'tempestune.log';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = (...parts: unknown[]) => {
  const line = `${stamp()} ${parts.map((p) => (p instanceof Error ? p.stack ?? p.message : String(p))).join(' ')}`;
  console.log(line);
  try {
    appendFileSync(file, line + '\n');
  } catch {
    // disk trouble shouldn't take the bot down
  }
};
