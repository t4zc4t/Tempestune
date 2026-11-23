# Tempestune

A Discord music bot with a calm slime in charge and a very thorough assistant in its head. It runs on your own PC, uses only free sources and free APIs, and keeps going 24/7 from a tray icon.

## What it does

- Plays songs from a name or a link: JioSaavn, YouTube, SoundCloud, Bandcamp, Spotify, Apple Music, Deezer, Jamendo and internet radio
- Known songs come from JioSaavn first (the label's own 320k upload), then YouTube, with SoundCloud as the last resort
- Works out which song you meant before searching, so you get the original and not a remix, sped up or lyric edit (unless you ask for one)
- Spotify, Apple Music and Deezer links are only read for the song names, the audio is found on JioSaavn, YouTube or SoundCloud
- Search menu across every source, with source and length filters, suggestions while typing, "did you mean" and search by a line from the lyrics
- Queue with pages, move, remove, shuffle, loop, seek and skip to
- Autoplay of related songs when the queue runs out, ready before the last song ends, with no repeats within the hour
- Live synced lyrics, filters (bassboost, nightcore, vaporwave, 8D, karaoke and more), speed and pitch, and even volume between loud and quiet uploads
- Your own bass, mid and treble with `eq`, saved and played on every song you add
- Saved playlists you can share with a code, playlist import from links, favourites and history
- Ready-made playlists: `tensura`, `anime`, `aot`, `jjk` and `demonslayer`
- DJ role, 24/7 mode and a request channel with its own player. Whoever queued a song can skip or stop it, everyone else votes
- Queue limits per person and per playlist, `stats` for the most played songs and a weekly recap card
- Leaves the voice channel after 2 minutes with nobody in it
- Shows what is playing as its status
- The queue survives restarts of the bot, Lavalink or the whole PC
- Daily database backups (the last 7 are kept in `backups/`), yt-dlp updates itself, and the owner gets a DM when Lavalink or YouTube keeps failing

Slash commands and a text prefix both work: `/play faded` or `tt p faded` (or mention the bot). `tt help` lists everything.

## Running it (Windows)

You need Node.js 26 or newer and Git. Everything else is downloaded on the first start: Java, Lavalink, yt-dlp and ffmpeg.

1. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID` and a long random `LAVALINK_PASSWORD`
2. Double-click `boot.cmd`
3. The tray icon near the clock shows if it is online. Right-click it for restart, rebuild, updates and logs

`stop.cmd` stops everything. The tray starts with Windows unless you untick it.

Optional settings in `.env`:

| Setting | What it does |
| --- | --- |
| `YOUTUBE` | `on` to use YouTube, `off` to stick to the other sources |
| `PREFIX` | Text command prefix, `tt` by default |
| `JAMENDO_ID` | Free client id from devportal.jamendo.com to add Jamendo |
| `CACHE_MB` | How big the song cache may grow, 2048 by default |

## How it fits together

- `lavalink/` holds the Lavalink node config. It plays the audio and reads Apple Music links through LavaSrc
- `src/relay.ts` fetches YouTube, SoundCloud and Bandcamp audio with yt-dlp into a small cache and serves it to Lavalink on this PC only
- `src/rank.ts` picks the right song and the right upload of it
- `tray/` is the tray icon that runs and watches the node and the bot
- Everything the bot remembers lives in `tempestune.db` (SQLite)

## Notes

Using YouTube this way goes against YouTube's terms, which is why it can be switched off. If YouTube starts asking to confirm you're not a bot, export the cookies of a spare account to `cookies/youtube.txt` (the folder is ignored by git) and the bot uses them for YouTube. When YouTube refuses a song, the bot looks for the same song on SoundCloud.

## Thanks

Lavalink, LavaSrc, lavalink-client, discord.js, yt-dlp, FFmpeg, LRCLIB, radio-browser.info, the iTunes Search API and the Deezer API.

## License

MIT
