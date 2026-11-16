import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { supabase } from "./supabaseClient";
import { readPref, writePref } from "./prefs";

// -----------------------------------------------------------------------------
// The music player (components/MusicPlayer.tsx): what it can play, its state,
// and the engine that drives YouTube's player. Shared by the desktop and the
// phone layout.
//
// Music comes from YouTube's official embedded player (the same source as
// freefy.app): free for everyone, streamed by YouTube. YouTube may show its
// own ads on some videos (none for YouTube Premium); the app adds none.
//
// The app owns the queue. `queue` is the list in the order it will play
// (shuffle reorders it here, never inside YouTube), and `index` is the song
// playing. Every control changes the state at once (the song, the play /
// pause intent, a "loading" status) and then tells YouTube; YouTube's events
// only confirm. So the queue shown, the highlighted song and what YouTube
// plays cannot drift apart.
//
// YouTube is given the same list (loadPlaylist with the ids), because its own
// playlist is what keeps the music going from song to song when the tab is in
// the background or the phone is locked. When the queue changes while a song
// plays (add to queue, shuffle), YouTube's copy is brought up to date at the
// next song change, so the song playing is never interrupted.
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

/**
 * What is playing: the favourites mix, one artist, some songs, or a playlist
 * link. `key` is a stable identity ("pl:<id>", "search:<q>", "radio:<videoId>",
 * "artist:<id>", "trends"…): compare keys, never labels, to tell whether a
 * list is the one playing. music.play fills it in for mix / artist / list.
 */
export type Source =
  | { kind: "mix"; key?: string }
  | { kind: "artist"; artist: string; key?: string }
  | { kind: "videos"; label: string; tracks: Track[]; start: number; key?: string }
  | { kind: "list"; label: string; list: string; video?: string; key?: string };

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
/** Music only (the default) or the video too. */
export type Mode = "audio" | "video";
/**
 * What the player is doing: loading = asked, YouTube has not started yet;
 * buffering = YouTube is fetching; playing / paused = confirmed.
 */
export type Status = "idle" | "loading" | "buffering" | "playing" | "paused";

export interface NowPlaying {
  id: string;
  title: string;
  author: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

/** Where the docked video sits (page coordinates). */
export interface DockRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MusicState {
  view: View;
  source: Source | null;
  /** The user's intent (set at once on click); `status` says what YouTube is doing. */
  playing: boolean;
  status: Status;
  /** The song playing or about to: set at once from the queue on play / next / prev. */
  now: NowPlaying | null;
  /** Which corner the small player sits in. */
  side: Side;
  mode: Mode;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: boolean;
  /** The songs, in the order they will play (empty while a YouTube list loads). */
  queue: Track[];
  index: number;
  /** The Music tab is on screen: it shows the controls, the floating player steps back. */
  tab: boolean;
  /** In video mode on the Music tab, the video sits on the tab's slot (see setDockRect). */
  docked: boolean;
  /** YouTube's player API could not load (blocked or offline): retry with music.retry(). */
  failed: string | null;
  /** A short message ("Added to the queue"). Never shown in place of the song title. */
  toast: Toast | null;
  /** "I have YouTube Premium": the player comes from youtube.com, not youtube-nocookie.com. */
  premium: boolean;
  /** Create the YouTube player now (a music control is about to be used). */
  warm: boolean;
}

/** What setMusic accepts: the state, plus the old fields kept for older callers. */
export type MusicPatch = Partial<MusicState> & {
  /** @deprecated a notice is a toast now (music.toast). */
  notice?: string | null;
  /** @deprecated use setDockRect. */
  dock?: DockRect | null;
};

let state: MusicState = {
  view: "closed",
  source: null,
  playing: false,
  status: "idle",
  now: null,
  side: readPref("music") === "left" ? "left" : "right",
  mode: readPref("musicMode") === "video" ? "video" : "audio",
  volume: Number(readPref("musicVolume") ?? 80) || 80,
  muted: false,
  shuffle: false,
  repeat: false,
  queue: [],
  index: -1,
  tab: false,
  docked: false,
  failed: null,
  toast: null,
  premium: readPref("musicPremium") === "1",
  warm: false,
};
const listeners = new Set<() => void>();

export function getMusic(): MusicState {
  return state;
}

let volTimer: ReturnType<typeof setTimeout> | undefined;

export function setMusic(patch: MusicPatch): void {
  const { notice, dock, ...rest } = patch;
  if (typeof notice === "string") toast(notice);
  if ("dock" in patch) setDockRect(dock ?? null);
  // Only a real change notifies anyone.
  let changed = false;
  for (const k in rest) {
    if (rest[k as keyof typeof rest] !== state[k as keyof MusicState]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...rest };
  // YouTube could not be reached: nothing will ever start, so a click must not
  // leave a spinner turning. Say again why (the toast has Riprova).
  if (state.failed && (state.status === "loading" || state.status === "buffering")) {
    state = { ...state, status: "idle", playing: false };
    if (!("failed" in rest)) queueMicrotask(() => toast(tr("music.failed"), "error"));
  }
  if (rest.side) writePref("music", rest.side);
  if (rest.mode) writePref("musicMode", rest.mode);
  if (rest.volume !== undefined) {
    // localStorage is synchronous: write once the slider rests.
    clearTimeout(volTimer);
    volTimer = setTimeout(() => writePref("musicVolume", String(state.volume)), 400);
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Shallow equality for selectors that return a small object or array. */
export function shallowEq<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Part of the music state: the component re-renders only when what `sel`
 * returns changes. Return primitives or stable references, or pass `eq`
 * (e.g. shallowEq) for a small object.
 */
export function useMusicSel<T>(sel: (s: MusicState) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ s: MusicState; v: T } | null>(null);
  const get = () => {
    const s = state;
    const l = last.current;
    if (l && l.s === s) return l.v;
    const v = sel(s);
    if (l && eq(l.v, v)) {
      last.current = { s, v: l.v };
      return l.v;
    }
    last.current = { s, v };
    return v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

/** Is the list with this key the one playing? (See Source.key.) */
export function isSourceKey(key: string): boolean {
  return !!key && state.source?.key === key;
}

/** The legacy shape: the state plus time / duration (read, not followed) and a notice that is always null. */
export type LegacyMusicState = MusicState & { time: number; duration: number; notice: null; dock: DockRect | null };

/**
 * @deprecated use useMusicSel (or useMusicTime). The whole state; re-renders on
 * any change except the time ticking.
 */
export function useMusic(): LegacyMusicState {
  const s = useSyncExternalStore(subscribe, getMusic, getMusic);
  return useMemo(() => ({ ...s, time: time.time, duration: time.duration, notice: null, dock: dockRect }), [s]);
}

// ---- Time: its own tiny store, so the 500 ms tick re-renders only the seek bars.

let time = { time: 0, duration: 0 };
const timeListeners = new Set<() => void>();

export function getMusicTime(): { time: number; duration: number } {
  return time;
}

function setTime(t: number, d: number = time.duration): void {
  if (t === time.time && d === time.duration) return;
  time = { time: t, duration: d };
  timeListeners.forEach((l) => l());
}

function subscribeTime(l: () => void): () => void {
  timeListeners.add(l);
  return () => {
    timeListeners.delete(l);
  };
}

/** Seconds played and the song's length (0 while unknown). */
export function useMusicTime(): { time: number; duration: number } {
  return useSyncExternalStore(subscribeTime, getMusicTime, getMusicTime);
}

// ---- The docked video: its rectangle goes straight to the player's element.

let dockRect: DockRect | null = null;
let dockEl: HTMLElement | null = null;

/**
 * In video mode on the Music tab, where the video goes (viewport px), or null.
 * Only `docked` (on / off) is in the state; the rectangle is written as CSS
 * variables on the player, so moving it re-renders nothing.
 */
export function setDockRect(r: DockRect | null): void {
  const next = r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null;
  if (next && dockRect && next.x === dockRect.x && next.y === dockRect.y && next.w === dockRect.w && next.h === dockRect.h) return;
  dockRect = next;
  applyDock();
  if (!!next !== state.docked) setMusic({ docked: !!next });
}

/** The element the dock variables are written to (MusicPlayer's root). */
export function registerDockTarget(el: HTMLElement | null): void {
  dockEl = el;
  applyDock();
}

function applyDock(): void {
  const el = dockEl;
  if (!el) return;
  const r = dockRect;
  for (const [k, v] of [
    ["--dx", r?.x],
    ["--dy", r?.y],
    ["--dw", r?.w],
    ["--dh", r?.h],
  ] as const) {
    if (v === undefined) el.style.removeProperty(k);
    else el.style.setProperty(k, `${v}px`);
  }
}

// ---- Toasts -------------------------------------------------------------------

let toastId = 0;

/** A short message in its own pill (never in place of the song title). */
export function toast(text: string, kind: "info" | "error" = "info"): void {
  const id = ++toastId;
  setMusic({ toast: { id, text, kind } });
  // A newer toast is not cleared by an older one's timer.
  setTimeout(() => {
    if (state.toast?.id === id) setMusic({ toast: null });
  }, kind === "error" ? 3800 : 2400);
}

// The engine's own messages are translated when they are shown: MusicPlayer
// hands over the current translator.
let tr: (key: string) => string = (k) => k;
export function setMusicTranslator(t: (key: string) => string): void {
  tr = t;
}

// ---- Pure queue logic (unit-tested) ------------------------------------------

/** Where Next goes: the following song, the first one again with repeat, or null at the end. */
export function nextIndex(index: number, len: number, repeat: boolean): number | null {
  if (len <= 0) return null;
  if (index + 1 < len) return index + 1;
  return repeat ? 0 : null;
}

/** Where Previous goes (null: there is none, restart the song). */
export function prevIndex(index: number, len: number, repeat: boolean): number | null {
  if (len <= 0) return null;
  if (index > 0) return index - 1;
  return repeat ? len - 1 : null;
}

export function shuffled<T>(a: T[], rnd: () => number = Math.random): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** Shuffle on: the song playing first, the rest in a random order. */
export function shuffleQueue(q: Track[], index: number, rnd: () => number = Math.random): { queue: Track[]; index: number } {
  const cur = q[index];
  if (!cur) return { queue: shuffled(q, rnd), index: -1 };
  return { queue: [cur, ...shuffled(q.filter((_, i) => i !== index), rnd)], index: 0 };
}

/** Shuffle off: back to the original order, at the same song (same entry, not just the same id). */
export function unshuffleQueue(original: Track[], q: Track[], index: number): { queue: Track[]; index: number } {
  const cur = q[index];
  const i = cur ? original.indexOf(cur) : -1;
  return { queue: original, index: i >= 0 ? i : cur ? original.findIndex((t) => t.id === cur.id) : -1 };
}

/** Songs added after the current one ("next") or at the end. Each gets its own entry. */
export function insertTracks(q: Track[], index: number, tracks: Track[], where: "next" | "end"): Track[] {
  const adding = tracks.filter((t) => t.id !== q[index]?.id).map((t) => ({ ...t }));
  const out = q.slice();
  out.splice(where === "next" ? Math.max(0, index + 1) : out.length, 0, ...adding);
  return out;
}

function sameIds(a: string[] | null, b: Track[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i].id) return false;
  return true;
}

const nowOf = (t: Track | undefined): NowPlaying | null => (t ? { id: t.id, title: t.title, author: t.channel } : null);

/** The text that names a source ("Mix preferiti", an artist, a list's label). */
export function sourceLabel(s: Source | null, t: (key: string) => string): string {
  if (!s) return "";
  if (s.kind === "mix") return t("music.mix");
  if (s.kind === "artist") return s.artist;
  return s.label;
}

function withKey(s: Source): Source {
  if (s.key) return s;
  if (s.kind === "mix") return { ...s, key: "mix" };
  if (s.kind === "artist") return { ...s, key: `artist:${s.artist}` };
  if (s.kind === "list") return { ...s, key: `list:${s.list}` };
  return s;
}

// ---- The engine: drives YouTube's player ---------------------------------------

/** The part of YouTube's IFrame Player the engine uses. */
export interface YtLike {
  loadPlaylist(arg: string[] | { list: string; listType: "playlist"; index?: number }, index?: number, startSeconds?: number): void;
  cuePlaylist(arg: string[] | { list: string; listType: "playlist"; index?: number }, index?: number, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  nextVideo(): void;
  playVideoAt(i: number): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  setLoop(on: boolean): void;
  getPlaylist(): string[] | null;
  getPlaylistIndex(): number;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getVolume(): number;
  isMuted(): boolean;
  getVideoData(): { video_id?: string; title?: string; author?: string };
}

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
const S = YT_STATE;

/** Consecutive songs that may fail before the queue stops (also stops after a full lap). */
export const MAX_ERRORS = 5;

let yt: YtLike | null = null;
/** The ids YouTube has loaded (null: none, or a YouTube list not read yet). */
let ytIds: string[] | null = null;
/** The queue in its original order while shuffle is on. */
let original: Track[] | null = null;
/** The video the app asked for, until YouTube confirms it; older events are ignored. */
let expectId: string | null = null;
let expectAt = 0;
/** A YouTube list (mix, artist, link) whose ids are not known yet. */
let adopting: { list: string; shuffle: boolean; adds: { tracks: Track[]; where: "next" | "end" }[] } | null = null;
let adoptTimer: ReturnType<typeof setInterval> | undefined;
let mix: { order: Artist[]; pos: number } | null = null;
let errCount = 0;
/** music.play calls: a late answer (radio) checks it has not been overtaken. */
let playSeq = 0;
/** Start the next load here (seek or resume before the player was ready, or a rebuild). */
let resumeAt = 0;
let seekTarget: number | null = null;
let seekAt = 0;
let localVolAt = 0;
let lastCmd = { kind: "", at: 0 };
let blockTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let tickN = 0;
let loopApplied: boolean | null = null;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function cmd(kind: string): void {
  lastCmd = { kind, at: now() };
}

/** YouTube's player is ready (MusicPlayer). Everything asked before now is applied. */
export function attachPlayer(p: YtLike): void {
  yt = p;
  ytIds = null;
  loopApplied = null;
  p.setVolume(state.volume);
  if (state.muted) p.mute();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 500);
  if (state.failed) setMusic({ failed: null });
  syncToPlayer();
}

/** The player is going away (rebuild, unmount): later commands wait for the next one. */
export function detachPlayer(): void {
  if (yt) resumeAt = safe(() => yt!.getCurrentTime(), 0) || time.time;
  yt = null;
  ytIds = null;
  expectId = null;
  clearInterval(tickTimer);
  clearInterval(adoptTimer);
  clearTimeout(blockTimer);
}

function safe<T>(f: () => T, d: T): T {
  try {
    return f();
  } catch {
    return d;
  }
}

/** Load what the state says onto a (new) player: the queue at its song and second. */
function syncToPlayer(): void {
  const p = yt;
  if (!p || !state.source) return;
  const at = resumeAt;
  resumeAt = 0;
  if (state.queue.length && state.index >= 0) {
    ytLoad(state.index, at, !state.playing);
  } else if (adopting || state.source.kind !== "videos") {
    const list = adopting?.list ?? listOf(state.source);
    if (list) startList(list, adopting?.shuffle ?? state.source.kind !== "list");
  }
}

function listOf(s: Source): string | null {
  if (s.kind === "list") return s.list;
  if (s.kind === "artist") return ARTISTS.find((a) => a.name === s.artist)?.list ?? null;
  if (s.kind === "mix") {
    if (!mix) mix = { order: shuffled(ARTISTS), pos: 0 };
    return mix.order[mix.pos].list;
  }
  return null;
}

/** Give YouTube the queue and start (or cue) song i. */
function ytLoad(i: number, start = 0, cue = false): void {
  const p = yt;
  const q = state.queue;
  expectId = q[i]?.id ?? null;
  expectAt = now();
  if (!p) {
    resumeAt = start;
    return;
  }
  const ids = q.map((t) => t.id);
  if (cue) p.cuePlaylist(ids, i, start);
  else if (sameIds(ytIds, q) && start === 0) p.playVideoAt(i);
  else p.loadPlaylist(ids, i, start);
  ytIds = ids;
  if (!cue) armBlocked();
}

/** Go to song i of the queue: the state changes now, YouTube follows. */
function goTo(i: number, auto = false): void {
  const q = state.queue;
  if (i < 0 || i >= q.length) return;
  if (!auto) errCount = 0;
  cmd("play");
  seekTarget = null;
  setTime(0, 0);
  setMusic({ index: i, now: nowOf(q[i]), playing: true, status: "loading" });
  ytLoad(i);
}

/** A YouTube list whose ids come later (mix, artist, pasted link). */
function startList(list: string, shuffle: boolean): void {
  const adds = adopting?.adds ?? [];
  adopting = { list, shuffle, adds };
  ytIds = null;
  expectId = null;
  const p = yt;
  if (!p) return;
  // A random start: cue the list (nothing plays), read its ids, shuffle them
  // here, then play. Otherwise play at once and read the ids as it plays.
  if (shuffle) p.cuePlaylist({ list, listType: "playlist", index: 0 });
  else p.loadPlaylist({ list, listType: "playlist", index: 0 });
  clearInterval(adoptTimer);
  const until = now() + 10000;
  adoptTimer = setInterval(() => {
    if (!adopting || now() > until) {
      clearInterval(adoptTimer);
      // The list never told its ids: just play it as YouTube has it.
      if (adopting && yt && state.playing) {
        adopting = null;
        yt.playVideo();
      }
      return;
    }
    adopt();
  }, 150);
  armBlocked(12000);
}

/** The YouTube list's ids are known: they become the app's queue. */
function adopt(): void {
  const p = yt;
  const a = adopting;
  if (!p || !a) return;
  const ids = safe(() => p.getPlaylist(), null);
  if (!ids || !ids.length) return;
  adopting = null;
  clearInterval(adoptTimer);
  let q: Track[] = ids.map((id) => ({ id, title: "", channel: "" }));
  if (a.shuffle) {
    q = shuffled(q);
    original = null;
    for (const add of a.adds) q = insertTracks(q, 0, add.tracks, add.where);
    setMusic({ queue: q, index: 0 });
    ytLoad(0, 0, !state.playing);
    return;
  }
  let index = Math.max(0, safe(() => p.getPlaylistIndex(), 0));
  ytIds = ids;
  if (state.shuffle && q.length > 1) {
    original = q;
    ({ queue: q, index } = shuffleQueue(q, index));
  }
  for (const add of a.adds) q = insertTracks(q, index, add.tracks, add.where);
  // The titles come as the songs play (YouTube's list gives only ids).
  setMusic({ queue: q, index });
}

/** The favourites mix: the next artist's songs. */
function advanceMix(): void {
  if (!mix) mix = { order: shuffled(ARTISTS), pos: 0 };
  mix.pos = (mix.pos + 1) % mix.order.length;
  original = null;
  setTime(0, 0);
  setMusic({ queue: [], index: -1, now: null, playing: true, status: "loading" });
  startList(mix.order[mix.pos].list, true);
}

/** Stop where we are (end of the queue, or nothing can play). */
function halt(message?: string): void {
  clearTimeout(blockTimer);
  expectId = null;
  setMusic({ playing: false, status: "paused" });
  if (message) toast(message, "error");
}

/**
 * Autoplay refused (phones play only from a tap inside YouTube's frame): if
 * nothing has started a few seconds after a play, say so; the next tap on
 * Play tries again.
 */
function armBlocked(ms = 6000): void {
  clearTimeout(blockTimer);
  blockTimer = setTimeout(() => {
    const p = yt;
    if (!p || !state.playing || adopting) return;
    const s = safe(() => p.getPlayerState(), S.PLAYING);
    if (s === S.PLAYING || s === S.BUFFERING) return;
    setMusic({ playing: false, status: "paused" });
    toast(tr("music.tapToPlay"));
  }, ms);
}

/** Which queue entry YouTube is playing. */
function locate(vid: string): number {
  const q = state.queue;
  const i = state.index;
  if (q[i]?.id === vid) return i;
  if (q[i + 1]?.id === vid) return i + 1;
  const yi = safe(() => yt?.getPlaylistIndex() ?? -1, -1);
  if (sameIds(ytIds, q) && q[yi]?.id === vid) return yi;
  return q.findIndex((t) => t.id === vid);
}

/** YouTube's onStateChange. */
export function onYtState(s: number): void {
  const p = yt;
  if (!p) return;
  const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
  // An event about the song before the one asked for: ignore it.
  if (expectId && vid && vid !== expectId && s !== S.UNSTARTED && s !== S.CUED && now() - expectAt < 8000) return;

  if (s === S.CUED) {
    if (adopting) adopt();
    return;
  }
  if (s === S.UNSTARTED) {
    if (state.playing && state.status !== "loading") setMusic({ status: "loading" });
    return;
  }
  if (s === S.BUFFERING) {
    if (!state.playing) {
      // Paused while it loaded: keep it paused.
      p.pauseVideo();
      return;
    }
    setMusic({ status: "buffering" });
    return;
  }
  if (s === S.PLAYING) {
    expectId = null;
    clearTimeout(blockTimer);
    errCount = 0;
    if (adopting) adopt();
    if (!state.playing) {
      p.pauseVideo();
      setMusic({ status: "paused" });
      return;
    }
    if (loopApplied !== state.repeat) {
      p.setLoop(state.repeat);
      loopApplied = state.repeat;
    }
    const d = safe(() => p.getVideoData(), {} as ReturnType<YtLike["getVideoData"]>);
    let q = state.queue;
    let index = vid ? locate(vid) : state.index;
    let np: NowPlaying | null = state.now;
    if (index >= 0) {
      const t = q[index];
      // The app's title wins; a song known only by id takes YouTube's.
      if (!t.title && d.title) {
        q = q.slice();
        q[index] = { ...t, title: d.title, channel: t.channel || d.author || "" };
      }
      np = nowOf(q[index]);
    } else if (vid) {
      index = state.index;
      np = { id: vid, title: d.title ?? "", author: d.author ?? "" };
    }
    setMusic({ status: "playing", queue: q, index, now: np });
    setTime(safe(() => p.getCurrentTime(), 0) || 0, safe(() => p.getDuration(), 0) || 0);
    return;
  }
  if (s === S.PAUSED) {
    // Our own pause echoing back after a quick Play: not the user's wish.
    if (state.playing && lastCmd.kind === "play" && now() - lastCmd.at < 900) return;
    if (state.playing || state.status !== "paused") setMusic({ playing: false, status: "paused" });
    return;
  }
  if (s === S.ENDED) {
    const q = state.queue;
    if (!q.length) {
      // A YouTube list not read yet: YouTube moves on by itself.
      const len = safe(() => p.getPlaylist()?.length ?? 0, 0);
      if (state.source?.kind === "mix" && len > 0 && p.getPlaylistIndex() >= len - 1) advanceMix();
      return;
    }
    const n = nextIndex(state.index, q.length, state.repeat);
    if (n === null) {
      if (state.source?.kind === "mix") return advanceMix();
      setMusic({ playing: false, status: "paused" });
      return;
    }
    setTime(0, 0);
    setMusic({ index: n, now: nowOf(q[n]), status: "loading" });
    expectId = q[n].id;
    expectAt = now();
    // YouTube's list is ours: it moves on by itself (also in a background
    // tab). If the queue changed meanwhile, load the new one now.
    if (!sameIds(ytIds, q)) {
      const ids = q.map((t) => t.id);
      p.loadPlaylist(ids, n);
      ytIds = ids;
    }
  }
}

/** YouTube's onError: 2 / 153 = the player cannot play here at all; others = this video. */
export function onYtError(code: number): void {
  const p = yt;
  if (!p) return;
  const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
  if (expectId && vid && vid !== expectId && now() - expectAt < 8000) return;
  expectId = null;
  if (code === 2 || code === 153) return halt(tr("music.playerError"));
  errCount++;
  const q = state.queue;
  if (errCount >= Math.min(MAX_ERRORS, q.length || MAX_ERRORS)) return halt(tr("music.noPlayable"));
  if (!q.length) {
    toast(tr("music.unavailable"), "error");
    p.nextVideo();
    armBlocked();
    return;
  }
  const n = nextIndex(state.index, q.length, state.repeat);
  if (n === null) {
    if (state.source?.kind === "mix") {
      toast(tr("music.unavailable"), "error");
      return advanceMix();
    }
    return halt(tr("music.endUnavailable"));
  }
  toast(tr("music.unavailable"), "error");
  goTo(n, true);
}

/** Every 500 ms: the time (its own store), the list's ids, and YouTube's own volume controls. */
function tick(): void {
  const p = yt;
  if (!p) return;
  tickN++;
  if (adopting && tickN % 2 === 0) adopt();
  if (state.status !== "playing" && tickN % 3 !== 0) return;
  const t = safe(() => p.getCurrentTime(), 0) || 0;
  const d = safe(() => p.getDuration(), 0) || 0;
  if (seekTarget !== null) {
    // YouTube reports the old position for a moment after a seek: wait for it.
    if (Math.abs(t - seekTarget) < 1.5 || now() - seekAt > 1500) seekTarget = null;
  }
  if (seekTarget === null && (Math.abs(t - time.time) >= 0.25 || d !== time.duration)) setTime(t, d);
  // YouTube's own volume controls show only in video mode; right after a
  // change here its getters still report the old value.
  if (state.mode === "video" && now() - localVolAt > 1500) {
    const muted = safe(() => p.isMuted(), state.muted);
    const vol = safe(() => p.getVolume(), state.volume);
    const patch: Partial<MusicState> = {};
    if (muted !== state.muted) patch.muted = muted;
    if (typeof vol === "number" && !muted && vol !== state.volume) patch.volume = vol;
    if (Object.keys(patch).length) setMusic(patch);
  }
}

// ---- Commands -----------------------------------------------------------------

let volRaf = 0;

export const music = {
  open: () => setMusic({ view: "open", warm: true }),
  minimize: () => setMusic({ view: state.source ? "mini" : "closed" }),
  close: () => {
    clearTimeout(blockTimer);
    yt?.stopVideo();
    setMusic({ view: "closed", playing: false, status: "idle" });
  },
  /** Create the YouTube player ahead of time (pointerdown / hover on a music control). */
  warm: () => {
    if (!state.warm) setMusic({ warm: true });
  },
  play: (s0: Source) => {
    const s = withKey(s0);
    playSeq++;
    errCount = 0;
    original = null;
    adopting = null;
    clearInterval(adoptTimer);
    seekTarget = null;
    resumeAt = 0;
    setTime(0, 0);
    cmd("play");
    markUsed();
    // From the Music tab the tab is the player: the floating one stays as it is.
    const view = state.tab ? state.view : state.view === "closed" ? "open" : state.view;
    if (s.kind === "videos") {
      let queue = s.tracks.slice();
      let index = Math.max(0, Math.min(s.start, queue.length - 1));
      if (state.shuffle && queue.length > 1) {
        original = queue;
        ({ queue, index } = shuffleQueue(queue, index));
      }
      if (!queue.length) return setMusic({ source: s, view, queue, index: -1, now: null, playing: false, status: "idle" });
      setMusic({ source: s, view, warm: true, queue, index, now: nowOf(queue[index]), playing: true, status: "loading" });
      ytLoad(index);
      return;
    }
    mix = s.kind === "mix" ? { order: shuffled(ARTISTS), pos: 0 } : null;
    setMusic({ source: s, view, warm: true, queue: [], index: -1, now: null, playing: true, status: "loading" });
    const list = listOf(s);
    if (list) startList(list, s.kind !== "list" || state.shuffle);
  },
  toggle: () => {
    if (!state.source) return;
    if (state.playing) {
      // Pause now, also while it loads (YouTube is paused again if it starts).
      cmd("pause");
      clearTimeout(blockTimer);
      setMusic({ playing: false, status: "paused" });
      yt?.pauseVideo();
      return;
    }
    cmd("play");
    setMusic({ playing: true, status: "loading" });
    const p = yt;
    if (!p) return; // applied when the player is ready
    const q = state.queue;
    const ys = safe(() => p.getPlayerState(), S.UNSTARTED);
    if (q.length && state.index >= 0 && (!sameIds(ytIds, q) || ys === S.ENDED)) {
      // The queue changed while paused (or the list ended): load it at this second.
      ytLoad(state.index, ys === S.ENDED ? 0 : time.time);
    } else if (!q.length && adopting?.shuffle) {
      // Still reading a YouTube list: it starts when its ids are known.
    } else {
      p.playVideo();
      armBlocked();
    }
  },
  next: () => {
    if (!state.source) return;
    const q = state.queue;
    if (!q.length) {
      // A YouTube list not read yet: YouTube knows what is next.
      cmd("play");
      setMusic({ playing: true, status: "loading" });
      if (state.source.kind === "mix") {
        const len = safe(() => yt?.getPlaylist()?.length ?? 0, 0);
        if (len > 0 && (yt?.getPlaylistIndex() ?? 0) >= len - 1) return advanceMix();
      }
      yt?.nextVideo();
      return;
    }
    const n = nextIndex(state.index, q.length, state.repeat);
    if (n === null) {
      if (state.source.kind === "mix") advanceMix();
      return;
    }
    goTo(n);
  },
  prev: () => {
    if (!state.source) return;
    const q = state.queue;
    const n = prevIndex(state.index, q.length, state.repeat);
    if (time.time > 4 || n === null) return music.seek(0);
    goTo(n);
  },
  seek: (sec: number) => {
    seekTarget = sec;
    seekAt = now();
    setTime(sec);
    if (yt) yt.seekTo(sec, true);
    else resumeAt = sec;
  },
  /** While dragging, the store and the player follow; the preference is written once it rests. */
  setVolume: (v: number) => {
    v = Math.max(0, Math.min(100, Math.round(v)));
    localVolAt = now();
    const wasMuted = state.muted;
    setMusic({ volume: v, muted: v === 0 });
    const p = yt;
    if (!p) return;
    // One command per frame, however fast the slider moves.
    cancelAnimationFrameSafe(volRaf);
    volRaf = requestAnimationFrameSafe(() => {
      if (state.volume === 0) p.mute();
      else {
        p.setVolume(state.volume);
        if (wasMuted) p.unMute();
      }
    });
  },
  setMuted: (m: boolean) => {
    localVolAt = now();
    setMusic({ muted: m, ...(!m && state.volume === 0 ? { volume: 50 } : {}) });
    const p = yt;
    if (!p) return;
    if (m) p.mute();
    else {
      p.setVolume(state.volume);
      p.unMute();
    }
  },
  setShuffle: (on: boolean) => {
    if (on === state.shuffle) return;
    const q = state.queue;
    if (q.length > 1) {
      // The app shuffles its queue; YouTube's copy follows at the next song.
      if (on) {
        original = q;
        const r = shuffleQueue(q, state.index);
        setMusic({ shuffle: true, queue: r.queue, index: r.index });
      } else {
        const r = original ? unshuffleQueue(original, q, state.index) : { queue: q, index: state.index };
        original = null;
        setMusic({ shuffle: false, queue: r.queue, index: r.index });
      }
    } else setMusic({ shuffle: on });
  },
  setRepeat: (on: boolean) => {
    setMusic({ repeat: on });
    if (yt) {
      yt.setLoop(on);
      loopApplied = on;
    }
  },
  playAt: (i: number) => goTo(i),
  /**
   * "Play next" / "Add to queue". With nothing playing, it simply plays. The
   * song playing is not interrupted: YouTube gets the new list at the next song.
   */
  enqueue: (tracks: Track[], where: "next" | "end", label: string) => {
    if (!tracks.length) return;
    if (!state.source) return music.play({ kind: "videos", label, tracks, start: 0 });
    if (!state.queue.length && adopting) {
      adopting.adds.push({ tracks, where });
      return;
    }
    const q = insertTracks(state.queue, state.index, tracks, where);
    if (original) {
      const cur = state.queue[state.index];
      const at = cur ? original.indexOf(cur) : -1;
      const added = q.filter((t) => !state.queue.includes(t));
      original = original.slice();
      original.splice(where === "next" && at >= 0 ? at + 1 : original.length, 0, ...added);
    }
    setMusic({ queue: q });
  },
  setMode: (m: Mode) => setMusic({ mode: m }),
  toast,
  /** Try loading YouTube's player again (after `failed`). */
  retry: () => {
    setMusic({ failed: null, warm: true, ...(state.source ? { playing: true, status: "loading" as Status } : {}) });
  },
  /** "I have YouTube Premium": the player is rebuilt on the other host, keeping the song, second and queue. */
  setPremium: (on: boolean) => {
    writePref("musicPremium", on ? "1" : "0");
    setMusic({ premium: on });
  },
};

function requestAnimationFrameSafe(f: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(f);
  f();
  return 0;
}
function cancelAnimationFrameSafe(id: number): void {
  if (id && typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
}

/** Music was played in this browser session: the next visit may load YouTube early. */
function markUsed(): void {
  try {
    sessionStorage.setItem("gtd-music-used", "1");
  } catch {
    /* no storage */
  }
}
export function musicUsedThisSession(): boolean {
  try {
    return sessionStorage.getItem("gtd-music-used") === "1";
  } catch {
    return false;
  }
}

/** For tests: back to a fresh state. */
export function __resetMusicForTests(): void {
  detachPlayer();
  state = { ...state, view: "closed", source: null, playing: false, status: "idle", now: null, shuffle: false, repeat: false, queue: [], index: -1, toast: null, failed: null, docked: false };
  time = { time: 0, duration: 0 };
  original = null;
  adopting = null;
  mix = null;
  errCount = 0;
  resumeAt = 0;
  seekTarget = null;
  memo.clear();
  inflight.clear();
  token = undefined;
}

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

// ---- Calling the music functions ------------------------------------------------

/** Every way a music request can fail. The UI shows musicErrorText(code) and ignores "aborted". */
export type MusicErrorCode = "login" | "offline" | "timeout" | "no-functions" | "no-key" | "quota" | "not-found" | "unavailable" | "server" | "aborted";
export type MusicFail = { error: MusicErrorCode };

const CODES = new Set<string>(["login", "offline", "timeout", "no-functions", "no-key", "quota", "not-found", "unavailable", "server", "aborted"]);

/** An HTTP answer → an error code (the server sends codes; older ones sent English text). */
export function errorCode(status: number, body: unknown): MusicErrorCode {
  const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof raw === "string" && CODES.has(raw)) return raw as MusicErrorCode;
  if (raw === "auth-unavailable" || raw === "youtube") return "unavailable";
  // Not JSON: on 404 the functions are not deployed here (local dev); a
  // 502 / 504 page comes from Netlify or YouTube, not from missing functions.
  if (!body || typeof body !== "object") return status === 404 ? "no-functions" : status === 504 ? "timeout" : status === 502 ? "unavailable" : "server";
  if (status === 401 || status === 403) return "login";
  if (status === 404) return "not-found";
  if (status === 429) return "quota";
  if (status === 501 || status === 503) return "no-key";
  if (status === 502) return "unavailable";
  if (status === 504) return "timeout";
  return "server";
}

const ERROR_KEYS: Record<MusicErrorCode, string> = {
  login: "music.err.login",
  offline: "music.err.offline",
  timeout: "music.err.timeout",
  "no-functions": "music.err.noFunctions",
  "no-key": "music.noKey",
  quota: "music.quota",
  "not-found": "music.err.notFound",
  unavailable: "music.err.unavailable",
  server: "music.err.server",
  aborted: "music.err.server",
};

/** The message for an error code, in the UI's language. Unknown text never reaches the screen. */
export function musicErrorText(code: string, t: (key: string) => string): string {
  return t(ERROR_KEYS[code as MusicErrorCode] ?? "music.err.server");
}

// The access token, kept up to date by Supabase (no getSession per request).
let token: string | null | undefined;
let authHooked = false;
async function getToken(): Promise<string | null> {
  if (!authHooked) {
    authHooked = true;
    try {
      supabase.auth.onAuthStateChange((_e, s) => {
        token = s?.access_token ?? null;
      });
    } catch {
      authHooked = false;
    }
  }
  if (token !== undefined) return token;
  const { data } = await supabase.auth.getSession();
  token = data.session?.access_token ?? null;
  return token;
}

export interface CallOpts {
  signal?: AbortSignal;
}
interface FnInit {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  /** Keep a success this long (ms); 0 = not at all. */
  keepMs?: number;
}

/** Answers kept (successes; definite failures only briefly), and requests in flight. */
const memo = new Map<string, { until: number; v: unknown }>();
const inflight = new Map<string, { p: Promise<unknown>; users: number; ctrl: AbortController }>();
const FAIL_KEEP_MS = 10000;
const NO_KEEP = new Set<MusicErrorCode>(["aborted", "timeout", "offline", "login"]);

/** "Riprova": forget the failures kept for a few seconds, so a retry really asks again. */
export function forgetMusicFailures(): void {
  for (const [k, m] of memo) if ((m.v as Partial<MusicFail> | null)?.error) memo.delete(k);
}

async function request<T>(path: string, init: FnInit, ctrl: AbortController): Promise<T | MusicFail> {
  const tok = await getToken();
  if (!tok) return { error: "login" };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, init.timeoutMs ?? 12000);
  try {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${tok}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok && body && typeof body === "object" && !(body as { error?: unknown }).error) return body as T;
    const code = errorCode(res.status, body);
    if (code === "login") token = undefined; // read it again next time
    return { error: code };
  } catch {
    if (timedOut) return { error: "timeout" };
    if (ctrl.signal.aborted) return { error: "aborted" };
    return { error: "offline" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call to a music function: a client timeout, identical GETs in flight
 * shared, successes kept for `keepMs`. A caller's AbortSignal answers it
 * "aborted" at once; the request itself stops only when nobody waits for it.
 */
async function callFn<T>(path: string, init: FnInit, opts: CallOpts = {}): Promise<T | MusicFail> {
  const { signal } = opts;
  if (signal?.aborted) return { error: "aborted" };
  const key = (init.method ?? "GET") === "GET" ? path : null;
  if (key) {
    const m = memo.get(key);
    if (m && m.until > Date.now()) return m.v as T | MusicFail;
    if (m) memo.delete(key);
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { error: "offline" };
  let entry = key ? inflight.get(key) : undefined;
  if (!entry) {
    const ctrl = new AbortController();
    const e: { p: Promise<unknown>; users: number; ctrl: AbortController } = { p: Promise.resolve(null), users: 0, ctrl };
    e.p = request<T>(path, init, ctrl).then((r) => {
      if (key) {
        if (inflight.get(key) === e) inflight.delete(key);
        const err = (r as MusicFail).error;
        if (!err && init.keepMs) memo.set(key, { until: Date.now() + init.keepMs, v: r });
        else if (err && !NO_KEEP.has(err)) memo.set(key, { until: Date.now() + FAIL_KEEP_MS, v: r });
      }
      return r;
    });
    if (key) inflight.set(key, e);
    entry = e;
  }
  const en = entry;
  en.users++;
  return new Promise<T | MusicFail>((resolve) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      if (--en.users <= 0) {
        // Nobody waits any more: stop it, and let the next caller start afresh.
        if (key && inflight.get(key) === en) inflight.delete(key);
        en.ctrl.abort();
      }
      resolve({ error: "aborted" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void en.p.then((r) => {
      signal?.removeEventListener("abort", onAbort);
      if (done) return;
      done = true;
      en.users--;
      resolve(r as T | MusicFail);
    });
  });
}

/** Last request wins: each next() aborts the one before. */
export function lastRequest(): { next: () => AbortSignal; abort: () => void } {
  let c: AbortController | null = null;
  return {
    next: () => {
      c?.abort();
      c = new AbortController();
      return c.signal;
    },
    abort: () => {
      c?.abort();
      c = null;
    },
  };
}

/** lastRequest() for a component: the pending request is aborted on unmount. */
export function useLastRequest(): { next: () => AbortSignal; abort: () => void } {
  const r = useRef<ReturnType<typeof lastRequest> | null>(null);
  if (!r.current) r.current = lastRequest();
  useEffect(() => () => r.current?.abort(), []);
  return r.current;
}

// ---- Search -----------------------------------------------------------------

export type SearchResult = { tracks: Track[] } | MusicFail;

export async function searchMusic(
  q: string,
  opts: { channelId?: string; order?: "relevance" | "viewCount"; signal?: AbortSignal } = {}
): Promise<SearchResult> {
  const params = new URLSearchParams({ q });
  if (opts.channelId) params.set("channelId", opts.channelId);
  if (opts.order) params.set("order", opts.order);
  const r = await callFn<{ tracks?: Track[] }>(`/.netlify/functions/music-search?${params}`, { keepMs: 5 * 60 * 1000 }, opts);
  if ("error" in r) return r as MusicFail;
  return Array.isArray(r.tracks) ? { tracks: r.tracks } : { error: "server" };
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

function callPlaylistFn<T>(params: Record<string, string>, opts?: CallOpts): Promise<T | MusicFail> {
  return callFn<T>(`/.netlify/functions/music-playlist?${new URLSearchParams(params)}`, { keepMs: 10 * 60 * 1000 }, opts);
}

/** One public YouTube / YouTube Music playlist, with its songs. */
export function fetchYtPlaylist(list: string, opts?: CallOpts): Promise<YtPlaylist | MusicFail> {
  return callPlaylistFn<YtPlaylist>({ list }, opts);
}

// A playlist search costs 100 of the key's 10,000 daily units: the suggested
// ones are kept in this browser for a day.
const FIND_CACHE = "gtd-music-find:";
const DAY = 24 * 60 * 60 * 1000;

export async function findYtPlaylists(q: string, cache = false, opts?: CallOpts): Promise<{ lists: YtPlaylist[] } | MusicFail> {
  const key = FIND_CACHE + q.toLowerCase();
  if (cache) {
    try {
      const hit = JSON.parse(localStorage.getItem(key) ?? "null") as { at: number; lists: YtPlaylist[] } | null;
      if (hit && Date.now() - hit.at < DAY && Array.isArray(hit.lists)) return { lists: hit.lists };
    } catch {
      /* no storage: just ask */
    }
  }
  const r = await callPlaylistFn<{ lists: YtPlaylist[] }>({ q }, opts);
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

/** Answers are kept for this session, so moving between pages asks nothing again. */
function browse<T>(params: Record<string, string>, opts?: CallOpts): Promise<T | MusicFail> {
  return callFn<T>(`/.netlify/functions/music-browse?${new URLSearchParams(params)}`, { keepMs: 60 * 60 * 1000 }, opts);
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
export function fetchCharts(country: string, opts?: CallOpts) {
  return browse<{ lists: ChartList[]; artists: ChartArtist[] }>({ charts: country }, opts);
}

/** YouTube Music's Explore: trends, new music videos. */
export function fetchExplore(opts?: CallOpts) {
  return browse<{ sections: { title: string; tracks: Track[] }[] }>({ explore: "1" }, opts);
}

/** Any YouTube Music artist (from the charts): name, picture, songs. */
export function fetchMusicArtist(id: string, opts?: CallOpts) {
  return browse<{ name: string; thumb: string; tracks: Track[] }>({ artist: id }, opts);
}

/** Search suggestions while typing ([] on any failure, including an abort). */
export async function fetchSuggestions(q: string, opts?: CallOpts): Promise<string[]> {
  const r = await browse<{ suggestions: string[] }>({ suggest: q.trim().toLowerCase() }, opts);
  return "suggestions" in r && Array.isArray(r.suggestions) ? r.suggestions : [];
}

/**
 * "Radio": the song plays at once, then ~50 like it are added after it when
 * they arrive (dropped if the user has played something else meanwhile).
 * Returns an error code, "empty", or null.
 */
export async function playRadio(t: { id: string; title: string; channel?: string; thumb?: string }, label: string): Promise<MusicErrorCode | "empty" | null> {
  const seed: Track = { id: t.id, title: t.title, channel: t.channel ?? "", thumb: t.thumb };
  music.play({ kind: "videos", label: `${label} · ${t.title}`, key: `radio:${t.id}`, tracks: [seed], start: 0 });
  const seq = playSeq;
  toast(tr("music.radioLoading"));
  const r = await browse<{ tracks: Track[] }>({ radio: t.id });
  if (seq !== playSeq) return null;
  if ("error" in r) return r.error === "aborted" ? null : r.error;
  const more = (r.tracks ?? []).filter((x) => x.id !== t.id);
  if (!more.length) return "empty";
  music.enqueue(more, "end", label);
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

const SPOTIFY_MS = 25000;

/** A public Spotify playlist (first 100 songs) or album: name, cover, songs. */
export function fetchSpotify(url: string, opts?: CallOpts) {
  return callFn<SpotifyList>(`/.netlify/functions/music-spotify?url=${encodeURIComponent(url.trim())}`, { timeoutMs: SPOTIFY_MS, keepMs: 10 * 60 * 1000 }, opts);
}

/**
 * Finds each song on YouTube, 15 per call, two calls at a time; `progress`
 * is told how many are done. The songs YouTube failed on (`failed`, or a whole
 * batch that failed) are asked once more. Returns one Track or null per song.
 */
export async function matchSpotify(songs: SpotifySong[], progress: (done: number) => void, cancelled: () => boolean, opts?: CallOpts): Promise<(Track | null)[]> {
  const out: (Track | null)[] = new Array(songs.length).fill(null);
  const batches: number[] = [];
  const SIZE = 15;
  for (let i = 0; i < songs.length; i += SIZE) batches.push(i);
  let done = 0;
  const call = (part: SpotifySong[]) =>
    callFn<{ matches: (Track | null)[]; failed?: number[] }>(`/.netlify/functions/music-spotify`, { method: "POST", body: { songs: part }, timeoutMs: SPOTIFY_MS }, opts);
  const worker = async () => {
    while (batches.length && !cancelled() && !opts?.signal?.aborted) {
      const start = batches.shift()!;
      const part = songs.slice(start, start + SIZE);
      const r = await call(part);
      // The indexes to ask again: those YouTube failed on, or all of a failed batch.
      let again: number[] = [];
      if ("error" in r) again = r.error === "aborted" ? [] : part.map((_, i) => i);
      else {
        r.matches.forEach((m, i) => (out[start + i] = m ?? null));
        again = (r.failed ?? []).filter((i) => i >= 0 && i < part.length);
      }
      if (again.length && !cancelled()) {
        const r2 = await call(again.map((i) => part[i]));
        if (!("error" in r2)) r2.matches.forEach((m, k) => (out[start + again[k]] = m ?? null));
      }
      done += part.length;
      progress(done);
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}
