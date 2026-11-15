const need = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
};

export const config = {
  token: need('DISCORD_TOKEN'),
  password: need('LAVALINK_PASSWORD'),
  youtube: process.env.YOUTUBE?.toLowerCase() === 'on',
  // text commands start with this, like "tt p faded"
  prefix: (process.env.PREFIX || 'tt').trim(),
  // free client id from devportal.jamendo.com, jamendo stays off without one
  jamendo: process.env.JAMENDO_ID?.trim() || '',
  // the relay serves cached tracks to lavalink on this port, only on this pc
  relayPort: Number(process.env.RELAY_PORT || 2340),
  cacheMb: Number(process.env.CACHE_MB || 2048),
};
