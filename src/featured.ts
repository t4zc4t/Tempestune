import type { Want } from './music.js';

// ready-made playlists anyone can play: "tt tensura", "tt anime", or "tt pl load <name>"
// songs are stored by artist and title; the right upload is found when each one plays

interface Featured {
  key: string;
  name: string;
  about: string;
  songs: [artist: string, title: string][];
}

export const FEATURED: Featured[] = [
  {
    key: 'tensura',
    name: 'Tensura openings and endings',
    about: 'Every opening and ending of That Time I Got Reincarnated as a Slime, season 1 to 4, plus the Scarlet Bond theme',
    songs: [
      ['Takuma Terashima', 'Nameless Story'], // s1 op1
      ['TRUE', 'Another Colony'], // s1 ed1
      ['Takuma Terashima', 'Megurumono'], // s1 op2
      ['Azusa Tadokoro', 'Little Soldier'], // s1 ed2
      ['TRUE', 'Storyteller'], // s2 op1
      ['STEREO DIVE FOUNDATION', 'STORYSEEKER'], // s2 ed1
      ['MindaRyn', 'Like Flames'], // s2 op2
      ['Takuma Terashima', 'Reincarnate'], // s2 ed2
      ['MindaRyn', 'Make Me Feel Better'], // scarlet bond
      ['STEREO DIVE FOUNDATION', 'PEACEKEEPER'], // s3 op1
      ['Rin Kurusu', 'Believer'], // s3 ed1
      ['Momoiro Clover Z', 'Renacer Serenade'], // s3 op2
      ['MindaRyn', 'Miracle Soup'], // s3 ed2
      ['Eir Aoi', 'Esoragoto'], // s4 op1
      ['CiON', 'Katsubo'], // s4 ed1
      ['Daoko', 'TACTIC'], // s4 op2
      ['Azusa Tadokoro', 'Hymnal'], // s4 ed2
    ],
  },
  {
    key: 'anime',
    name: 'Anime hits',
    about: 'Well loved anime openings and endings',
    songs: [
      ['LiSA', 'Gurenge'],
      ['TK from Ling tosite sigure', 'Unravel'],
      ['Ikimonogakari', 'Blue Bird'],
      ['KANA-BOON', 'Silhouette'],
      ['Linked Horizon', 'Guren no Yumiya'],
      ['Linked Horizon', 'Shinzou wo Sasageyo'],
      ['SiM', 'The Rumbling'],
      ['Eve', 'Kaikai Kitan'],
      ['King Gnu', 'SPECIALZ'],
      ['Kenshi Yonezu', 'KICK BACK'],
      ['YOASOBI', 'Idol'],
      ['Creepy Nuts', 'Bling-Bang-Bang-Born'],
      ['LiSA', 'Crossing Field'],
      ['LiSA', 'Homura'],
      ['Aimer', 'Zankyou Sanka'],
      ['Kenshi Yonezu', 'Peace Sign'],
      ['Official HIGE DANdism', 'Mixed Nuts'],
      ['Mrs. GREEN APPLE', 'Inferno'],
      ['FLOW', 'Sign'],
      ['Asian Kung-Fu Generation', 'Haruka Kanata'],
      ['Yoko Takahashi', 'A Cruel Angel\'s Thesis'],
      ['Seatbelts', 'Tank!'],
      ['Kanako Itou', 'Hacking to the Gate'],
      ['Goose house', 'Hikaru Nara'],
      ['Coda', 'BLOODY STREAM'],
      ['Masatoshi Ono', 'Departure!'],
      ['MAN WITH A MISSION', 'Dark Crow'],
      ['Vickeblanka', 'Black Catcher'],
      ['UVERworld', 'ODD FUTURE'],
      ['GRANRODEO', 'TRASH CANDY'],
      ['SCREEN mode', 'Reason Living'],
      ['Tatsuya Kitani', 'Ao no Sumika'],
      ['RADWIMPS', 'Sparkle'],
      ['Minami', 'Kawaki wo Ameku'],
      ['MindaRyn', 'Like Flames'],
    ],
  },
];

export const featured = (name: string) => {
  const q = name.trim().toLowerCase();
  return FEATURED.find((f) => f.key === q || f.name.toLowerCase() === q);
};

export const featuredSongs = (f: Featured): Want[] => f.songs.map(([author, title]) => ({ title, author, how: 'find', source: 'search' }));
