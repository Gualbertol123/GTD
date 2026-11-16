// -----------------------------------------------------------------------------
// Spotify mode: the app's queue played by Spotify's Web Playback SDK, in this
// browser, as a Spotify device called "Team GTD" (Premium only, as Spotify
// requires for every listener).
//
// It is the second engine behind lib/music.ts (AltEngine): the queue, the
// index, the play / pause intent and the status stay there, so every view
// works unchanged. Only one engine ever plays: music.setEngine pauses the
// other first, YouTube's paths stand still in Spotify mode, and a Spotify
// state that says "playing" while YouTube is the engine is paused at once.
// Nothing from one service is mixed, segued or overlapped with the other.
//
//   device   the SDK script (sdk.scdn.co), one Spotify.Player, connect(),
//            "ready" gives the device id. account_error (no Premium),
//            initialization_error (no EME in this browser) and
//            authentication_error (old sign-in, missing scopes) end Spotify
//            mode with a toast (music.spotifyFailed).
//   start(i) each Track plays as its Spotify twin: track.spotify, or a match
//            found with GET /search (scored on title, artist and length; kept
//            per YouTube id in localStorage). A song with no twin is skipped
//            with a toast, never played from YouTube. PUT /me/player/play
//            gets the next ≤ 50 matched songs (the "window") on this device;
//            when the window runs out the next one is sent.
//   state    player_state_changed → status, playing, index, now (Spotify's own
//            title and artists), spNow (its cover, link) and the time.
//
// Security (the team shares one login; a Spotify session is per person, per
// device, see spotifyAuth):
//   this device only  every player command carries device_id = this browser's
//            SDK device (spApi refuses any other, and any without one): never
//            Spotify's "active device" (someone's phone, another computer).
//            No local device: no command, a toast. Playback moved to another
//            device (an empty SDK state, or GET /me/player names another
//            device): paused here with a toast, never taken back by itself.
//   network  sdk.scdn.co, accounts or api.spotify.com blocked (script error
//            or 10 s, a fetch TypeError, no "ready" in 15 s = the websocket):
//            a toast and back to YouTube with the same queue. Nothing tries
//            another host or a proxy.
//   names    another name picked on this device: the old person's device is
//            dropped; Spotify mode goes on only if the new person is signed in
//            on this device, else back to YouTube with a toast.
//
// Every decision is a "[music] …" line (mlog).
// -----------------------------------------------------------------------------

import { getMusic, mlog, musicTr, nextIndex, nowOf, registerSpotifyEngine, setMusic, setMusicTime, spotifyFailed, toast, getMusicTime, type AltEngine, type SpotifyNow, type Track } from "./music";
import { normText } from "./musicSort";
import { readPref } from "./prefs";
import { onSpotifySession, refreshSpotifyToken, setSpotifyAuthLogger, spotifyAuthState, spotifyOwner, spotifyRefreshFailure, spotifyTokenExpiry, spotifyUserToken, whenSpotifyAuthReady } from "./spotifyAuth";

// spotifyAuth's decisions (decrypting, migration, refresh) go to the same "[music]" log.
setSpotifyAuthLogger(mlog);

// ---- The SDK's shapes ---------------------------------------------------------

export interface SdkTrack {
  id: string | null;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string; uri?: string }[];
  album: { name: string; uri?: string; images: { url: string; width?: number | null; height?: number | null }[] };
  linked_from?: { uri: string | null; id: string | null };
}
export interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  loading?: boolean;
  timestamp?: number;
  track_window: { current_track: SdkTrack | null; previous_tracks: SdkTrack[]; next_tracks: SdkTrack[] };
}
export interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (arg: never) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  activateElement?(): Promise<void>;
}
interface SdkNamespace {
  Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer;
}
type SdkWindow = Window & { Spotify?: SdkNamespace; onSpotifyWebPlaybackSDKReady?: () => void };

export const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
/** What a network must let through for Spotify mode (README §1e). */
export const SPOTIFY_HOSTS = ["accounts.spotify.com", "api.spotify.com", "*.spotify.com (https + wss)", "sdk.scdn.co", "*.scdn.co", "*.spotifycdn.com"];
export const DEVICE_NAME = "Team GTD";
const API = "https://api.spotify.com/v1";
/** The SDK script must load in this long (sdk.scdn.co blocked or dropped: unreachable). */
const SDK_MS = 10000;
/** "ready" (the SDK's websocket to Spotify) must come in this long. */
const READY_MS = 15000;
const CALL_MS = 10000;
/** The songs given to Spotify at once (PUT /me/player/play). */
export const WINDOW_MAX = 50;
/** Songs in a row with no Spotify twin before the queue stops. */
export const MAX_MISSES = 12;
/** A start Spotify has not confirmed by then: show Play again (and say so). */
const START_CHECK_MS = 10000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const fmt = (key: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), musicTr(key));

/** Why Spotify mode ended (each has a toast). */
export type SpFailure = "premium" | "browser" | "auth" | "sdk" | "device" | "not-allowed" | "api" | "network";
class SpError extends Error {
  constructor(
    public reason: SpFailure,
    detail = "",
    /** The device was dropped on purpose (another name picked): not a failure to report. */
    public dropped = false
  ) {
    super(`spotify ${reason}${detail ? `: ${detail}` : ""}`);
  }
}
const FAIL_KEY: Record<SpFailure, string> = {
  premium: "music.sp.premium",
  browser: "music.sp.browser",
  auth: "music.sp.auth",
  sdk: "music.sp.sdk",
  device: "music.sp.device",
  "not-allowed": "music.sp.notAllowed",
  api: "music.sp.api",
  network: "music.sp.unreachable",
};

// ---- Matching a song to Spotify (pure, unit-tested) ----------------------------

const words = (s: string) => new Set(normText(s).split(" ").filter(Boolean));
const squash = (s: string) => normText(s).replace(/ /g, "");

/** Bracketed or trailing extras a YouTube title adds to the song's name. */
const TITLE_NOISE =
  /\b(official|ufficiale|oficial|officiel|music video|video ?clip|videoclip|video|audio|lyrics?|lyric video|testo|letra|paroles|hd|hq|4k|remaster(ed)?|visuali[sz]er|mv|m\/v|explicit|clean)\b/i;
const VARIANT = /\b(live|remix|karaoke|instrumental|acoustic|acustica|cover|slowed|sped up|reverb|8d|nightcore|demo|edit)\b/i;

/** The song's name without "(Official Video)", "[HD]", "feat. X" and friends. */
export function cleanTitle(s: string): string {
  return s
    .replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (TITLE_NOISE.test(inner) || /^\s*(feat|ft)\b/i.test(inner) ? " " : m))
    .replace(/\b(official (music )?video|official audio|video ufficiale|videoclip ufficiale|lyric video|with lyrics)\b/gi, " ")
    .replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—|:]+$/, "")
    .trim();
}

/** The artist a YouTube channel stands for ("LuisFonsiVEVO" → "Luis Fonsi", "Queen - Topic" → "Queen"). */
export function channelArtist(channel: string): string {
  return channel
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\b(official|ufficiale|oficial|music|musica|tv|channel|canale)\b/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title + artist of a YouTube song: "Artist - Song", "Song - Artist" (the channel decides), or the channel's name. */
export function guessSong(title: string, channel: string): { title: string; artist: string } {
  const chan = channelArtist(channel);
  const segs = title.split(/\s[-–—|]\s/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const [a, b] = segs;
    const key = squash(chan);
    const inA = key.length >= 3 && (squash(a).includes(key) || key.includes(squash(a)));
    const inB = key.length >= 3 && (squash(b).includes(key) || key.includes(squash(b)));
    if (inB && !inA) return { title: cleanTitle(a), artist: cleanTitle(b) };
    return { title: cleanTitle(b), artist: cleanTitle(a).replace(/\s(feat\.?|ft\.?|featuring|&|x)\s.*$/i, "").trim() };
  }
  return { title: cleanTitle(title), artist: chan };
}

export interface MatchWant {
  title: string;
  artist: string;
  /** The song's length, when known. */
  ms?: number;
}
export interface MatchCand {
  id: string;
  name: string;
  artists: string[];
  ms?: number;
}

/**
 * How well a Spotify track fits the song (higher is better; see MATCH_MIN).
 * The same ideas as the YouTube matcher (netlify/lib/ytjs matchSong): title
 * words ×3, artist ×2, a big length difference costs a little, and a live /
 * remix / karaoke version not asked for costs a lot.
 */
export function scoreMatch(want: MatchWant, c: MatchCand): number {
  const tw = words(cleanTitle(want.title));
  const cw = words(cleanTitle(c.name));
  if (!tw.size || !cw.size) return 0;
  const hit = [...tw].filter((w) => cw.has(w)).length;
  const titleHit = hit / tw.size;
  // Words Spotify's name has and the song does not ("Song" vs "Other Song").
  const extra = [...cw].filter((w) => !tw.has(w)).length / cw.size;
  const aw = words(want.artist);
  const ak = squash(want.artist);
  let artistHit = 0;
  for (const a of c.artists) {
    const k = squash(a);
    if (ak.length >= 3 && k.length >= 3 && (k.includes(ak) || ak.includes(k))) artistHit = 1;
    else if (aw.size) artistHit = Math.max(artistHit, [...words(a)].filter((w) => aw.has(w)).length / aw.size);
  }
  let score = titleHit * 3 - extra + artistHit * 2;
  if (want.ms && c.ms) score -= Math.min(1.2, Math.max(0, Math.abs(want.ms - c.ms) - 45000) / 60000);
  if (VARIANT.test(c.name) && !VARIANT.test(want.title)) score -= 1.5;
  return score;
}
/** Below this, no candidate is the song. */
export const MATCH_MIN = 3.2;

/** The best candidate, or null when none is good enough. */
export function pickMatch(want: MatchWant, cands: MatchCand[]): { cand: MatchCand; score: number } | null {
  let best: { cand: MatchCand; score: number } | null = null;
  for (const c of cands) {
    const score = scoreMatch(want, c);
    if (!best || score > best.score) best = { cand: c, score };
  }
  return best && best.score >= MATCH_MIN ? best : null;
}

// ---- The match cache (per YouTube id, this browser) ----------------------------

const CACHE_KEY = "gtd-spotify-match";
const CACHE_MAX = 3000;
/** A song not found is asked again after a day (Spotify's catalogue grows). */
const MISS_KEEP_MS = 24 * 60 * 60 * 1000;
type CacheMap = Record<string, { s: string | null; at: number }>;
let cache: CacheMap | null = null;

function readCache(): CacheMap {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as unknown;
    cache = v && typeof v === "object" ? (v as CacheMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}
function writeCache(): void {
  const c = readCache();
  const keys = Object.keys(c);
  if (keys.length > CACHE_MAX) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete c[k]);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* full or blocked: kept in memory */
  }
}

/** The Spotify id known for a YouTube song: an id, null (not on Spotify), or undefined (not looked up). */
export function knownMatch(t: Track): string | null | undefined {
  if (t.spotify) return t.spotify;
  const e = readCache()[t.id];
  if (!e) return undefined;
  if (e.s) return e.s;
  return Date.now() - e.at < MISS_KEEP_MS ? null : undefined;
}
function remember(t: Track, s: string | null): void {
  readCache()[t.id] = { s, at: Date.now() };
  writeCache();
  // Kept on the in-memory Track too (team playlists store it when they are saved).
  if (s) t.spotify = s;
}

// ---- The Web API (the signed-in user's token) ----------------------------------

export interface ApiAnswer {
  /** 0 = no answer (see `net`); -1 = refused here: a player command not for this browser's device. */
  status: number;
  json: unknown;
  /** Why there was no answer: "blocked" = the fetch failed (TypeError) while online; "offline"; "timeout". */
  net?: "blocked" | "offline" | "timeout";
}

/** Player commands that change playback: each must name this browser's device. */
const PLAYER_WRITE = /^\/me\/player(\/(play|pause|next|previous|seek|volume|queue|shuffle|repeat))?(\?|$)/;

/** The device a player command is for: device_id in the address, or the one device of a transfer (PUT /me/player). */
export function commandDevice(path: string, body?: unknown): string | null {
  const [p, q = ""] = path.split("?");
  if (p === "/me/player") {
    const ids = (body as { device_ids?: unknown } | null | undefined)?.device_ids;
    return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string" ? ids[0] : null;
  }
  return new URLSearchParams(q).get("device_id");
}

/** A token with less than this left is refreshed before it is used. */
export const TOKEN_MARGIN_MS = 60_000;

/**
 * The access token, refreshed FIRST when it has run out or is about to (an
 * hour after the sign-in, or a tab reloaded later: the token stays in
 * sessionStorage). Spotify's SDK would otherwise connect with a dead token
 * and fail with authentication_error. Null: not signed in (or the refresh
 * was refused, which signs out).
 */
export async function freshSpotifyToken(): Promise<string | null> {
  // Right after a reload or a name change the sealed token is still being decrypted.
  await whenSpotifyAuthReady();
  const tok = spotifyUserToken();
  if (!tok) return null;
  const exp = Number(spotifyTokenExpiry());
  if (!Number.isFinite(exp) || exp - Date.now() > TOKEN_MARGIN_MS) return tok;
  mlog("Spotify token expired or about to: refreshing it before use", { leftS: Math.round((exp - Date.now()) / 1000) });
  const t = await refreshSpotifyToken();
  if (t) return t;
  // Offline or slow: the old one is tried (and refreshed again on a 401). Refused: signed out.
  return spotifyUserToken();
}

/** One call to api.spotify.com: a timeout, one refresh on 401, one wait on 429. Status 0 = network. */
export async function spApi(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<ApiAnswer> {
  if (method !== "GET" && PLAYER_WRITE.test(path)) {
    const dev = commandDevice(path, body);
    if (!dev || !deviceId || dev !== deviceId) {
      // Never Spotify's "active device" (someone's phone, another computer): only this browser's.
      mlog("REFUSED: a Spotify player command not for this browser's device (not sent)", { path: path.split("?")[0], asked: dev, local: deviceId }, "warn");
      return { status: -1, json: null };
    }
  }
  let tok = await freshSpotifyToken();
  if (!tok) return { status: 401, json: null };
  if (method !== "GET" && PLAYER_WRITE.test(path)) {
    // The token in hand must be the device's person's: the name may have changed in another tab
    // while this call waited (the switch is heard a moment later). Never their token on our device.
    const dev = commandDevice(path, body);
    if (dev !== deviceId || deviceOwner !== spotifyOwner()) {
      mlog("REFUSED: the person picked changed while a Spotify player command waited (not sent)", { path: path.split("?")[0], device: deviceOwner || null, now: spotifyOwner() || null }, "warn");
      return { status: -1, json: null };
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_MS);
    let res: Response;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      const net = ctrl.signal.aborted ? "timeout" : typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "blocked";
      mlog(`Spotify API: no answer (${net})`, { path: path.split("?")[0], error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "warn");
      return { status: 0, json: null, net };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && attempt === 0) {
      mlog("Spotify API 401: refreshing the sign-in", { path: path.split("?")[0] });
      tok = await refreshSpotifyToken();
      if (!tok) return { status: 401, json: null };
      continue;
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(3, Number(res.headers.get("Retry-After")) || 1);
      mlog(`Spotify API 429: waiting ${wait} s`, { path: path.split("?")[0] }, "warn");
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  }
  return { status: 0, json: null };
}

const reasonOf = (a: ApiAnswer) => String((a.json as { error?: { reason?: string; message?: string } } | null)?.error?.reason ?? (a.json as { error?: { message?: string } } | null)?.error?.message ?? "");

interface ApiTrack {
  id?: string;
  name?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
}

const finding = new Map<string, Promise<string | null>>();

/**
 * The song's Spotify id: known (track.spotify, the cache) or found with
 * GET /search?type=track&limit=5. null: not on Spotify. Throws SpError on a
 * failure that is not "not found" (offline, refused), which is not cached.
 */
export function resolveTrack(t: Track): Promise<string | null> {
  const k = knownMatch(t);
  if (k !== undefined) {
    if (k && !t.spotify) t.spotify = k;
    return Promise.resolve(k);
  }
  let p = finding.get(t.id);
  if (!p) {
    p = findOnSpotify(t).finally(() => finding.delete(t.id));
    finding.set(t.id, p);
  }
  return p;
}

async function findOnSpotify(t: Track): Promise<string | null> {
  const want = guessSong(t.title, t.channel);
  if (!want.title) {
    mlog("Spotify match: the song has no title to look for", { yt: t.id });
    return null;
  }
  const q = `${want.artist} ${want.title}`.trim().slice(0, 200);
  const a = await spApi("GET", `/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
  if (a.status === 0 && a.net === "blocked") throw new SpError("network", "api.spotify.com: fetch failed");
  if (a.status === 401) throw new SpError("auth", "search 401");
  if (a.status === 403) throw new SpError("not-allowed", reasonOf(a));
  if (a.status < 200 || a.status >= 300) throw new SpError("api", `search ${a.status}`);
  const items = ((a.json as { tracks?: { items?: (ApiTrack | null)[] } } | null)?.tracks?.items ?? []).filter((x): x is ApiTrack => !!x?.id && !!x.name);
  const cands: MatchCand[] = items.map((x) => ({ id: x.id!, name: x.name!, artists: (x.artists ?? []).map((y) => y?.name ?? "").filter(Boolean), ms: x.duration_ms }));
  const best = pickMatch(want, cands);
  mlog(best ? "Spotify match found" : "Spotify match: not on Spotify", {
    yt: t.id,
    youtube: `${t.channel} · ${t.title}`,
    asked: q,
    picked: best ? `${best.cand.artists.join(", ")} · ${best.cand.name}` : null,
    score: best ? Math.round(best.score * 100) / 100 : Math.round(Math.max(0, ...cands.map((c) => scoreMatch(want, c))) * 100) / 100,
    candidates: cands.length,
  });
  remember(t, best?.cand.id ?? null);
  return best?.cand.id ?? null;
}

// ---- The queue window (pure, unit-tested) --------------------------------------

export interface SpWindow {
  uris: string[];
  /** The queue entry of each uri when the window was made. */
  idx: number[];
  /**
   * The Track of each uri. The queue can be rewritten under the window (play
   * next, add, shuffle): a song is found again by its Track object, never by
   * an old position.
   */
  tracks?: Track[];
}

/** Where window entry k is in the queue now (-1: no longer in it). */
export function entryIndex(w: SpWindow | null, k: number, q: Track[]): number {
  if (!w || k < 0 || k >= w.uris.length) return -1;
  const t = w.tracks?.[k];
  if (!t) return w.idx[k] ?? -1;
  if (q[w.idx[k]] === t) return w.idx[k];
  return q.indexOf(t);
}

/**
 * How many window entries are still right after the queue changed: from
 * entry `from` (the song Spotify is on) each next entry must be the queue's
 * next song with a twin, with only songs known not to be on Spotify between.
 * Spotify would play the entries after that by itself, in the old order.
 */
export function validWindowLength(w: SpWindow, q: Track[], from: number, known: (t: Track) => string | null | undefined = knownMatch): number {
  const start = Math.max(0, from);
  let prev = entryIndex(w, start, q);
  if (prev < 0) return start;
  for (let k = start + 1; k < w.uris.length; k++) {
    const at = entryIndex(w, k, q);
    if (at <= prev) return k;
    for (let j = prev + 1; j < at; j++) if (known(q[j]) !== null) return k;
    prev = at;
  }
  return w.uris.length;
}

/**
 * The songs Spotify gets from queue entry i: the following entries whose twin
 * is known, up to WINDOW_MAX, in order. Songs known not to be on Spotify are
 * left out (skipped); the window stops at the first song not looked up yet
 * (it is sent with the next window).
 */
export function windowFrom(q: Track[], i: number, known: (t: Track) => string | null | undefined = knownMatch, max = WINDOW_MAX): SpWindow {
  const uris: string[] = [];
  const idx: number[] = [];
  const tracks: Track[] = [];
  for (let j = i; j < q.length && uris.length < max; j++) {
    const s = known(q[j]);
    if (s === undefined) break;
    if (s === null) continue;
    uris.push(`spotify:track:${s}`);
    idx.push(j);
    tracks.push(q[j]);
  }
  return { uris, idx, tracks };
}

/** The biggest album image no wider than ~640 px (Spotify gives 640 / 300 / 64). */
export function coverOfSdk(t: SdkTrack | null | undefined): string {
  const imgs = [...(t?.album?.images ?? [])].filter((x) => x?.url);
  imgs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return (imgs.find((x) => (x.width ?? 0) <= 640) ?? imgs[0])?.url ?? "";
}

/** What the screens show for a Spotify track (its own metadata, cover and link). */
export function spNowOf(t: SdkTrack): SpotifyNow {
  const id = t.id ?? t.uri.split(":").pop() ?? "";
  return {
    id,
    uri: t.uri,
    title: t.name,
    artists: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name ?? "",
    cover: coverOfSdk(t),
    url: `https://open.spotify.com/track/${id}`,
  };
}

/** Which window entry a Spotify state is about (relinked tracks report their original uri in linked_from). */
export function windowPos(w: SpWindow | null, t: SdkTrack | null | undefined): number {
  if (!w || !t) return -1;
  const k = w.uris.indexOf(t.uri);
  if (k >= 0) return k;
  return t.linked_from?.uri ? w.uris.indexOf(t.linked_from.uri) : -1;
}

/**
 * The music state a Spotify state means. `expectI`: the queue entry asked for
 * and not confirmed yet (null when none); `ownPause`: the app paused it a
 * moment ago. Returns null when the state is a late echo to ignore.
 */
export function mapState(
  s: SdkState,
  m: { index: number; playing: boolean; queue: Track[] },
  w: SpWindow | null,
  expectI: number | null,
  ownPause: boolean
): { index: number; playing: boolean; status: "loading" | "buffering" | "playing" | "paused"; confirmed: boolean } | null {
  const k = windowPos(w, s.track_window.current_track);
  const at = k >= 0 ? entryIndex(w, k, m.queue) : -1;
  if (expectI !== null && at !== expectI) {
    // Still about the song before the one asked for.
    return null;
  }
  const index = at >= 0 ? at : m.index;
  if (!s.paused) {
    if (!m.playing && ownPause) return { index, playing: false, status: "paused", confirmed: false };
    return { index, playing: true, status: s.loading ? "buffering" : "playing", confirmed: !s.loading };
  }
  if (expectI !== null && m.playing) return { index, playing: true, status: "loading", confirmed: false };
  if (s.loading && m.playing) return { index, playing: true, status: "buffering", confirmed: false };
  return { index, playing: false, status: "paused", confirmed: false };
}

/** A Spotify state that says the song ended with nothing after it in the window. */
export function isEnded(s: SdkState, last: { uri: string; pos: number; dur: number; paused: boolean } | null): boolean {
  const cur = s.track_window.current_track;
  if (!s.paused || s.position !== 0 || !cur || !last || last.paused || !last.uri) return false;
  if (s.track_window.previous_tracks.some((t) => t.uri === last.uri) && cur.uri === last.uri) return true;
  return cur.uri === last.uri && last.dur > 0 && last.pos >= last.dur - 3000;
}

// ---- The device -------------------------------------------------------------------

let sdkPromise: Promise<SdkNamespace> | null = null;

function loadSdk(): Promise<SdkNamespace> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<SdkNamespace>((resolve, reject) => {
    const w = window as SdkWindow;
    if (w.Spotify?.Player) return resolve(w.Spotify);
    mlog("loading Spotify's Web Playback SDK", { url: SDK_URL });
    const prev = w.onSpotifyWebPlaybackSDKReady;
    const s = document.createElement("script");
    const fail = (why: string) => {
      clearTimeout(timer);
      sdkPromise = null;
      w.onSpotifyWebPlaybackSDKReady = prev;
      s.remove();
      // The script is Spotify's own and only from sdk.scdn.co: no other host is tried.
      reject(new SpError("network", why));
    };
    const timer = setTimeout(() => fail(`${SDK_URL} did not load in ${SDK_MS / 1000} s`), SDK_MS);
    w.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timer);
      prev?.();
      if (w.Spotify?.Player) resolve(w.Spotify);
      else {
        clearTimeout(timer);
        sdkPromise = null;
        w.onSpotifyWebPlaybackSDKReady = prev;
        reject(new SpError("sdk", "no Spotify.Player"));
      }
    };
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => fail(`${SDK_URL}: script error (blocked?)`);
    document.head.appendChild(s);
  });
  return sdkPromise;
}

let player: SdkPlayer | null = null;
let deviceId: string | null = null;
/** Whose sign-in the device was made with (spotifyOwner then). */
let deviceOwner = "";
let devicePromise: Promise<string> | null = null;
let readyWait: { resolve: (id: string) => void; reject: (e: SpError) => void } | null = null;
let tokenAsks = 0;
let activated = false;
let tunedFor: string | null = null;

/** The device's fatal errors: before "ready" they fail the wait; after it, Spotify mode ends. */
function fatal(e: SpError): void {
  mlog(`← Spotify ${e.reason} error`, { message: e.message }, "warn");
  if (readyWait) {
    readyWait.reject(e);
    readyWait = null;
    return;
  }
  failed(e);
}

function makePlayer(S: SdkNamespace): SdkPlayer {
  tokenAsks = 0;
  const owner = spotifyOwner();
  deviceOwner = owner;
  const p = new S.Player({
    name: DEVICE_NAME,
    volume: (getMusic().muted ? 0 : getMusic().volume) / 100,
    getOAuthToken: (cb) => {
      if (owner !== spotifyOwner()) {
        // Another name was picked (maybe in another tab): this device never gets that person's token; it is dropped.
        mlog("Spotify SDK asks for a token, but another name is picked now: not given (the device is dropped)", { device: owner || null, now: spotifyOwner() || null }, "warn");
        return;
      }
      // The first ask gets the token in hand (refreshed first if it has run out); a later one means it ran out.
      const noToken = (what: string) => (spotifyRefreshFailure() === "network" ? new SpError("network", `accounts.spotify.com: ${what}`) : new SpError("auth", what));
      if (tokenAsks++ === 0) {
        void freshSpotifyToken().then((t) => (t ? cb(t) : fatal(noToken("no token"))));
        return;
      }
      mlog("Spotify SDK asks for a new token: refreshing the sign-in");
      void refreshSpotifyToken().then((t) => (t ? cb(t) : fatal(noToken("refresh failed"))));
    },
  });
  p.addListener("ready", ({ device_id }: { device_id: string }) => {
    if (player !== p) return; // a dropped device (another name picked)
    deviceId = device_id;
    mlog("← Spotify ready: device made", { device: DEVICE_NAME, id: device_id });
    readyWait?.resolve(device_id);
    readyWait = null;
  });
  p.addListener("not_ready", ({ device_id }: { device_id: string }) => {
    if (player !== p) return;
    mlog("← Spotify not_ready: the device went offline (it is made again on the next play)", { id: device_id }, "warn");
    if (deviceId === device_id) deviceId = null;
  });
  p.addListener("player_state_changed", (s: SdkState | null) => player === p && onState(s));
  p.addListener("autoplay_failed", () => {
    mlog("← Spotify autoplay_failed: the browser wants a tap to start", undefined, "warn");
    clearCheck();
    expect = null;
    if (getMusic().engine === "spotify") {
      setMusic({ playing: false, status: "paused" });
      toast(musicTr("music.sp.tapPlay"));
    }
  });
  p.addListener("initialization_error", ({ message }: { message: string }) => fatal(new SpError("browser", message)));
  p.addListener("authentication_error", ({ message }: { message: string }) => fatal(new SpError("auth", message)));
  p.addListener("account_error", ({ message }: { message: string }) => fatal(new SpError("premium", message)));
  p.addListener("playback_error", ({ message }: { message: string }) => {
    mlog("← Spotify playback_error: skipping the song", { message }, "warn");
    if (getMusic().engine !== "spotify") return;
    toast(musicTr("music.sp.playbackError"), "error");
    advance(getMusic().index);
  });
  return p;
}

/** The device "Team GTD", made once (and again after a failure or not_ready). */
function ensureDevice(): Promise<string> {
  if (player && deviceId) return Promise.resolve(deviceId);
  if (devicePromise) return devicePromise;
  let made: SdkPlayer | null = null;
  devicePromise = (async () => {
    const S = await loadSdk();
    if (!player) {
      mlog("creating the Spotify device", { name: DEVICE_NAME });
      player = makePlayer(S);
    }
    const p = player;
    const ready = new Promise<string>((resolve, reject) => {
      readyWait = { resolve, reject };
      setTimeout(() => {
        if (readyWait?.resolve === resolve) {
          readyWait = null;
          // The SDK loaded but its websocket to Spotify (wss://*.spotify.com) never opened.
          reject(new SpError("network", `no "ready" from the SDK in ${READY_MS / 1000} s (websocket to Spotify blocked?)`));
        }
      }, READY_MS);
    });
    made = p;
    const ok = await p.connect();
    mlog(`→ Spotify.connect: ${ok ? "connecting" : "refused"}`);
    if (!ok) {
      readyWait = null;
      throw new SpError("browser", "connect refused");
    }
    const id = await ready;
    if (player !== p) throw new SpError("device", "dropped", true);
    return id;
  })()
    .catch((e: unknown) => {
      // A broken player is dropped: the next try makes a new one (never the one made since for another person).
      if (made && player === made) {
        try {
          player.disconnect();
        } catch {
          /* gone */
        }
        player = null;
        deviceId = null;
      }
      throw e instanceof SpError ? e : new SpError("sdk", String(e));
    })
    .finally(() => {
      devicePromise = null;
    });
  return devicePromise;
}

/**
 * The Player object made ahead of the click (no connect, so no device yet):
 * when the Music tab or the ♪ panel opens while signed in. Then the click on
 * the switch or Play can call activateElement() synchronously, as mobile
 * browsers and Safari require before the first play.
 */
export function prepareSpotifyPlayer(): void {
  if (player || !spotifyUserToken()) return;
  void loadSdk().then(
    (S) => {
      if (player || !spotifyUserToken()) return;
      mlog("Spotify player made ahead of the click (no device yet)", { name: DEVICE_NAME });
      player = makePlayer(S);
    },
    (e) => mlog("Spotify SDK preload failed (said when it is used)", { error: (e as Error).message })
  );
}

/** Phones, tablets and Safari: sound may start only inside a tap (activateElement). */
function strictAutoplay(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android|Mobi/i.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Firefox/.test(ua)) || ((navigator.maxTouchPoints ?? 0) > 1 && /Macintosh/.test(ua));
}

/** Inside the user's click: lets the SDK start sound (mobile browsers, Safari). */
function activateInClick(): void {
  if (!player?.activateElement) return;
  if (!activated) mlog("→ Spotify.activateElement (inside the click)");
  activated = true;
  void player.activateElement().catch(() => {});
}

// ---- The engine ---------------------------------------------------------------------

/** The window Spotify has (null: nothing given yet). */
let win: SpWindow | null = null;
/** Spotify still has songs after `win` that are no longer next in the queue (it changed): it must not go on to them. */
let winCut = false;
/** The queue entry asked for and not confirmed by Spotify yet. */
let expect: { i: number; at: number } | null = null;
let startSeq = 0;
let ownPauseAt = -1e9;
let last: { uri: string; pos: number; dur: number; at: number; paused: boolean } | null = null;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let lastSkipToastAt = -1e9;

const ownPause = () => now() - ownPauseAt < 10000;

function clearCheck(): void {
  clearTimeout(checkTimer);
  checkTimer = undefined;
}

/** Spotify mode ends with a toast saying why (music.spotifyFailed: back to YouTube, paused). */
function failed(e: unknown): void {
  if (e instanceof SpError && e.dropped) return void mlog("Spotify: a start for the dropped device ended (another name picked)");
  const reason: SpFailure = e instanceof SpError ? e.reason : "api";
  mlog(`Spotify mode failed (${reason}): back to YouTube`, { error: e instanceof Error ? e.message : String(e) }, "warn");
  if (reason === "network") {
    mlog("Spotify is not reachable from this network: nothing else is tried (no proxy, no other host). A network admin can allow these", { hosts: SPOTIFY_HOSTS, online: typeof navigator !== "undefined" ? navigator.onLine : null }, "warn");
  }
  clearCheck();
  expect = null;
  if (getMusic().engine !== "spotify") return;
  toast(musicTr(FAIL_KEY[reason]), "error");
  spotifyFailed();
}

/** The time ticks between Spotify's events (it sends one per change, not per second). */
function startTick(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (getMusic().engine !== "spotify") {
      clearInterval(tickTimer);
      tickTimer = undefined;
      return;
    }
    if (!last || last.paused) return;
    const pos = Math.min(last.dur || Infinity, last.pos + (now() - last.at));
    setMusicTime(pos / 1000, last.dur / 1000);
  }, 500);
}

/** Did it start? Spotify must say "playing" in time, or the app shows Play again (never a spinner forever). */
function armCheck(seq: number): void {
  clearCheck();
  checkTimer = setTimeout(() => {
    checkTimer = undefined;
    if (seq !== startSeq || getMusic().engine !== "spotify" || !getMusic().playing) return;
    void player
      ?.getCurrentState()
      .then(async (s) => {
        if (seq !== startSeq) return;
        if (s && !s.paused) return onState(s);
        if (!s && (await checkWhere().catch(() => false))) return;
        if (seq !== startSeq) return;
        mlog("start check: Spotify did not start in time: showing Play", { state: s ? "paused" : "none" }, "warn");
        expect = null;
        setMusic({ playing: false, status: "paused" });
        toast(musicTr("music.sp.notStarted"));
      })
      .catch(() => {});
  }, START_CHECK_MS);
}

/** Toast the songs skipped (not on Spotify), at most one every few seconds. */
function sayMissing(t: Track): void {
  if (now() - lastSkipToastAt < 2500) return;
  lastSkipToastAt = now();
  toast(fmt("music.sp.notOn", { title: t.title || t.id }));
}

/**
 * Play queue entry i on Spotify. Its twin is looked up first (a song not on
 * Spotify is skipped with a toast), then the next songs are matched too (a
 * few at once, briefly), and the window goes to Spotify with PUT
 * /me/player/play on this device.
 */
async function start(i: number, auto: boolean, atSec = 0): Promise<void> {
  const seq = ++startSeq;
  clearCheck();
  activateInClick();
  const m0 = getMusic();
  const want = m0.queue[i];
  if (!want) return nothingToPlay(i);
  // Next in the window Spotify already has: its own nextTrack (no call).
  const k = windowPos(win, last ? ({ uri: last.uri } as SdkTrack) : null);
  if (player && deviceId && atSec === 0 && win && k >= 0 && k + 1 < win.uris.length && entryIndex(win, k, m0.queue) >= 0 && entryIndex(win, k + 1, m0.queue) === i && win.uris[k] === last?.uri) {
    mlog(`→ Spotify.nextTrack (song ${i + 1} is next in the window)`, { auto });
    expect = { i, at: now() };
    void player.nextTrack().catch(() => {});
    armCheck(seq);
    return;
  }
  const km = knownMatch(want);
  mlog(`Spotify: play song ${i + 1}/${m0.queue.length}`, { title: want.title, auto, at: Math.round(atSec), spotify: km === undefined ? "to look up" : km === null ? "not on Spotify" : km });
  let dev: string;
  try {
    dev = await ensureDevice();
  } catch (e) {
    if (seq === startSeq) failed(e);
    return;
  }
  if (seq !== startSeq || getMusic().engine !== "spotify") return;
  if (auto && elsewhere) {
    // Playing on another device now: nothing goes on here by itself.
    mlog("  not continuing here: Spotify plays on another device (press Play to bring it here)");
    expect = null;
    setMusic({ playing: false, status: "paused" });
    return;
  }
  // The first song with a twin, from i on.
  let j = i;
  let misses = 0;
  for (;;) {
    const q = getMusic().queue;
    const t = q[j];
    if (!t) return nothingToPlay(j);
    let sid: string | null;
    try {
      // The few after it are looked up meanwhile, so the first window is not one song long.
      const ahead = q.slice(j + 1, j + 5).filter((x) => knownMatch(x) === undefined);
      ahead.forEach((x) => void resolveTrack(x).catch(() => null));
      sid = await resolveTrack(t);
    } catch (e) {
      if (seq !== startSeq) return;
      if (e instanceof SpError && (e.reason === "auth" || e.reason === "not-allowed" || e.reason === "network")) return failed(e);
      mlog("Spotify search failed: stopping here", { error: (e as Error).message }, "warn");
      setMusic({ playing: false, status: "paused" });
      toast(musicTr("music.sp.api"), "error");
      return;
    }
    if (seq !== startSeq || getMusic().engine !== "spotify") return;
    if (sid) break;
    misses++;
    mlog(`  song ${j + 1} is not on Spotify: skipped (never played from YouTube in Spotify mode)`, { title: t.title, inARow: misses });
    sayMissing(t);
    const m = getMusic();
    const n = nextIndex(j, m.queue.length, m.repeat);
    if (n === null || n === i || misses >= MAX_MISSES) {
      mlog("Spotify: no song left to play in this queue", { misses }, "warn");
      expect = null;
      setMusic({ playing: false, status: "paused" });
      toast(musicTr(n === null && misses < MAX_MISSES ? "music.sp.endMissing" : "music.sp.noneOn"), "error");
      return;
    }
    j = n;
    setMusicTime(0, 0);
    // No Spotify cover or link next to a song Spotify has not confirmed.
    setMusic({ index: j, now: nowOf(m.queue[j]), status: "loading", spNow: null });
  }
  // Wait briefly for the ones being looked up, so the window is longer.
  const q = getMusic().queue;
  const ahead = q.slice(j + 1, j + 5).map((x) => resolveTrack(x).catch(() => null));
  await Promise.race([Promise.all(ahead), new Promise((r) => setTimeout(r, 1500))]);
  if (seq !== startSeq || getMusic().engine !== "spotify") return;
  const q2 = getMusic().queue;
  if (q2[j] !== q[j]) {
    const at = q2.indexOf(q[j]);
    if (at < 0) return;
    j = at;
  }
  const w = windowFrom(q2, j);
  win = w;
  winCut = false;
  last = null;
  if (!getMusic().playing) {
    // Paused while the song was looked up: nothing is sent (Play sends it), so Spotify never starts by itself.
    mlog("  paused while the song was looked up: PUT /me/player/play not sent (Play sends it)", { song: j + 1 });
    expect = null;
    return;
  }
  if (!player || dev !== deviceId) return noLocalDevice("the device went away before the play");
  expect = { i: j, at: now() };
  mlog(`→ Spotify PUT /me/player/play (${w.uris.length} songs, from queue song ${j + 1})`, { device: dev, first: w.uris[0], window: `${w.idx[0] + 1}-${w.idx[w.idx.length - 1] + 1}`, at: Math.round(atSec) });
  let a = await playOn(dev, w, atSec);
  if (seq !== startSeq) return abortedPlay(dev, a);
  if (a.status === 404) {
    // The device is not known yet (right after "ready"), or it went away: hand the playback to it, then again.
    mlog("Spotify answered 404 (device not active): transferring the playback to it, then playing again", { reason: reasonOf(a) }, "warn");
    const tr = await spApi("PUT", "/me/player", { device_ids: [dev], play: false });
    if (tr.status === -1) return noLocalDevice("transfer refused here");
    await new Promise((r) => setTimeout(r, 400));
    if (seq !== startSeq) return;
    if (!getMusic().playing) {
      mlog("  paused meanwhile: the second PUT /me/player/play is not sent");
      expect = null;
      return;
    }
    a = await playOn(dev, w, atSec);
    if (seq !== startSeq) return abortedPlay(dev, a);
  }
  if (a.status === -1) return noLocalDevice("play refused here");
  if (a.status === 0 && a.net === "blocked") return failed(new SpError("network", "api.spotify.com: PUT /me/player/play failed"));
  if (a.status === 401) return failed(new SpError("auth", "play 401"));
  if (a.status === 403) return failed(new SpError(/premium/i.test(reasonOf(a)) ? "premium" : "not-allowed", reasonOf(a)));
  if (a.status < 200 || a.status >= 300) {
    mlog(`Spotify refused to play (${a.status})`, { reason: reasonOf(a) }, "warn");
    expect = null;
    setMusic({ playing: false, status: "paused" });
    toast(musicTr(a.status === 0 ? "music.err.offline" : "music.sp.api"), "error");
    return;
  }
  void tune(dev);
  // Paused while it was being asked: Spotify is paused again when it reports playing (onState).
  if (!getMusic().playing) {
    mlog("  paused while Spotify was loading: pausing it");
    ownPauseAt = now();
    void player?.pause().catch(() => {});
  }
  startTick();
  armCheck(seq);
  // The songs after the window are looked up in the background, so the next window is long.
  void prefetch(seq, w.idx[w.idx.length - 1] + 1);
}

/** This browser's Spotify device is not ready: NO play command is sent anywhere (never another device), a toast. */
function noLocalDevice(why: string): void {
  mlog("Spotify: this browser's device is not ready: nothing sent (never to another device)", { why }, "warn");
  expect = null;
  clearCheck();
  setMusic({ playing: false, status: "paused" });
  toast(musicTr("music.sp.noDevice"), "error");
}

/** Playback is on another device (or no device is active) now. */
let elsewhere = false;

/**
 * Spotify plays on another device now (the person's phone, another computer):
 * paused here with a toast; it is NOT transferred back (only a Play here does).
 */
function movedAway(why: string, detail?: unknown): void {
  mlog(`Spotify playback moved to another device (${why}): paused here, not taken back`, detail, "warn");
  startSeq++;
  clearCheck();
  expect = null;
  if (last) last = { ...last, paused: true };
  const was = elsewhere;
  elsewhere = true;
  const m = getMusic();
  if (m.engine !== "spotify") return;
  if (m.playing || m.status !== "paused") setMusic({ playing: false, status: "paused" });
  if (!was) toast(musicTr("music.sp.otherDevice"));
}

/** GET /me/player: is another device playing this account now? Then movedAway. */
export async function checkWhere(): Promise<boolean> {
  const a = await spApi("GET", "/me/player");
  const j = a.json as { device?: { id?: string | null; name?: string; type?: string }; is_playing?: boolean } | null;
  if (a.status !== 200 || !j?.device) return false;
  if (j.device.id && j.device.id === deviceId) return false;
  if (!j.is_playing) return false;
  movedAway("GET /me/player names another device", { device: j.device.name ?? null, type: j.device.type ?? null });
  return true;
}

/** The queue entry to play is not there (the queue is empty or shrank): Play again, with a reason, never a spinner forever. */
function nothingToPlay(i: number): void {
  mlog("Spotify: nothing to play at this queue entry (the queue is empty or changed)", { entry: i + 1, queue: getMusic().queue.length }, "warn");
  expect = null;
  clearCheck();
  setMusic({ playing: false, status: "paused", spNow: null });
  toast(musicTr("music.sp.nothing"));
}

/**
 * A PUT /me/player/play that landed after the app moved on (back to YouTube,
 * another song, stop): when the app no longer wants Spotify to sound, it is
 * paused at once, not after the next state echo (never two services at once).
 */
function abortedPlay(dev: string, a: ApiAnswer): void {
  const m = getMusic();
  if (a.status < 200 || a.status >= 300) return;
  if (m.engine === "spotify" && m.playing) return; // a newer start is on its way
  mlog("  the play landed after the app moved on: pausing Spotify at once", { engine: m.engine, playing: m.playing }, "warn");
  ownPauseAt = now();
  void player?.pause().catch(() => {});
  if (dev === deviceId) void spApi("PUT", `/me/player/pause?device_id=${encodeURIComponent(dev)}`);
}

function playOn(dev: string, w: SpWindow, atSec: number): Promise<ApiAnswer> {
  return spApi("PUT", `/me/player/play?device_id=${encodeURIComponent(dev)}`, { uris: w.uris, offset: { position: 0 }, position_ms: Math.max(0, Math.round(atSec * 1000)) });
}

/** The app owns the queue (shuffle, repeat): Spotify's own shuffle and repeat are turned off once per device. */
async function tune(dev: string): Promise<void> {
  if (tunedFor === dev) return;
  tunedFor = dev;
  mlog("→ Spotify shuffle off, repeat off (the app keeps the order)");
  await spApi("PUT", `/me/player/shuffle?state=false&device_id=${encodeURIComponent(dev)}`);
  await spApi("PUT", `/me/player/repeat?state=off&device_id=${encodeURIComponent(dev)}`);
}

async function prefetch(seq: number, from: number): Promise<void> {
  const q = getMusic().queue;
  const todo = q.slice(from, from + 30).filter((t) => knownMatch(t) === undefined);
  if (!todo.length) return;
  mlog(`Spotify: looking up the next ${todo.length} songs in the background`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && seq === startSeq && getMusic().engine === "spotify") {
      const t = todo[next++];
      await resolveTrack(t).catch(() => null);
    }
  };
  await Promise.all([worker(), worker()]);
}

/** The song at queue entry `from` is over (ended, refused): on to the next, or the end. */
function advance(from: number): void {
  const m = getMusic();
  if (elsewhere) {
    mlog("Spotify: not going on here (it plays on another device)");
    return;
  }
  const n = nextIndex(from, m.queue.length, m.repeat);
  if (n === null) {
    mlog("Spotify: end of the queue");
    expect = null;
    setMusic({ playing: false, status: "paused" });
    return;
  }
  mlog(`Spotify: on to song ${n + 1}/${m.queue.length}`);
  setMusicTime(0, 0);
  setMusic({ index: n, now: nowOf(m.queue[n]), playing: true, status: "loading", spNow: null });
  void start(n, true);
}

/** player_state_changed: the music state follows Spotify. */
export function onState(s: SdkState | null): void {
  const m = getMusic();
  if (m.engine !== "spotify") {
    // Spotify must never sound while YouTube is the engine.
    if (s && !s.paused) {
      mlog("← Spotify plays while YouTube is the engine: pausing it", undefined, "warn");
      void player?.pause().catch(() => {});
    }
    return;
  }
  if (!s) {
    // This device is no longer the active one: playback moved (Spotify app, another computer) or stopped.
    if (m.playing && !expect) movedAway("the SDK reports no state: this device is not active");
    else mlog("← Spotify: no state (this device is not active)", { playing: m.playing, expect: expect?.i ?? null });
    return;
  }
  if (!s.paused && elsewhere) {
    mlog("← Spotify plays on THIS device again (chosen in Spotify's device list): following it");
    elsewhere = false;
  }
  const cur = s.track_window.current_track;
  mlog(`← Spotify ${s.paused ? "paused" : "playing"}${s.loading ? " (loading)" : ""}`, { track: cur ? `${cur.artists.map((a) => a.name).join(", ")} · ${cur.name}` : null, position: Math.round(s.position / 1000), app: m.status, expect: expect?.i ?? null });
  if (win && winCut && !expect && m.playing && cur && last?.uri && cur.uri !== last.uri && windowPos(win, cur) < 0) {
    const kl = windowPos(win, { uri: last.uri } as SdkTrack);
    if (kl >= 0) {
      // Spotify went on in the order it was given, but the queue changed (play next, shuffle): its song is not next.
      const at = entryIndex(win, kl, m.queue);
      mlog("  Spotify went on to a song that is no longer next in the queue: pausing it, the queue's next goes to Spotify", { track: cur.name, after: at >= 0 ? at + 1 : null });
      void player?.pause().catch(() => {});
      last = null;
      advance(at >= 0 ? at : m.index);
      return;
    }
  }
  if (!expect && m.playing && !ownPause() && isEnded(s, last)) {
    const k = windowPos(win, cur);
    const ek = entryIndex(win, k, m.queue);
    const at = ek >= 0 ? ek : m.index;
    mlog(`  song ${at + 1} ended and the window is over: the next one goes to Spotify`);
    last = { ...last!, paused: true };
    advance(at);
    return;
  }
  if (expect && now() - expect.at > 12000) expect = null;
  const r = mapState(s, m, win, expect?.i ?? null, ownPause());
  if (!r) {
    mlog("  ignored: about the song before the one asked for");
    return;
  }
  if (!s.paused && !m.playing && ownPause()) {
    mlog("  paused again: the app asked to pause while Spotify loaded");
    void player?.pause().catch(() => {});
  } else if (!s.paused && !m.playing) mlog("  started outside the app (media key, Spotify app): following it");
  if (r.confirmed) {
    expect = null;
    clearCheck();
  }
  if (r.index > m.index + 1) {
    for (let j = m.index + 1; j < r.index; j++) if (knownMatch(m.queue[j]) === null) sayMissing(m.queue[j]);
  }
  const t = m.queue[r.index];
  const sp = cur ? spNowOf(cur) : m.spNow;
  // Kept on the Track only when it IS the song Spotify plays (its window entry is this very Track object).
  const kw = windowPos(win, cur);
  if (t && cur?.id && !t.spotify && kw >= 0 && win?.tracks?.[kw] === t) t.spotify = cur.linked_from?.id ?? cur.id;
  setMusic({
    index: r.index,
    playing: r.playing,
    status: r.status,
    spNow: sp,
    // Spotify's own title and artists, for the song it plays (its metadata, as the policy asks).
    now: t ? { id: t.id, title: sp?.title || t.title, author: sp?.artists || t.channel } : m.now,
  });
  last = { uri: cur?.uri ?? "", pos: s.position, dur: s.duration, at: now(), paused: s.paused };
  setMusicTime(s.position / 1000, s.duration / 1000);
  startTick();
}

const engine: AltEngine = {
  activate(i) {
    elsewhere = false;
    mlog("Spotify mode on", { start: i >= 0 ? i + 1 : null, device: deviceId ? "ready" : player ? "player made, to connect" : "to make" });
    activateInClick();
    startTick();
    if (i >= 0 && !player && strictAutoplay()) {
      // No player to activate inside this click: a play now is sure to be refused by this browser. Play does it.
      mlog("  no Spotify player inside the click on a phone / Safari: not starting by itself (press Play)", undefined, "warn");
      setMusic({ playing: false, status: "paused" });
      toast(musicTr("music.sp.tapPlay"));
      i = -1;
    }
    if (i >= 0) {
      void start(i, false);
      return;
    }
    void ensureDevice().then(
      (id) => mlog("Spotify device ready for Play", { id }),
      (e) => getMusic().engine === "spotify" && failed(e)
    );
  },
  start(i, auto) {
    if (!auto) elsewhere = false; // the person asked to play HERE
    void start(i, auto);
  },
  pause() {
    ownPauseAt = now();
    clearCheck();
    if (last) last = { ...last, pos: last.paused ? last.pos : last.pos + (now() - last.at), at: now(), paused: true };
    mlog("→ Spotify.pause");
    void player?.pause().catch(() => {});
  },
  resume() {
    const m = getMusic();
    activateInClick();
    ownPauseAt = -1e9;
    if (elsewhere) {
      // Play pressed here while Spotify plays elsewhere: brought here by a PUT /me/player/play for THIS device only.
      elsewhere = false;
      mlog("Play pressed here while Spotify played on another device: playing here");
      void start(m.index >= 0 ? m.index : 0, false, getMusicTime().time);
      return;
    }
    const k = windowPos(win, last ? ({ uri: last.uri } as SdkTrack) : null);
    if (player && deviceId && k >= 0 && entryIndex(win, k, m.queue) === m.index) {
      mlog("→ Spotify.resume");
      const seq = ++startSeq;
      void player.resume().catch(() => {});
      armCheck(seq);
      return;
    }
    // Nothing of this song on the device yet (switched mode, the queue changed): play it from here.
    void start(m.index >= 0 ? m.index : 0, false, k >= 0 ? 0 : getMusicTime().time);
  },
  seek(sec) {
    mlog("→ Spotify.seek", { sec: Math.round(sec) });
    if (last) last = { ...last, pos: sec * 1000, at: now() };
    void player?.seek(Math.round(sec * 1000)).catch(() => {});
  },
  volume(v) {
    // iOS does not let a page set the volume: the phone's buttons do.
    void player?.setVolume(Math.max(0, Math.min(1, v / 100))).catch(() => {});
  },
  stop() {
    startSeq++;
    clearCheck();
    expect = null;
    win = null;
    winCut = false;
    ownPauseAt = now();
    if (last) last = { ...last, paused: true };
    if (player) {
      mlog("→ Spotify.pause (Spotify mode off)");
      void player.pause().catch(() => {});
    }
  },
  warm() {
    if (player && deviceId) return;
    mlog("warming Spotify's device (pointerdown on the switch)");
    void ensureDevice().catch((e) => mlog("Spotify warm-up failed (said when it is used)", { error: (e as Error).message }));
  },
  queueChanged() {
    const w = win;
    if (!w) return;
    const q = getMusic().queue;
    const kl = windowPos(w, last ? ({ uri: last.uri } as SdkTrack) : null);
    const from = kl >= 0 ? kl : Math.max(0, w.idx.findIndex((_, k) => entryIndex(w, k, q) === getMusic().index));
    const n = validWindowLength(w, q, from);
    const idx = w.uris.map((_, k) => entryIndex(w, k, q));
    if (n >= w.uris.length) {
      win = { ...w, idx };
      mlog("Spotify: the queue changed; the songs Spotify has are still next in it", { window: w.uris.length });
      return;
    }
    win = { uris: w.uris.slice(0, n), idx: idx.slice(0, n), tracks: w.tracks?.slice(0, n) };
    winCut = true;
    mlog("Spotify: the queue changed; Spotify's next songs are not the queue's any more (the next one is sent again)", { kept: n, dropped: w.uris.length - n });
  },
};

registerSpotifyEngine(engine);

// ---- The person picked on this device --------------------------------------------

/** Drop the device made with the previous person's token: nothing of theirs plays or is controlled any more. */
function dropDevice(why: string): void {
  startSeq++;
  clearCheck();
  expect = null;
  win = null;
  winCut = false;
  last = null;
  elsewhere = false;
  tunedFor = null;
  const p = player;
  player = null;
  deviceId = null;
  activated = false;
  if (readyWait) {
    readyWait.reject(new SpError("device", "dropped", true));
    readyWait = null;
  }
  if (!p) return;
  mlog(`Spotify device dropped (${why})`);
  try {
    void p.pause().catch(() => {});
    p.disconnect();
  } catch {
    /* gone */
  }
}

/** Spotify mode cannot go on for the person now picked: back to YouTube (paused, same queue), with a toast. */
function notSignedInNow(name: string): void {
  if (getMusic().engine !== "spotify") return;
  mlog("the person picked on this device is not signed in to Spotify here: back to YouTube", { name: name || null }, "warn");
  toast(name ? fmt("music.sp.ownerOut", { name }) : musicTr("music.sp.noIdentity"), "error");
  spotifyFailed("after another name was picked");
}

/** The person picked last on this device (lowercased key, and as shown). */
let pickedOwner = "";
let pickedName = "";

onSpotifySession((e) => {
  if (e.kind === "no-identity") {
    toast(musicTr("music.sp.noIdentity"), "error");
    return;
  }
  if (e.kind === "loaded") {
    if (e.error === "keystore" && e.owner === spotifyOwner()) {
      // This browser's key store (IndexedDB) did not answer: signed out in this tab, the stored sign-in kept.
      mlog("Spotify sign-in could not be read: this browser's key store does not answer", { owner: e.owner }, "warn");
      toast(musicTr("music.sp.keystore"), "error");
      if (getMusic().engine === "spotify") spotifyFailed("the key store does not answer");
      return;
    }
    if (!e.signedIn && e.owner === pickedOwner) notSignedInNow(pickedName);
    return;
  }
  pickedOwner = e.owner;
  pickedName = e.name;
  dropDevice("another name was picked on this device");
  const m = getMusic();
  if (m.engine !== "spotify") return;
  const st = spotifyAuthState().status;
  if (st === "in") {
    mlog("Spotify mode goes on with the new person's own sign-in (paused: press Play)", { name: e.name });
    setMusic({ playing: false, status: m.source || m.queue.length ? "paused" : "idle", spNow: null });
    toast(fmt("music.sp.ownerSwitched", { name: e.name }));
  } else if (st === "busy") {
    // Their sealed sign-in is being read: paused meanwhile; "loaded" decides.
    mlog("Spotify mode: reading the new person's sign-in (paused meanwhile)", { name: e.name });
    setMusic({ playing: false, status: m.source || m.queue.length ? "paused" : "idle", spNow: null });
  } else notSignedInNow(e.name);
});

// A reload while in Spotify mode: music.ts starts on YouTube because the sealed sign-in is read
// asynchronously; once it is read, Spotify mode is back as chosen (nothing plays by itself).
void whenSpotifyAuthReady().then(() => {
  const m = getMusic();
  if (m.engine !== "youtube" || m.playing || m.status !== "idle" || readPref("musicEngine") !== "spotify" || !spotifyUserToken()) return;
  mlog("Spotify sign-in read at startup: Spotify mode again, as chosen on this device");
  setMusic({ engine: "spotify" });
});

/** For tests: forget the device, the window and the cache in memory. */
export function __resetSpotifyForTests(): void {
  player = null;
  deviceId = null;
  deviceOwner = "";
  devicePromise = null;
  readyWait = null;
  sdkPromise = null;
  activated = false;
  tunedFor = null;
  win = null;
  winCut = false;
  expect = null;
  startSeq++;
  ownPauseAt = -1e9;
  last = null;
  lastSkipToastAt = -1e9;
  elsewhere = false;
  clearCheck();
  clearInterval(tickTimer);
  tickTimer = undefined;
  cache = null;
  finding.clear();
}
