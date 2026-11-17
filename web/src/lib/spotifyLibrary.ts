// -----------------------------------------------------------------------------
// "La mia libreria Spotify": the signed-in person's own Spotify library, read
// in the browser with their own token (lib/spotifyAuth.ts), straight from
// api.spotify.com. Only the endpoints a Development Mode app still has
// (late 2026) are used:
//
//   GET /me/playlists                   your playlists (own + collaborative), 50 a page
//   GET /me/tracks                      liked songs, 50 a page (capped at 2000)
//   GET /me/albums                      saved albums, 50 a page
//   GET /me/following?type=artist       followed artists (cursor pages)
//   GET /me/player/recently-played      the last 50 songs played
//   GET /artists/{id}/albums            an artist's albums (403 / 404: "none")
//   GET /albums/{id} + /albums/{id}/tracks
//   GET /playlists/{id} + /playlists/{id}/items   (songs only for your own /
//                                       collaborative playlists: else "meta-only")
//   GET /search?type=track|album|playlist   10 per type, paged with offset
//
// Every call: the caller's AbortSignal, a 10 s timeout, one token refresh on
// 401, and 429 (rate limit / quota) reported with Retry-After so the page can
// say when to try again. Nothing here plays anything: Spotify mode plays.
// Every decision goes to the [music] log (mlog).
// -----------------------------------------------------------------------------

import { mlog, type SpotifyList, type SpotifySong, type Track } from "./music";
import { onSpotifySession, refreshSpotifyToken, signOutSpotify, spotifyOwner, spotifyUserToken } from "./spotifyAuth";

export const SPOTIFY_API = "https://api.spotify.com/v1";
/** Each call must answer within this. */
const CALL_MS = 10_000;
/** Liked songs read at most (a note says so when there are more). */
export const LIKED_CAP = 2000;
/** Songs read from one playlist / album at most (as the other Spotify readers). */
export const LIST_CAP = 1000;
/** Search: Spotify's limit per type since 2026. */
export const SEARCH_LIMIT = 10;
/** Saved albums / playlists / artists listed at most. */
const COLLECTION_CAP = 1000;
/** A 429 with a Retry-After this short is waited out once, silently. */
const SHORT_WAIT_S = 3;

export type SpotifyErrorCode = "signed-out" | "quota" | "forbidden" | "not-found" | "network" | "aborted" | "server";

export class SpotifyApiError extends Error {
  constructor(
    public code: SpotifyErrorCode,
    public status = 0,
    /** 429: seconds to wait (Retry-After), when Spotify said. */
    public retryAfter?: number
  ) {
    super(`spotify ${code}${status ? " " + status : ""}`);
  }
}

/** The message for a failed call, for a toast (`t`: the page's translator). */
export function spotifyErrorText(e: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const code = e instanceof SpotifyApiError ? e.code : "server";
  if (code === "quota") return e instanceof SpotifyApiError && e.retryAfter !== undefined ? t("spl.errQuota", { s: e.retryAfter }) : t("spl.errQuotaLater");
  if (code === "signed-out") return t("spl.errSignedOut");
  if (code === "forbidden") return t("spl.errForbidden");
  if (code === "not-found") return t("spl.errNotFound");
  if (code === "network") return t("spl.errNetwork");
  return t("spl.errServer");
}

// ---- Shapes the page shows -------------------------------------------------------

export interface SpTrack {
  /** Spotify track id (22 chars). */
  id: string;
  name: string;
  /** Artists, comma separated. */
  artists: string;
  ms: number;
  album?: string;
  cover?: string;
  /** open.spotify.com link (attribution: every item links back to Spotify). */
  url: string;
}

export type SpKind = "playlist" | "album" | "artist";
export interface SpItem {
  kind: SpKind;
  id: string;
  name: string;
  /** Owner (playlist), artists (album), "" (artist). */
  sub: string;
  cover: string;
  /** Songs (playlist / album), when Spotify says. */
  count?: number;
  url: string;
  /** Playlist: owned by the signed-in person / collaborative (its songs are readable). */
  mine?: boolean;
  collaborative?: boolean;
}

export type ListResult =
  | { status: "ok"; item: SpItem; tracks: SpTrack[]; total: number; capped?: boolean }
  /** Spotify gave only the details: a playlist the person neither owns nor collaborates on. */
  | { status: "meta-only"; item: SpItem };

// ---- Raw API shapes (only what is read) ----------------------------------------------

interface ApiImage {
  url?: string;
  width?: number | null;
}
interface ApiArtist {
  id?: string;
  name?: string;
  images?: ApiImage[];
  external_urls?: { spotify?: string };
  followers?: { total?: number };
}
interface ApiAlbum {
  id?: string;
  name?: string;
  images?: ApiImage[];
  artists?: ApiArtist[];
  total_tracks?: number;
  release_date?: string;
  album_type?: string;
  external_urls?: { spotify?: string };
  tracks?: Page<ApiTrack>;
}
export interface ApiTrack {
  id?: string | null;
  name?: string;
  duration_ms?: number;
  artists?: ApiArtist[];
  album?: ApiAlbum;
  type?: string;
  is_local?: boolean;
  external_urls?: { spotify?: string };
}
interface ApiPlaylist {
  id?: string;
  name?: string;
  images?: ApiImage[] | null;
  owner?: { id?: string; display_name?: string };
  collaborative?: boolean;
  external_urls?: { spotify?: string };
  /** `items` since February 2026, `tracks` before. */
  items?: { total?: number } | null;
  tracks?: { total?: number } | null;
}
interface Page<T> {
  items?: (T | null)[];
  next?: string | null;
  total?: number;
  cursors?: { after?: string | null };
}

// ---- The one GET -------------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const tm = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(tm), resolve()), { once: true });
  });

/** `p`, unless `signal` aborts first (then SpotifyApiError("aborted")); `p` itself carries on. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new SpotifyApiError("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SpotifyApiError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e))
    );
  });
}

/** Seconds from a Retry-After header (seconds or an HTTP date). */
export function retryAfterSeconds(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) : undefined;
}

/**
 * GET api.spotify.com with the person's token. `path` is "/me/…" or a full
 * https://api.spotify.com/v1/… address (a page's `next`). One refresh on 401;
 * a 429 with a short Retry-After waited out once, else SpotifyApiError("quota").
 */
export async function spGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = path.startsWith("https://") ? path : `${SPOTIFY_API}${path}`;
  if (!url.startsWith(SPOTIFY_API + "/")) throw new SpotifyApiError("server");
  let tok = spotifyUserToken();
  if (!tok) throw new SpotifyApiError("signed-out", 401);
  let refreshed = false;
  let waited = false;
  for (;;) {
    if (signal?.aborted) throw new SpotifyApiError("aborted");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: ctrl.signal });
    } catch {
      if (signal?.aborted) throw new SpotifyApiError("aborted");
      mlog("splib: network error or timeout", { path: url.slice(SPOTIFY_API.length) }, "warn");
      throw new SpotifyApiError("network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      mlog("splib: 401, refreshing the token once");
      // The refresh is one promise shared with every caller (the player's
      // getOAuthToken too): it never gets this caller's signal, so leaving a
      // section cannot cancel it for the others. This caller only stops waiting.
      tok = await raceAbort(refreshSpotifyToken(), signal);
      if (!tok) {
        if (spotifyUserToken()) {
          // Offline or slow: spotifyAuth kept the sign-in. Say "network", not "sign in again".
          mlog("splib: token refresh did not answer (network): still signed in", undefined, "warn");
          throw new SpotifyApiError("network", 401);
        }
        mlog("splib: refresh refused, signed out", undefined, "warn");
        throw new SpotifyApiError("signed-out", 401);
      }
      continue;
    }
    if (res.status === 401) {
      // Refused again with a fresh token: the sign-in is no good. Sign out, so
      // the page shows "Accedi con Spotify" as the message says.
      mlog("splib: 401 again after a fresh token: signing out", undefined, "warn");
      signOutSpotify();
      throw new SpotifyApiError("signed-out", 401);
    }
    if (res.status === 429) {
      const s = retryAfterSeconds(res.headers.get("retry-after"));
      if (!waited && s !== undefined && s <= SHORT_WAIT_S) {
        waited = true;
        mlog("splib: 429, waiting before one retry", { seconds: s });
        await sleep(s * 1000, signal);
        continue;
      }
      mlog("splib: 429 quota / rate limit", { path: url.slice(SPOTIFY_API.length), retryAfter: s ?? null }, "warn");
      throw new SpotifyApiError("quota", 429, s);
    }
    if (!res.ok) {
      const code: SpotifyErrorCode = res.status === 401 ? "signed-out" : res.status === 403 ? "forbidden" : res.status === 404 ? "not-found" : "server";
      mlog("splib: refused", { path: url.slice(SPOTIFY_API.length), status: res.status }, "warn");
      throw new SpotifyApiError(code, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new SpotifyApiError("server", res.status);
    }
  }
}

/**
 * Every page of a list, following `next`, up to `cap` items. `pick` finds the
 * page in the answer (e.g. `followed artists` sit under `artists`).
 */
export async function pageAll<T>(
  first: string,
  opts: { signal?: AbortSignal; cap?: number; pick?: (j: unknown) => Page<T> | undefined; progress?: (n: number, total: number | undefined) => void } = {}
): Promise<{ items: T[]; total: number | undefined; capped: boolean }> {
  const cap = opts.cap ?? COLLECTION_CAP;
  const pick = opts.pick ?? ((j: unknown) => j as Page<T>);
  const items: T[] = [];
  let total: number | undefined;
  let next: string | null | undefined = first;
  let pages = 0;
  while (next && items.length < cap) {
    const page: Page<T> | undefined = pick(await spGet<unknown>(next, opts.signal));
    pages++;
    if (!page) break;
    if (typeof page.total === "number") total = page.total;
    for (const it of page.items ?? []) if (it) items.push(it);
    opts.progress?.(Math.min(items.length, cap), total);
    next = page.next;
    if (!(page.items ?? []).length) break;
  }
  const capped = items.length > cap || (!!next && items.length >= cap);
  mlog("splib: paged", { first: first.replace(SPOTIFY_API, "").split("?")[0], pages, items: Math.min(items.length, cap), total: total ?? null, capped });
  return { items: items.slice(0, cap), total, capped };
}

// ---- Mapping ---------------------------------------------------------------------

export function bestImage(images: ApiImage[] | null | undefined, small = false): string {
  const list = [...(images ?? [])].filter((i) => i?.url);
  if (!list.length) return "";
  list.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  if (!small) return list[0].url ?? "";
  // The smallest that is still at least 160 px wide (else the largest).
  const ok = list.filter((i) => (i.width ?? 0) >= 160);
  return (ok[ok.length - 1] ?? list[0]).url ?? "";
}

const openUrl = (kind: string, id: string, given?: string) => (given && given.startsWith("https://open.spotify.com/") ? given : `https://open.spotify.com/${kind}/${id}`);

/** A Spotify track as the page shows it; null for local files, episodes and empty slots. */
export function trackOf(t: ApiTrack | null | undefined, album?: ApiAlbum): SpTrack | null {
  if (!t || t.is_local || !t.id || !t.name || (t.type && t.type !== "track")) return null;
  const al = t.album ?? album;
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a?.name).filter(Boolean).join(", "),
    ms: Number(t.duration_ms) || 0,
    ...(al?.name ? { album: al.name } : {}),
    ...(al?.images?.length ? { cover: bestImage(al.images, true) } : {}),
    url: openUrl("track", t.id, t.external_urls?.spotify),
  };
}

function playlistItem(p: ApiPlaylist, me?: string): SpItem | null {
  if (!p?.id) return null;
  const count = p.items?.total ?? p.tracks?.total;
  return {
    kind: "playlist",
    id: p.id,
    name: String(p.name ?? "Spotify"),
    sub: String(p.owner?.display_name ?? p.owner?.id ?? ""),
    cover: bestImage(p.images, true),
    ...(typeof count === "number" ? { count } : {}),
    url: openUrl("playlist", p.id, p.external_urls?.spotify),
    ...(me && p.owner?.id === me ? { mine: true } : {}),
    ...(p.collaborative ? { collaborative: true } : {}),
  };
}
function albumItem(a: ApiAlbum | null | undefined): SpItem | null {
  if (!a?.id) return null;
  return {
    kind: "album",
    id: a.id,
    name: String(a.name ?? "Spotify"),
    sub: [(a.artists ?? []).map((x) => x?.name).filter(Boolean).join(", "), a.release_date?.slice(0, 4)].filter(Boolean).join(" · "),
    cover: bestImage(a.images, true),
    ...(typeof a.total_tracks === "number" ? { count: a.total_tracks } : {}),
    url: openUrl("album", a.id, a.external_urls?.spotify),
  };
}
function artistItem(a: ApiArtist | null | undefined): SpItem | null {
  if (!a?.id) return null;
  return { kind: "artist", id: a.id, name: String(a.name ?? "Spotify"), sub: "", cover: bestImage(a.images, true), url: openUrl("artist", a.id, a.external_urls?.spotify) };
}
function notNull<T>(x: T | null): x is T {
  return x !== null;
}

/** The song the matcher looks for on YouTube, keeping its Spotify id. */
export function songOf(t: SpTrack): SpotifySong & { id: string } {
  return { title: t.name, artist: t.artists, ms: t.ms, id: t.id };
}

/** The Spotify id a song carries (library and pasted imports), if any. */
export function spotifyIdOf(s: SpotifySong | null | undefined): string | undefined {
  const id = (s as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && /^[A-Za-z0-9]{22}$/.test(id) ? id : undefined;
}

/**
 * The YouTube matches with each song's Spotify track id kept (Track.spotify),
 * so Spotify mode plays it without searching. Index i of `matches` is song i.
 */
export function withSpotifyIds(matches: (Track | null)[], songs: SpotifySong[]): (Track | null)[] {
  return matches.map((m, i) => {
    const id = spotifyIdOf(songs[i]);
    return m && id ? { ...m, spotify: id } : m;
  });
}

/** A list the import job can match (lib/music SpotifyList), each song carrying its Spotify id. */
export function importListOf(item: SpItem | { kind: "liked" | "recent"; name: string; owner?: string; cover?: string; id?: string }, tracks: SpTrack[]): SpotifyList {
  return {
    kind: item.kind === "album" ? "album" : "playlist",
    id: `${item.kind}:${item.id ?? item.kind}`,
    name: item.name,
    owner: "sub" in item ? item.sub : item.owner ?? "Spotify",
    // Spotify's cover art is not copied: the import becomes YouTube songs
    // (README §1e), and Spotify's art must not stand for another service's stream.
    cover: "",
    songs: tracks.map(songOf),
    via: "api",
    total: tracks.length,
  };
}

// ---- The library ------------------------------------------------------------------

let meId: string | null = null;
/** Whose session meId was read with (the person picked + their access token): another one reads it again. */
let meKey = "";
const sessionKey = () => `${spotifyOwner()}|${spotifyUserToken() ?? ""}`;
// Another person picked, signed out or signed in again: the cached id is not theirs.
onSpotifySession(() => {
  meId = null;
  meKey = "";
});
/**
 * The signed-in person's Spotify user id (to tell their own playlists). Cached
 * for this person's session only. `fresh`: asked again with the token in hand
 * (the liked songs' owner check, never from a cache).
 */
export async function spotifyMe(signal?: AbortSignal, opts: { fresh?: boolean } = {}): Promise<string | null> {
  const key = sessionKey();
  if (meId && meKey === key && !opts.fresh) return meId;
  meId = null;
  meKey = key;
  try {
    const j = await spGet<{ id?: string }>("/me", signal);
    const id = j.id ?? null;
    // Read for this session: the person or token changed meanwhile, then not kept.
    if (meKey === key) meId = id;
    return id;
  } catch (e) {
    if (e instanceof SpotifyApiError && (e.code === "aborted" || e.code === "quota" || e.code === "signed-out")) throw e;
    mlog("splib: /me unavailable", { error: String(e) }, "warn");
  }
  return null;
}

/** Your playlists, own and collaborative (and the ones you follow), every page. */
export async function myPlaylists(signal?: AbortSignal): Promise<SpItem[]> {
  const me = await spotifyMe(signal);
  const { items } = await pageAll<ApiPlaylist>("/me/playlists?limit=50", { signal });
  const out = items.map((p) => playlistItem(p, me ?? undefined)).filter(notNull);
  mlog("splib: playlists", { n: out.length, mine: out.filter((p) => p.mine || p.collaborative).length });
  return out;
}

/** Liked songs, 50 a page, at most LIKED_CAP (capped says there were more). */
export async function likedTracks(signal?: AbortSignal, progress?: (n: number, total: number | undefined) => void): Promise<{ tracks: SpTrack[]; total: number; capped: boolean }> {
  const r = await pageAll<{ track?: ApiTrack }>("/me/tracks?limit=50", { signal, cap: LIKED_CAP, progress });
  const tracks = r.items.map((x) => trackOf(x.track)).filter(notNull);
  const total = r.total ?? tracks.length;
  mlog("splib: liked", { n: tracks.length, total, capped: r.capped || total > LIKED_CAP });
  return { tracks, total, capped: r.capped || total > LIKED_CAP };
}

/** How many liked songs there are (one tiny page: Spotify's `total`). */
export async function likedTotal(signal?: AbortSignal): Promise<number> {
  const j = await spGet<{ total?: number }>("/me/tracks?limit=1", signal);
  return Number(j.total) || 0;
}

export async function savedAlbums(signal?: AbortSignal): Promise<SpItem[]> {
  const { items } = await pageAll<{ album?: ApiAlbum }>("/me/albums?limit=50", { signal });
  return items.map((x) => albumItem(x.album)).filter(notNull);
}

export async function followedArtists(signal?: AbortSignal): Promise<SpItem[]> {
  const { items } = await pageAll<ApiArtist>("/me/following?type=artist&limit=50", { signal, pick: (j) => (j as { artists?: Page<ApiArtist> }).artists });
  return items.map(artistItem).filter(notNull);
}

/** The last songs played (Spotify keeps 50), newest first, each song once. */
export async function recentlyPlayed(signal?: AbortSignal): Promise<SpTrack[]> {
  const j = await spGet<{ items?: ({ track?: ApiTrack } | null)[] }>("/me/player/recently-played?limit=50", signal);
  const seen = new Set<string>();
  const out: SpTrack[] = [];
  for (const x of j.items ?? []) {
    const t = trackOf(x?.track);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  mlog("splib: recent", { n: out.length });
  return out;
}

/** An artist's albums and singles. Spotify refusing (403 / 404) gives none, not an error. */
export async function artistAlbums(id: string, signal?: AbortSignal): Promise<{ artist: SpItem | null; albums: SpItem[] }> {
  let artist: SpItem | null = null;
  try {
    artist = artistItem(await spGet<ApiArtist>(`/artists/${encodeURIComponent(id)}`, signal));
  } catch (e) {
    if (e instanceof SpotifyApiError && (e.code === "aborted" || e.code === "quota" || e.code === "signed-out")) throw e;
  }
  try {
    const { items } = await pageAll<ApiAlbum>(`/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=10`, { signal, cap: 100 });
    return { artist, albums: items.map(albumItem).filter(notNull) };
  } catch (e) {
    if (e instanceof SpotifyApiError && (e.status === 403 || e.status === 404)) {
      mlog("splib: artist albums refused, showing none", { id, status: e.status }, "warn");
      return { artist, albums: [] };
    }
    throw e;
  }
}

/** An album with every song (its first page comes with the album, then /albums/{id}/tracks). */
export async function albumTracks(id: string, signal?: AbortSignal): Promise<ListResult> {
  const a = await spGet<ApiAlbum>(`/albums/${encodeURIComponent(id)}`, signal);
  const item = albumItem({ ...a, id: a.id ?? id })!;
  const first = a.tracks;
  const raw: ApiTrack[] = (first?.items ?? []).filter((x): x is ApiTrack => !!x);
  let capped = false;
  if (first?.next) {
    const rest = await pageAll<ApiTrack>(first.next, { signal, cap: LIST_CAP - raw.length });
    raw.push(...rest.items);
    capped = rest.capped;
  }
  const tracks = raw.map((t) => trackOf(t, a)).filter(notNull);
  mlog("splib: album", { id, n: tracks.length });
  return { status: "ok", item, tracks, total: first?.total ?? tracks.length, ...(capped ? { capped } : {}) };
}

/**
 * A playlist with its songs: only for a playlist the person owns or
 * collaborates on (Development Mode, since February 2026). Any other gives
 * "meta-only" (details, no songs): the page offers the paste method.
 */
export async function playlistTracks(id: string, signal?: AbortSignal): Promise<ListResult> {
  const fields = "id,name,owner(id,display_name),images,collaborative,external_urls,items(total),tracks(total)";
  const me = await spotifyMe(signal).catch(() => null); // to tell the person's own playlist ("Tua")
  const meta = await spGet<ApiPlaylist>(`/playlists/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`, signal);
  const item = playlistItem({ ...meta, id: meta.id ?? id }, me ?? undefined)!;
  const total = meta.items?.total ?? meta.tracks?.total;
  if (typeof total !== "number") {
    mlog("splib: playlist details only (not yours)", { id });
    return { status: "meta-only", item };
  }
  if (total === 0) return { status: "ok", item, tracks: [], total: 0 };
  try {
    const r = await pageAll<{ is_local?: boolean; item?: ApiTrack | null; track?: ApiTrack | null }>(`/playlists/${encodeURIComponent(id)}/items?limit=50`, { signal, cap: LIST_CAP });
    const tracks = r.items.map((e) => (e.is_local ? null : trackOf(e.item ?? e.track))).filter(notNull);
    if (!tracks.length && total > 0) return { status: "meta-only", item };
    mlog("splib: playlist", { id, n: tracks.length, total });
    return { status: "ok", item: { ...item, count: total }, tracks, total, ...(r.capped || total > LIST_CAP ? { capped: true } : {}) };
  } catch (e) {
    if (e instanceof SpotifyApiError && e.status === 403) {
      mlog("splib: playlist songs refused (403): details only", { id });
      return { status: "meta-only", item };
    }
    throw e;
  }
}

export type SearchType = "track" | "album" | "playlist";
export interface SearchPage {
  tracks?: { items: SpTrack[]; more: boolean };
  albums?: { items: SpItem[]; more: boolean };
  playlists?: { items: SpItem[]; more: boolean };
}

/** Search Spotify: 10 results per type (Spotify's 2026 limit), `offset` for "more". */
export async function searchSpotify(q: string, types: SearchType[], offset = 0, signal?: AbortSignal): Promise<SearchPage> {
  const me = types.includes("playlist") ? await spotifyMe(signal).catch(() => null) : null; // "Tua" on your own playlists
  const p = new URLSearchParams({ q: q.trim(), type: types.join(","), limit: String(SEARCH_LIMIT), offset: String(Math.max(0, Math.min(offset, 1000 - SEARCH_LIMIT))) });
  const j = await spGet<{ tracks?: Page<ApiTrack>; albums?: Page<ApiAlbum>; playlists?: Page<ApiPlaylist> }>(`/search?${p}`, signal);
  const more = (pg?: Page<unknown>) => !!pg?.next && offset + SEARCH_LIMIT < 1000;
  const out: SearchPage = {};
  if (j.tracks) out.tracks = { items: (j.tracks.items ?? []).map((t) => trackOf(t)).filter(notNull), more: more(j.tracks) };
  if (j.albums) out.albums = { items: (j.albums.items ?? []).map(albumItem).filter(notNull), more: more(j.albums) };
  if (j.playlists) out.playlists = { items: (j.playlists.items ?? []).map((x) => (x ? playlistItem(x, me ?? undefined) : null)).filter(notNull), more: more(j.playlists) };
  mlog("splib: search", { q: q.trim(), types, offset, n: { t: out.tracks?.items.length ?? 0, a: out.albums?.items.length ?? 0, p: out.playlists?.items.length ?? 0 } });
  return out;
}

/**
 * The songs of a playlist / album link read with the person's token, for the
 * single-link import (SpotifyPage), keeping the Spotify ids. "meta-only" for
 * someone else's playlist; "fail" for anything else (the server path is used).
 */
export async function readLinkAsUser(kind: "playlist" | "album", id: string, signal?: AbortSignal): Promise<SpotifyList | "meta-only" | "fail"> {
  if (!spotifyUserToken()) return "fail";
  try {
    let r: ListResult;
    if (kind === "album") r = await albumTracks(id, signal);
    else r = await playlistTracks(id, signal);
    if (r.status === "meta-only") return "meta-only";
    const list = importListOf(r.item, r.tracks);
    return { ...list, id, total: r.total, ...(r.capped ? { truncated: true } : {}) };
  } catch (e) {
    mlog("splib: link read failed, using the server", { kind, id, error: e instanceof SpotifyApiError ? e.code : String(e) }, "warn");
    return "fail";
  }
}

/** A Spotify playlist / album link (or spotify: URI) → its kind and id. */
export function spotifyLinkTarget(s: string): { kind: "playlist" | "album"; id: string } | null {
  const m = s.trim().match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})|^spotify:(playlist|album):([A-Za-z0-9]{22})$/);
  if (!m) return null;
  return { kind: (m[1] ?? m[3]) as "playlist" | "album", id: m[2] ?? m[4] };
}

// Signing in from the library page: Spotify sends the browser back to the
// Import page (#/music/spotify); this flag brings it on to the library. It
// counts only on a real return from Spotify with a code (this document was
// loaded at /callback?code=…): a Back from Spotify's page (the page restored
// from the back/forward cache) or a refusal clears it, so it never sends a
// later visit to Importa da Spotify elsewhere.
const RETURN_KEY = "gtd-splib-return";
/** What to do once back (the one-button "Aggiungi tutte le mie playlist" started before signing in). */
const INTENT_KEY = "gtd-splib-intent";
export type LibraryIntent = "add-all";
/** The intent of the last real return, until taken. */
let returnIntent: LibraryIntent | null = null;
const dropReturn = () => {
  try {
    sessionStorage.removeItem(RETURN_KEY);
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    /* blocked storage: nothing kept */
  }
};
export function markLibraryReturn(intent?: LibraryIntent): void {
  try {
    sessionStorage.setItem(RETURN_KEY, String(Date.now()));
    if (intent) sessionStorage.setItem(INTENT_KEY, intent);
    else sessionStorage.removeItem(INTENT_KEY);
  } catch {
    /* private mode: the person opens the library again */
    return;
  }
  // Back from Spotify's page: the app comes back from the cache, not from /callback.
  window.addEventListener(
    "pageshow",
    (e) => {
      if (!(e as PageTransitionEvent).persisted) return;
      mlog("splib: back from Spotify without signing in: return flag cleared");
      dropReturn();
    },
    { once: true }
  );
}

/** The address this document was loaded at (before /callback became /#/music/spotify). */
function loadedAt(): string {
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
    return nav?.name ?? "";
  } catch {
    return "";
  }
}

/** True once after a sign-in started from the library came back with a code (within 15 minutes). */
export function takeLibraryReturn(from = loadedAt()): boolean {
  let v = 0;
  try {
    v = Number(sessionStorage.getItem(RETURN_KEY));
  } catch {
    return false;
  }
  if (!v) return false;
  let intent: string | null = null;
  try {
    intent = sessionStorage.getItem(INTENT_KEY);
  } catch {
    intent = null;
  }
  dropReturn();
  let callback = false;
  try {
    const u = new URL(from);
    callback = u.pathname === "/callback" && u.searchParams.has("code") && !u.searchParams.has("error");
  } catch {
    callback = false;
  }
  const fresh = Date.now() - v < 15 * 60_000;
  mlog(callback && fresh ? "splib: back from sign-in: to the library" : "splib: stale return flag dropped", { callback, fresh, intent });
  returnIntent = callback && fresh && intent === "add-all" ? "add-all" : null;
  return callback && fresh;
}

/** True once when the sign-in was started by "Aggiungi tutte le mie playlist" (after takeLibraryReturn). */
export function takeAddAllIntent(): boolean {
  const v = returnIntent === "add-all";
  returnIntent = null;
  return v;
}

/** Tests: forget the cached user id. */
export function forgetSpotifyLibrary(): void {
  meId = null;
  meKey = "";
}
