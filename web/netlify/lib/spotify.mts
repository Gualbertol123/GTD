// -----------------------------------------------------------------------------
// Reading a public Spotify playlist, album or single songs, for "Importa da
// Spotify". Only titles, artists and lengths are read; the music itself is then
// found on YouTube (lib/ytjs.mts matchSong) and plays in YouTube's player.
//
// Two sources, in this order:
//
// 1. The official Spotify Web API, when the site has its own free app keys
//    (env SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET on Netlify, Client
//    Credentials flow; README §1e). All of a playlist, up to MAX_SONGS songs.
//    The keys are read from process.env here only, never logged or returned.
//    Since late 2024 Spotify refuses (404 / 403) new apps the playlists made
//    by Spotify itself (editorial / algorithmic, ids often "37i9dQZF1…"):
//    those fall back to 2. Since February 2026, an app in Development Mode
//    gets a playlist's songs only for playlists the signed-in user owns or
//    collaborates on: with Client Credentials (no user) only the details come
//    back (name, cover, no `items`), so the songs come from 2 (reason
//    "owner-only"), keeping the API's name and cover. Both answer shapes are
//    read: the new one (`items` / `items.items[].item`, GET …/items) and the
//    old one (`tracks` / `tracks.items[].track`, GET …/tracks), which apps in
//    Extended Quota Mode still get.
// 2. Spotify's public embed page (open.spotify.com/embed/…, the player
//    websites put on their pages), read as a plain page. No key needed. It
//    lists a playlist's FIRST 100 songs (an album's all). The answer then says
//    `limited` and why (`reason`), and the app explains how to get the rest:
//    copy the songs in the Spotify app and paste them (readSpotifyTrack: each
//    song's own public embed page). Unofficial: if Spotify changes that page,
//    this stops working and the app says so.
//
// Nothing scraped from those pages (they also carry an anonymous web-player
// token) is ever used to call Spotify's APIs: only the site's own keys are.
// -----------------------------------------------------------------------------

import { BUDGET_MS, NotFoundError, TimeoutError, TtlCache } from "./http.mts";

/** Spotify's page must answer within this, or the import says "timeout". */
const READ_MS = 6000;
/** The Web API part must be done within this (then the embed page still fits in the budget). */
const API_MS = 5000;
/** Songs taken from one playlist / album at most. */
export const MAX_SONGS = 1000;
/** API pages asked at once. */
const PAGES_AT_ONCE = 4;

let lists = new TtlCache(50);
let songsById = new TtlCache(3000);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export interface SpotifySong {
  title: string;
  artist: string;
  /** Length in ms (helps pick the right YouTube video). */
  ms: number;
}

/**
 * Why the list may be short: no keys, a playlist made by Spotify, the API
 * failed, or the API gave only the playlist's details (since February 2026 a
 * Development Mode app reads the songs only of the user's own playlists).
 */
export type LimitReason = "no-key" | "spotify-owned" | "api-error" | "owner-only";

export interface SpotifyList {
  kind: "playlist" | "album";
  id: string;
  name: string;
  owner: string;
  cover: string;
  songs: SpotifySong[];
  /** Where the songs came from. */
  via: "api" | "embed";
  /** The playlist's / album's real number of songs (API only). */
  total?: number;
  /** More than MAX_SONGS: only the first MAX_SONGS were taken. */
  truncated?: boolean;
  /** The embed page was used for a playlist of 100+ songs: there may be more. */
  limited?: boolean;
  /** Why the embed page was used (set whenever via is "embed"). */
  reason?: LimitReason;
}

/** "https://open.spotify.com/intl-it/playlist/ID?si=…", "spotify:playlist:ID", … → kind + id. */
export function parseSpotify(input: string): { kind: "playlist" | "album"; id: string } | null {
  const s = input.trim();
  const m =
    s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/) ??
    s.match(/^spotify:(playlist|album):([A-Za-z0-9]{22})$/);
  return m ? { kind: m[1] as "playlist" | "album", id: m[2] } : null;
}

export const isTrackId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9]{22}$/.test(s);

/** Tests: forget the cached lists, songs and token. */
export function forgetSpotify(): void {
  lists = new TtlCache(50);
  songsById = new TtlCache(3000);
  token = null;
}

/**
 * The list, kept 10 minutes per instance (opening it twice asks Spotify once).
 * `start`: when the request began (the budget is counted from it). Throws
 * NotFoundError, a TimeoutError, or another Error.
 */
export function readSpotify(kind: "playlist" | "album", id: string, start = Date.now()): Promise<SpotifyList> {
  return lists.get(`${kind}:${id}`, 10 * 60_000, () => readBest(kind, id, start));
}

async function readBest(kind: "playlist" | "album", id: string, start: number): Promise<SpotifyList> {
  const keys = credentials();
  let reason: LimitReason = "no-key";
  let meta: SpotifyList | null = null;
  if (keys) {
    try {
      return await readApi(kind, id, keys, start + API_MS);
    } catch (e) {
      if (e instanceof MetaOnly) {
        meta = e.list;
        reason = kind === "playlist" ? "owner-only" : "api-error";
      } else reason = kind === "playlist" && e instanceof ApiError && (e.status === 404 || e.status === 403) ? "spotify-owned" : "api-error";
      console.warn("spotify api:", e instanceof ApiError ? `${e.status}` : e instanceof Error ? e.message : e, "→ embed page");
    }
  }
  const ms = Math.min(READ_MS, BUDGET_MS - 1000 - (Date.now() - start));
  let list: SpotifyList;
  try {
    if (ms <= 0) throw new TimeoutError();
    list = await readEmbed(kind, id, ms);
  } catch (e) {
    // A list the API says is empty: it is (never an error for it).
    if (meta && meta.total === 0) return meta;
    throw e;
  }
  if (meta) {
    // The API's details, the embed page's songs (never "0 songs" when it has some).
    if (!list.songs.length) return meta;
    const more = kind === "playlist" && (list.songs.length >= 100 || (!!meta.total && meta.total > list.songs.length));
    return {
      ...list,
      name: meta.name || list.name,
      owner: meta.owner || list.owner,
      cover: meta.cover || list.cover,
      ...(meta.total ? { total: meta.total } : {}),
      reason,
      ...(more ? { limited: true } : {}),
    };
  }
  return { ...list, reason, ...(kind === "playlist" && list.songs.length >= 100 ? { limited: true } : {}) };
}

// ---- 1. The official Web API (the site's own keys) -----------------------------

class ApiError extends Error {
  constructor(public status: number) {
    super(`spotify api ${status}`);
    this.name = "ApiError";
  }
}

/** The API gave the list's details but none of its songs: `list` has them (songs empty). */
class MetaOnly extends Error {
  constructor(public list: SpotifyList) {
    super("spotify api: details only");
    this.name = "MetaOnly";
  }
}

function credentials(): { id: string; secret: string } | null {
  const id = process.env.SPOTIFY_CLIENT_ID?.trim();
  const secret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

/** The app token, kept until ~60 s before it expires (one per instance). */
let token: { key: string; value: Promise<string>; until: number } | null = null;

function appToken(keys: { id: string; secret: string }, until: number): Promise<string> {
  if (token && token.key === keys.id && token.until > Date.now()) return token.value;
  const entry: { key: string; value: Promise<string>; until: number } = { key: keys.id, until: Number.POSITIVE_INFINITY, value: Promise.resolve("") };
  entry.value = (async () => {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
      headers: {
        Authorization: `Basic ${Buffer.from(`${keys.id}:${keys.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new ApiError(res.status);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new ApiError(500);
    // Kept until ~60 s before it expires (until then: shared while on its way).
    entry.until = Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 60) * 1000;
    return j.access_token;
  })();
  token = entry;
  entry.value.catch(() => {
    if (token === entry) token = null;
  });
  return entry.value;
}

async function api<T>(path: string, keys: { id: string; secret: string }, until: number): Promise<T> {
  if (until - Date.now() <= 0) throw new TimeoutError();
  const tok = await appToken(keys, until);
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (res.status === 401 && token) token = null; // expired early: the next call asks again
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

/** `fn` on every item, at most `n` at once; results in the items' order. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

interface ApiTrack {
  name?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
  type?: string;
}
interface ApiImage {
  url?: string;
  width?: number | null;
}
/** One playlist entry: `item` since February 2026, `track` before (and in Extended Quota Mode). */
export interface ApiEntry {
  is_local?: boolean;
  item?: ApiTrack | null;
  track?: ApiTrack | null;
}

function songOf(t: ApiTrack | null | undefined): SpotifySong | null {
  if (!t?.name || (t.type && t.type !== "track")) return null; // episodes, empty slots
  return { title: t.name, artist: (t.artists ?? []).map((a) => a?.name).filter(Boolean).join(", "), ms: Number(t.duration_ms) || 0 };
}

/** The songs of a page of playlist entries, either shape; local files, episodes and empty slots skipped. */
export function songsOfEntries(entries: (ApiEntry | null | undefined)[]): SpotifySong[] {
  return entries
    .filter((e) => !!e && !e.is_local)
    .map((e) => songOf(e?.item ?? e?.track))
    .filter((s): s is SpotifySong => !!s);
}

/** A playlist's number of songs, either shape (`items.total` / `tracks.total`); undefined when absent. */
export function totalOf(meta: { items?: { total?: unknown } | null; tracks?: { total?: unknown } | null }): number | undefined {
  const t = meta.items?.total ?? meta.tracks?.total;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : undefined;
}

const bestImage = (images: ApiImage[] | undefined) => [...(images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";

/** The offsets of every page needed for `total` songs (capped at MAX_SONGS). */
export const pageOffsets = (total: number, size: number) => {
  const out: number[] = [];
  for (let o = 0; o < Math.min(total, MAX_SONGS); o += size) out.push(o);
  return out;
};

const META_FIELDS = "name,owner(display_name),images,items(total),tracks(total)";
const ENTRY_FIELDS = "name,duration_ms,artists(name),type";
const PAGE_FIELDS = `total,items(is_local,item(${ENTRY_FIELDS}),track(${ENTRY_FIELDS}))`;

/** GET with a `fields` filter; if Spotify refuses the filter (400), once more without it. */
async function apiFields<T>(path: string, fields: string, keys: { id: string; secret: string }, until: number): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  try {
    return await api<T>(`${path}${sep}fields=${encodeURIComponent(fields)}`, keys, until);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) return api<T>(path, keys, until);
    throw e;
  }
}

async function readApi(kind: "playlist" | "album", id: string, keys: { id: string; secret: string }, until: number): Promise<SpotifyList> {
  if (kind === "playlist") {
    const meta = await apiFields<{
      name?: string;
      owner?: { display_name?: string };
      images?: ApiImage[];
      items?: { total?: number } | null;
      tracks?: { total?: number } | null;
    }>(`/playlists/${id}`, META_FIELDS, keys, until);
    const total = totalOf(meta);
    const base: SpotifyList = {
      kind,
      id,
      name: String(meta.name ?? "Spotify"),
      owner: String(meta.owner?.display_name ?? ""),
      cover: bestImage(meta.images),
      songs: [],
      via: "api",
      ...(total !== undefined ? { total } : {}),
    };
    // Details only (no `items`, no total): a Development Mode app reading a
    // playlist its user does not own. The songs come from the embed page.
    if (total === undefined) throw new MetaOnly(base);
    if (total === 0) return base;

    // GET …/items (since February 2026), else …/tracks (404 / 410: the old API).
    let route = "items";
    const page = async (offset: number) => {
      const path = (r: string) => `/playlists/${id}/${r}?limit=100&offset=${offset}`;
      try {
        return await apiFields<{ items?: (ApiEntry | null)[] }>(path(route), PAGE_FIELDS, keys, until);
      } catch (e) {
        if (route === "items" && e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          route = "tracks";
          return apiFields<{ items?: (ApiEntry | null)[] }>(path(route), PAGE_FIELDS, keys, until);
        }
        throw e;
      }
    };
    const offsets = pageOffsets(total, 100);
    let pages: { items?: (ApiEntry | null)[] }[];
    try {
      const first = await page(offsets[0]); // finds the route the others use
      pages = [first, ...(await pool(offsets.slice(1), PAGES_AT_ONCE, page))];
    } catch (e) {
      // The details came, the songs are refused: the user-only rule again.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) throw new MetaOnly(base);
      throw e;
    }
    const songs = songsOfEntries(pages.flatMap((p) => p.items ?? [])).slice(0, MAX_SONGS);
    if (!songs.length) throw new MetaOnly(base);
    return { ...base, songs, ...(total > MAX_SONGS ? { truncated: true } : {}) };
  }

  const album = await api<{
    name?: string;
    artists?: { name?: string }[];
    images?: ApiImage[];
    total_tracks?: number;
    tracks?: { total?: number } | null;
    items?: { total?: number } | null;
  }>(`/albums/${id}`, keys, until);
  const total = totalOf(album) ?? (Number(album.total_tracks) || 0);
  const pages = await pool(pageOffsets(total, 50), PAGES_AT_ONCE, (offset) =>
    api<{ items?: (ApiTrack & ApiEntry)[] }>(`/albums/${id}/tracks?limit=50&offset=${offset}`, keys, until)
  );
  const songs = pages
    .flatMap((p) => p.items ?? [])
    .map((t) => songOf(t?.item ?? t?.track ?? t))
    .filter((s): s is SpotifySong => !!s)
    .slice(0, MAX_SONGS);
  const list: SpotifyList = {
    kind,
    id,
    name: String(album.name ?? "Spotify"),
    owner: (album.artists ?? []).map((a) => a?.name).filter(Boolean).join(", "),
    cover: bestImage(album.images),
    songs,
    via: "api",
    total,
    ...(total > MAX_SONGS ? { truncated: true } : {}),
  };
  if (!songs.length && total > 0) throw new MetaOnly({ ...list, songs: [] });
  return list;
}

// ---- 2. The public embed page ----------------------------------------------------

async function embedEntity(path: string, ms: number): Promise<any> {
  const res = await fetch(`https://open.spotify.com/embed/${path}`, {
    signal: AbortSignal.timeout(ms),
    headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" },
  });
  if (res.status === 404) throw new NotFoundError();
  if (!res.ok) throw new Error(`spotify ${res.status}`);
  return entityOf(await res.text());
}

/** The page's __NEXT_DATA__ entity (the data the embedded player shows). */
export function entityOf(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("spotify-changed");
  return JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity ?? null;
}

async function readEmbed(kind: "playlist" | "album", id: string, ms: number): Promise<SpotifyList> {
  const entity = await embedEntity(`${kind}/${id}`, ms);
  if (!entity?.trackList) throw new NotFoundError();
  const songs: SpotifySong[] = (entity.trackList as any[])
    .filter((t) => t?.title)
    .map((t) => ({ title: String(t.title), artist: String(t.subtitle ?? "").replace(/ /g, " "), ms: Number(t.duration) || 0 }));
  const sources: { url: string; width?: number }[] = entity.coverArt?.sources ?? entity.visualIdentity?.image ?? [];
  const cover = [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";
  return {
    kind,
    id,
    name: String(entity.name ?? entity.title ?? "Spotify"),
    owner: String(entity.subtitle ?? entity.authors?.[0]?.name ?? ""),
    cover,
    songs,
    via: "embed",
  };
}

/** One song from its embed page's entity (title, artists, length). Null when it is not a song. */
export function songFromEntity(entity: any): SpotifySong | null {
  const title = entity?.title ?? entity?.name;
  if (!title || (entity.type && entity.type !== "track")) return null;
  const artist = Array.isArray(entity.artists)
    ? entity.artists.map((a: { name?: string }) => a?.name).filter(Boolean).join(", ")
    : String(entity.subtitle ?? "").replace(/ /g, " ");
  return { title: String(title), artist, ms: Number(entity.duration) || 0 };
}

/**
 * One song (a pasted track link), from its public embed page; kept a day per
 * instance. Throws NotFoundError (no such song), a TimeoutError or an Error.
 */
export function readSpotifyTrack(id: string, ms: number): Promise<SpotifySong> {
  return songsById.get(`t:${id}`, 24 * 3600_000, async () => {
    if (!(ms > 0)) throw new TimeoutError();
    const song = songFromEntity(await embedEntity(`track/${id}`, ms));
    if (!song) throw new NotFoundError();
    return song;
  });
}
