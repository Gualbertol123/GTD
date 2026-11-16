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
  /**
   * YouTube refused to start from the app (a phone's autoplay rule, a wall or
   * overlay in YouTube's frame): its frame is shown so a tap inside it starts the music.
   */
  needsTap: boolean;
  /** A short message ("Added to the queue"). Never shown in place of the song title. */
  toast: Toast | null;
  /** "I have YouTube Premium": the player comes from youtube.com, not youtube-nocookie.com. */
  premium: boolean;
  /** Bumped to make MusicPlayer build a new YouTube player (the stall rescue's last step). */
  rebuild: number;
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
  needsTap: false,
  toast: null,
  premium: readPref("musicPremium") === "1",
  rebuild: 0,
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
  const last = useRef<SelMemo<T> | null>(null);
  const get = () => selectMemo(last, state, sel, eq);
  return useSyncExternalStore(subscribe, get, get);
}

/** useMusicSel's cache: the last state, selector and value. */
export type SelMemo<T> = { s: MusicState; sel: (s: MusicState) => T; v: T };

/**
 * The value for `sel` on `s`, cached on both. A new selector (one that closes
 * over a new `t` or prop) is run again even if the state did not change; an
 * equal result still gives back the previous reference, so React stays calm.
 */
export function selectMemo<T>(last: { current: SelMemo<T> | null }, s: MusicState, sel: (s: MusicState) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const l = last.current;
  if (l && l.s === s && l.sel === sel) return l.v;
  const v = sel(s);
  if (l && eq(l.v, v)) {
    last.current = { s, sel, v: l.v };
    return l.v;
  }
  last.current = { s, sel, v };
  return v;
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
/** The ids the app last gave YouTube (for the log; YouTube's own list is what is checked). */
let ytIds: string[] | null = null;
/**
 * YouTube takes at most 200 ids: a longer queue is given as a 200-song window
 * starting at queue entry `ytBase` (YouTube's entry k is the queue's ytBase + k).
 */
export const YT_MAX = 200;
let ytBase = 0;
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
let localVolAt = -1e9;
let lastCmd = { kind: "", at: 0 };
/** When the app last asked YouTube to pause (a PAUSED right after Play is its echo only if this is recent). */
let lastPauseAt = -1e9;
/** The last video YouTube really played: its later BUFFERING is a reload (network), not a start. */
let startedId: string | null = null;
const pageHidden = () => typeof document !== "undefined" && document.hidden;
/** The app asked YouTube to pause and it has not confirmed yet: a late start is undone. */
let pausePending = false;
/** The "did it start?" check (armBlocked); undefined when none is pending. */
let blockTimer: ReturnType<typeof setTimeout> | undefined;
/** A song ended: did YouTube really move on to the next one? (armAdvance) */
let advanceTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Videos the app has left since YouTube last confirmed a song: their late
 * events are ignored. Any other video YouTube reports is followed (YouTube
 * may move on by itself, past a song it cannot play).
 */
const leftIds = new Set<string>();
/** YouTube says PLAYING but the second stands still: what was tried (0 none, 1 seek, 2 reload, 3 gave up). */
let frozenStage = 0;
/** Times YouTube was found muted by itself in audio mode (muted autoplay). */
let muteTries = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let tickN = 0;
let loopApplied: boolean | null = null;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---- Console log ----------------------------------------------------------------
// Every command sent to YouTube, every YouTube event and what the app decided,
// as "[music] …" lines in the browser console. On by default; turn it off with
// localStorage.setItem("gtd-music-log", "0"). The last 500 lines are also kept
// in window.__music.log; window.__music.dump() prints them with the state.

const STATE_NAME: Record<number, string> = { [-1]: "UNSTARTED", 0: "ENDED", 1: "PLAYING", 2: "PAUSED", 3: "BUFFERING", 5: "CUED" };
const ytStateName = (n: number) => STATE_NAME[n] ?? `state ${n}`;
export const musicLog: { t: number; ev: string; data?: unknown }[] = [];

function logOn(): boolean {
  if (import.meta.env?.MODE === "test") return false;
  try {
    return localStorage.getItem("gtd-music-log") !== "0";
  } catch {
    return true;
  }
}

/** One line in the console and in the in-memory log. */
export function mlog(ev: string, data?: unknown, level: "info" | "warn" = "info"): void {
  const t = Math.round(now());
  musicLog.push({ t, ev, data });
  if (musicLog.length > 500) musicLog.shift();
  if (!logOn() || typeof console === "undefined") return;
  const line = `[music] ${(t / 1000).toFixed(2)}s ${ev}`;
  if (level === "warn") console.warn(line, data ?? "");
  else console.info(line, data ?? "");
}

/** What the app and YouTube each think, in one object (for log lines). */
function snap(): Record<string, unknown> {
  const p = yt;
  return {
    app: `${state.status}${state.playing ? "" : " (paused intent)"}`,
    index: state.index,
    queue: state.queue.length,
    now: state.now?.id ?? null,
    expect: expectId,
    yt: p ? ytStateName(safe(() => p.getPlayerState(), -9)) : "no player",
    ytVideo: p ? safe(() => p.getVideoData()?.video_id ?? "", "?") : null,
    ytIndex: p ? safe(() => p.getPlaylistIndex(), -1) : null,
    ytTime: p ? Math.round(safe(() => p.getCurrentTime(), 0) || 0) : null,
    ytList: p ? safe(() => p.getPlaylist()?.length ?? 0, 0) : null,
    sent: ytIds ? `${ytIds.length} ids from song ${ytBase + 1}` : null,
    needsTap: state.needsTap,
    adopting: !!adopting,
  };
}

const YT_COMMANDS = new Set(["loadPlaylist", "cuePlaylist", "playVideoAt", "playVideo", "pauseVideo", "stopVideo", "nextVideo", "previousVideo", "seekTo", "setLoop", "mute", "unMute"]);

const START_COMMANDS = new Set(["loadPlaylist", "playVideoAt", "playVideo"]);

/** The last tap anywhere on the page (for the log: was a command sent inside a gesture?). */
let lastTapAt = -1e9;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pointerup", () => (lastTapAt = now()), { capture: true, passive: true });
}

/** The browser's user activation (true: inside a tap) and the ms since the last tap. */
function gesture(): { gesture: boolean | null; sinceTapMs: number } {
  const ua = typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation : undefined;
  return { gesture: ua ? ua.isActive : null, sinceTapMs: Math.round(now() - lastTapAt) };
}

/** The player, with every command logged (getters and setVolume are not, they are too chatty). */
function logged(p: YtLike): YtLike {
  if (typeof Proxy === "undefined") return p;
  return new Proxy(p, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (typeof v !== "function") return v;
      const name = String(key);
      return (...args: unknown[]) => {
        if (YT_COMMANDS.has(name)) {
          const shown: unknown[] = args.map((a) => (Array.isArray(a) ? `[${a.length} ids, first ${String(a[0])}]` : a));
          // Was it sent inside a tap? Phones start media only from one.
          if (START_COMMANDS.has(name)) shown.push(gesture());
          mlog(`→ YouTube.${name}`, shown);
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

if (typeof window !== "undefined") {
  (window as unknown as { __music?: unknown }).__music = {
    log: musicLog,
    state: () => state,
    snap: () => snap(),
    dump: () => {
      console.table(musicLog.map((e) => ({ s: (e.t / 1000).toFixed(2), event: e.ev, data: typeof e.data === "string" ? e.data : JSON.stringify(e.data) })));
      console.info("[music] now", snap());
    },
  };
}

function cmd(kind: string): void {
  lastCmd = { kind, at: now() };
  pausePending = kind === "pause";
  if (kind === "pause") lastPauseAt = lastCmd.at;
  // A new command from the user: the stall rescue starts over.
  frozenStage = 0;
  stall.stage = 0;
}

/** A start YouTube reports now is the echo of a load the app has since paused. */
function ownPauseWanted(): boolean {
  return pausePending && now() - lastCmd.at < 10000;
}

/** YouTube's player is ready (MusicPlayer). Everything asked before now is applied. */
export function attachPlayer(p0: YtLike): void {
  const p = logged(p0);
  yt = p;
  mlog("player ready", { pending: state.source ? sourceLogName(state.source) : null, playing: state.playing });
  ytIds = null;
  ytBase = 0;
  loopApplied = null;
  p.setVolume(state.volume);
  // The app's sound setting wins: YouTube may start muted (muted autoplay).
  if (state.muted) p.mute();
  else p.unMute();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 500);
  if (state.failed) setMusic({ failed: null });
  syncToPlayer();
}

/** The player is going away (rebuild, unmount): later commands wait for the next one. */
export function detachPlayer(): void {
  mlog("player detached (rebuild or unmount)");
  if (yt) resumeAt = safe(() => yt!.getCurrentTime(), 0) || time.time;
  yt = null;
  ytIds = null;
  ytBase = 0;
  expectId = null;
  leftIds.clear();
  clearInterval(tickTimer);
  clearInterval(adoptTimer);
  clearBlock();
  clearTimeout(advanceTimer);
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

/** Where YouTube's 200-id window starts so that queue entry i is in it. */
export function ytWindowStart(len: number, i: number): number {
  if (len <= YT_MAX) return 0;
  return Math.max(0, Math.min(i, len - YT_MAX));
}

/**
 * Is YouTube's real list (getPlaylist) exactly the queue's window at ytBase,
 * with entry i in it? Only then can it jump (playVideoAt) or move on by
 * itself. YouTube drops ids it cannot use and keeps at most 200, so the ids
 * the app sent are not proof.
 */
function ytAligned(p: YtLike, q: Track[], i: number): boolean {
  if (i < ytBase || i >= ytBase + YT_MAX || i >= q.length) return false;
  const real = safe(() => p.getPlaylist(), null);
  const want = q.slice(ytBase, ytBase + YT_MAX);
  return !!real && real.length === want.length && real.every((id, k) => id === want[k].id);
}

/** A new song is asked for: the video YouTube is on now (and the one asked before) are left behind. */
function setExpect(id: string | null): void {
  const cur = yt ? safe(() => yt!.getVideoData()?.video_id ?? "", "") : "";
  if (cur && cur !== id) leftIds.add(cur);
  if (expectId && expectId !== id) leftIds.add(expectId);
  if (id) leftIds.delete(id);
  expectId = id;
  expectAt = now();
}

/**
 * Give YouTube the queue and start (or cue) song i. `force`: load the list
 * again even if YouTube seems to have it (it did not move on by itself).
 */
function ytLoad(i: number, start = 0, cue = false, force = false): void {
  const p = yt;
  const q = state.queue;
  setExpect(q[i]?.id ?? null);
  if (!p) {
    resumeAt = start;
    return;
  }
  const jump = !cue && !force && start === 0 && ytAligned(p, q, i);
  const base = jump ? ytBase : ytWindowStart(q.length, i);
  const ids = q.slice(base, base + YT_MAX).map((t) => t.id);
  mlog(`load song ${i + 1}/${q.length}`, {
    id: expectId,
    title: q[i]?.title,
    start: Math.round(start),
    mode: cue ? "cue (stay paused)" : jump ? "jump in YouTube's list" : force ? "load list again (forced)" : "load list",
    ...(q.length > YT_MAX ? { window: `${base + 1}-${base + ids.length}` } : {}),
  });
  noteLoad(expectId);
  if (cue) p.cuePlaylist(ids, i - base, start);
  else if (jump) p.playVideoAt(i - base);
  else p.loadPlaylist(ids, i - base, start);
  ytBase = base;
  ytIds = ids;
  if (!cue) armBlocked();
}

/** Go to song i of the queue: the state changes now, YouTube follows. */
function goTo(i: number, auto = false): void {
  const q = state.queue;
  if (i < 0 || i >= q.length) return;
  if (!auto) {
    errCount = 0;
    unmuteInTap();
  }
  cmd("play");
  clearTimeout(advanceTimer);
  seekTarget = null;
  setTime(0, 0);
  setMusic({ index: i, now: nowOf(q[i]), playing: true, status: "loading" });
  ytLoad(i);
}

/** Inside the user's tap, YouTube may still unmute itself (a phone allows sound only from a tap). */
function unmuteInTap(): void {
  const p = yt;
  if (p && !state.muted && safe(() => p.isMuted(), false)) {
    mlog("YouTube is muted: unmuting it inside the tap");
    p.unMute();
  }
}

/** A YouTube list whose ids come later (mix, artist, pasted link). */
function startList(list: string, shuffle: boolean): void {
  const adds = adopting?.adds ?? [];
  mlog("YouTube list: waiting for its songs", { list, shuffle });
  adopting = { list, shuffle, adds };
  ytIds = null;
  ytBase = 0;
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
      if (!adopting) return;
      // The list never told its ids: stop waiting for them (also while paused,
      // so a later Play sends playVideo) and play it as YouTube has it.
      adopting = null;
      mlog("YouTube list gave no song ids in 10 s: playing it as YouTube has it", { playing: state.playing }, "warn");
      if (yt && state.playing) {
        yt.playVideo();
        armBlocked();
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
  mlog(`YouTube list read: ${ids.length} songs`, { shuffle: a.shuffle });
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
  ytBase = 0;
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
  mlog("mix: next artist");
  if (!mix) mix = { order: shuffled(ARTISTS), pos: 0 };
  mix.pos = (mix.pos + 1) % mix.order.length;
  original = null;
  setTime(0, 0);
  setMusic({ queue: [], index: -1, now: null, playing: true, status: "loading" });
  startList(mix.order[mix.pos].list, true);
}

function sourceLogName(s: Source): string {
  if (s.kind === "videos") return `${s.key ?? "songs"} "${s.label}"`;
  if (s.kind === "list") return `list ${s.list}`;
  if (s.kind === "artist") return `artist ${s.artist}`;
  return "mix";
}

/** The same song loaded again and again in a short time: say so (a load loop). */
const recentLoads: { id: string | null; at: number }[] = [];
function noteLoad(id: string | null): void {
  const t = now();
  recentLoads.push({ id, at: t });
  while (recentLoads.length && t - recentLoads[0].at > 20000) recentLoads.shift();
  const same = recentLoads.filter((l) => l.id === id).length;
  if (same >= 3) mlog(`the same song was loaded ${same} times in 20 s (a loop?)`, snap(), "warn");
}

/** Stop where we are (end of the queue, or nothing can play). */
function halt(message?: string): void {
  mlog("stop", { why: message ?? "end of the queue", ...snap() }, "warn");
  clearBlock();
  clearTimeout(advanceTimer);
  expectId = null;
  setMusic({ playing: false, status: "paused" });
  if (message) toast(message, "error");
}

function clearBlock(): void {
  clearTimeout(blockTimer);
  blockTimer = undefined;
}

/**
 * The app stops waiting for YouTube to start: it shows paused and YouTube's
 * own frame (needsTap), where a tap always starts the music, even on a phone
 * that refuses a start from the app. YouTube is NOT paused: a start that
 * arrives late is still followed (onYtState PLAYING).
 */
function giveUp(why: string, textKey = "music.tapToPlay"): void {
  clearBlock();
  mlog(`gave up waiting (${why}): showing paused and YouTube's frame to tap`, { ...snap(), ...gesture() }, "warn");
  setMusic({ playing: false, status: "paused", needsTap: true });
  toast(tr(textKey));
}

/**
 * Did it start? A few seconds after a play, YouTube must be PLAYING (its
 * PLAYING event clears this check). Still BUFFERING with the second not
 * moving: one more wait (a slow network). Otherwise, or after that, the app
 * gives up (giveUp): a phone's autoplay rule, a wall in YouTube's frame, or a
 * dead network never leave a spinner turning.
 */
function armBlocked(ms = state.needsTap ? 3000 : 6000, retry = false): void {
  clearBlock();
  const p0 = yt;
  const t0 = p0 ? safe(() => p0.getCurrentTime(), 0) || 0 : 0;
  blockTimer = setTimeout(() => {
    blockTimer = undefined;
    const p = yt;
    if (!p || !state.playing || adopting) return;
    const s = safe(() => p.getPlayerState(), S.PLAYING);
    // PLAYING: started (a frozen second is the watchdog's job).
    if (s === S.PLAYING) return;
    const t = safe(() => p.getCurrentTime(), 0) || 0;
    const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
    if (s === S.BUFFERING && vid && vid === startedId) {
      // The song had already played: YouTube is stuck reloading it (network).
      // Not a refused start: never give up, rescue it step by step.
      if (t > t0 + 0.1) return armBlocked(8000, true); // slow, but it moves
      return rescue(p, t, "stuck buffering in the middle of the song");
    }
    // In the background the browser slows everything down: never give up a
    // start there; the check runs again (and when the page is shown).
    if (pageHidden()) {
      if (!retry) mlog("start check: page in the background, not giving up: checking again later", snap());
      return armBlocked(8000, true);
    }
    if (s === S.BUFFERING) {
      if (t > t0 + 0.1) {
        mlog("start check: still buffering but the second moves: waiting", { t: Math.round(t) });
        return armBlocked(8000, retry);
      }
      if (!retry) {
        mlog(`start check: buffering ${ms / 1000} s with the second at ${Math.round(t)}: waiting 8 s more`, snap(), "warn");
        return armBlocked(8000, true);
      }
      return giveUp("buffering with no progress", "music.stalled");
    }
    giveUp(`YouTube is ${ytStateName(s)} ${ms / 1000} s after play (autoplay refused?)`);
  }, ms);
}

/**
 * A song ended and YouTube should move on to queue entry n by itself: if a
 * few seconds later it is still at the end (or elsewhere), the list is given
 * again (once). The PLAYING of song n, or any new command, clears this.
 */
function armAdvance(n: number): void {
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    advanceTimer = undefined;
    const p = yt;
    const want = state.queue[n]?.id;
    if (!p || !want || expectId !== want || !state.playing || state.index !== n) return;
    const s = safe(() => p.getPlayerState(), S.PLAYING);
    const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
    if (s === S.PLAYING || s === S.BUFFERING || (vid === want && s !== S.ENDED)) return;
    mlog(`YouTube did not move on to song ${n + 1} after the last one ended: loading it again`, snap(), "warn");
    ytLoad(n, 0, false, true);
  }, 4000);
}

/** Which queue entry YouTube is playing. */
function locate(vid: string): number {
  const q = state.queue;
  const i = state.index;
  if (q[i]?.id === vid) return i;
  if (q[i + 1]?.id === vid) return i + 1;
  const yi = safe(() => yt?.getPlaylistIndex() ?? -1, -1);
  if (yi >= 0 && q[ytBase + yi]?.id === vid) return ytBase + yi;
  // YouTube moved on by itself: the first such entry after the current one.
  const after = q.findIndex((t, k) => k > i && t.id === vid);
  return after >= 0 ? after : q.findIndex((t) => t.id === vid);
}

/** An event about a video the app has just left (a late echo of the song before): ignore it. */
function isLeftEcho(vid: string): boolean {
  return !!expectId && !!vid && vid !== expectId && leftIds.has(vid) && now() - expectAt < 8000;
}

/** YouTube's onStateChange. */
export function onYtState(s: number): void {
  const p = yt;
  if (!p) return;
  const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
  mlog(`← YouTube ${ytStateName(s)}`, { video: vid, app: state.status, playing: state.playing, expect: expectId });
  // Only the song the app left is set aside; any other video is the one
  // YouTube really plays (it may have moved past a song it could not play).
  if (s !== S.UNSTARTED && s !== S.CUED && isLeftEcho(vid)) {
    mlog(`  ignored: about ${vid}, which the app has left (it asked for ${expectId})`);
    return;
  }

  if (s === S.CUED) {
    if (adopting) adopt();
    return;
  }
  if (s === S.UNSTARTED) {
    if (state.playing && state.status !== "loading") setMusic({ status: "loading" });
    if (state.playing && !blockTimer && !adopting) {
      mlog("  no start check pending while loading: arming one");
      armBlocked();
    }
    return;
  }
  if (s === S.BUFFERING) {
    if (!state.playing) {
      // Paused while it loaded: keep it paused.
      if (ownPauseWanted() || !state.source) {
        mlog("  paused again: the app asked to pause while it loaded");
        p.pauseVideo();
        return;
      }
      // The app gave up waiting: only a real PLAYING brings it back (no
      // spinner again for a start that may never come).
      if (state.needsTap) {
        mlog("  buffering after the app gave up: waiting for PLAYING to follow it");
        return;
      }
      // Play pressed in YouTube's frame, or a media key: the user's wish, checked like any start.
      mlog("  started from YouTube's frame or a media key: following it");
      setMusic({ playing: true, status: "buffering" });
      armBlocked();
      return;
    }
    setMusic({ status: "buffering" });
    if (!blockTimer) {
      // A song that already played and reloads: look again sooner (the rescue
      // ladder starts there); a start keeps the usual wait.
      const midSong = !!vid && vid === startedId;
      mlog(midSong ? "  YouTube reloads the song: checking it in 4 s" : "  buffering with no start check pending: arming one");
      armBlocked(midSong ? 4000 : undefined);
    }
    return;
  }
  if (s === S.PLAYING) {
    if (vid) startedId = vid;
    expectId = null;
    leftIds.clear();
    clearBlock();
    clearTimeout(advanceTimer);
    errCount = 0;
    if (adopting) adopt();
    if (!state.playing) {
      if (ownPauseWanted() || !state.source) {
        mlog("  paused again: the app asked to pause while it loaded");
        p.pauseVideo();
        setMusic({ status: "paused" });
        return;
      }
      // Started from YouTube's frame, a media key, or a late start: follow it.
      mlog("  YouTube started on its own (frame, media key or a late start): following it");
      setMusic({ playing: true });
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
      if (index !== state.index) mlog(`  YouTube is at song ${index + 1}, not ${state.index + 1}: the app follows`);
      const t = q[index];
      // The app's title wins; a song known only by id takes YouTube's.
      if (!t.title && d.title) {
        q = q.slice();
        q[index] = { ...t, title: d.title, channel: t.channel || d.author || "" };
        // The same entry in the unshuffled order, so the two still match by identity.
        if (original) {
          const oi = original.indexOf(t);
          if (oi >= 0) {
            original = original.slice();
            original[oi] = q[index];
          }
        }
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
    pausePending = false;
    // Our own pause echoing back after a quick Play: not the user's wish.
    // Only when a pause was really sent just before that Play.
    if (state.playing && lastCmd.kind === "play" && now() - lastCmd.at < 900 && lastCmd.at - lastPauseAt < 900) {
      mlog("  ignored: echo of an earlier pause right after Play");
      return;
    }
    // Paused while the app is waiting for the start: that is YouTube leaving
    // the previous song (it reports PAUSED, often with no video id, a few ms
    // after loadPlaylist / playVideoAt), not a refusal. A real refusal leaves
    // YouTube standing still, which the start check (armBlocked) catches.
    if (state.playing && (state.status === "loading" || state.status === "buffering")) {
      mlog("  ignored: YouTube leaving the previous song while the new one loads");
      if (!blockTimer) armBlocked();
      return;
    }
    if (state.playing || state.status !== "paused") {
      mlog("  paused in YouTube (frame, media key or the system): following it");
      setMusic({ playing: false, status: "paused" });
    }
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
      mlog("  end of the queue");
      setMusic({ playing: false, status: "paused" });
      return;
    }
    // YouTube's real list is the queue's: it moves on by itself (also in a
    // background tab). Otherwise (the queue changed, YouTube dropped or capped
    // ids) it gets the queue again, at song n.
    const aligned = ytAligned(p, q, n);
    mlog(`  song ended: on to ${n + 1}/${q.length}`, { id: q[n].id, youtubeMovesOnItself: aligned });
    setTime(0, 0);
    setMusic({ index: n, now: nowOf(q[n]), status: "loading" });
    if (!aligned) {
      ytLoad(n, 0, false, true);
    } else {
      setExpect(q[n].id);
      armBlocked();
    }
    armAdvance(n);
  }
}

const ERROR_MEANING: Record<number, string> = {
  2: "bad request (player parameters)",
  5: "HTML5 player error",
  100: "video not found / private / removed",
  101: "owner does not allow embedding",
  150: "owner does not allow embedding",
  153: "no referrer sent (embed refused)",
};

/** YouTube's onError: 2 / 153 = the player cannot play here at all; others = this video. */
export function onYtError(code: number): void {
  const p = yt;
  if (!p) return;
  const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
  mlog(`← YouTube ERROR ${code}`, { video: vid, expect: expectId, meaning: ERROR_MEANING[code] ?? "unknown", errorsInARow: errCount + 1 }, "warn");
  // YouTube may have moved past the song asked for by itself (it skips ids
  // it cannot use): an error about a later entry is an error on that entry.
  const ahead = vid && !leftIds.has(vid) ? state.queue.findIndex((t, k) => k > state.index && t.id === vid) : -1;
  if (expectId && vid && vid !== expectId && ahead < 0 && now() - expectAt < 8000) {
    mlog("  ignored: about a song the app has already left");
    return;
  }
  expectId = null;
  if (code === 2 || code === 153) return halt(tr("music.playerError"));
  if (ahead >= 0) {
    mlog(`  YouTube had moved on to song ${ahead + 1} by itself: the skip goes on from there`);
    setMusic({ index: ahead, now: nowOf(state.queue[ahead]) });
  }
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
  if (tickN % 2 === 0) watchdog(p);
  if (state.status !== "playing" && tickN % 3 !== 0) return;
  const t = safe(() => p.getCurrentTime(), 0) || 0;
  const d = safe(() => p.getDuration(), 0) || 0;
  if (seekTarget !== null) {
    // YouTube reports the old position for a moment after a seek: wait for it.
    if (Math.abs(t - seekTarget) < 1.5 || now() - seekAt > 1500) seekTarget = null;
  }
  if (seekTarget === null && (Math.abs(t - time.time) >= 0.25 || d !== time.duration)) setTime(t, d);
  // Right after a change here YouTube's getters still report the old value.
  if (now() - localVolAt <= 1500) return;
  const muted = safe(() => p.isMuted(), state.muted);
  if (state.mode === "video") {
    // YouTube's own volume controls show only in video mode: the app follows them.
    const vol = safe(() => p.getVolume(), state.volume);
    const patch: Partial<MusicState> = {};
    if (muted !== state.muted) patch.muted = muted;
    if (typeof vol === "number" && !muted && vol !== state.volume) patch.volume = vol;
    if (Object.keys(patch).length) setMusic(patch);
    return;
  }
  // Audio mode: YouTube's controls are hidden, so the app's setting wins. A
  // phone may start YouTube muted (muted autoplay): unmute it; if that is
  // refused too, show YouTube's frame, where a tap turns the sound on.
  if (muted === state.muted) {
    muteTries = 0;
    return;
  }
  if (state.muted) {
    mlog("YouTube is not muted but the app is: muting it");
    p.mute();
    return;
  }
  // Only once it plays (a load may report muted for a moment); asked twice: the frame is shown.
  if (state.status !== "playing" || muteTries >= 2) return;
  muteTries++;
  if (muteTries === 1) {
    mlog("YouTube muted itself (muted autoplay?): unmuting it", { volume: state.volume, ...gesture() }, "warn");
    p.setVolume(state.volume);
    p.unMute();
    return;
  }
  mlog("YouTube stays muted after unMute: showing its frame so a tap turns the sound on", snap(), "warn");
  setMusic({ needsTap: true });
  toast(tr("music.tapToUnmute"));
}

/**
 * Once a second: does what the app shows match what YouTube does? Logs a
 * warning when it doesn't, and puts it right where that is safe:
 * - YouTube plays (the second moves) but the app still shows loading or
 *   paused (its PLAYING event was missed or set aside, or a late start): the
 *   app follows YouTube. The moving second also clears needsTap.
 * - The app wants music and no start check is pending: one is armed, so a
 *   spinner never turns forever.
 * - YouTube says PLAYING but the second does not move (a dead frame, network):
 *   after 10 s a seek, after 20 s the song is loaded again at that second,
 *   after 30 s the app gives up (paused + YouTube's frame). The player itself
 *   is never destroyed on a timer (a long ad would be lost).
 */
let wd = { since: 0, kind: "", lastT: -1, stillSince: 0 };
function watchdog(p: YtLike): void {
  const ys = safe(() => p.getPlayerState(), -9);
  const t = safe(() => p.getCurrentTime(), 0) || 0;
  const tnow = now();
  const moving = ys === S.PLAYING && wd.lastT >= 0 && Math.abs(t - wd.lastT) >= 0.05;
  let kind = "";
  if (moving && state.status !== "playing" && state.playing) kind = "yt-playing-app-not";
  else if (state.playing && ys !== S.PLAYING && ys !== S.BUFFERING && !adopting) kind = "app-playing-yt-not";
  else if (moving && !state.playing && !ownPauseWanted()) kind = "yt-playing-app-paused";
  if (kind !== wd.kind) wd = { ...wd, since: tnow, kind };
  const forMs = tnow - wd.since;
  if (kind === "yt-playing-app-not" && forMs > 1500) {
    mlog("watchdog: YouTube is playing but the app still shows loading: following YouTube", snap(), "warn");
    expectId = null;
    onYtState(S.PLAYING);
    wd.kind = "";
  } else if (kind === "yt-playing-app-paused" && forMs > 1500) {
    mlog("watchdog: YouTube is playing while the app shows paused: following YouTube", snap(), "warn");
    setMusic({ playing: true });
    onYtState(S.PLAYING);
    wd.kind = "";
  } else if (kind === "app-playing-yt-not" && forMs > 8000 && Math.round(forMs / 1000) % 8 === 0) {
    mlog(`watchdog: the app wants music but YouTube is ${ytStateName(ys)} for ${Math.round(forMs / 1000)} s`, snap(), "warn");
  }
  // Waiting for a start with no check pending (a path that did not arm one).
  if (state.playing && state.status !== "playing" && ys !== S.PLAYING && !blockTimer && !adopting) {
    mlog("watchdog: the app waits for YouTube with no start check pending: arming one", snap(), "warn");
    armBlocked();
  }
  if (moving) {
    frozenStage = 0;
    if (stall.stage) {
      mlog(`rescue worked at step ${stall.stage}: the song plays on`, snap());
      stall.stage = 0;
    }
    // (Not while YouTube is still muted by itself: the frame is where a tap unmutes it.)
    if (state.needsTap && !(state.mode !== "video" && !state.muted && safe(() => p.isMuted(), false))) {
      mlog("YouTube plays and the second moves: its frame can step back");
      setMusic({ needsTap: false });
    }
  }
  // The second does not move while YouTube says PLAYING.
  if (ys === S.PLAYING && !moving) {
    if (!wd.stillSince) wd.stillSince = tnow;
    else {
      const still = tnow - wd.stillSince;
      if (still > 5000 && Math.round(still / 1000) % 5 === 0) mlog(`watchdog: YouTube says PLAYING but the time has stayed at ${Math.round(t)} s for ${Math.round(still / 1000)} s (ad, network, or a blocked frame)`, snap(), "warn");
      // No length known yet (an ad, or still loading): a longer grace.
      const limit = (safe(() => p.getDuration(), 0) || 0) > 0 ? 10000 : 30000;
      if (state.playing && still > limit && frozenStage < 3) unfreeze(p, t);
    }
  } else wd.stillSince = 0;
  wd.lastT = t;
}

/** The second froze while YouTube says PLAYING (see watchdog): same rescue as a stuck reload. */
function unfreeze(p: YtLike, t: number): void {
  wd.stillSince = now();
  // In the background the browser may stop updating the second: not a stall.
  if (pageHidden()) return;
  frozenStage++;
  rescue(p, t, "the second froze while PLAYING");
}

/**
 * The stall rescue: a song that had been playing is stuck (YouTube reloading
 * it for ever, or a frozen second). Each step runs only if the one before did
 * not help, always at the same song and second, and never pauses or gives up:
 *   1. nudge: seek to this second + play (YouTube re-opens the stream);
 *   2. reload the song at this second (a new connection to the stream);
 *   3. build a new YouTube player (a new frame, a new connection) and go on
 *      at this song and second — the last resort, not while the page is hidden;
 *   4. then: offline → wait for the connection and go on at once; online →
 *      reload at this second every 20 s, saying the connection is the problem.
 * The ladder starts over when the second moves again, or on any user command.
 */
const stall = { stage: 0, t: 0, toastAt: -1e9 };
function rescue(p: YtLike, t: number, why: string): void {
  if (!state.playing) return;
  if (stall.stage === 0) stall.t = t;
  stall.stage++;
  const at = Math.max(0, Math.max(t, stall.t) - 0.5);
  const i = state.index;
  const canLoad = state.queue.length > 0 && i >= 0;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const info = { step: stall.stage, at: Math.round(at), offline, hidden: pageHidden(), ...snap() };
  if (now() - stall.toastAt > 30000) {
    stall.toastAt = now();
    toast(tr(offline ? "music.noConnection" : "music.slowNetwork"));
  }
  setMusic({ status: "buffering" });
  if (offline) {
    // Nothing to fetch from: the 'online' event goes on at once (see below).
    mlog(`rescue: ${why}, and the device is offline: waiting for the connection`, info, "warn");
    return armBlocked(10000, true);
  }
  if (stall.stage === 1) {
    mlog(`rescue step 1/3: ${why}: nudging YouTube (seek to ${Math.round(at)} s + play)`, info, "warn");
    p.seekTo(at, true);
    p.playVideo();
    return armBlocked(5000, true);
  }
  if (stall.stage === 2 || (stall.stage === 3 && pageHidden()) || !canLoad) {
    mlog(`rescue step 2/3: ${why}: reloading the song at ${Math.round(at)} s (new stream connection)`, info, "warn");
    if (canLoad) ytLoad(i, at, false, true);
    else p.playVideo();
    return armBlocked(6000, true);
  }
  if (stall.stage === 3) {
    mlog(`rescue step 3/3 (last resort): ${why}: building a new YouTube player, going on at ${Math.round(at)} s`, info, "warn");
    resumeAt = at;
    setMusic({ rebuild: state.rebuild + 1 });
    return armBlocked(15000, true);
  }
  mlog(`rescue: ${why} again after a new player: reloading at ${Math.round(at)} s (the network is the problem)`, info, "warn");
  ytLoad(i, at, false, true);
  armBlocked(20000, true);
}

/**
 * The page comes back (phone unlocked, tab shown, restored from the
 * back-forward cache): look at YouTube at once, so a stall is caught when the
 * user returns rather than seconds later.
 */
function recheck(why: string): void {
  const p = yt;
  mlog(`page ${why}`, snap());
  if (!p) return;
  watchdog(p);
  const ys = safe(() => p.getPlayerState(), -9);
  if (state.playing && ys !== S.PLAYING && !blockTimer && !adopting) {
    mlog("  the app waits for YouTube: arming a start check");
    armBlocked();
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? recheck("visible again") : mlog("page hidden", snap())));
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) recheck("restored from the back-forward cache");
  });
  window.addEventListener("pagehide", (e) => mlog("page hide", { persisted: (e as PageTransitionEvent).persisted, ...snap() }));
  document.addEventListener("freeze", () => mlog("page frozen by the browser", snap()));
  document.addEventListener("resume", () => recheck("resumed by the browser"));
  window.addEventListener("offline", () => mlog("the device went offline", snap(), "warn"));
  window.addEventListener("online", () => {
    mlog("the device is online again", snap());
    // Music was wanted and is stuck: go on at once, at the same second.
    const p = yt;
    if (!p || !state.playing || state.status === "playing") return;
    const t = safe(() => p.getCurrentTime(), 0) || time.time;
    if (state.queue.length && state.index >= 0 && startedId === state.queue[state.index]?.id) {
      mlog(`  reloading the song at ${Math.round(t)} s`);
      ytLoad(state.index, Math.max(0, t - 0.5), false, true);
    } else p.playVideo();
    armBlocked(10000, true);
  });
}

// ---- Commands -----------------------------------------------------------------

let volRaf = 0;

export const music = {
  open: () => setMusic({ view: "open", warm: true }),
  minimize: () => setMusic({ view: state.source ? "mini" : "closed" }),
  close: () => {
    clearBlock();
    clearTimeout(advanceTimer);
    cmd("pause");
    yt?.stopVideo();
    setMusic({ view: "closed", playing: false, status: "idle", needsTap: false });
  },
  /** Create the YouTube player ahead of time (pointerdown / hover on a music control). */
  warm: () => {
    if (!state.warm) setMusic({ warm: true });
  },
  play: (s0: Source) => {
    const s = withKey(s0);
    mlog("PLAY asked", { source: sourceLogName(s), songs: s.kind === "videos" ? s.tracks.length : "YouTube list", start: s.kind === "videos" ? s.start : 0, player: yt ? "ready" : "not ready yet (applied when ready)" });
    playSeq++;
    errCount = 0;
    original = null;
    adopting = null;
    clearInterval(adoptTimer);
    seekTarget = null;
    resumeAt = 0;
    setTime(0, 0);
    cmd("play");
    clearTimeout(advanceTimer);
    unmuteInTap();
    // A new play: YouTube's frame steps back until a start is refused again.
    if (state.needsTap) mlog("new play: YouTube's frame steps back (needsTap off)");
    setMusic({ needsTap: false });
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
    mlog(state.playing ? "PAUSE pressed" : "PLAY pressed", snap());
    if (state.playing) {
      // Pause now, also while it loads (YouTube is paused again if it starts).
      cmd("pause");
      clearBlock();
      clearTimeout(advanceTimer);
      setMusic({ playing: false, status: "paused", needsTap: false });
      yt?.pauseVideo();
      return;
    }
    cmd("play");
    setMusic({ playing: true, status: "loading" });
    const p = yt;
    if (!p) return; // applied when the player is ready
    unmuteInTap();
    const q = state.queue;
    const ys = safe(() => p.getPlayerState(), S.UNSTARTED);
    const vid = safe(() => p.getVideoData()?.video_id ?? "", "");
    const reload = q.length > 0 && state.index >= 0 && (ys === S.ENDED || vid !== q[state.index].id || !ytAligned(p, q, state.index));
    if (reload) {
      // The queue changed while paused, YouTube's list is not the queue, or the list ended: load it at this second.
      mlog("  YouTube's list or song is not the app's: loading the queue again", { ytVideo: vid, ytState: ytStateName(ys) });
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
    mlog("NEXT pressed", { index: state.index, queue: state.queue.length });
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
      armBlocked();
      return;
    }
    const n = nextIndex(state.index, q.length, state.repeat);
    if (n === null) {
      if (state.source.kind === "mix") return advanceMix();
      // The last song: say so, instead of a button that seems dead.
      mlog("  last song of the queue: nothing after it (repeat is off)");
      toast(tr("music.lastSong"));
      return;
    }
    goTo(n);
  },
  prev: () => {
    if (!state.source) return;
    mlog("PREV pressed", { index: state.index, time: Math.round(time.time) });
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
    setMusic({ volume: v, muted: v === 0 });
    const p = yt;
    if (!p) return;
    // One command per frame, however fast the slider moves. It reads the state
    // then, not a flag from this call: a later call in the same frame cancels this one.
    cancelAnimationFrameSafe(volRaf);
    volRaf = requestAnimationFrameSafe(() => {
      if (state.volume === 0) p.mute();
      else {
        p.setVolume(state.volume);
        if (!state.muted) p.unMute();
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
  startedId = null;
  stall.stage = 0;
  stall.toastAt = -1e9;
  state = { ...state, view: "closed", source: null, playing: false, status: "idle", now: null, shuffle: false, repeat: false, queue: [], index: -1, toast: null, failed: null, docked: false };
  time = { time: 0, duration: 0 };
  original = null;
  adopting = null;
  mix = null;
  errCount = 0;
  pausePending = false;
  lastCmd = { kind: "", at: 0 };
  lastPauseAt = -1e9;
  localVolAt = -1e9;
  frozenStage = 0;
  muteTries = 0;
  wd = { since: 0, kind: "", lastT: -1, stillSince: 0 };
  state = { ...state, needsTap: false, mode: "audio", muted: false };
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
