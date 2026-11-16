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

import { Innertube, Log } from "youtubei.js";

export interface Song {
  id: string;
  title: string;
  channel: string;
  thumb: string;
}

// Its parser logs a lot of harmless notes: keep only real errors.
try {
  Log.setLevel(Log.Level.ERROR);
} catch {
  /* older/newer versions: fine either way */
}

let client: Promise<Innertube> | null = null;

/** One client per warm function instance (creating it takes ~0.2 s). */
function innertube(): Promise<Innertube> {
  if (!client) {
    client = Innertube.create({ lang: "it", location: "IT", retrieve_player: false }).catch((e) => {
      client = null;
      throw e;
    });
  }
  return client;
}

/** Runs `fn` with the client; a failure drops the client so the next call starts fresh. */
async function withClient<T>(fn: (yt: Innertube) => Promise<T>): Promise<T> {
  const yt = await innertube();
  try {
    return await fn(yt);
  } catch (e) {
    client = null;
    throw e;
  }
}

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

/** Songs for some words (two pages of YouTube's own search: ~40). */
export function searchSongs(q: string): Promise<Song[]> {
  return withClient(async (yt) => {
    const first = await yt.search(q, { type: "video" });
    let found = songs(first.videos as any[]);
    if (found.length < 30 && first.has_continuation) {
      const more = await first.getContinuation().catch(() => null);
      if (more) found = songs([...(first.videos as any[]), ...(more.videos as any[])]);
    }
    return found;
  });
}

/** What YouTube Music suggests while typing. */
export function suggest(q: string): Promise<string[]> {
  return withClient(async (yt) => {
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

/** "Radio": the song, then ~50 songs like it (YouTube Music's automix). */
export function radio(videoId: string): Promise<Song[]> {
  return withClient(async (yt) => {
    const panel = await yt.music.getUpNext(videoId, true);
    const list = songs(panel.contents as any[]);
    // A real radio has ~50 songs. A short one (~24) is YouTube's generic
    // fallback with little to do with the song: mix in more by the same artist.
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
    return mixed.slice(0, 50);
  });
}

/** YouTube Music's Explore page: its sections of songs (trends, new videos…). */
export function explore(): Promise<{ title: string; tracks: Song[] }[]> {
  return withClient(async (yt) => {
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
export function playlist(list: string, max = 200): Promise<{ list: string; title: string; channel: string; thumb: string; total: number; tracks: Song[] }> {
  return withClient(async (yt) => {
    let page: any = await yt.music.getPlaylist(list);
    const header = page.header;
    const nodes: any[] = [...(page.items ?? [])];
    let guard = 0;
    while (page.has_continuation && nodes.length < max && guard++ < 6) {
      page = await page.getContinuation();
      nodes.push(...(page.items ?? page.contents ?? []));
    }
    const tracks = songs(nodes, max);
    if (!tracks.length) throw new Error("not-found");
    return {
      list,
      title: str(header?.title) || "Playlist",
      channel: (header?.author?.name ?? "").replace(/\s*•.*$/, ""),
      thumb: tracks[0] ? `https://i.ytimg.com/vi/${tracks[0].id}/hqdefault.jpg` : "",
      total: Math.max(tracks.length, Number(str(header?.song_count).replace(/\D/g, "")) || 0),
      tracks,
    };
  });
}

/** Playlists on YouTube for some words. */
export function findPlaylists(q: string): Promise<{ list: string; title: string; channel: string; thumb: string }[]> {
  return withClient(async (yt) => {
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
  });
}

/** An artist's most popular songs, from their channel's "Popular" order. */
export function artistTop(channelId: string): Promise<Song[]> {
  return withClient(async (yt) => {
    const ch = await yt.getChannel(channelId);
    let videos: any = await ch.getVideos();
    const popular = (videos.filters as string[] | undefined)?.find((f) => /popolar|popular/i.test(f));
    if (popular) videos = await videos.applyFilter(popular);
    let found = songs(videos.videos);
    let guard = 0;
    while (found.length < 30 && videos.has_continuation && guard++ < 3) {
      videos = await videos.getContinuation();
      found = songs([...found.map((s) => ({ id: s.id, title: s.title, author: { name: s.channel } })), ...(videos.videos ?? [])]);
    }
    return found;
  });
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
  return withClient(async (yt) => {
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
    if (!lists.length && !artists.length) throw new Error("no charts");
    return { lists, artists: artists.slice(0, 20) };
  });
}

/** Any YouTube Music artist: name, picture and their songs / videos. */
export function musicArtist(id: string): Promise<{ name: string; thumb: string; tracks: Song[] }> {
  return withClient(async (yt) => {
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

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !["feat", "ft", "the", "official", "video", "audio", "lyrics", "testo", "remastered", "remaster"].includes(w)));

function parseLength(text: string): number {
  const p = text.split(":").map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0) * 1000;
}

/**
 * The YouTube video for a song known by title + artist (+ length): searches
 * "artist title", scores the first results on title words, artist and length,
 * and prefers official uploads over covers, karaoke, live and lyric versions.
 */
export function matchSong(title: string, artist: string, ms = 0): Promise<Song | null> {
  return withClient(async (yt) => {
    const first = artist.split(",")[0].trim();
    const r = await yt.search(`${first} ${title}`, { type: "video" });
    const tw = words(title);
    const aw = words(first);
    let best: { s: Song; score: number } | null = null;
    for (const v of (r.videos as any[]).slice(0, 8)) {
      const s = toSong(v);
      if (!s) continue;
      const hay = words(`${s.title} ${s.channel}`);
      const titleHit = [...tw].filter((w) => hay.has(w)).length / Math.max(1, tw.size);
      const artistHit = [...aw].filter((w) => hay.has(w)).length / Math.max(1, aw.size);
      let score = titleHit * 3 + artistHit * 2;
      const len = parseLength(str(v.length_text ?? v.duration?.text ?? ""));
      // Music videos often run longer than the track (intro, outro): only
      // a big difference counts, and never by much.
      if (ms && len) score -= Math.min(1.2, Math.max(0, Math.abs(len - ms) - 45000) / 60000);
      const t = norm(s.title + " " + s.channel);
      if (/\b(cover|karaoke|instrumental|8d|slowed|reverb|nightcore|tutorial|reaction)\b/.test(t) && !/\b(cover|karaoke|instrumental)\b/.test(norm(title))) score -= 2;
      if (/\blive\b/.test(t) && !/\blive\b/.test(norm(title))) score -= 0.7;
      // An official video beats a fan-made lyric video of the same song.
      if (/\b(lyrics?|testo|letra|paroles)\b/.test(t)) score -= 0.5;
      if (/vevo|- topic/i.test(`${s.channel} ${str(v.author?.name)}`)) score += 0.6;
      if (/\bofficial\b|ufficiale|oficial/i.test(s.title)) score += 0.6;
      if ((v.author?.badges ?? []).some((b: any) => /ARTIST/.test(String(b?.style)))) score += 0.8;
      if (!best || score > best.score) best = { s, score };
    }
    return best && best.score >= 2.5 ? best.s : null;
  });
}
