import { useSyncExternalStore } from "react";
import { supabase } from "./supabaseClient";
import { genId } from "./constants";
import type { Track } from "./music";

// -----------------------------------------------------------------------------
// The team's music playlists (table music_playlists, migrations 018 and 019).
//
// Kept apart from the board: loaded the first time a screen needs them, kept
// live with their own realtime channel, and shared by every screen through a
// small module-level store. Before migration 018 runs, `available` is false
// and the Library says what to run.
//
// API (every write is optimistic: the store changes at once, then the server
// is asked; on failure the change is rolled back. Writes never throw.)
//
//   type PlaylistError = "offline" | "forbidden" | "missing-table" | "not-found" | "server"
//   type WriteResult   = { ok: true } | { ok: false; error: PlaylistError }
//
//   usePlaylists(): { playlists, loaded, available, error: PlaylistError | null }
//   usePlaylist(id): Playlist | undefined     re-renders only when that playlist changes
//   getPlaylist(id): Playlist | undefined     the same, outside React
//   reloadPlaylists(): Promise<void>          full reload (also done on reconnect / tab return)
//
//   createPlaylist(name, owner, tracks?): { playlist: Playlist; saved: Promise<WriteResult> }
//       synchronous: the playlist is already in the store, navigate to playlist.id at once
//   restorePlaylist(p: Playlist): Promise<WriteResult>                  undo of deletePlaylist
//   renamePlaylist(id, name): Promise<WriteResult>
//   deletePlaylist(id): Promise<WriteResult>
//   addToPlaylist(id, track): Promise<WriteResult>                      a song already there: ok, no change
//   addTracksToPlaylist(id, tracks): Promise<WriteResult>
//   insertInPlaylist(id, track, index): Promise<WriteResult>            undo of removeFromPlaylist
//   removeFromPlaylist(id, trackId, index?): Promise<WriteResult>       index = where the row was shown
//   moveInPlaylist(id, from, to): Promise<WriteResult>
//
// Song edits and renames go through the database functions of migration 019,
// which change the row as it is on the server, so teammates editing the same
// playlist don't lose each other's songs. Before 019 runs, the app falls back
// to writing the whole song list.
//
// Realtime: each event is applied row by row. While our own writes on a
// playlist are in flight, events for it are held (the newest wins) and applied
// once the last write settles, so an echo never reverts an optimistic change.
// Echoes that arrive after that are recognised by the exact updated_at our
// writes got back (never by comparing clocks), so they don't flicker either;
// any other event is applied, since realtime delivers in commit order.
// Migration 020 makes the database stamp updated_at, so "newest wins" while a
// write is in flight compares one clock only.
// -----------------------------------------------------------------------------

export interface Playlist {
  id: string;
  name: string;
  owner: string;
  tracks: Track[];
  createdAt: number;
  updatedAt: number;
}

export type PlaylistError = "offline" | "forbidden" | "missing-table" | "not-found" | "server";
export type WriteResult = { ok: true } | { ok: false; error: PlaylistError };

interface Row {
  id: string;
  name: string;
  owner: string;
  tracks: Track[] | null;
  created_at: number;
  updated_at: number;
}

interface Store {
  playlists: Playlist[];
  loaded: boolean;
  available: boolean;
  error: PlaylistError | null;
}

const TABLE = "music_playlists";
const OK: WriteResult = { ok: true };
const fail = (error: PlaylistError): WriteResult => ({ ok: false, error });

let store: Store = { playlists: [], loaded: false, available: true, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
}

function fromRow(r: Row): Playlist {
  return {
    id: r.id,
    name: r.name ?? "",
    owner: r.owner ?? "",
    tracks: Array.isArray(r.tracks) ? r.tracks.filter((t) => t && typeof t.id === "string") : [],
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

const clean = (t: Track): Track => ({ id: t.id, title: t.title, channel: t.channel, thumb: t.thumb });

export function getPlaylist(id: string | null | undefined): Playlist | undefined {
  return id ? store.playlists.find((p) => p.id === id) : undefined;
}

/** Puts a playlist in the store (null removes it). A new one goes at `at`, or first. */
function putLocal(id: string, p: Playlist | null, at = 0) {
  const i = store.playlists.findIndex((x) => x.id === id);
  if (!p) {
    if (i >= 0) set({ playlists: store.playlists.filter((x) => x.id !== id) });
    return;
  }
  if (i >= 0 && store.playlists[i] === p) return;
  const next = store.playlists.slice();
  if (i >= 0) next[i] = p;
  else next.splice(Math.max(0, Math.min(at, next.length)), 0, p);
  set({ playlists: next });
}

// ---- Errors -----------------------------------------------------------------

type DbError = { code?: string; message?: string; status?: number };

function missingTable(e: DbError): boolean {
  return e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? "");
}

function missingFunction(e: DbError): boolean {
  return e.code === "PGRST202" || e.code === "42883" || /could not find the function/i.test(e.message ?? "");
}

/** Maps a Supabase error (or a thrown one) to the codes the UI shows. */
export function playlistErrorCode(e: unknown): PlaylistError {
  const x = (e && typeof e === "object" ? e : {}) as DbError;
  const msg = x.message ?? String(e ?? "");
  if (missingTable(x)) return "missing-table";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(msg)) return "offline";
  if (
    x.code === "42501" ||
    x.code === "PGRST301" ||
    x.code === "PGRST302" ||
    x.status === 401 ||
    x.status === 403 ||
    /permission denied|row-level security|jwt/i.test(msg)
  )
    return "forbidden";
  return "server";
}

// ---- Writes in flight -------------------------------------------------------
// One entry per playlist with writes in flight: the playlist as it was before
// the first of them (for rollback), and the newest server version seen since
// (from realtime, a reload or a write's answer), applied when the last settles.

interface Flight {
  n: number;
  base: Playlist | undefined;
  baseAt: number;
  failed: boolean;
  shadow?: { row: Playlist | null };
  mine: Set<number>; // updated_at of the rows our writes got back
  echoed: Set<number>; // ...and of those whose realtime echo already came
}
const flights = new Map<string, Flight>();

// After a flight settles, its echoes can still be on their way. For a short
// while we remember the stamps our writes got back: an event carrying one of
// them is our own echo (already shown, or superseded) and is skipped. If the
// store now shows our last write and its echo hasn't come yet, any other event
// committed before it (realtime is in commit order) and is skipped too, since
// our row already includes it.
interface Settled {
  mine: Set<number>;
  last: number | null; // the stamp shown now whose echo is still due
  lastUntil: number; // a lost echo must not hold teammates' changes for long
  until: number;
}
const settled = new Map<string, Settled>();
const SETTLED_MS = 15_000;
const ECHO_MS = 4_000;

function offer(f: Flight, row: Playlist | null) {
  const cur = f.shadow?.row;
  // A deletion always wins; a row wins over a deletion seen earlier (it came
  // later), and otherwise only if it is at least as new.
  if (!row || !f.shadow || !cur || row.updatedAt >= cur.updatedAt) f.shadow = { row };
}

type Remote = PromiseLike<{ data: unknown; error: DbError | null }>;

/**
 * Applies `next` to the store at once, then runs `remote`. Rolls back if it
 * fails. `remote` must answer with the written row(s) (insert/update/rpc with
 * .select()), except for a delete.
 */
async function write(
  id: string,
  next: Playlist | null,
  remote: () => Remote,
  kind: "row" | "delete" = "row"
): Promise<WriteResult> {
  let f = flights.get(id);
  if (!f) {
    const i = store.playlists.findIndex((p) => p.id === id);
    f = { n: 0, base: store.playlists[i], baseAt: Math.max(0, i), failed: false, mine: new Set(), echoed: new Set() };
    flights.set(id, f);
  }
  f.n++;
  putLocal(id, next);

  let res: WriteResult;
  try {
    const { data, error } = await remote();
    if (error) {
      f.failed = true;
      const code = playlistErrorCode(error);
      if (code === "missing-table") set({ available: false });
      res = fail(code);
    } else if (kind === "delete") {
      offer(f, null);
      res = OK;
    } else {
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as Row[];
      if (rows[0]?.id) {
        const got = fromRow(rows[0]);
        f.mine.add(got.updatedAt);
        offer(f, got);
        res = OK;
      } else {
        offer(f, null); // the playlist is gone (a teammate deleted it)
        res = fail("not-found");
      }
    }
  } catch (e) {
    f.failed = true;
    res = fail(playlistErrorCode(e));
  }

  if (--f.n === 0) {
    flights.delete(id);
    if (f.shadow) putLocal(id, f.shadow.row, f.baseAt);
    else if (f.failed) putLocal(id, f.base ?? null, f.baseAt);
    if (f.mine.size) {
      const shown = f.shadow?.row?.updatedAt;
      const due = shown !== undefined && f.mine.has(shown) && !f.echoed.has(shown) ? shown : null;
      const now = Date.now();
      settled.set(id, { mine: f.mine, last: due, lastUntil: now + ECHO_MS, until: now + SETTLED_MS });
    }
  }
  return res;
}

// Migration 019's functions, or the whole-array write before it runs.
let hasRpc: boolean | undefined;

async function rpcOr(fn: string, args: Record<string, unknown>, fallback: () => Remote) {
  if (hasRpc !== false) {
    const r = await supabase.rpc(fn, args);
    if (!r.error) {
      hasRpc = true;
      return r;
    }
    if (!missingFunction(r.error)) return r;
    hasRpc = false;
  }
  return fallback();
}

/** Pre-019 fallback: save the whole song list as this browser has it now. */
const saveTracks = (id: string) => () =>
  supabase
    .from(TABLE)
    .update({ tracks: getPlaylist(id)?.tracks ?? [], updated_at: Date.now() })
    .eq("id", id)
    .select();

// ---- Loading and realtime ---------------------------------------------------

let loadSeq = 0; // the newest reload; older answers are dropped
let events = 0; // realtime events applied; a reload that started before one is stale
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

export async function reloadPlaylists(): Promise<void> {
  const mine = ++loadSeq;
  const ev = events;
  let data: unknown;
  let error: DbError | null;
  try {
    ({ data, error } = await supabase.from(TABLE).select("*").order("updated_at", { ascending: false }));
  } catch (e) {
    error = { message: String(e) };
  }
  if (mine !== loadSeq) return; // a newer reload will answer
  if (error) {
    const missing = missingTable(error);
    set({ loaded: true, available: !missing, error: missing ? null : playlistErrorCode(error) });
    return;
  }
  // A realtime event arrived meanwhile: this snapshot may be older than it.
  if (ev !== events && store.loaded) {
    scheduleReload();
    return;
  }
  const rows = ((data ?? []) as Row[]).map(fromRow);
  const seen = new Set(rows.map((r) => r.id));
  const next: Playlist[] = [];
  // Playlists with writes in flight keep their optimistic version (incl. new ones).
  for (const p of store.playlists) if (flights.has(p.id) && !seen.has(p.id)) next.push(p);
  for (const r of rows) {
    const f = flights.get(r.id);
    if (f) {
      offer(f, r);
      // In flight but not in the store: only our own pending delete does that.
      const cur = getPlaylist(r.id);
      if (cur) next.push(cur);
    } else next.push(r);
  }
  set({ playlists: next, loaded: true, available: true, error: null });
}

function scheduleReload(ms = 300) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    void reloadPlaylists();
  }, ms);
}

async function fetchOne(id: string) {
  try {
    const { data, error } = await supabase.from(TABLE).select("*").eq("id", id);
    if (error) return;
    const row = (data as Row[] | null)?.[0];
    const p = row ? fromRow(row) : null;
    const f = flights.get(id);
    if (f) offer(f, p);
    else putLocal(id, p);
  } catch {
    /* the next reload heals it */
  }
}

type Change = { eventType: string; new: unknown; old: unknown };

/** Applies one realtime event to the store (exported for the tests). */
export function applyChange(c: Change) {
  events++;
  if (c.eventType === "DELETE") {
    const id = (c.old as { id?: string } | null)?.id;
    if (!id) return scheduleReload();
    const f = flights.get(id);
    if (f) offer(f, null);
    else putLocal(id, null);
    return;
  }
  const raw = c.new as Partial<Row> | null;
  if (!raw?.id) return scheduleReload();
  const f = flights.get(raw.id);
  const cur = getPlaylist(raw.id);
  if (raw.tracks === undefined) {
    // A big song list left unchanged can be left out of the event.
    if (f) {
      const at = Number(raw.updated_at);
      if (at) f.echoed.add(at);
      return; // our write's answer will bring the row
    }
    if (!cur) return void fetchOne(raw.id);
    raw.tracks = cur.tracks;
  }
  const row = fromRow(raw as Row);
  const s = settled.get(row.id);
  if (f) {
    if (s?.mine.has(row.updatedAt)) return; // a late echo of an earlier flight
    f.echoed.add(row.updatedAt);
    return offer(f, row);
  }
  if (s && Date.now() > s.until) settled.delete(row.id);
  else if (s) {
    if (Date.now() > s.lastUntil) s.last = null;
    if (s.last !== null && row.updatedAt === s.last) {
      s.last = null; // the echo of what we show: nothing to change
      if (cur?.updatedAt === row.updatedAt) return;
    } else if (s.mine.has(row.updatedAt) || s.last !== null) return;
  }
  putLocal(row.id, row);
}

let started = false;

function start() {
  if (started) return;
  started = true;
  void reloadPlaylists();
  supabase
    .channel("music-playlists")
    .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, (payload: Change) => applyChange(payload))
    // On every (re)connect, pull what changed while the socket was down.
    .subscribe((status: string) => {
      if (status === "SUBSCRIBED") scheduleReload(0);
    });
  if (typeof document !== "undefined") {
    const visible = () => document.visibilityState === "visible";
    document.addEventListener("visibilitychange", () => visible() && scheduleReload());
    window.addEventListener("online", () => scheduleReload());
    // Safety net: realtime can drop events, so converge every couple of minutes.
    setInterval(() => visible() && scheduleReload(0), 120_000);
  }
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getStore = () => store;

export function usePlaylists(): Store {
  return useSyncExternalStore(subscribe, getStore, getStore);
}

/** One playlist; re-renders only when that playlist changes. */
export function usePlaylist(id: string | null | undefined): Playlist | undefined {
  const get = () => getPlaylist(id);
  return useSyncExternalStore(subscribe, get, get);
}

// ---- Changes ----------------------------------------------------------------

/** Makes a playlist. Synchronous: it is in the store on return; `saved` says if the server kept it. */
export function createPlaylist(
  name: string,
  owner: string,
  tracks: Track[] = []
): { playlist: Playlist; saved: Promise<WriteResult> } {
  const now = Date.now();
  const seen = new Set<string>();
  const list = tracks.filter((t) => t?.id && !seen.has(t.id) && seen.add(t.id)).map(clean);
  const playlist: Playlist = {
    id: genId() + genId(),
    name: name.trim() || "Playlist",
    owner,
    tracks: list,
    createdAt: now,
    updatedAt: now,
  };
  const saved = insertRow(playlist);
  return { playlist, saved };
}

/** Puts back a deleted playlist as it was (same id), e.g. from an undo. */
export function restorePlaylist(p: Playlist): Promise<WriteResult> {
  return insertRow({ ...p, updatedAt: Date.now() });
}

function insertRow(p: Playlist): Promise<WriteResult> {
  const row = { id: p.id, name: p.name, owner: p.owner, tracks: p.tracks, created_at: p.createdAt, updated_at: p.updatedAt };
  return write(p.id, p, () => supabase.from(TABLE).upsert(row).select());
}

export function renamePlaylist(id: string, name: string): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  const n = name.trim() || cur.name;
  if (n === cur.name) return Promise.resolve(OK);
  return write(id, { ...cur, name: n, updatedAt: Date.now() }, () =>
    rpcOr("music_playlist_rename", { p_id: id, p_name: n }, () =>
      supabase.from(TABLE).update({ name: n, updated_at: Date.now() }).eq("id", id).select()
    )
  );
}

export function deletePlaylist(id: string): Promise<WriteResult> {
  if (!getPlaylist(id)) return Promise.resolve(OK);
  return write(id, null, () => supabase.from(TABLE).delete().eq("id", id), "delete");
}

/** Adds a song at the end (a song already there is not added again). */
export function addToPlaylist(id: string, track: Track): Promise<WriteResult> {
  return addTracksToPlaylist(id, [track]);
}

export function addTracksToPlaylist(id: string, tracks: Track[]): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  const seen = new Set(cur.tracks.map((t) => t.id));
  const fresh = tracks.filter((t) => t?.id && !seen.has(t.id) && seen.add(t.id)).map(clean);
  if (!fresh.length) return Promise.resolve(OK);
  return write(id, { ...cur, tracks: [...cur.tracks, ...fresh], updatedAt: Date.now() }, () =>
    rpcOr("music_playlist_append", { p_id: id, p_tracks: fresh }, saveTracks(id))
  );
}

/** Puts a song at `index` (0 = first), e.g. to undo a removal. */
export function insertInPlaylist(id: string, track: Track, index: number): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (cur.tracks.some((t) => t.id === track.id)) return Promise.resolve(OK);
  const at = Math.max(0, Math.min(index, cur.tracks.length));
  const next = cur.tracks.slice();
  next.splice(at, 0, clean(track));
  return write(id, { ...cur, tracks: next, updatedAt: Date.now() }, () =>
    rpcOr("music_playlist_insert", { p_id: id, p_track: clean(track), p_index: at }, saveTracks(id))
  );
}

/** Removes a song. `index` is where the row was shown (picks the right copy). */
export function removeFromPlaylist(id: string, trackId: string, index?: number): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  const at =
    index !== undefined && cur.tracks[index]?.id === trackId ? index : cur.tracks.findIndex((t) => t.id === trackId);
  if (at < 0) return Promise.resolve(OK);
  const next = cur.tracks.slice();
  next.splice(at, 1);
  return write(id, { ...cur, tracks: next, updatedAt: Date.now() }, () =>
    rpcOr("music_playlist_remove", { p_id: id, p_track_id: trackId, p_index: at }, saveTracks(id))
  );
}

export function moveInPlaylist(id: string, from: number, to: number): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (from === to || from < 0 || from >= cur.tracks.length || to < 0 || to >= cur.tracks.length)
    return Promise.resolve(OK);
  const next = cur.tracks.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return write(id, { ...cur, tracks: next, updatedAt: Date.now() }, () =>
    rpcOr("music_playlist_move", { p_id: id, p_track_id: it.id, p_to: to }, saveTracks(id))
  );
}
