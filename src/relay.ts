import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './log.js';

// SoundCloud and Bandcamp only hand out streams lavalink can't read anymore,
// so yt-dlp fetches the track into a small cache and lavalink plays it from here

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = root + 'lavalink/tools/';
const win = process.platform === 'win32';
const ytdlp = existsSync(tools + (win ? 'yt-dlp.exe' : 'yt-dlp')) ? tools + (win ? 'yt-dlp.exe' : 'yt-dlp') : 'yt-dlp';
const ffmpeg = tools + 'ffmpeg/bin';
const cache = root + 'cache/';
mkdirSync(cache, { recursive: true });

const run = (args: string[], timeoutMs = 60_000) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(ytdlp, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited with ${code}`));
    });
  });

export interface RelayHit {
  title: string;
  author: string;
  url: string;
  duration: number;
  artwork?: string;
}

// soundcloud search, cheap: no stream lookups, just the list
export async function searchSoundCloud(query: string, limit = 10): Promise<RelayHit[]> {
  const raw = await run(['--flat-playlist', '-J', '--no-warnings', `scsearch${limit}:${query}`], 30_000);
  const entries: any[] = JSON.parse(raw).entries ?? [];
  return entries
    .filter((e) => e.webpage_url && e.duration !== 30) // 30s exactly is a preview of a paid track
    .map((e) => ({
      title: e.title,
      author: e.uploader ?? 'SoundCloud',
      url: e.webpage_url,
      duration: Math.round((e.duration ?? 0) * 1000),
      artwork: [...(e.thumbnails ?? [])].reverse().find((t: any) => t.width >= 300)?.url,
    }));
}

// youtube search through yt-dlp, the same cheap list as soundcloud
export async function searchYouTube(query: string, limit = 10): Promise<RelayHit[]> {
  const raw = await run(['--flat-playlist', '-J', '--no-warnings', `ytsearch${limit}:${query}`], 30_000);
  const entries: any[] = JSON.parse(raw).entries ?? [];
  return entries
    .filter((e) => e.url && e.duration && e.live_status !== 'is_live')
    .map((e) => ({
      title: e.title,
      author: e.channel ?? e.uploader ?? 'YouTube',
      url: e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      duration: Math.round(e.duration * 1000),
      artwork: e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : undefined,
    }));
}

const isYouTube = (url: string) => /youtube\.com\/|youtu\.be\//i.test(url);

const keyOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 120);
const busy = new Map<string, Promise<string>>();

const EXTS = ['m4a', 'mp3', 'opus', 'webm', 'ogg', 'flac'];
const cached = (key: string) => EXTS.map((e) => `${key}.${e}`).find((f) => existsSync(cache + f));

// returns a url lavalink can play, downloading the track first if it isn't cached
export function relay(url: string): Promise<string> {
  const key = keyOf(url);
  const local = (f: string) => `http://127.0.0.1:${config.relayPort}/${f}`;
  const have = cached(key);
  if (have) {
    const now = new Date();
    utimesSync(cache + have, now, now); // keeps it fresh for the cleanup
    return Promise.resolve(local(have));
  }
  const going = busy.get(key);
  if (going) return going;
  // ffmpeg only repairs the container (soundcloud sends fragmented mp4), the audio is never re-encoded
  const job = run(
    [
      // youtube: plain m4a audio, node solves its signature puzzle. soundcloud: its aac stream
      ...(isYouTube(url) ? ['-f', 'ba[ext=m4a]/ba', '--js-runtimes', 'node'] : ['-f', 'hls_aac_160k/hls_aac_96k/mp3-128/bestaudio']),
      '--ffmpeg-location', ffmpeg,
      '--no-playlist', '--no-progress', '--no-warnings', '--no-part',
      '-P', `temp:${cache}tmp`,
      '-o', `${cache}${key}.%(ext)s`,
      url,
    ],
    5 * 60_000,
  )
    .then(() => {
      const f = cached(key);
      if (!f) throw new Error('download finished but no file was written');
      trim();
      return local(f);
    })
    .finally(() => busy.delete(key));
  busy.set(key, job);
  return job;
}

// oldest files go first once the cache is over its size
function trim() {
  const files = readdirSync(cache)
    .filter((f) => EXTS.some((e) => f.endsWith(`.${e}`)))
    .map((f) => ({ f, s: statSync(cache + f) }))
    .sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
  let total = files.reduce((n, x) => n + x.s.size, 0);
  const limit = config.cacheMb * 1024 * 1024;
  for (const x of files) {
    if (total <= limit) break;
    if ([...busy.keys()].some((k) => x.f.startsWith(k))) continue;
    rmSync(cache + x.f, { force: true });
    total -= x.s.size;
  }
}

// a tiny file server with range support so seeking works
export function startRelay() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    if (!/^[a-z0-9_]+\.(m4a|mp3|opus|webm|ogg|flac)$/i.test(name) || !existsSync(cache + name)) {
      res.writeHead(404).end();
      return;
    }
    const size = statSync(cache + name).size;
    const type = name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.m4a') ? 'audio/mp4' : 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      createReadStream(cache + name, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      createReadStream(cache + name).pipe(res);
    }
  });
  server.on('error', (e) => log('relay error', e));
  server.listen(config.relayPort, '127.0.0.1', () => log(`relay on ${config.relayPort}`));
}

// a soundcloud/bandcamp link as a list of tracks: one for a track, many for sets and albums
export async function listOf(url: string): Promise<{ name?: string; hits: RelayHit[] }> {
  const j = JSON.parse(await run(['--flat-playlist', '-J', '--no-warnings', ...(isYouTube(url) ? ['--js-runtimes', 'node'] : []), url], 60_000));
  const art = (x: any) => [...(x.thumbnails ?? [])].reverse().find((t: any) => (t.width ?? 0) >= 300)?.url ?? x.thumbnail;
  const hit = (e: any): RelayHit => ({
    title: e.title ?? 'Unknown title',
    author: e.uploader ?? e.artist ?? j.uploader ?? '',
    url: e.webpage_url ?? (e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`),
    duration: Math.round((e.duration ?? 0) * 1000),
    artwork: art(e) ?? art(j),
  });
  if (!Array.isArray(j.entries)) return { hits: [hit(j)] };
  return { name: j.title, hits: j.entries.filter((e: any) => e.url || e.webpage_url).map(hit) };
}
