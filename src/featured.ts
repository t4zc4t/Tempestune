import type { Want } from './music.js';

// ready-made playlists anyone can play: "tt tensura", "tt aot", "tt anime", or "tt pl load <name>"
// each song is pinned to one full upload so nothing random sneaks in; if an upload goes away
// the usual fallback finds the song by name instead

interface Featured {
  key: string;
  name: string;
  aliases?: string[];
  about: string;
  songs: [artist: string, title: string, video: string, seconds: number][];
}

export const FEATURED: Featured[] = [
  {
    key: 'tensura',
    name: 'Tensura openings and endings',
    aliases: ['slime', 'rimuru'],
    about: 'Every opening and ending from seasons 1 to 3, plus the Scarlet Bond movie theme',
    songs: [
      ['Takuma Terashima', 'Nameless Story', 'W1O8iRu0V4A', 248], // s1 op1
      ['TRUE', 'Another Colony', 'x2wUyP0l4bw', 247], // s1 ed1
      ['Takuma Terashima', 'Megurumono', 'TQepXfab5pg', 308], // s1 op2
      ['Azusa Tadokoro', 'Little Soldier', 'Ov6CybJctdQ', 238], // s1 ed2
      ['TRUE', 'Storyteller', 'JLQTiFwBVyI', 272], // s2 op1
      ['STEREO DIVE FOUNDATION', 'STORYSEEKER', 'XIIqgWUtPpk', 239], // s2 ed1
      ['MindaRyn', 'Like Flames', 'q8TGietS5Q0', 261], // s2 op2
      ['Takuma Terashima', 'Reincarnate', 'DQAiVc3L2vQ', 249], // s2 ed2
      ['MindaRyn', 'Make Me Feel Better', 'r3xAis_5f_Q', 276], // scarlet bond
      ['STEREO DIVE FOUNDATION', 'PEACEKEEPER', 'HC_1YdaanEc', 244], // s3 op1
      ['Rin Kurusu', 'Believer', 'ptyp93BBwJs', 197], // s3 ed1
      ['Momoiro Clover Z', 'Renacer Serenade', '_qxHz8vH5KM', 253], // s3 op2
      ['MindaRyn', 'Miracle Soup', 'fOGS2tn-eog', 210], // s3 ed2
    ],
  },
  {
    key: 'anime',
    name: 'Anime hits',
    aliases: ['animehits'],
    about: 'Big anime openings, endings and themes, one full version each',
    songs: [
      ['LiSA', 'Gurenge', 'x1FV6IrjZCY', 236],
      ['TK from Ling tosite sigure', 'unravel', 'Fve_lHIPa-I', 243],
      ['Ikimonogakari', 'Blue Bird', 'KpsJWFuVTdI', 217],
      ['KANA-BOON', 'Silhouette', 'dlFA0Zq1k2A', 266],
      ['ASIAN KUNG-FU GENERATION', 'Haruka Kanata', 'nJ6A6GC_ki4', 247],
      ['FLOW', 'GO!!!', 'AE4b9jO1uB4', 266],
      ['Linked Horizon', 'Guren no Yumiya', 'Pn7dCgtwX2c', 317],
      ['Linked Horizon', 'Shinzou wo Sasageyo!', 'wwfwjEroBXc', 382],
      ['SiM', 'The Rumbling', 'OBqw818mQ1E', 224],
      ['Eve', 'Kaikai Kitan', '1tk1pqwrOys', 224],
      ['ALI', 'LOST IN PARADISE feat. AKLO', 'uwD3W9a9qJw', 329],
      ['Tatsuya Kitani', 'Ao no Sumika', 'zuoVd2QNxJo', 201],
      ['King Gnu', 'SPECIALZ', 'fhzKLBZJC3w', 242],
      ['Kenshi Yonezu', 'KICK BACK', 'M2cckDmNLMI', 228],
      ['Kenshi Yonezu', 'Peace Sign', '9aJVr5tTTWk', 265],
      ['YOASOBI', 'Idol', 'ZRtdQ81jPUQ', 226],
      ['Creepy Nuts', 'Bling-Bang-Bang-Born', 'mLW35YMzELE', 173],
      ['LiSA', 'crossing field', '1aPOj0ERTEc', 249],
      ['LiSA', 'Homura', '4DxL6IKmXx4', 302],
      ['Aimer', 'Zankyosanka', 'tLQLa6lM3Us', 182],
      ['Official HIGE DANdism', 'Mixed Nuts', 'CbH2F0kXgTY', 230],
      ['Mrs. GREEN APPLE', 'Inferno', 'wfCcs0vLysk', 222],
      ['MAN WITH A MISSION', 'Dark Crow', '3J_7BEHLRTE', 277],
      ['ONE OK ROCK', 'The Beginning', 'Hh9yZWeTmVM', 314],
      ['DAOKO x Kenshi Yonezu', 'Uchiage Hanabi', 'Sm4KdU46dhU', 286],
      ['Minami', 'Kawaki wo Ameku', '0YF8vecQWYs', 254],
      ['Goose house', 'Hikaru Nara', 'SnXkhkEvNIM', 259],
      ['Coda', 'BLOODY STREAM', 'QJVIOhyhz5A', 296],
      ['Kanako Itou', 'Hacking to the Gate', 'tdjthJXntrk', 271],
      ['Masatoshi Ono', 'Departure!', '6q3gd47tTVw', 256],
      ['Yoko Takahashi', 'A Cruel Angel\'s Thesis', 'o6wtDPVkKqI', 244],
      ['Yoko Kanno & SEATBELTS', 'Tank!', 'd75ov4HvRrM', 442],
    ],
  },
  {
    key: 'aot',
    name: 'Attack on Titan openings and endings',
    about: 'Every opening and ending, season 1 to the final episode',
    aliases: ['attackontitan', 'snk'],
    songs: [
      ['Linked Horizon', 'Guren no Yumiya', 'Pn7dCgtwX2c', 316], // s1 op1
      ['Yoko Hikasa', 'Utsukushiki Zankoku na Sekai', 'p_xPXSoVFjU', 302], // s1 ed1
      ['Linked Horizon', 'Jiyuu no Tsubasa', 'EO8EadQNIXU', 327], // s1 op2
      ['cinema staff', 'great escape', 'u2YSzzXb2I4', 205], // s1 ed2
      ['Linked Horizon', 'Shinzou wo Sasageyo!', 'wwfwjEroBXc', 382], // s2 op
      ['Shinsei Kamattechan', 'Yuugure no Tori', 'sUW4dDWiz-A', 303], // s2 ed
      ['YOSHIKI feat. HYDE', 'Red Swan', 'r1XE8ON8fos', 269], // s3 op1
      ['Linked Horizon', 'Akatsuki no Requiem', '3FmoPWSdjc4', 265], // s3 ed1
      ['Linked Horizon', 'Shoukei to Shikabane no Michi', 'NCRcTZiahss', 275], // s3 op2
      ['cinema staff', 'Name of Love', 'LnCDBel2JV0', 264], // s3 ed2
      ['Shinsei Kamattechan', 'Boku no Sensou', 'goXKlOozyx8', 279], // final season op1
      ['Yuko Ando', 'Shogeki', 'UAuwzw_5JU4', 185], // final season ed1
      ['SiM', 'The Rumbling', 'OBqw818mQ1E', 223], // final season op2
      ['Ai Higuchi', 'Akuma no Ko', 'N4F3bjlL_H4', 230], // final season ed2
      ['SiM', 'UNDER THE TREE', 'IPX-L2F78fU', 272], // final chapters op
      ['Ai Higuchi', 'Itterasshai', 'LE2_BeKcG4E', 253], // final chapters ed
      ['Linked Horizon', 'The Last Titan', 'QQaT50lkN3c', 241], // last episode op
    ],
  },
  {
    key: 'jjk',
    name: 'Jujutsu Kaisen openings and endings',
    about: 'Every opening and ending from seasons 1 to 3, plus the Jujutsu Kaisen 0 movie songs',
    aliases: ['jujutsu', 'jujutsukaisen'],
    songs: [
      ['Eve', 'Kaikai Kitan', '1tk1pqwrOys', 223], // s1 op1
      ['ALI', 'LOST IN PARADISE feat. AKLO', 'uwD3W9a9qJw', 328], // s1 ed1
      ['Who-ya Extended', 'VIVID VICE', 'EU6I8TxU6Z4', 200], // s1 op2
      ['Cö shu Nie', 'give it back', 'QJ8P-81gYA8', 215], // s1 ed2
      ['King Gnu', 'Ichizu', 'hm1na9R2uYA', 190], // movie 0 theme
      ['King Gnu', 'Sakayume', 'M6gcoDN9jBc', 319], // movie 0 ending
      ['Tatsuya Kitani', 'Ao no Sumika', 'zuoVd2QNxJo', 201], // s2 op1
      ['Soushi Sakiyama', 'Akari', '4jWzGkRsHw8', 249], // s2 ed1
      ['King Gnu', 'SPECIALZ', 'fhzKLBZJC3w', 241], // s2 op2
      ['Hitsujibungaku', 'more than words', 'kGY6N9DL4Jw', 299], // s2 ed2
      ['King Gnu', 'AIZO', 'zz2a9Q2Wru0', 238], // s3 op
      ['jo0ji', 'Yoake no Uta', 'ufcDIOS1HRo', 202], // s3 ed
    ],
  },
  {
    key: 'demonslayer',
    name: 'Demon Slayer openings and endings',
    about: 'Every opening and ending, plus the Mugen Train and Infinity Castle movie songs',
    aliases: ['kny', 'kimetsu'],
    songs: [
      ['LiSA', 'Gurenge', 'x1FV6IrjZCY', 235], // s1 op
      ['FictionJunction feat. LiSA', 'from the edge', 'qz9bpL7o9Uo', 274], // s1 ed
      ['LiSA', 'Homura', '4DxL6IKmXx4', 301], // mugen train movie
      ['LiSA', 'Akeboshi', 'yGcm81aaTHg', 273], // mugen train arc op
      ['LiSA', 'Shirogane', '5whFTc6SaI8', 274], // mugen train arc ed
      ['Aimer', 'Zankyosanka', 'tLQLa6lM3Us', 181], // entertainment district op
      ['Aimer', 'Asa ga Kuru', 'QORbTrXHpsA', 291], // entertainment district ed
      ['MAN WITH A MISSION x milet', 'Kizuna no Kiseki', 'Jb6Zlg30rgk', 225], // swordsmith village op
      ['milet x MAN WITH A MISSION', 'Koi Kogare', 'vZUyKVE9dus', 225], // swordsmith village ed
      ['MY FIRST STORY x HYDE', 'MUGEN', '1a3b7ZpUcn4', 242], // hashira training op
      ['HYDE x MY FIRST STORY', 'Tokoshie', 'zjEU6Kp8Gn8', 262], // hashira training ed
      ['Aimer', 'A World Where the Sun Never Rises', 'DJOf0XtVpkI', 174], // infinity castle
      ['LiSA', 'Shine in the Cruel Night', 'ysdtX8kRTuQ', 385], // infinity castle
    ],
  },
];

export const featured = (name: string) => {
  const q = name.trim().toLowerCase();
  return FEATURED.find((f) => f.key === q || f.name.toLowerCase() === q || f.aliases?.includes(q));
};

export const featuredSongs = (f: Featured): Want[] =>
  f.songs.map(([author, title, video, seconds]) => {
    const link = `https://www.youtube.com/watch?v=${video}`;
    return { title, author, duration: seconds * 1000, artwork: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`, link, uri: link, how: 'relay', source: 'youtube' };
  });
