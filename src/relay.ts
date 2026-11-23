import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

// a spare account's cookies get past youtube's "confirm you're not a bot" check.
// optional: drop the exported file at cookies/youtube.txt and it's picked up on the next song
const cookies = root + 'cookies/youtube.txt';
const ytAuth = () => (existsSync(cookies) ? ['--cookies', cookies] : []);

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
  const job = fetchTo(url, key, false)
    // youtube sometimes refuses one player type, the tv one usually still works
    .catch((e) => (isYouTube(url) ? fetchTo(url, key, true) : Promise.reject(e)))
    .then(async () => {
      const f = cached(key);
      if (!f) throw new Error('download finished but no file was written');
      await measure(f).catch((e) => log('loudness check failed:', e instanceof Error ? e.message : e));
      trim();
      return local(f);
    })
    .finally(() => busy.delete(key));
  busy.set(key, job);
  return job;
}

// at most two downloads at once, so a big playlist doesn't hammer youtube (and get the pc rate limited)
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const fetchTo = (url: string, key: string, retry: boolean) =>
  slot(() => run(
    [
      // youtube: plain m4a audio, node solves its signature puzzle. jiosaavn: its 320k m4a. soundcloud: its aac stream
      ...(isYouTube(url)
        ? ['-f', 'ba[ext=m4a]/ba', '--js-runtimes', 'node', ...ytAuth()]
        : /jiosaavn\.com\//i.test(url)
          ? ['-f', '320/128/bestaudio']
          : ['-f', 'hls_aac_160k/hls_aac_96k/mp3-128/bestaudio']),
      ...(retry ? ['--extractor-args', 'youtube:player_client=tv,web_safari'] : []),
      '--ffmpeg-location', ffmpeg,
      '--no-playlist', '--no-progress', '--no-warnings', '--no-part',
      '-P', `temp:${cache}tmp`,
      '-o', `${cache}${key}.%(ext)s`,
      url,
    ],
    5 * 60_000,
  ));

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
    rmSync(`${cache}${x.f}.lufs`, { force: true });
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
  // big playlists stop at 300 songs, plenty for one session
  const j = JSON.parse(await run(['--flat-playlist', '-J', '--no-warnings', '--playlist-end', '300', ...(isYouTube(url) ? ['--js-runtimes', 'node', ...ytAuth()] : []), url], 60_000));
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

// ---------- loudness, so quiet and loud uploads come out at a similar volume (ffmpeg loudnorm, measure only) ----------

const ffmpegExe = existsSync(`${ffmpeg}/${win ? 'ffmpeg.exe' : 'ffmpeg'}`) ? `${ffmpeg}/${win ? 'ffmpeg.exe' : 'ffmpeg'}` : 'ffmpeg';

function measure(file: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegExe, ['-hide_banner', '-nostats', '-i', cache + file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => p.kill(), 60_000);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
      clearTimeout(timer);
      const lufs = /"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/.exec(err)?.[1];
      // -70 or lower means silence, nothing worth adjusting
      if (lufs && Number(lufs) > -70) writeFileSync(`${cache}${file}.lufs`, lufs);
      resolve();
    });
  });
}

// volume multiplier to bring a cached file to about -14 LUFS (what most streaming apps use)
export function gainFor(url?: string): number | null {
  const name = url?.startsWith(`http://127.0.0.1:${config.relayPort}/`) ? url.split('/').pop() : null;
  if (!name || !existsSync(`${cache}${name}.lufs`)) return null;
  const lufs = Number(readFileSync(`${cache}${name}.lufs`, 'utf8'));
  if (!Number.isFinite(lufs)) return null;
  return Math.min(1.6, Math.max(0.45, 10 ** ((-14 - lufs) / 20)));
}

// youtube changes often, so the standalone yt-dlp updates itself once a day, between downloads
export async function updateYtdlp() {
  if (!existsSync(tools + (win ? 'yt-dlp.exe' : 'yt-dlp'))) return;
  if (busy.size) return void setTimeout(updateYtdlp, 10 * 60_000).unref();
  const out = await run(['-U'], 3 * 60_000).catch((e) => `update failed: ${e instanceof Error ? e.message : e}`);
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
  log(`yt-dlp: ${line}`);
}
