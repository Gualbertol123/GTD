// -----------------------------------------------------------------------------
// YouTube.js (youtubei.js, https://ytjs.dev): reads YouTube the way its own
// website and YouTube Music app do — no API key and no daily quota.
//
// Used for FINDING music only: search, suggestions, "radio" (songs like this
// one), trends, playlists, an artist's popular songs. Playing stays with the
// official embedded player in the browser, which has no limit.
//
// Unofficial: YouTube may change its internals or challenge the server. Every
// caller therefore falls back to the official Data API (lib/youtube key) when
// this throws, and the app keeps working, just with the quota again.
// -----------------------------------------------------------------------------

import type { Innertube } from "youtubei.js";
import { BUDGET_MS, NotFoundError, TimeoutError, TtlCache, deadline, normKey } from "./http.mts";
import { classify, parseViews, type RawResult, type TrackKind, type TrackTag } from "../../src/lib/musicSort";
import { bestMatch, parseSpotify, queries, type MatchCandidate } from "./songMatch.mts";

export interface Song {
  id: string;
  title: string;
  channel: string;
  thumb: string;
}

let client: Promise<Innertube> | null = null;

/**
 * One client per warm function instance (creating it takes ~0.2 s). The
 * library (~1.3 MB) is loaded here, on first use, not when the function
 * starts: the login check runs meanwhile, and a refused request never loads it.
 */
function innertube(): Promise<Innertube> {
  if (!client) {
    const p: Promise<Innertube> = import("youtubei.js")
      .then(({ Innertube, Log }) => {
        // Its parser logs a lot of harmless notes: keep only real errors.
        try {
          Log.setLevel(Log.Level.ERROR);
        } catch {
          /* older/newer versions: fine either way */
        }
        return Innertube.create({ lang: "it", location: "IT", retrieve_player: false });
      })
      .catch((e) => {
        if (client === p) client = null;
        throw e;
      });
    client = p;
  }
  return client;
}

/**
 * Runs `fn` with the client, within `ms` (TimeoutError after). A real failure
 * drops the client so the next call starts fresh; "not found" and a timeout do
 * not, and neither does a late failure of a client already replaced.
 */
async function withClient<T>(fn: (yt: Innertube) => Promise<T>, ms = BUDGET_MS - 500): Promise<T> {
  const used = innertube();
  const run = used.then(fn).catch((e) => {
    if (!(e instanceof NotFoundError) && !(e instanceof TimeoutError) && client === used) client = null;
    throw e;
  });
  return deadline(run, ms);
}

/** Answers shared by every request of this warm instance (see TtlCache). */
const cache = new TtlCache(400);
const MIN = 60_000;

/** `fn` with the client, its answer kept for `ttl` ms under `key`. */
const cached = <T,>(key: string, ttl: number, fn: (yt: Innertube) => Promise<T>, ms?: number): Promise<T> => cache.get(key, ttl, () => withClient(fn, ms));

// ---- Turning YouTube's many item shapes into a Song ---------------------------

const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const s = (v as { toString?: () => string }).toString?.();
  return s && s !== "[object Object]" ? s : "";
};

const VIDEO_ID = /^[\w-]{11}$/;

/** A song from any of the node types YouTube.js returns, or null. */
function toSong(n: any): Song | null {
  if (!n) return null;
  // Video, CompactVideo, MusicResponsiveListItem, PlaylistPanelVideo, ...
  const id: string = n.video_id ?? n.id ?? n.content_id ?? n.endpoint?.payload?.videoId ?? "";
  if (!VIDEO_ID.test(id)) return null;
  // Only songs and videos: not artists, albums, playlists, podcasts.
  if (n.item_type && !["song", "video", "non_music_track"].includes(n.item_type)) return null;
  if (n.content_type && n.content_type !== "VIDEO") return null;
  const title = str(n.title) || str(n.metadata?.title) || str(n.name);
  if (!title) return null;
  const people: string =
    (n.artists ?? n.authors)?.map((a: any) => a?.name).filter(Boolean).join(", ") ||
    n.author?.name ||
    str(n.author) ||
    str(n.short_byline) ||
    str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text) ||
    // LockupView (YouTube's newer search layout, served to some requests): the channel is an avatar stack.
    str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.avatar_stack?.text) ||
    "";
  // YouTube's own 16:9 picture for the id: always there, same size everywhere.
  const thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  return { id, title, channel: people.replace(/\s+-\s+Topic$/, "").replace(/\s*·.*$/, ""), thumb };
}

function songs(nodes: any[] | undefined, max = 200): Song[] {
  const out: Song[] = [];
  const seen = new Set<string>();
  for (const n of nodes ?? []) {
    const s = toSong(n);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ---- What the functions ask for ------------------------------------------------

/** A search result: the song, what it is (official, live, cover…) and where YouTube put it. */
export interface SearchSong extends Song {
  kind: TrackKind;
  score: number;
  tag?: TrackTag;
  /** YouTube's own order (0 = first): "Pertinenza" in the app. */
  rank: number;
  views?: number;
}

/**
 * What YouTube says about a result's channel, before toSong tidies the name:
 * " - Topic" (YouTube's auto-generated official audio) and VEVO stay, and the
 * ♪ badge (BADGE_STYLE_TYPE_VERIFIED_ARTIST, "Canale ufficiale dell'artista").
 */
function rawOf(n: any, title: string): RawResult {
  const a = n.author ?? {};
  const badges: any[] = a.badges ?? [];
  return {
    title,
    channel:
      str(a.name) ||
      str(n.short_byline) ||
      (n.artists ?? n.authors)?.map((x: any) => x?.name).filter(Boolean).join(", ") ||
      // LockupView: no badges reach YouTube.js, only the name (classified like the Data API's results).
      str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.avatar_stack?.text) ||
      "",
    verifiedArtist: !!a.is_verified_artist || badges.some((b) => /VERIFIED_ARTIST/.test(String(b?.style))),
    verified: !!a.is_verified || badges.some((b) => /BADGE_STYLE_TYPE_VERIFIED$/.test(String(b?.style))),
  };
}

/** Each result classified (lib musicSort), in YouTube's order. */
function searchResults(nodes: any[] | undefined): SearchSong[] {
  const out: SearchSong[] = [];
  const seen = new Set<string>();
  for (const n of nodes ?? []) {
    const s = toSong(n);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    const c = classify(rawOf(n, s.title));
    // Video: "9.175.434.113 visualizzazioni"; LockupView: only the short "2,1 Mld" (next to the channel).
    const views = parseViews(str(n.view_count) || str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[1]?.text));
    out.push({ ...s, kind: c.kind, score: c.score, ...(c.tag ? { tag: c.tag } : {}), rank: out.length, ...(views !== undefined ? { views } : {}) });
  }
  return out;
}

/**
 * Songs for some words: the first page of YouTube's own search (~20, enough
 * for the list). A second page costs another full round trip (~0.5 s), so it
 * is asked for only when the first one is unusually short. Every result says
 * what it is (official video / audio, live, cover…) and its place in
 * YouTube's order: the app sorts them (official first) without asking again.
 */
export function searchSongs(q: string, ms?: number): Promise<SearchSong[]> {
  const run = async (yt: Innertube) => {
    const first = await yt.search(q, { type: "video" });
    let found = searchResults(first.videos as any[]);
    if (found.length < 12 && first.has_continuation) {
      const more = await first.getContinuation().catch(() => null);
      if (more) found = searchResults([...(first.videos as any[]), ...(more.videos as any[])]);
    }
    return found;
  };
  return cached(`search:${normKey(q)}`, 10 * MIN, run, ms);
}

/** What YouTube Music suggests while typing. */
export function suggest(q: string): Promise<string[]> {
  return cached(`suggest:${normKey(q)}`, 60 * MIN, async (yt) => {
    const sections = await yt.music.getSearchSuggestions(q);
    const out: string[] = [];
    for (const sec of sections as any[])
      for (const c of sec.contents ?? []) {
        const s = str(c.suggestion);
        if (s && !out.includes(s)) out.push(s);
      }
    return out.slice(0, 8);
  });
}

/**
 * A short radio (~24-27 songs) is YouTube's generic fallback, with little to
 * do with the song: mix in more by the same artist (two of theirs, then one
 * of the list), seed first.
 */
async function mixArtist(yt: Innertube, list: Song[], max: number): Promise<Song[]> {
  if (list.length >= 40 || !list[0]) return list;
  const artist = list[0].channel.replace(/VEVO$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!artist) return list;
  const same = (await yt.search(artist, { type: "video" }).then((r) => songs(r.videos as any[])).catch(() => [] as Song[]))
    .filter((x) => !list.some((y) => y.id === x.id));
  const mixed: Song[] = [list[0]];
  const rest = list.slice(1);
  while (same.length || rest.length) {
    if (same.length) mixed.push(same.shift()!);
    if (same.length) mixed.push(same.shift()!);
    if (rest.length) mixed.push(rest.shift()!);
  }
  return mixed.slice(0, max);
}

/** "Radio": the song, then ~50 songs like it (YouTube Music's automix). */
export function radio(videoId: string): Promise<Song[]> {
  return cached(`radio:${videoId}`, 10 * MIN, async (yt) => {
    const panel = await yt.music.getUpNext(videoId, true);
    return mixArtist(yt, songs(panel.contents as any[]), 50);
  });
}

/**
 * The longest radio YouTube gives for a song (a saved "radio playlist"):
 * YouTube Music's up-next mix "RDAMVM<id>", following its continuations.
 *
 * Measured from a server (Nov 2026): the first page has ~50 songs; each
 * continuation page repeats most of them and adds 1-10 new ones, and after
 * 4-15 pages it only repeats. A real radio ends at ~60-100 distinct songs
 * (61-66, 71, 96 on the songs tried). The watch-next mix "RD<id>" gives the
 * same or fewer (64, 70, 82). Neither ever reached 200, which stays the cap.
 *
 * Stops when there is no continuation, after 3 pages that add nothing, at
 * RADIO_MAX songs, or at `until` (a Date.now() value): whatever was found by
 * then is returned. The seed is always first; no song twice. A complete
 * answer is kept 6 hours, one cut short by time only 10 minutes.
 */
export const RADIO_MAX = 200;
const FULL_TTL = 6 * 60 * MIN;
const fullKept = new Map<string, { until: number; p: Promise<Song[]> }>();

export function radioFull(videoId: string, until = Date.now() + BUDGET_MS - 1500): Promise<Song[]> {
  const hit = fullKept.get(videoId);
  if (hit && hit.until > Date.now()) return hit.p;
  if (fullKept.size > 200) for (const [k, e] of fullKept) if (e.until <= Date.now()) fullKept.delete(k);
  let ttl = FULL_TTL;
  const run = async (yt: Innertube): Promise<Song[]> => {
    const list = `RDAMVM${videoId}`;
    const out: Song[] = [];
    const seen = new Set<string>();
    const take = (nodes: any[] | undefined) => {
      let added = 0;
      for (const n of nodes ?? []) {
        const s = toSong(n?.primary ?? n); // PlaylistPanelVideoWrapper → its video
        if (s && !seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
          added++;
          if (out.length >= RADIO_MAX) break;
        }
      }
      return added;
    };
    const first: any = await yt.actions.execute("/next", { client: "YTMUSIC", videoId, playlistId: list, parse: true });
    const { PlaylistPanel } = (await import("youtubei.js")).YTNodes;
    const panel: any = first.contents_memo?.getType(PlaylistPanel)?.[0];
    if (!panel) throw new NotFoundError("no radio");
    take(panel.contents);
    let token: string | null = panel.continuation ?? null;
    let idle = 0;
    while (token && idle < 3 && out.length < RADIO_MAX) {
      if (Date.now() > until - 600) {
        ttl = 10 * MIN; // cut short: ask again sooner
        break;
      }
      const page: any = await yt.actions.execute("/next", { client: "YTMUSIC", playlistId: list, continuation: token, parse: true });
      const c = page.continuation_contents;
      idle = take(c?.contents) ? 0 : idle + 1;
      token = c?.continuation ?? null;
    }
    // The seed first, even when YouTube put it elsewhere or left it out.
    const at = out.findIndex((s) => s.id === videoId);
    if (at > 0) out.unshift(...out.splice(at, 1));
    if (!out.length) throw new NotFoundError("no radio");
    return Date.now() < until - 1500 ? mixArtist(yt, out, 50) : out;
  };
  const p = withClient(run, Math.max(1, until - Date.now()));
  const entry = { until: Date.now() + FULL_TTL, p };
  fullKept.set(videoId, entry);
  p.then(
    () => {
      entry.until = Date.now() + ttl;
    },
    () => {
      if (fullKept.get(videoId) === entry) fullKept.delete(videoId);
    }
  );
  return p;
}

/** YouTube Music's Explore page: its sections of songs (trends, new videos…). */
export function explore(): Promise<{ title: string; tracks: Song[] }[]> {
  return cached("explore", 30 * MIN, async (yt) => {
    const page = await yt.music.getExplore();
    const out: { title: string; tracks: Song[] }[] = [];
    for (const sec of (page.sections ?? []) as any[]) {
      const tracks = songs(sec.contents, 50);
      if (tracks.length >= 4) out.push({ title: str(sec.header?.title) || str(sec.title), tracks });
    }
    return out;
  });
}

/** A playlist (YouTube or YouTube Music), up to `max` songs. */
export function playlist(list: string, max = 200, ms?: number): Promise<{ list: string; title: string; channel: string; thumb: string; total: number; tracks: Song[] }> {
  return cached(`playlist:${list}:${max}`, 10 * MIN, async (yt) => {
    let page: any = await yt.music.getPlaylist(list);
    const header = page.header;
    const nodes: any[] = [...(page.items ?? [])];
    let guard = 0;
    while (page.has_continuation && nodes.length < max && guard++ < 6) {
      page = await page.getContinuation();
      nodes.push(...(page.items ?? page.contents ?? []));
    }
    const tracks = songs(nodes, max);
    if (!tracks.length) throw new NotFoundError();
    return {
      list,
      title: str(header?.title) || "Playlist",
      channel: (header?.author?.name ?? "").replace(/\s*•.*$/, ""),
      thumb: tracks[0] ? `https://i.ytimg.com/vi/${tracks[0].id}/hqdefault.jpg` : "",
      total: Math.max(tracks.length, Number(str(header?.song_count).replace(/\D/g, "")) || 0),
      tracks,
    };
  }, ms);
}

/** Playlists on YouTube for some words. */
export function findPlaylists(q: string, ms?: number): Promise<{ list: string; title: string; channel: string; thumb: string }[]> {
  return cached(`playlists:${normKey(q)}`, 60 * MIN, async (yt) => {
    const r = await yt.search(q, { type: "playlist" });
    const out: { list: string; title: string; channel: string; thumb: string }[] = [];
    for (const n of r.results as any[]) {
      const list: string = n.content_id ?? n.id ?? n.playlist_id ?? "";
      if (!/^(PL|OL|UU|VL)[\w-]{10,}$/.test(list)) continue;
      out.push({
        list: list.replace(/^VL/, ""),
        title: str(n.metadata?.title) || str(n.title),
        channel: str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text) || n.author?.name || "",
        thumb: n.content_image?.primary_thumbnail?.image?.[0]?.url ?? n.thumbnails?.[0]?.url ?? "",
      });
      if (out.length >= 24) break;
    }
    return out;
  }, ms);
}

/**
 * An artist's most popular songs. YouTube keeps every channel's uploads in
 * popularity order as a playlist ("UULP" + the channel id without "UC"): one
 * call, ~0.3 s, up to 100 songs. The channel's "Popular" tab (4-6 calls, and
 * lately often just 1-2 songs) is only the backup.
 */
export function artistTop(channelId: string, ms?: number): Promise<Song[]> {
  const run = async (yt: Innertube) => {
    const nodes: any[] = [];
    try {
      let page: any = await yt.getPlaylist(`UULP${channelId.slice(2)}`);
      nodes.push(...(page.videos ?? []));
      let guard = 0;
      while (songs(nodes).length < 30 && page.has_continuation && guard++ < 2) {
        page = await page.getContinuation();
        nodes.push(...(page.videos ?? []));
      }
    } catch {
      /* no such list for this channel: the tab below */
    }
    if (songs(nodes).length >= 10) return songs(nodes, 50);
    const ch = await yt.getChannel(channelId);
    let videos: any = await ch.getVideos();
    const popular = (videos.filters as string[] | undefined)?.find((f) => /popolar|popular/i.test(f));
    if (popular) videos = await videos.applyFilter(popular);
    nodes.push(...(videos.videos ?? []));
    let guard = 0;
    while (songs(nodes).length < 30 && videos.has_continuation && guard++ < 3) {
      videos = await videos.getContinuation();
      nodes.push(...(videos.videos ?? []));
    }
    return songs(nodes, 50);
  };
  return cached(`top:${channelId}`, 30 * MIN, run, ms);
}

export interface ChartList {
  list: string;
  title: string;
  thumb: string;
}
export interface ChartArtist {
  id: string;
  name: string;
  thumb: string;
}

const thumbUrl = (t: any): string => (Array.isArray(t) ? t[0]?.url : t?.contents?.[0]?.url) ?? "";

/**
 * YouTube Music's charts for a country (IT, US, ... or ZZ = the world): the
 * chart playlists (trending, most watched today, top 100 ...) and the most
 * listened artists.
 */
export function charts(country: string): Promise<{ lists: ChartList[]; artists: ChartArtist[] }> {
  return cached(`charts:${country}`, 60 * MIN, async (yt) => {
    const r: any = await yt.actions.execute("/browse", {
      browseId: "FEmusic_charts",
      client: "YTMUSIC",
      formData: { selectedValues: [country] },
      parse: true,
    });
    const lists: ChartList[] = [];
    const artists: ChartArtist[] = [];
    for (const shelf of r.contents_memo?.get("MusicCarouselShelf") ?? []) {
      for (const n of shelf.contents ?? []) {
        const id: string = n.id ?? n.endpoint?.payload?.browseId ?? "";
        if (n.item_type === "playlist" && id) {
          lists.push({ list: id.replace(/^VL/, ""), title: str(n.title), thumb: thumbUrl(n.thumbnail) });
        } else if (n.item_type === "artist" && /^UC[\w-]{22}$/.test(id)) {
          artists.push({ id, name: n.name || str(n.title) || str(n.flex_columns?.[0]?.title), thumb: thumbUrl(n.thumbnail) });
        }
      }
    }
    if (!lists.length && !artists.length) throw new NotFoundError("no charts");
    return { lists, artists: artists.slice(0, 20) };
  });
}

/** Any YouTube Music artist: name, picture and their songs / videos. */
export function musicArtist(id: string): Promise<{ name: string; thumb: string; tracks: Song[] }> {
  return cached(`artist:${id}`, 30 * MIN, async (yt) => {
    const a: any = await yt.music.getArtist(id);
    const nodes: any[] = [];
    for (const s of a.sections ?? []) if (s.type === "MusicShelf" || /video|brani|songs/i.test(str(s.header?.title))) nodes.push(...(s.contents ?? []));
    return {
      name: str(a.header?.title),
      thumb: thumbUrl(a.header?.thumbnail),
      tracks: songs(nodes, 50),
    };
  });
}

// ---- Matching a song from elsewhere (Spotify import) ----------------------------
//
// The scoring is in lib/songMatch.mts (pure, unit-tested); this part asks YouTube.

/** A matched song: how sure the match is (0–1), and its length when known. */
export interface MatchedSong extends Song {
  confidence: number;
  ms?: number;
}

/**
 * YouTube Music's song search finds the official "Topic" audio, the same
 * recording as Spotify's (title, artists, length to the second). From some
 * networks it answers "no results" to everything (the music catalogue is
 * hidden there; seen from a cloud server in Nov 2026): after NO_MUSIC_AFTER
 * such answers in a row it is skipped for a while, then tried again.
 */
const NO_MUSIC_AFTER = 4;
const NO_MUSIC_FOR = 30 * MIN;
const musicState = { works: false, emptyRun: 0, skipUntil: 0 };

const secondsOf = (d: any): number => (typeof d?.seconds === "number" && d.seconds > 0 ? d.seconds * 1000 : parseLength(str(d?.text ?? d)));

function parseLength(text: string): number {
  if (!/^\d{1,3}(?:[:.]\d{2}){1,2}$/.test(text.trim())) return 0;
  return text.trim().split(/[:.]/).map(Number).reduce((a, b) => a * 60 + b, 0) * 1000;
}

/** The candidates of a video search (Video and LockupView nodes). */
export function videoCandidates(nodes: any[] | undefined): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const n of nodes ?? []) {
    const s = toSong(n);
    if (!s || out.some((c) => c.id === s.id)) continue;
    const raw = rawOf(n, s.title);
    let ms = 0;
    try {
      ms = secondsOf(n.duration) || parseLength(str(n.length_text));
    } catch {
      /* LockupView without a length badge */
    }
    // LockupView: the channel is the first metadata part (" - Topic" kept, unlike Song.channel).
    const channel = raw.channel || str(n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text) || s.channel;
    out.push({ id: s.id, title: s.title, channel, ms, verifiedArtist: raw.verifiedArtist, verified: raw.verified, source: "video", rank: out.length });
    if (out.length >= 12) break;
  }
  return out;
}

/** The candidates of a YouTube Music song search (MusicResponsiveListItem nodes, item_type "song"). */
export function musicCandidates(contents: any[] | undefined): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  const items: any[] = [];
  for (const sec of contents ?? []) items.push(...(sec?.contents ?? (sec?.item_type ? [sec] : [])));
  for (const n of items) {
    if (n?.item_type !== "song" && n?.item_type !== "video") continue;
    const id: string = n.id ?? n.video_id ?? "";
    if (!VIDEO_ID.test(id) || out.some((c) => c.id === id)) continue;
    const title = str(n.title);
    if (!title) continue;
    const artists: string[] = (n.artists ?? n.authors ?? []).map((a: any) => str(a?.name)).filter(Boolean);
    const by = artists.join(", ") || str(n.author?.name);
    out.push({
      id,
      title,
      // A song is the official audio ("Artist - Topic" on YouTube); a video keeps its channel.
      channel: n.item_type === "song" ? `${by} - Topic` : by,
      artists,
      ms: secondsOf(n.duration),
      source: n.item_type === "song" ? "music" : "video",
      rank: out.length,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** One query's candidates, kept 10 minutes (a retry of a song cut short goes on from there). */
function searchVideos(yt: Innertube, q: string): Promise<MatchCandidate[]> {
  return cache.get(`mv:${normKey(q)}`, 10 * MIN, async () => videoCandidates((await yt.search(q, { type: "video" })).videos as any[]));
}

/** YouTube Music's songs for a query, or [] (and nothing asked) while it is known to answer nothing. */
function searchMusic(yt: Innertube, q: string): Promise<MatchCandidate[]> {
  if (Date.now() < musicState.skipUntil) return Promise.resolve([]);
  return cache.get(`mm:${normKey(q)}`, 10 * MIN, async () => {
    const r: any = await yt.music.search(q, { type: "song" });
    const found = musicCandidates(r.contents as any[]);
    if (found.length) {
      musicState.works = true;
      musicState.emptyRun = 0;
    } else if (++musicState.emptyRun >= NO_MUSIC_AFTER) {
      musicState.works = false;
      musicState.emptyRun = 0;
      musicState.skipUntil = Date.now() + NO_MUSIC_FOR;
    }
    return found;
  });
}

/** Time a search needs (YouTube answers in ~0.3–0.8 s): no new one is started with less left. */
const SEARCH_MS = 1500;

/**
 * The YouTube video for a song known by title + artist (+ length in ms), or
 * null when YouTube has nothing good enough (a wrong song is worse than "not
 * found"). Tries, until a sure match (lib/songMatch):
 *   1. "artist title" on YouTube Music's songs (the official audio, the same
 *      recording as Spotify's) and on YouTube's videos, at the same time while
 *      it is not known whether the song search answers here;
 *   2. "title artists" and 3. "title" alone, videos only, the artist still checked.
 * Stops starting searches at `until` (a Date.now() value) minus the time one
 * takes: with nothing acceptable by then it throws TimeoutError (the song
 * goes in `failed`, worth asking again; the searches done are kept).
 */
export function matchSong(title: string, artist: string, ms = 0, until = Date.now() + BUDGET_MS - 1000): Promise<MatchedSong | null> {
  return cached(`match:${normKey(title)}|${normKey(artist)}|${Math.round(ms / 1000)}`, 60 * MIN, async (yt) => {
    const song = parseSpotify(title, artist, ms);
    const [q0, ...more] = queries(song);
    const music = () => searchMusic(yt, q0).catch(() => [] as MatchCandidate[]);
    // Each step is one or two searches; the next starts only when the best so far is not sure.
    const steps: (() => Promise<MatchCandidate[]>)[] =
      Date.now() < musicState.skipUntil
        ? [() => searchVideos(yt, q0)]
        : musicState.works
          ? [music, () => searchVideos(yt, q0)] // known to work: the official audio first
          : [async () => (await Promise.all([music(), searchVideos(yt, q0)])).flat()];
    for (const q of more) steps.push(() => searchVideos(yt, q));

    const pool: MatchCandidate[] = [];
    let best: ReturnType<typeof bestMatch> = null;
    let cut = false;
    let failure: unknown = null;
    for (const [i, step] of steps.entries()) {
      if (i > 0 && Date.now() > until - SEARCH_MS) {
        cut = true;
        break;
      }
      try {
        for (const c of await step()) if (!pool.some((p) => p.id === c.id && p.source === c.source)) pool.push(c);
      } catch (e) {
        // YouTube refused or failed (403, network): keep what the earlier searches found.
        failure = e;
        break;
      }
      best = bestMatch(song, pool);
      if (best?.r.sure) break;
    }
    if (!best) {
      if (failure) throw failure;
      if (cut) throw new TimeoutError();
      return null;
    }
    const { c, r } = best;
    return {
      id: c.id,
      title: c.title,
      channel: c.channel.replace(/\s+-\s+Topic$/, "").replace(/\s*·.*$/, ""),
      thumb: `https://i.ytimg.com/vi/${c.id}/mqdefault.jpg`,
      confidence: r.confidence,
      ...(c.ms ? { ms: c.ms } : {}),
    };
  }, Math.max(1, until - Date.now()));
}
