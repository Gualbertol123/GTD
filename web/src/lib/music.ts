import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { readPref, writePref } from "./prefs";

// -----------------------------------------------------------------------------
// The music player (components/MusicPlayer.tsx): what it can play, and its
// state, shared by the desktop and the phone layout.
//
// Music comes from YouTube's official embedded player (the same source as
// freefy.app): free for everyone, streamed by YouTube. YouTube may show its
// own ads on some videos (none for YouTube Premium); the app adds none.
// -----------------------------------------------------------------------------

export interface Artist {
  name: string;
  /** The official channel, for "most popular" on the artist page (needs the API key). */
  channel: string;
  /** The artist's official channel's uploads playlist ("UU…"): plays without an API key. */
  list: string;
}

/** The defaults: each artist's official VEVO channel (checked to exist and embed). */
export const ARTISTS: Artist[] = [
  { name: "Enrique Iglesias", channel: "UCVttQE6tS_agDSAU61Q65aA", list: "UUVttQE6tS_agDSAU61Q65aA" },
  { name: "Ricky Martin", channel: "UCNpY5DI8KO-ROA2BxgGWrXg", list: "UUNpY5DI8KO-ROA2BxgGWrXg" },
  { name: "Tiziano Ferro", channel: "UCvBz3n23YgAvAHfoZtdqZCA", list: "UUvBz3n23YgAvAHfoZtdqZCA" },
];

export interface Track {
  id: string;
  title: string;
  channel: string;
  thumb?: string;
}

/** What is playing: the favourites mix, one artist, some songs, or a playlist link. */
export type Source =
  | { kind: "mix" }
  | { kind: "artist"; artist: string }
  | { kind: "videos"; label: string; tracks: Track[]; start: number }
  | { kind: "list"; label: string; list: string; video?: string };

/** A YouTube link (or bare id) → a video and/or a playlist. */
export function parseYouTube(input: string): { video?: string; list?: string } | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return { video: s };
  if (/^(PL|UU|OL|RD|FL|LL)[\w-]{10,}$/.test(s)) return { list: s };
  let url: URL;
  try {
    url = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const list = url.searchParams.get("list") ?? undefined;
  let video: string | undefined;
  if (host === "youtu.be") video = url.pathname.slice(1, 12);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    video =
      url.searchParams.get("v") ??
      url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1] ??
      undefined;
  } else return null;
  if (video && !/^[\w-]{11}$/.test(video)) video = undefined;
  return video || list ? { video, list } : null;
}

// ---- Shared state -----------------------------------------------------------

export type View = "closed" | "open" | "mini";
export type Side = "right" | "left";
/** Music only (the video is not shown; the default) or the video too. */
export type Mode = "audio" | "video";

export interface NowPlaying {
  id: string;
  title: string;
  author: string;
}

export interface MusicState {
  view: View;
  source: Source | null;
  playing: boolean;
  now: NowPlaying | null;
  /** Which corner the small player sits in. */
  side: Side;
  notice: string | null;
  mode: Mode;
  /** Seconds played / total, while something is loaded. */
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: boolean;
  /** The songs queued, when known (search results, playlists). */
  queue: Track[];
  index: number;
  /** The Music tab is on screen: it shows the controls, the floating player steps back. */
  tab: boolean;
  /** In video mode on the Music tab: where the video sits (page coordinates). */
  dock: { x: number; y: number; w: number; h: number } | null;
}

/** What the player component exposes to the controls. */
export interface MusicController {
  play: (s: Source) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setShuffle: (on: boolean) => void;
  setRepeat: (on: boolean) => void;
  playAt: (i: number) => void;
  /** Put songs in the queue: right after the current one, or at the end. */
  enqueue: (tracks: Track[], where: "next" | "end") => void;
}

let state: MusicState = {
  view: "closed",
  source: null,
  playing: false,
  now: null,
  side: readPref("music") === "left" ? "left" : "right",
  notice: null,
  mode: readPref("musicMode") === "video" ? "video" : "audio",
  time: 0,
  duration: 0,
  volume: Number(readPref("musicVolume") ?? 80) || 80,
  muted: false,
  shuffle: false,
  repeat: false,
  queue: [],
  index: -1,
  tab: false,
  dock: null,
};
const listeners = new Set<() => void>();
let controller: MusicController | null = null;
// A play asked for before the player had loaded (first open).
let pending: Source | null = null;

export function getMusic(): MusicState {
  return state;
}

export function setMusic(patch: Partial<MusicState>): void {
  state = { ...state, ...patch };
  if (patch.side) writePref("music", patch.side);
  if (patch.mode) writePref("musicMode", patch.mode);
  if (patch.volume !== undefined) writePref("musicVolume", String(patch.volume));
  listeners.forEach((l) => l());
}

export function useMusic(): MusicState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export function registerController(c: MusicController | null): void {
  controller = c;
  if (c && pending) {
    const s = pending;
    pending = null;
    c.play(s);
  }
}

export const music = {
  open: () => setMusic({ view: "open" }),
  minimize: () => setMusic({ view: state.source ? "mini" : "closed" }),
  close: () => {
    controller?.stop();
    setMusic({ view: "closed", playing: false });
  },
  play: (s: Source) => {
    // From the Music tab the tab is the player: the floating one stays as it is.
    setMusic({ source: s, view: state.tab ? state.view : state.view === "closed" ? "open" : state.view, notice: null });
    if (controller) controller.play(s);
    else pending = s;
  },
  toggle: () => controller?.toggle(),
  next: () => controller?.next(),
  prev: () => controller?.prev(),
  seek: (sec: number) => controller?.seek(sec),
  setVolume: (v: number) => {
    setMusic({ volume: v, muted: v === 0 });
    controller?.setVolume(v);
  },
  setMuted: (m: boolean) => {
    setMusic({ muted: m });
    controller?.setMuted(m);
  },
  setShuffle: (on: boolean) => {
    setMusic({ shuffle: on });
    controller?.setShuffle(on);
  },
  setRepeat: (on: boolean) => {
    setMusic({ repeat: on });
    controller?.setRepeat(on);
  },
  playAt: (i: number) => controller?.playAt(i),
  /** "Play next" / "Add to queue". With nothing playing, it simply plays. */
  enqueue: (tracks: Track[], where: "next" | "end", label: string) => {
    if (!state.source || !controller) return music.play({ kind: "videos", label, tracks, start: 0 });
    controller.enqueue(tracks, where);
  },
  setMode: (m: Mode) => setMusic({ mode: m }),
};

/** A YouTube video's picture, used as the song's cover. */
export function coverOf(id: string | undefined, big = false): string {
  return id ? `https://i.ytimg.com/vi/${id}/${big ? "hqdefault" : "mqdefault"}.jpg` : "";
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---- Search -----------------------------------------------------------------

export type SearchResult = { tracks: Track[] } | { error: "no-key" | "quota" | "login" | string };

export async function searchMusic(q: string, opts: { channelId?: string; order?: "relevance" | "viewCount" } = {}): Promise<SearchResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { error: "login" };
  try {
    const params = new URLSearchParams({ q });
    if (opts.channelId) params.set("channelId", opts.channelId);
    if (opts.order) params.set("order", opts.order);
    const res = await fetch(`/.netlify/functions/music-search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as { tracks?: Track[]; error?: string };
    if (res.ok && body.tracks) return { tracks: body.tracks };
    if (res.status === 404) return { error: "no-key" }; // functions not deployed (local dev)
    return { error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function youtubeSearchUrl(q: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

// ---- Playlists from YouTube (Importa) ---------------------------------------

export interface YtPlaylist {
  list: string;
  title: string;
  channel: string;
  thumb: string;
  /** Songs YouTube says the list has (the import keeps up to 200). */
  total?: number;
  tracks?: Track[];
}

async function callPlaylistFn<T>(params: Record<string, string>): Promise<T | { error: string }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { error: "login" };
  try {
    const res = await fetch(`/.netlify/functions/music-playlist?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.ok && !body.error) return body;
    if (res.status === 404 && !body.error) return { error: "no-key" }; // functions not deployed (local dev)
    return { error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** One public YouTube / YouTube Music playlist, with its songs. */
export function fetchYtPlaylist(list: string): Promise<YtPlaylist | { error: string }> {
  return callPlaylistFn<YtPlaylist>({ list });
}

// A playlist search costs 100 of the key's 10,000 daily units: the suggested
// ones are kept in this browser for a day.
const FIND_CACHE = "gtd-music-find:";
const DAY = 24 * 60 * 60 * 1000;

export async function findYtPlaylists(q: string, cache = false): Promise<{ lists: YtPlaylist[] } | { error: string }> {
  const key = FIND_CACHE + q.toLowerCase();
  if (cache) {
    try {
      const hit = JSON.parse(localStorage.getItem(key) ?? "null") as { at: number; lists: YtPlaylist[] } | null;
      if (hit && Date.now() - hit.at < DAY && Array.isArray(hit.lists)) return { lists: hit.lists };
    } catch {
      /* no storage: just ask */
    }
  }
  const r = await callPlaylistFn<{ lists: YtPlaylist[] }>({ q });
  if (cache && "lists" in r) {
    try {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), lists: r.lists }));
    } catch {
      /* full or blocked */
    }
  }
  return r;
}

/** The playlist id in a pasted link (or a bare id), if any. */
export function playlistIdFrom(input: string): string | null {
  return parseYouTube(input)?.list ?? null;
}

// ---- Home, radio, suggestions (YouTube.js on the server: no quota) ----------

/** Answers kept for this session, so moving between pages asks nothing again. */
const memo = new Map<string, unknown>();

async function browse<T>(params: Record<string, string>, keep = true): Promise<T | { error: string }> {
  const key = new URLSearchParams(params).toString();
  if (keep && memo.has(key)) return memo.get(key) as T;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { error: "login" };
  try {
    const res = await fetch(`/.netlify/functions/music-browse?${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    // Not JSON: the functions are not deployed here (local dev).
    if (!body || typeof body !== "object") return { error: "no-functions" };
    if (res.ok && !body.error) {
      if (keep) memo.set(key, body);
      return body;
    }
    return { error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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

/** YouTube Music's charts for a country ("ZZ" = the world). */
export function fetchCharts(country: string) {
  return browse<{ lists: ChartList[]; artists: ChartArtist[] }>({ charts: country });
}

/** YouTube Music's Explore: trends, new music videos. */
export function fetchExplore() {
  return browse<{ sections: { title: string; tracks: Track[] }[] }>({ explore: "1" });
}

/** Any YouTube Music artist (from the charts): name, picture, songs. */
export function fetchMusicArtist(id: string) {
  return browse<{ name: string; thumb: string; tracks: Track[] }>({ artist: id });
}

/** Search suggestions while typing. */
export async function fetchSuggestions(q: string): Promise<string[]> {
  const r = await browse<{ suggestions: string[] }>({ suggest: q.trim().toLowerCase() });
  return "suggestions" in r ? r.suggestions : [];
}

/** "Radio": play this song, then ~50 like it. Returns an error key, or null. */
export async function playRadio(t: { id: string; title: string }, label: string): Promise<string | null> {
  const r = await browse<{ tracks: Track[] }>({ radio: t.id });
  if ("error" in r || !r.tracks.length) return "error" in r ? r.error : "empty";
  music.play({ kind: "videos", label: `${label} · ${t.title}`, tracks: r.tracks, start: 0 });
  return null;
}

// ---- Importa da Spotify ------------------------------------------------------

export interface SpotifySong {
  title: string;
  artist: string;
  ms: number;
}
export interface SpotifyList {
  kind: "playlist" | "album";
  id: string;
  name: string;
  owner: string;
  cover: string;
  songs: SpotifySong[];
}

/** Is this a Spotify playlist / album link? */
export function isSpotifyLink(s: string): boolean {
  return /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/[A-Za-z0-9]{22}|^spotify:(playlist|album):[A-Za-z0-9]{22}$/.test(s.trim());
}

async function spotifyCall<T>(init: { url?: string; songs?: SpotifySong[] }): Promise<T | { error: string }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { error: "login" };
  try {
    const res = init.url
      ? await fetch(`/.netlify/functions/music-spotify?url=${encodeURIComponent(init.url)}`, { headers: { Authorization: `Bearer ${token}` } })
      : await fetch(`/.netlify/functions/music-spotify`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ songs: init.songs }),
        });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!body || typeof body !== "object") return { error: "no-functions" };
    if (!res.ok || body.error) return { error: body.error ?? `HTTP ${res.status}` };
    return body;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** A public Spotify playlist (first 100 songs) or album: name, cover, songs. */
export function fetchSpotify(url: string) {
  return spotifyCall<SpotifyList>({ url: url.trim() });
}

/**
 * Finds each song on YouTube, 10 per call, two calls at a time; `progress`
 * is told how many are done. Returns one Track or null per song, in order.
 */
export async function matchSpotify(songs: SpotifySong[], progress: (done: number) => void, cancelled: () => boolean): Promise<(Track | null)[]> {
  const out: (Track | null)[] = new Array(songs.length).fill(null);
  const batches: number[] = [];
  for (let i = 0; i < songs.length; i += 10) batches.push(i);
  let done = 0;
  const worker = async () => {
    while (batches.length && !cancelled()) {
      const start = batches.shift()!;
      const part = songs.slice(start, start + 10);
      let r = await spotifyCall<{ matches: (Track | null)[] }>({ songs: part });
      if ("error" in r) r = await spotifyCall<{ matches: (Track | null)[] }>({ songs: part }); // one retry
      if (!("error" in r)) r.matches.forEach((m, i) => (out[start + i] = m));
      done += part.length;
      progress(done);
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}
