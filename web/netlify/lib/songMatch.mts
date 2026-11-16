// -----------------------------------------------------------------------------
// Matching a Spotify song (title, "A, B" artists, length) to a YouTube result:
// the pure part of matchSong (lib/ytjs.mts), no network, unit-tested in
// src/lib/__tests__/music-match.test.ts.
//
//   parseSpotify(title, artist, ms) → what the song is: its core title (no
//     " - 2011 Remaster", "(feat. X)", "- From …"), every artist (the "feat."
//     ones too), and which version was asked for (live, remix, acoustic…);
//   queries(song) → the searches to try, in order;
//   scoreCandidate(song, candidate) → how well one result fits, and whether it
//     is good enough to count as found (`accept`) and sure enough to stop
//     searching (`sure`).
//
// The weights come from a measured sample of ~170 Spotify songs
// (scripts/perf/match-rate.mjs, match-sample.json).
// -----------------------------------------------------------------------------

import { classify, type TrackKind, type TrackTag } from "../../src/lib/musicSort";

/** A Spotify song, taken apart. */
export interface SpotifySongParts {
  /** The title without version suffixes, "(feat. …)" and other brackets: what YouTube titles share. */
  core: string;
  /** Every artist: Spotify's list, then anyone named in "(feat. …)" / "(with …)". */
  artists: string[];
  ms: number;
  live: boolean;
  remix: boolean;
  acoustic: boolean;
  instrumental: boolean;
  /** Spotify's "- Radio Edit" / "- Edit": a shorter cut, so the length counts for less. */
  edit: boolean;
  /** Words worth adding to the search ("live", the remixer, "acoustic", "female version"). */
  hint: string;
}

/** One YouTube result, from the video search or YouTube Music's song search. */
export interface MatchCandidate {
  id: string;
  title: string;
  /** The channel as YouTube shows it (" - Topic" and VEVO kept). */
  channel: string;
  /** YouTube Music songs: the artists field. */
  artists?: string[];
  /** Length in ms, 0 if unknown. */
  ms: number;
  verifiedArtist?: boolean;
  verified?: boolean;
  /** "music" = YouTube Music's song search (the official "Topic" audio). */
  source: "music" | "video";
  /** Position in its result list (0 = first). */
  rank: number;
}

export interface CandidateScore {
  score: number;
  /** 0–1: how sure this is the song (shown by the app later for doubtful ones). */
  confidence: number;
  /** Good enough to count as found. */
  accept: boolean;
  /** So good there is no need to search further. */
  sure: boolean;
  titleHit: number;
  artistHit: number;
  /** |length difference| in ms, or null when either length is unknown. */
  delta: number | null;
  kind: TrackKind;
  tag?: TrackTag;
}

const LIVE = /\blive\b|\bao vivo\b|\ben vivo\b|\ben directo\b|\bdal vivo\b|\bunplugged\b|\brecorded at\b|\bin concert\b/i;
const REMIX = /\b(remix|rmx|mix|rework|bootleg|vip)\b/i;
const ACOUSTIC = /\b(acoustic|acustic[ao]|unplugged|piano version)\b/i;
const INSTRUMENTAL = /\b(instrumental|strumentale)\b/i;
const EDIT = /\b(radio edit|edit|single version|radio mix|short version)\b/i;
/** A " - …" suffix that only says which release it is: dropped from the search, ignored in titles. */
const DROP_SUFFIX = /^(.*\b)?(remaster(ed)?|\d{4}\s*(mix|version)?|mono|stereo|single|album|original|version|edit|radio|deluxe|bonus|explicit|clean|from\b|soundtrack|motion picture|spider-man|demo|take \d+|mix|live|remix|acoustic|recorded|session|ao vivo|en vivo|en directo|dal vivo|feat|with|con|instrumental|sped up|slowed)/i;
/** Brackets that hold another artist ("(feat. X)", "(with X)", "(con X)"). */
const FEAT_BRACKET = /[([]\s*(?:feat\.?|ft\.?|featuring|with|con|w\/)\s+([^)\]]+)[)\]]/gi;
const FEAT_BARE = /\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
/** Words that say which version, not which song (never required in a title). */
const VERSION_WORDS = new Set(
  "remaster remastered remasterizzato version versione ver mono stereo single album original edit radio deluxe bonus explicit clean from soundtrack motion picture the official video audio lyric lyrics testo letra feat ft featuring with con hd hq 4k mv".split(" ")
);

/**
 * Lower case, accents off ("Felicità" = "felicita"), only letters and digits
 * split by single spaces. Unlike musicSort's normText, Hangul syllables and
 * kana with marks stay whole (recomposed), so a Korean or Japanese word is one word.
 */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}
const squash = (s: string) => fold(s).replace(/ /g, "");
/** Hiragana, katakana, CJK, Hangul, Thai, Devanagari…: no spaces between words, so compared as one string. */
const NO_SPACES = /[ऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;

const splitArtists = (s: string) =>
  s
    .split(/\s*,\s*|\s+&\s+|\s+(?:and|e|y|x)\s+/i)
    .map((a) => a.replace(/[‎‏]/g, "").trim())
    .filter(Boolean);

/** A Spotify song taken apart (see SpotifySongParts). */
export function parseSpotify(title: string, artist: string, ms = 0): SpotifySongParts {
  let t = title.replace(/[‎‏‪-‮]/g, "").replace(/[“”«»„]/g, '"').replace(/[’‘`]/g, "'").trim();
  const artists = splitArtists(artist);
  const add = (names: string) => {
    for (const a of splitArtists(names)) if (!artists.some((x) => squash(x) === squash(a))) artists.push(a);
  };
  t = t.replace(FEAT_BRACKET, (_, names: string) => (add(names), " "));
  // " - Remastered 2011", " - Live at …", " - From "Footloose" Soundtrack": everything after the first such dash.
  const hints: string[] = [];
  let rest = "";
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && DROP_SUFFIX.test(dash[2])) {
    t = dash[1];
    rest = dash[2];
  }
  const bare = t.match(FEAT_BARE);
  if (bare) {
    add(bare[1]);
    t = t.slice(0, bare.index);
  }
  // Other brackets: version notes ("(Remastered)", "[Tamil]", "(Felix Jaehn Remix)") or a subtitle
  // ("(I Think It's Going To Be A Long, Long Time)") that YouTube titles often leave out.
  const brackets: string[] = [];
  let core = t.replace(/\s*[([]([^)\]]*)[)\]]?/g, (_, inner: string) => (brackets.push(inner), " ")).replace(/\s+/g, " ").trim();
  core = core.replace(/^["']+|["']+$/g, "").trim();
  if (!fold(core)) core = t.replace(/[()[\]"]/g, " ").replace(/\s+/g, " ").trim() || title;
  const notes = [rest, ...brackets].join(" ");
  const live = LIVE.test(notes);
  const remix = REMIX.test(notes) && !/\bremaster/i.test(notes.match(REMIX)?.[0] ?? "");
  const acoustic = ACOUSTIC.test(notes);
  const instrumental = INSTRUMENTAL.test(notes);
  const edit = EDIT.test(notes);
  if (live) hints.push("live");
  if (remix) {
    // "(Felix Jaehn Remix)" → "Felix Jaehn Remix"; "- Remix" → "remix".
    const named = [rest, ...brackets].find((x) => REMIX.test(x));
    hints.push(named && named.length < 40 ? named.replace(/\s*-\s*radio edit$/i, "") : "remix");
  }
  if (acoustic && !live) hints.push("acoustic");
  if (instrumental) hints.push("instrumental");
  const female = /female version/i.test(notes);
  if (female) hints.push("female version");
  return { core, artists, ms: ms > 0 ? ms : 0, live, remix, acoustic, instrumental, edit, hint: hints.join(" ") };
}

/**
 * The searches to try, best first: "artist title (+ version)", then the title
 * with every artist, then the title alone (the artist is still checked).
 * Duplicates are removed.
 */
export function queries(s: SpotifySongParts): string[] {
  const first = s.artists[0] ?? "";
  const plain = (q: string) => q.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const out = [
    plain(`${first} ${s.core} ${s.hint}`),
    plain(`${s.core} ${s.artists.slice(0, 3).join(" ")} ${s.hint}`),
    plain(`${s.core} ${s.hint}`),
  ];
  return out.filter((q, i) => q && out.indexOf(q) === i && (i < 2 || fold(s.core).length >= 3));
}

/** The words of a title that must be found: version words dropped (kept if nothing else is left). */
export function titleWords(core: string): string[] {
  const all = fold(core).split(" ").filter(Boolean);
  const kept = all.filter((w) => !VERSION_WORDS.has(w) && (w.length > 1 || NO_SPACES.test(w) || /\d/.test(w)));
  return kept.length ? kept : all;
}

/** Whether two words differ by at most one letter (added, missing or changed): "BBBBBOOTER" / "BBBBOOTER". */
export function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const tail = (x: string, y: string) => x.slice(i + 1) === y.slice(i + (x.length === y.length ? 1 : 0));
  return a.length >= b.length ? tail(a, b) : tail(b, a);
}

/** Share of `words` found in `text`: whole words; long ones also inside a longer word (scripts with no spaces too) or with one letter off. */
function share(words: string[], text: string): number {
  if (!words.length) return 0;
  const norm = fold(text);
  const hay = ` ${norm} `;
  const sq = norm.replace(/ /g, "");
  const tokens = norm.split(" ");
  const hit = words.filter(
    (w) => hay.includes(` ${w} `) || ((w.length >= 4 || NO_SPACES.test(w)) && sq.includes(w)) || (w.length >= 6 && tokens.some((t) => oneEdit(w, t)))
  ).length;
  return hit / words.length;
}

/** Channel names add "VEVO", "Official", "- Topic", "TV"…; this is the artist part, squashed. */
const channelName = (c: string) =>
  squash(c.replace(/\s+-\s+Topic$/i, "").replace(/vevo$/i, "").replace(/\b(official|officiel|oficial|ufficiale|music|musica|tv|channel|canale)\b/gi, " "));

/** How well one artist name fits a result: 1 = named (channel, artists field or title), 0.5 = half its words. */
function artistFit(name: string, c: MatchCandidate): number {
  const a = squash(name);
  if (a.length < 2) return 0;
  const ch = channelName(c.channel);
  const fields = [ch, ...(c.artists ?? []).map(squash), squash(c.title)];
  if (fields.some((f) => f && (f === a || (a.length >= 3 && f.includes(a)) || (f.length >= 4 && f === ch && a.includes(f))))) return 1;
  const words = fold(name).split(" ").filter((w) => w.length > 1);
  if (words.length < 2) return 0;
  const half = share(words, `${c.title} ${c.channel} ${(c.artists ?? []).join(" ")}`);
  return half >= 0.5 ? 0.5 : 0;
}

/** What a result says about its own version, beyond musicSort's classify. */
const NOT_THE_RECORD = /\b(alternate|alternative) (version|take)\b|\bdemo\b|\brehearsal\b|\bed sullivan\b|\btop of the pops\b|\bperformance\b|\bfull album\b|\bmedley\b/i;

/** Below this a candidate is not accepted: "not found" is better than a wrong song. */
export const MIN_CONFIDENCE = 0.45;

/** classify bonus for what a result is (official first; covers, karaoke and edits far behind). */
const KIND: Record<TrackKind, number> = { official: 1.0, audio: 1.0, live: 0, other: 0, cover: -2.5 };

/**
 * How well a result fits the song. Title words (3), an artist (2), the length
 * (up to +2.5 when within 2 s; a music video's longer cut costs a little, a
 * different recording a lot), what it is (classify: official / Topic audio
 * up, covers / karaoke / slowed edits down, live down unless asked for).
 *
 * `accept`: most of the title and an artist, or the whole title with the exact
 * length; or, for a title written in another script or language, the
 * artist's own upload with the exact length. Otherwise it is another song,
 * and "not found" is better than a wrong one.
 */
export function scoreCandidate(s: SpotifySongParts, c: MatchCandidate): CandidateScore {
  const words = titleWords(s.core);
  const whole = squash(s.core);
  const titleHit = Math.max(share(words, c.title), (whole.length >= 4 || (whole.length >= 2 && NO_SPACES.test(whole))) && squash(c.title).includes(whole) ? 1 : 0);
  let artistHit = 0;
  s.artists.forEach((a, i) => {
    artistHit = Math.max(artistHit, artistFit(a, c) * (i === 0 ? 1 : 0.85));
  });
  const delta = s.ms && c.ms ? Math.abs(c.ms - s.ms) : null;
  const cls = classify({ title: c.title, channel: c.source === "music" && !/ - Topic$/i.test(c.channel) ? `${c.channel} - Topic` : c.channel, verifiedArtist: c.verifiedArtist, verified: c.verified });
  const candLive = cls.kind === "live" || LIVE.test(c.title);
  const candRemix = /\bremix\b|\brmx\b/i.test(c.title);

  let score = titleHit * 3 + artistHit * 2;
  // Length: Spotify's and YouTube Music's are the same recording to the second.
  if (delta !== null) {
    const loose = s.edit ? 2 : 1; // a radio edit's length varies more between releases
    if (delta <= 2000 * loose) score += 2.5;
    else if (delta <= 5000 * loose) score += 2;
    else if (delta <= 10000 * loose) score += 1.2;
    else if (delta <= 30000) score += 0.3; // a music video with an intro
    else score -= Math.min(2, (delta - 30000) / 30000);
  }
  // What it is. A version asked for by name is not penalised, and one not asked for is.
  if (cls.kind === "cover") {
    const asked = (cls.tag === "edit" && s.remix) || (cls.tag === "cover" && s.instrumental && /instrumental|karaoke/i.test(c.title));
    score += asked ? 0 : cls.tag === "lyrics" || cls.tag === "unofficial" ? -0.4 : KIND.cover;
  } else score += KIND[cls.kind];
  if (s.live !== candLive) score -= 1.5;
  if (s.remix !== candRemix) score -= s.remix ? 0.8 : 1.2;
  if (!s.acoustic && /\bacoustic\b/i.test(c.title)) score -= 0.8;
  if (NOT_THE_RECORD.test(c.title)) score -= 0.8;
  if (c.source === "music" || /\s-\s*Topic$/i.test(c.channel)) score += 0.5;
  score += Math.max(0, 0.3 - c.rank * 0.03);

  // Gates: the title and an artist, or the exact recording.
  const exact = delta !== null && delta <= 3000;
  const own = artistHit >= 1 && (/\s-\s*Topic$/i.test(c.channel) || c.source === "music" || channelName(c.channel).includes(squash(s.artists[0] ?? "")));
  const otherScript = NO_SPACES.test(c.title) !== NO_SPACES.test(s.core);
  const coverLike = cls.kind === "cover" && cls.tag === "cover" && !s.instrumental;
  const accept =
    !coverLike &&
    ((titleHit >= 0.6 && artistHit >= 0.5) ||
      // The whole title, to the second: an artist named differently ("Chad LB" for Chad Lefkowitz-Brown).
      (titleHit >= 0.99 && words.length >= 2 && exact && cls.kind !== "live" && cls.kind !== "cover") ||
      (otherScript && own && exact));

  let confidence = 1;
  if (titleHit < 0.8) confidence -= 0.25;
  if (titleHit < 0.6) confidence -= 0.15;
  if (artistHit < 1) confidence -= artistHit > 0 ? 0.25 : 0.3;
  if (delta === null) confidence -= 0.1;
  else if (delta > 90000) confidence -= 0.6; // another recording (a concert, a long video)
  else if (delta > 45000) confidence -= 0.4;
  else if (delta > 10000 * (s.edit ? 2 : 1)) confidence -= 0.2;
  if (s.live !== candLive || s.remix !== candRemix) confidence -= 0.3;
  if (cls.kind === "cover") confidence -= cls.tag === "lyrics" || cls.tag === "unofficial" ? 0.1 : 0.4;
  if (NOT_THE_RECORD.test(c.title)) confidence -= 0.2;
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  const sure = accept && confidence >= 0.75;
  return { score, confidence, accept: accept && confidence >= MIN_CONFIDENCE, sure, titleHit, artistHit, delta, kind: cls.kind, ...(cls.tag ? { tag: cls.tag } : {}) };
}

/** The best accepted candidate (highest score; ties keep the earlier one), or null. */
export function bestMatch(s: SpotifySongParts, list: MatchCandidate[]): { c: MatchCandidate; r: CandidateScore } | null {
  let best: { c: MatchCandidate; r: CandidateScore } | null = null;
  for (const c of list) {
    const r = scoreCandidate(s, c);
    if (r.accept && (!best || r.score > best.r.score)) best = { c, r };
  }
  return best;
}
