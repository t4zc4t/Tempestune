import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// one small sqlite file: playlists, favourites, history, plays, eq, server settings and saved queues
const file = process.env.DB_PATH ? process.env.DB_PATH : fileURLToPath(new URL('../tempestune.db', import.meta.url));
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (guild TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    code TEXT NOT NULL UNIQUE,
    songs TEXT NOT NULL,
    created INTEGER NOT NULL,
    UNIQUE (owner, name)
  );
  CREATE TABLE IF NOT EXISTS favourites (user TEXT NOT NULL, key TEXT NOT NULL, song TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (user, key));
  CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, guild TEXT NOT NULL, song TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS history_user ON history (user, at DESC);
  CREATE TABLE IF NOT EXISTS queues (guild TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS eq (user TEXT PRIMARY KEY, bass INTEGER NOT NULL, mid INTEGER NOT NULL, treble INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, user TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, ms INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS plays_guild ON plays (guild, at DESC);
`);

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
