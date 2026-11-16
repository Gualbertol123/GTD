// -----------------------------------------------------------------------------
// Which search result is the official song, and the order the results show in.
//
// Shared by the server and the browser (no DOM, no React):
//   - the server (netlify/lib/ytjs.mts, netlify/functions/music-search.mts)
//     classifies every search result once, with what YouTube says about the
//     channel (the "Official Artist Channel" badge, "- Topic", VEVO), and
//     matchSong (Spotify import) scores its candidates with the same rules;
//   - the browser (MusicTab Search, the ♪ panel) sorts and filters the list it
//     got, instantly, with no new request: "Ufficiali prima" (default),
//     "Pertinenza" (YouTube's own order) or "Più visti", and can hide covers.
//
// The rules come from real YouTube.js answers (despacito, sere nere, bohemian
// rhapsody, blinding lights, perfect, la solitudine, albachiara): see the
// fixtures in src/lib/__tests__/music-search-sort.test.ts.
// -----------------------------------------------------------------------------

/** What a search result is. "audio" is the official audio: official, shown after the video. */
export type TrackKind = "official" | "audio" | "live" | "cover" | "other";
/** Why a "cover" result is not the song (its small label). */
export type TrackTag = "cover" | "edit" | "lyrics" | "unofficial";

/** One result as YouTube gives it (the channel name as shown, " - Topic" included). */
export interface RawResult {
  title: string;
  channel: string;
  /** YouTube's ♪ badge: "Official Artist Channel" / "Canale ufficiale dell'artista". */
  verifiedArtist?: boolean;
  /** YouTube's plain ✓ badge (lyric channels and TV shows have it too). */
  verified?: boolean;
}

export interface Classified {
  kind: TrackKind;
  /** Higher = more likely the song's official version (for ties and matchSong). */
  score: number;
  tag?: TrackTag;
}

/** Lower case, no accents, only letters and digits split by single spaces. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const squash = (s: string) => normText(s).replace(/ /g, "");

// ---- Signals in a title (and channel name) -----------------------------------

const OFFICIAL_MARK =
  /\b(official|ufficiale|oficial|officiel|offizielles)\b[^()[\]]*\b(video|videoclip|clip|audio|visuali[sz]er|lyric video)\b|\b(music video|videoclip ufficiale|video ufficiale|clip officiel|video oficial|visuali[sz]er)\b/i;
const AUDIO_MARK = /\b(official audio|audio ufficiale|audio oficial|audio officiel)\b|[([]\s*audio\s*[)\]]|\(\s*official\s+audio|\baudio\)$/i;
// "live" as a version of the song (not "Live Forever"): in brackets, "live at/in/on…", at the end, "- Live".
const LIVE_STRICT =
  /[([][^)\]]*\blive\b|\blive\s+(at|in|on|from|@|a|al|da|dal|en|aus|19\d\d|20\d\d|video|aid|performance|session)\b|[-–‒—|]\s*live\s*([-–‒—|,([]|$)|\blive\s*[,([]|\blive\s*!?\s*$|\b(ao vivo|en vivo|dal vivo|en directo|in concerto|in concert|concerto|concert|unplugged|mtv|acoustic session|live session|world tour|tour 20\d\d|tiny desk|sanremo|festivalbar|top ?pop|tonight show|late show|jimmy kimmel|jimmy fallon|colbert|later with jools|performance)\b/i;
const LIVE_WORD = /\blive\b/i;
const KARAOKE = /\b(karaoke|instrumental|strumentale|base musicale|backing track|minus one)\b/i;
const COVER = /\b(cover|covers|rendition|tribute|tributo|reinterpretazione|choreography|coreografia|flash ?mob|the voice|x factor|got talent|american idol|amici di|immortal songs|masked singer|tale e quale)\b|불후의/i;
// Instruments and dancing: a cover unless the artist's own upload ("Billy Joel - Piano Man", "Dance Monkey").
const INSTRUMENT = /\b(dance|sax|saxophone|sassofono|violin|violino|cello|violoncello|guitar|chitarra|piano|pianoforte|drums?|drum cover|batteria|ukulele|flute|flauto|harp|arpa|kalimba|ocarina)\b/i;
const EDIT =
  /\b(slowed|sped up|speed up|reverb|8d|nightcore|bass boosted|loop|looped|extended|mashup|mash up|remix|dj mix|club mix|lofi|lo fi|phonk|drill|tiktok version|\d+\s*(hours?|ore)|[1-9]\d+\s*(minutes?|minuti|min))\b/i;
const LYRICS = /\b(lyrics?|lyric video|testo|con testo|letra|paroles|legendado|legendada|traducao|traduzione|traduccion|sub espanol|subtitulado|lirik|karaoke lyrics)\b|가사/i;
const OFF_TOPIC = /\b(reaction|reacts?|reagisce|tutorial|lesson|lezione|how to play|come suonare|trailer|scene|scena|parody|parodia|fan ?made|fanmade|fan video|unofficial|non ufficiale|meme)\b/i;
const FAN_CHANNEL = /\b(fans?|fanpage|fan club|fanclub)\b/i;

/** Words a channel adds to the artist's name ("Queen Official", "laurapausinitv", "X - Topic"). */
const CHANNEL_NOISE = /\b(topic|vevo|official|officiel|oficial|ufficiale|tv|music|musica|channel|canale|multimedia)\b/g;

function channelKey(channel: string): string {
  return normText(channel.replace(/\s+-\s+Topic$/i, "").replace(/vevo$/i, ""))
    .replace(CHANNEL_NOISE, " ")
    .replace(/\s+/g, "");
}

/** The artists named in a title: each part of "A, B & C feat. D - Song", and the song part too ("Song - Artist"). */
function titleSegments(title: string): string[][] {
  const segs = title.split(/\s[-–‒—|]\s|:\s|\s\/\s/);
  return segs.map((seg) => {
    const bare = seg.replace(/[([].*?[)\]]/g, " ");
    const parts = bare.split(/,|&|\+|\s(?:x|e|y|and|with|con|feat\.?|ft\.?|featuring)\s/i).map(squash);
    return [squash(bare), ...parts].filter(Boolean);
  });
}

const sameName = (part: string, key: string) =>
  part === key || (key.length >= 4 && part.length >= 4 && (key.includes(part) || part.includes(key)));

/** Where the channel's name is in the title: 0 = the first part (the artist), 1 = elsewhere, -1 = not there. */
function channelInTitle(title: string, channel: string): number {
  const key = channelKey(channel);
  if (key.length < 2) return -1;
  const segs = titleSegments(title);
  if (segs[0]?.some((p) => sameName(p, key))) return 0;
  if (segs.slice(1).some((s) => s.some((p) => sameName(p, key)))) return 1;
  // No separator ("Luis Fonsi Despacito ft. Daddy Yankee (audio)"): anywhere in it.
  if (segs.length === 1 && key.length >= 4 && squash(title).includes(key)) return 0;
  return -1;
}

const BASE: Record<TrackKind, number> = { official: 100, audio: 80, live: 50, other: 30, cover: 10 };

/**
 * What one result is. Covers, karaoke, edits and lyric uploads beat every
 * other signal (an artist covering someone else is still a cover); then live;
 * then the official channel (the artist's own, VEVO, "- Topic") decides
 * between the official video, the official audio and "other".
 */
export function classify(r: RawResult): Classified {
  const title = r.title ?? "";
  const channel = r.channel ?? "";
  const hay = `${title} ${channel}`;
  const topic = /\s-\s*Topic$/i.test(channel);
  const vevo = /vevo\s*$/i.test(channel);
  const where = channelInTitle(title, channel);
  const fan = FAN_CHANNEL.test(channel);
  // The artist's own channel: VEVO, "- Topic", or its name is an artist in the title.
  const own = !fan && (vevo || topic || where >= 0);
  const head = !fan && (vevo || topic || where === 0);
  const officialMark = OFFICIAL_MARK.test(title);
  let score = (r.verifiedArtist ? 8 : 0) + (vevo || topic ? 6 : 0) + (officialMark ? 5 : 0) + (r.verified ? 1 : 0) + (own ? 4 : 0);
  const done = (kind: TrackKind, tag?: TrackTag): Classified => ({ kind, score: BASE[kind] + score, ...(tag ? { tag } : {}) });

  if (KARAOKE.test(hay) || COVER.test(hay)) return done("cover", "cover");
  // An instrument in the title is a cover unless it is the artist's own upload ("Billy Joel - Piano Man").
  if (INSTRUMENT.test(title) && !head) return done("cover", "cover");
  if (OFF_TOPIC.test(title) || fan) return done("cover", "unofficial");
  // A remix by the artist (their channel, their name first) is theirs.
  if (EDIT.test(title) && !(head && /\bremix\b/i.test(title) && !/\b(slowed|reverb|sped|8d|nightcore|loop)\b/i.test(title))) return done("cover", "edit");
  if (LYRICS.test(title) && !(own && officialMark)) return done("cover", "lyrics");
  // On an official channel only clear live markers count ("Live Forever" is a song).
  if (LIVE_STRICT.test(hay) || (!own && LIVE_WORD.test(title))) return done("live");
  if (topic) return done("audio");
  // Official: VEVO; the ♪ badge with the channel named in the title; an
  // "(Official Video)" from a channel named in it; or the channel is the
  // artist named first ("Tiziano Ferro - Sere Nere" by Tiziano Ferro). A
  // channel named only later ("… | Netflix") or not at all ("DJ DY") is not.
  if (vevo || (own && (r.verifiedArtist || officialMark)) || head) {
    return done(AUDIO_MARK.test(title) ? "audio" : "official");
  }
  return done("other");
}

// ---- Sorting and hiding (the browser) -----------------------------------------

export type SortMode = "official" | "relevance" | "views";

export interface SortableTrack {
  id: string;
  title: string;
  channel: string;
  kind?: TrackKind;
  /** The position YouTube gave it (0 = first). */
  rank?: number;
  views?: number;
}

const STOP = new Set(["the", "feat", "ft", "official", "video", "audio", "lyrics", "testo", "di", "de", "la", "il", "lo", "el", "le", "a", "e"]);

/**
 * Whether a result is the song searched for: most of the query's words are in
 * its title or channel ("tiziano ferro sere nere" → not "Rosso Relativo",
 * even from Tiziano Ferro's own channel).
 */
export function onTopic(t: { title: string; channel: string }, q: string): boolean {
  const words = normText(q).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return true;
  const hay = ` ${normText(`${t.title} ${t.channel}`)} `;
  const sq = hay.replace(/ /g, "");
  const hits = words.filter((w) => hay.includes(` ${w} `) || (w.length >= 4 && sq.includes(w))).length;
  return hits >= Math.ceil(words.length * 0.75);
}

/** Same artist: same channel, or an artist named first in both titles. */
function sameArtist(a: SortableTrack, b: SortableTrack): boolean {
  const ka = channelKey(a.channel);
  if (ka && ka === channelKey(b.channel)) return true;
  const pa = titleSegments(a.title)[0] ?? [];
  const pb = titleSegments(b.title)[0] ?? [];
  return pa.some((x) => pb.some((y) => sameName(x, y)));
}

/** The song's artist for this list: who made its first official result (in YouTube's order). */
function leadOf(list: SortableTrack[], q: string): SortableTrack | undefined {
  return list
    .filter((t) => (t.kind === "official" || t.kind === "audio") && onTopic(t, q))
    .reduce<SortableTrack | undefined>((best, t, i) => (!best || (t.rank ?? i) < (best.rank ?? i) ? t : best), undefined);
}

/**
 * The group a result sorts into for "Ufficiali prima" (lower first). An
 * "official" video of the song by someone else (KIDZ BOP's own "Blinding
 * Lights (Official Music Video)") or of another song goes with the rest.
 */
export function group(t: SortableTrack, q = "", lead?: SortableTrack): number {
  const theirs = () => onTopic(t, q) && (!lead || t === lead || sameArtist(t, lead));
  switch (t.kind) {
    case "official":
      return theirs() ? 0 : 3;
    case "audio":
      return theirs() ? 1 : 3;
    case "live":
      return 2;
    case "cover":
      return 4;
    default:
      return 3;
  }
}

const rankOf = (t: SortableTrack, i: number) => (typeof t.rank === "number" ? t.rank : i);

/** Whether "Più visti" can be offered: YouTube.js gave view counts. */
export function hasViews(list: SortableTrack[]): boolean {
  return list.some((t) => typeof t.views === "number" && t.views > 0);
}

/** Whether "hide covers" would hide anything. */
export const isHideable = (t: SortableTrack) => t.kind === "cover";

/**
 * The results in the chosen order (a new array; the input is not changed).
 * Ties always keep YouTube's order. Results without a kind (an old answer)
 * stay where they are.
 */
export function sortTracks<T extends SortableTrack>(list: T[], mode: SortMode, q = "", hide = false): T[] {
  // "Più visti" without view counts (the Data API gives none): official first.
  const m: SortMode = mode === "views" && !hasViews(list) ? "official" : mode;
  const lead = m === "official" ? leadOf(list, q) : undefined;
  const rows = list.map((t, i) => ({ t, r: rankOf(t, i), g: m === "official" ? group(t, q, lead) : 0 }));
  const kept = hide ? rows.filter((x) => !isHideable(x.t)) : rows;
  if (m === "views") {
    kept.sort((a, b) => (b.t.views ?? -1) - (a.t.views ?? -1) || a.r - b.r);
  } else {
    kept.sort((a, b) => a.g - b.g || a.r - b.r);
  }
  return kept.map((x) => x.t);
}

/** The result that gets the "Ufficiale" badge: the first official video (or audio) of the song, in the order shown. */
export function primaryOfficial(list: SortableTrack[], q = ""): string | null {
  const lead = leadOf(list, q);
  const first = (k: TrackKind) => list.find((t) => t.kind === k && onTopic(t, q) && (!lead || sameArtist(t, lead)))?.id;
  return first("official") ?? first("audio") ?? null;
}

// ---- The viewer's choice, kept per browser (lib/prefs "gtd-music-sort") ----------

export interface SortPrefs {
  mode: SortMode;
  hide: boolean;
}
export const DEFAULT_SORT: SortPrefs = { mode: "official", hide: false };

/** The stored choice, or the default for anything missing or broken. */
export function parseSortPrefs(raw: string | null): SortPrefs {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<SortPrefs> | null;
    const mode: SortMode = v?.mode === "relevance" || v?.mode === "views" ? v.mode : "official";
    return { mode, hide: v?.hide === true };
  } catch {
    return { ...DEFAULT_SORT };
  }
}

const UNIT: [RegExp, number][] = [
  [/^(mld|b|bn|md)$/i, 1e9],
  [/^(mln|m|mio)$/i, 1e6],
  [/^(k|mila|mil|k\.)$/i, 1e3],
];

/**
 * A view count from YouTube's text: the full "9.175.434.113 visualizzazioni" /
 * "1,234 views", or the short "2,1 Mld" / "25 Mln" / "1.2M" / "870K"
 * (approximate, enough to sort). undefined if there is none.
 */
export function parseViews(text: string): number | undefined {
  const s = (text ?? "").trim();
  const short = /^([\d]+(?:[.,]\d+)?)\s*([a-z.]+)\b/i.exec(s);
  if (short) {
    const unit = UNIT.find(([re]) => re.test(short[2]));
    if (unit) return Math.round(Number(short[1].replace(",", ".")) * unit[1]);
  }
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return /^(no|nessuna)\b/i.test(s) ? 0 : undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}
