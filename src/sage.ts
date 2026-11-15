// Tempestune's voice: a calm slime with a very thorough assistant in its head.
// Kept short, one line per moment, never more than a flavour.
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

const lines = {
  loaded: [
    'Analysis complete.',
    'Analysis complete. Playing it now~',
    'Analysis complete. Good pick, honestly.',
  ],
  queued: [
    'Added to the queue.',
    'Stored away for later.',
    'Noted. It is in the queue.',
  ],
  predator: [
    'Predator: absorbed {n} tracks into the queue.',
    'Predator: {n} tracks taken in. Nothing goes to waste.',
  ],
  searching: [
    'Great Sage: analysing your request...',
    'Great Sage: searching...',
  ],
  notFound: [
    'Great Sage: no result found for that. Try other words?',
    'Great Sage: nothing matched. Maybe a different spelling?',
  ],
  failed: [
    'Great Sage: that track could not be loaded, skipping it.',
    'Great Sage: something went wrong with that one. Moving on.',
  ],
  notOriginal: [
    'Great Sage: the original is not free on SoundCloud, so this is the closest version I found.',
  ],
  noVoice: ['Join a voice channel first, then call me.'],
  otherVoice: ['I am already playing in another channel here.'],
  nothing: ['Nothing is playing right now.'],
  stopped: ['Stopped and cleared the queue. Call me any time.'],
  skipped: ['Skipped.'],
  paused: ['Paused.'],
  resumed: ['Resumed.'],
  queueEnd: ['That was the last track. I will wait here a little.'],
  nodeDown: ['Great Sage: the audio node is not ready yet, give it a moment.'],
} as const;

export type Moment = keyof typeof lines;

export const say = (moment: Moment, vars: Record<string, string | number> = {}) =>
  pick(lines[moment]).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
