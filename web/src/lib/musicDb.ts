import { useSyncExternalStore } from "react";
import { supabase } from "./supabaseClient";
import { genId } from "./constants";
import { spotifyOwner, spotifyUserToken } from "./spotifyAuth";
import { likedTracks, readLinkAsUser, songOf, spotifyMe } from "./spotifyLibrary";
import { fetchRadio, fetchSpotify, fetchYtPlaylist, matchSpotify, mlog, type MusicErrorCode, type SpotifyList, type SpotifySong, type Track } from "./music";

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
// Radio playlists (migration 021): a song's radio saved as a playlist, which
// updates itself once a day while it stays a radio.
//
//   createRadioPlaylist(seed, owner, name?): Promise<RadioCreate>
//       asks for the full radio first (fetchRadio, full=1), then works like
//       createPlaylist; saved resolves with radioSaved: false before 021 runs
//       (it is then an ordinary playlist, and the UI says 021 is needed)
//   detachRadio(id): Promise<WriteResult>        "Stacca": an ordinary playlist from now on
//   maybeRefreshRadios(now?): Promise<void>      the daily refresh (see below)
//
// Editing a radio playlist's songs (add / insert / remove / move) detaches it
// first (radio_seed = null), so a refresh never overwrites the user's own
// changes; a rename keeps it a radio.
//
// The daily refresh runs in the browser (no server secret): after the
// playlists load and when the page becomes visible, at most once an hour per
// browser and never twice at once in this tab. A radio checked more than 24 h
// ago is asked for again; music_playlist_radio_refresh then stamps the check
// (songs unchanged: p_tracks null) or replaces the songs, and only if the row
// is still due by the database clock, so two browsers can't both refresh.
// Only the stored list changes: a queue already playing is a copy and keeps
// playing as it was.
//
// Imported playlists that sync with their source (migration 022): a playlist
// imported from Spotify (a playlist / album link; La mia libreria: a playlist,
// an album, the liked songs) or from a YouTube playlist remembers its source
// (Playlist.source). A pasted list of track links has none.
//
//   createPlaylist(name, owner, tracks, source?)   saved resolves with
//       sourceSaved: false before 022 runs (an ordinary playlist, no sync)
//   syncPlaylist(id, { force? }): Promise<SyncResult>
//       re-reads the source and updates the songs; force (the "Sincronizza"
//       button) also works on a detached playlist and on a radio (021's
//       refresh, forced). One sync per playlist at a time: a second call joins
//       the running one.
//   useSyncState(id)                   { phase, n, m } while a sync runs
//   detachSource(id) / reattachSource(id)   "Stacca" / "Riattiva sync automatica"
//   maybeSyncSources(now?, force?)     the daily sync (lazy, like the radio's)
//
// Design: the source is never dropped. Detaching sets source_auto = false
// (manual song edits do it too, as for a radio), so the daily sync leaves the
// playlist alone but "Sincronizza" can still resync it once, and "Riattiva"
// turns it back on. A rename keeps the sync.
//
// The sync: Spotify read with the signed-in person's token when there is one
// (spotifyLibrary), else through the server (fetchSpotify: the embed page
// gives a playlist's first 100, so the sync is "limited" and the songs already
// there past those are kept, never deleted); the liked songs only with the
// token of the Spotify account that imported them (source.id), otherwise the
// sync is skipped, not failed; a YouTube list with fetchYtPlaylist. Songs are
// compared by source id (Track.spotify, else the title+artist key Track.src
// kept at import, or the YouTube id): existing matches are kept, only NEW
// songs are matched on YouTube (matchSpotify), songs gone from the source are
// dropped and the source's order is followed. Nothing changed: only the time
// is stamped. music_playlist_source_sync writes only while the row is still
// due (the daily sync) or always (p_stale_ms 0, the button), so two browsers
// can't both do the daily sync. A queue already playing is a copy: untouched.
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
  /** A saved radio that updates itself daily (migration 021); absent for ordinary playlists. */
  radio?: RadioInfo;
  /** Where the playlist was imported from (migration 022); absent for ordinary playlists. */
  source?: SourceInfo;
}

export type SourceKind = "spotify-playlist" | "spotify-album" | "spotify-liked" | "youtube-playlist";
const SOURCE_KINDS = new Set<string>(["spotify-playlist", "spotify-album", "spotify-liked", "youtube-playlist"]);

/** A source as given when importing. `id`: the Spotify / YouTube list id, or for the liked songs the importer's Spotify user id. */
export interface NewSource {
  kind: SourceKind;
  id: string;
  name: string;
}
export interface SourceInfo extends NewSource {
  /** When the source was last checked (ms, database clock); null = never. */
  syncedAt: number | null;
  /** Synced automatically once a day; false once detached (song edits, "Stacca"). */
  auto: boolean;
}

/** A playlist song with the key of the source song it was matched from (Spotify imports). */
export type SourcedTrack = Track & { src?: string };

export interface RadioInfo {
  /** The seed song's video id. */
  seed: string;
  /** The seed song's title. */
  title: string;
  /** When the radio was last checked (ms, database clock); null = never. */
  refreshedAt: number | null;
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
  radio_seed?: string | null;
  radio_title?: string | null;
  radio_refreshed_at?: number | string | null;
  source_kind?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  source_synced_at?: number | string | null;
  source_auto?: boolean | null;
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
    ...(r.radio_seed
      ? {
          radio: {
            seed: r.radio_seed,
            title: r.radio_title ?? "",
            refreshedAt: r.radio_refreshed_at == null ? null : Number(r.radio_refreshed_at) || null,
          },
        }
      : {}),
    ...(r.source_kind && SOURCE_KINDS.has(r.source_kind) && r.source_id
      ? {
          source: {
            kind: r.source_kind as SourceKind,
            id: r.source_id,
            name: r.source_name ?? "",
            syncedAt: r.source_synced_at == null ? null : Number(r.source_synced_at) || null,
            auto: r.source_auto !== false,
          },
        }
      : {}),
  };
}

const clean = (t: Track): Track => ({
  id: t.id,
  title: t.title,
  channel: t.channel,
  thumb: t.thumb,
  ...(t.spotify ? { spotify: t.spotify } : {}),
  ...((t as SourcedTrack).src ? { src: (t as SourcedTrack).src } : {}),
});

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

/** A column of migration 021 that isn't there yet. */
function missingColumn(e: DbError): boolean {
  return e.code === "PGRST204" || e.code === "42703" || /could not find the '\w+' column|column .* does not exist/i.test(e.message ?? "");
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
  void maybeRefreshRadios();
  void maybeSyncSources();
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
    // Coming back also checks the radio and imported playlists (at most hourly; after the reload).
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

/** sourceSaved: only with a source (false before migration 022). */
export type SourceSaveResult = WriteResult & { sourceSaved?: boolean };

/**
 * Makes a playlist. Synchronous: it is in the store on return; `saved` says if
 * the server kept it, and (with a `source`) whether with its source
 * (sourceSaved false before migration 022: an ordinary playlist, no sync).
 */
export function createPlaylist(
  name: string,
  owner: string,
  tracks: Track[] = [],
  source?: NewSource | null
): { playlist: Playlist; saved: Promise<SourceSaveResult> } {
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
    // Just imported: the source was read now, so the first daily sync is due tomorrow.
    ...(source?.id ? { source: { kind: source.kind, id: source.id, name: source.name, syncedAt: now, auto: true } } : {}),
  };
  if (playlist.source) mlog("source-pl create", { id: playlist.id, kind: playlist.source.kind, src: playlist.source.id, songs: list.length });
  const flag = { v: false };
  const saved: Promise<SourceSaveResult> = playlist.source ? insertRow(playlist, flag).then((res) => ({ ...res, sourceSaved: res.ok && flag.v })) : insertRow(playlist);
  return { playlist, saved };
}

/** Puts back a deleted playlist as it was (same id), e.g. from an undo. */
export function restorePlaylist(p: Playlist): Promise<WriteResult> {
  return insertRow({ ...p, updatedAt: Date.now() });
}

/**
 * Saves a whole playlist (new, or put back). A radio's / a source's columns
 * are tried first; when the migration that adds them hasn't run, it is saved
 * as an ordinary playlist and `extraSaved.v` stays false.
 */
function insertRow(p: Playlist, extraSaved?: { v: boolean }): Promise<WriteResult> {
  const row = { id: p.id, name: p.name, owner: p.owner, tracks: p.tracks, created_at: p.createdAt, updated_at: p.updatedAt };
  const extra = p.radio
    ? { cols: { radio_seed: p.radio.seed, radio_title: p.radio.title, radio_refreshed_at: p.radio.refreshedAt }, known: () => hasRadioCols, mark: (v: boolean) => (hasRadioCols = v), log: "radio-pl: no radio columns (migration 021), saved as a plain playlist" }
    : p.source
      ? {
          cols: { source_kind: p.source.kind, source_id: p.source.id, source_name: p.source.name, source_synced_at: p.source.syncedAt, source_auto: p.source.auto },
          known: () => hasSourceCols,
          mark: (v: boolean) => (hasSourceCols = v),
          log: "source-pl: no source columns (migration 022), saved as a plain playlist (no sync)",
        }
      : null;
  if (!extra) return write(p.id, p, () => supabase.from(TABLE).upsert(row).select());
  return write(p.id, p, async () => {
    if (extra.known() !== false) {
      const r = await supabase.from(TABLE).upsert({ ...row, ...extra.cols }).select();
      if (!r.error || !missingColumn(r.error)) {
        if (!r.error) extra.mark(true);
        if (extraSaved) extraSaved.v = !r.error;
        return r;
      }
      extra.mark(false);
      mlog(extra.log, undefined, "warn");
    }
    // Before the migration: an ordinary playlist (the row coming back has neither).
    if (extraSaved) extraSaved.v = false;
    return supabase.from(TABLE).upsert(row).select();
  });
}

/** The playlist after a song edit: no longer a radio, and its source sync detached. */
function edited(cur: Playlist, tracks: Track[]): Playlist {
  return { ...cur, tracks, updatedAt: Date.now(), radio: undefined, ...(cur.source ? { source: { ...cur.source, auto: false } } : {}) };
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
  return write(id, edited(cur, [...cur.tracks, ...fresh]), detachFirst(id, cur, () =>
    rpcOr("music_playlist_append", { p_id: id, p_tracks: fresh }, saveTracks(id))
  ));
}

/** Puts a song at `index` (0 = first), e.g. to undo a removal. */
export function insertInPlaylist(id: string, track: Track, index: number): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (cur.tracks.some((t) => t.id === track.id)) return Promise.resolve(OK);
  const at = Math.max(0, Math.min(index, cur.tracks.length));
  const next = cur.tracks.slice();
  next.splice(at, 0, clean(track));
  return write(id, edited(cur, next), detachFirst(id, cur, () =>
    rpcOr("music_playlist_insert", { p_id: id, p_track: clean(track), p_index: at }, saveTracks(id))
  ));
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
  return write(id, edited(cur, next), detachFirst(id, cur, () =>
    rpcOr("music_playlist_remove", { p_id: id, p_track_id: trackId, p_index: at }, saveTracks(id))
  ));
}

export function moveInPlaylist(id: string, from: number, to: number): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (from === to || from < 0 || from >= cur.tracks.length || to < 0 || to >= cur.tracks.length)
    return Promise.resolve(OK);
  const next = cur.tracks.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return write(id, edited(cur, next), detachFirst(id, cur, () =>
    rpcOr("music_playlist_move", { p_id: id, p_track_id: it.id, p_to: to }, saveTracks(id))
  ));
}

// ---- Radio playlists (migration 021) ------------------------------------------

/** Migration 021's columns: unknown until a radio write or refresh answers. */
let hasRadioCols: boolean | undefined;

/** The keys the radio fields have in a Playlist, removed (detach / pre-021 row). */
function plain(p: Playlist): Playlist {
  const { radio: _drop, ...rest } = p;
  void _drop;
  return rest;
}

/**
 * A song edit on a radio playlist or an auto-synced import: detach it on the
 * server first (radio_seed = null / source_auto = false), so a daily refresh
 * or sync can never overwrite the edit, then make the edit. An ordinary
 * playlist goes straight to the edit.
 */
function detachFirst(id: string, was: Playlist, edit: () => Remote): () => Remote {
  const radio = !!was.radio;
  // Any playlist with a source, whatever this copy says of `auto`: another browser may
  // have pressed "Riattiva" and its echo not be here yet (the server decides, not this copy).
  const source = !!was.source;
  if (!radio && !source) return edit;
  return async () => {
    const d = await supabase
      .from(TABLE)
      .update({ ...(radio ? { radio_seed: null } : {}), ...(source ? { source_auto: false } : {}) })
      .eq("id", id)
      .select();
    if (d.error && !missingColumn(d.error)) return d;
    mlog(radio ? "radio-pl detached (songs edited)" : "source-pl detached (songs edited)", { id });
    // The detach's own echo must not flicker either.
    const stamp = Number((d.data as Row[] | null)?.[0]?.updated_at);
    if (stamp) flights.get(id)?.mine.add(stamp);
    return edit();
  };
}

/** "Stacca": the playlist stops updating itself and becomes an ordinary one. */
export function detachRadio(id: string): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (!cur.radio) return Promise.resolve(OK);
  mlog("radio-pl detach", { id });
  return write(id, plain({ ...cur, updatedAt: Date.now() }), () => supabase.from(TABLE).update({ radio_seed: null }).eq("id", id).select());
}

export const RADIO_MAX = 200;

/** The radio's songs as a playlist: the seed first, no song twice, at most RADIO_MAX. */
function radioTracks(seed: Track, tracks: Track[]): Track[] {
  const seen = new Set<string>([seed.id]);
  const rest = tracks.filter((t) => t?.id && !seen.has(t.id) && seen.add(t.id)).map(clean);
  return [clean(seed), ...rest].slice(0, RADIO_MAX);
}

export type RadioSaveResult = WriteResult & { radioSaved: boolean };
export type RadioCreate =
  | { ok: true; playlist: Playlist; saved: Promise<RadioSaveResult> }
  | { ok: false; error: MusicErrorCode | "empty" };

/**
 * Saves a song's radio (the longest one YouTube gives) as a team playlist,
 * "Radio · <title>" unless named. The radio is asked for first; then, like
 * createPlaylist, the playlist is in the store at once and `saved` says if the
 * server kept it, and whether as a radio (radioSaved false before migration
 * 021: an ordinary playlist that won't update itself).
 */
export async function createRadioPlaylist(seed: Track, owner: string, name?: string): Promise<RadioCreate> {
  mlog("radio-pl create: fetching radio", { seed: seed.id });
  const r = await fetchRadio(seed.id, { full: true });
  if ("error" in r) {
    mlog("radio-pl create: radio failed", { seed: seed.id, error: r.error }, "warn");
    return { ok: false, error: r.error };
  }
  const tracks = radioTracks(seed, Array.isArray(r.tracks) ? r.tracks : []);
  if (tracks.length < 2) return { ok: false, error: "empty" };
  const now = Date.now();
  const playlist: Playlist = {
    id: genId() + genId(),
    name: name?.trim() || `Radio · ${seed.title}`,
    owner,
    tracks,
    createdAt: now,
    updatedAt: now,
    radio: { seed: seed.id, title: seed.title, refreshedAt: now },
  };
  mlog("radio-pl create", { id: playlist.id, seed: seed.id, songs: tracks.length });
  const radioSaved = { v: false };
  const saved = insertRow(playlist, radioSaved).then((res) => ({ ...res, radioSaved: res.ok && radioSaved.v }));
  return { ok: true, playlist, saved };
}

// The daily refresh.
export const RADIO_STALE_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const CHECK_KEY = "gtd-music-radio-check";
let lastCheck = 0;
let refreshing: Promise<void> | null = null;

function readCheck(): number {
  try {
    return Number(localStorage.getItem(CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}
function writeCheck(at: number) {
  try {
    localStorage.setItem(CHECK_KEY, String(at));
  } catch {
    /* no storage: the in-memory stamp still limits this tab */
  }
}

/**
 * Checks the radio playlists if this browser hasn't in the last hour (and
 * isn't already doing it): each one checked more than 24 h ago is refreshed.
 * Never throws. `force` skips the hourly limit (not the one-at-a-time guard).
 */
export function maybeRefreshRadios(now = Date.now(), force = false): Promise<void> {
  if (refreshing) return refreshing;
  if (hasRadioCols === false || !store.loaded) return Promise.resolve();
  if (!force && now - Math.max(lastCheck, readCheck()) < CHECK_EVERY_MS) return Promise.resolve();
  if (!store.playlists.some((p) => p.radio)) return Promise.resolve();
  lastCheck = now;
  writeCheck(now);
  refreshing = refreshRadios(now)
    .catch((e) => mlog("radio-pl refresh failed", String(e), "warn"))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function refreshRadios(now: number): Promise<void> {
  const due = store.playlists.filter((p) => p.radio && (p.radio.refreshedAt == null || now - p.radio.refreshedAt >= RADIO_STALE_MS));
  mlog("radio-pl check", { radios: store.playlists.filter((p) => p.radio).length, due: due.length });
  for (const p of due) {
    if (hasRadioCols === false) return;
    await guarded(p.id, false, () => refreshOne(p.id, RADIO_STALE_MS));
  }
}

/** Asks for the radio again and saves it if due (`staleMs` 0: always, the button). */
async function refreshOne(id: string, staleMs: number): Promise<SyncResult> {
  const before = getPlaylist(id);
  if (!before?.radio) return { status: "skipped", reason: "no-source" };
  const { seed } = before.radio;
  const r = await fetchRadio(seed, { full: true });
  if ("error" in r) {
    mlog("radio-pl refresh: radio failed", { id, seed, error: r.error }, "warn");
    return { status: "error", error: r.error };
  }
  // Detached or deleted meanwhile (the server checks too).
  const cur = getPlaylist(id);
  if (!cur?.radio) return { status: "skipped", reason: "no-source" };
  const seedTrack = cur.tracks.find((t) => t.id === seed) ?? r.tracks?.find((t) => t.id === seed) ?? { id: seed, title: cur.radio.title, channel: "" };
  const tracks = radioTracks(seedTrack, Array.isArray(r.tracks) ? r.tracks : []);
  if (tracks.length < 2) {
    mlog("radio-pl refresh: radio empty, kept as is", { id, seed }, "warn");
    return { status: "error", error: "empty" };
  }
  const same = tracks.length === cur.tracks.length && tracks.every((t, i) => t.id === cur.tracks[i].id);
  mlog(same ? "radio-pl refresh: unchanged, stamp only" : "radio-pl refresh: new songs", { id, before: cur.tracks.length, after: tracks.length, forced: staleMs <= 0 });
  let data: unknown;
  let error: DbError | null;
  try {
    ({ data, error } = await supabase.rpc("music_playlist_radio_refresh", { p_id: id, p_tracks: same ? null : tracks, p_stale_ms: staleMs }));
  } catch (e) {
    error = { message: String(e) };
  }
  if (error) {
    if (missingFunction(error) || missingColumn(error)) hasRadioCols = false;
    mlog("radio-pl refresh: save failed", { id, error: error.code ?? error.message }, "warn");
    return { status: "error", error: playlistErrorCode(error) };
  }
  hasRadioCols = true;
  const row = (Array.isArray(data) ? data : data ? [data] : [])[0] as Row | undefined;
  if (!row?.id) {
    mlog("radio-pl refresh: not due on the server (another browser did it)", { id });
    return { status: "skipped", reason: "not-due" };
  }
  // Only the stored list changes; a queue playing it is a copy and goes on.
  const got = fromRow(row);
  const f = flights.get(id);
  if (f) offer(f, got);
  else putLocal(id, got);
  mlog("radio-pl refreshed", { id, songs: got.tracks.length });
  return { status: "done", ...counts(cur.tracks, got.tracks), missing: [], unchanged: same, limited: false };
}

// ---- Imported playlists synced with their source (migration 022) ------------------

export type SyncError = MusicErrorCode | PlaylistError | "empty" | "migration";
export interface SyncMissing {
  title: string;
  artist: string;
}
export type SyncResult =
  | {
      status: "done";
      added: number;
      removed: number;
      /** Source songs not found on YouTube (not in the playlist). */
      missing: SyncMissing[];
      /** Nothing changed: only the time was stamped. */
      unchanged: boolean;
      /** Only part of the source could be read (e.g. a playlist's first 100): nothing was removed. */
      limited: boolean;
    }
  /** liked-other: the liked songs need the Spotify account that imported them; not-due: another browser just did it. */
  | { status: "skipped"; reason: "liked-other" | "not-due" | "no-source" }
  | { status: "error"; error: SyncError };

export interface SyncState {
  phase: "reading" | "matching" | "saving";
  /** Matching: songs done / to find. */
  n: number;
  m: number;
}

/** Migration 022's columns: unknown until a source write or sync answers. */
let hasSourceCols: boolean | undefined;

/** Has migration 022 been seen missing? (the UI then says imports won't sync) */
export function sourcesMissing(): boolean {
  return hasSourceCols === false;
}

// One sync per playlist at a time (also the radio's refresh), and its progress.
const syncing = new Map<string, { job: Promise<SyncResult>; force: boolean }>();
/** A forced sync ("Sincronizza") asked while a daily one ran: it runs right after it. */
const forcedNext = new Map<string, Promise<SyncResult>>();
const syncStates = new Map<string, SyncState>();
const syncListeners = new Set<() => void>();
function setSyncState(id: string, st: SyncState | null) {
  if (st) syncStates.set(id, st);
  else syncStates.delete(id);
  syncListeners.forEach((l) => l());
}
const subscribeSync = (l: () => void) => {
  syncListeners.add(l);
  return () => {
    syncListeners.delete(l);
  };
};
export function getSyncState(id: string | null | undefined): SyncState | undefined {
  return id ? syncStates.get(id) : undefined;
}
/** A sync's progress for one playlist (undefined when none runs). */
export function useSyncState(id: string | null | undefined): SyncState | undefined {
  const get = () => getSyncState(id);
  return useSyncExternalStore(subscribeSync, get, get);
}

function guarded(id: string, force: boolean, run: () => Promise<SyncResult>): Promise<SyncResult> {
  const running = syncing.get(id);
  if (running) {
    if (running.force || !force) {
      mlog("source-pl sync: already running, joined", { id, forced: force });
      return running.job;
    }
    // The button while a daily sync runs: that one may skip (detached, not due), so the
    // one-off asked for runs after it, never replaced by its result.
    const queued = forcedNext.get(id);
    if (queued) return queued;
    mlog("source-pl sync: forced sync queued after the running daily one", { id });
    const next = running.job.then(() => {
      forcedNext.delete(id);
      return syncPlaylist(id, { force: true });
    });
    forcedNext.set(id, next);
    return next;
  }
  setSyncState(id, { phase: "reading", n: 0, m: 0 });
  const job = run()
    .catch((e): SyncResult => {
      mlog("source-pl sync failed", { id, error: String(e) }, "warn");
      return { status: "error", error: "server" };
    })
    .finally(() => {
      syncing.delete(id);
      setSyncState(id, null);
    });
  syncing.set(id, { job, force });
  return job;
}

/** Songs added and removed between two lists (by YouTube id). */
function counts(before: Track[], after: Track[]): { added: number; removed: number } {
  const was = new Set(before.map((t) => t.id));
  const now = new Set(after.map((t) => t.id));
  return { added: after.filter((t) => !was.has(t.id)).length, removed: before.filter((t) => !now.has(t.id)).length };
}

/** A Spotify song's title + artist key (a song read through the server has no Spotify id). */
export function songKey(s: { title?: string; artist?: string } | null | undefined): string {
  const norm = (x: string | undefined) =>
    (x ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${norm(s?.artist)}|${norm(s?.title)}`;
}

/** The Spotify id a song carries, if any. */
const spIdOf = (s: SpotifySong | undefined) => {
  const id = (s as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && /^[A-Za-z0-9]{22}$/.test(id) ? id : undefined;
};

/**
 * Import matches with each song's source key kept (Track.src, and the Spotify
 * id when known), so the daily sync can tell which songs it already has.
 * Index i of `matches` is song i.
 */
export function withSourceKeys(matches: (Track | null)[], songs: SpotifySong[]): (Track | null)[] {
  return matches.map((m, i) => {
    if (!m || !songs[i]) return m;
    const id = spIdOf(songs[i]);
    return { ...m, ...(id && !m.spotify ? { spotify: id } : {}), src: songKey(songs[i]) } as SourcedTrack;
  });
}

/**
 * The source a Spotify import job should remember: a playlist / album link
 * (`link`), or La mia libreria's list id ("playlist:ID", "album:ID",
 * "liked:…"; recently played and pasted songs have none). For the liked songs
 * `me` is the importer's Spotify user id (without it, no source).
 */
export function spotifySourceOf(list: Pick<SpotifyList, "kind" | "id" | "name">, opts: { library?: boolean; link?: string; me?: string | null }): NewSource | null {
  if (list.kind === "tracks") return null;
  if (opts.library) {
    const [kind, id] = list.id.split(":");
    if (kind === "playlist" && id) return { kind: "spotify-playlist", id, name: list.name };
    if (kind === "album" && id) return { kind: "spotify-album", id, name: list.name };
    if (kind === "liked" && opts.me) return { kind: "spotify-liked", id: opts.me, name: list.name };
    return null;
  }
  const m = (opts.link ?? "").match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})|^spotify:(playlist|album):([A-Za-z0-9]{22})$/);
  if (!m) return null;
  return { kind: (m[1] ?? m[3]) === "album" ? "spotify-album" : "spotify-playlist", id: m[2] ?? m[4], name: list.name };
}

/** One song of the source as read now. */
export interface SrcItem {
  /** Spotify songs: the song (with its Spotify id when read with a token). */
  song?: SpotifySong;
  /** YouTube lists: the video itself. */
  track?: Track;
}

/**
 * Pairs the source's songs with the playlist's: slot i is the existing track
 * matching item i (by Spotify id, else the title + artist key; by YouTube id
 * for a YouTube list), or null for a new song. Each track pairs once.
 * `unused`: the playlist's tracks no item matched, in their order.
 */
export function planSync(existing: Track[], items: SrcItem[]): { slots: (Track | null)[]; unused: Track[] } {
  const byId = new Map<string, Track[]>();
  const byKey = new Map<string, Track[]>();
  const push = (m: Map<string, Track[]>, k: string | undefined, t: Track) => {
    if (!k) return;
    const l = m.get(k);
    if (l) l.push(t);
    else m.set(k, [t]);
  };
  for (const t of existing) {
    push(byId, t.id, t);
    push(byId, t.spotify, t);
    push(byKey, (t as SourcedTrack).src, t);
  }
  const used = new Set<Track>();
  const take = (m: Map<string, Track[]>, k: string | undefined) => {
    if (!k) return null;
    const l = m.get(k);
    const t = l?.find((x) => !used.has(x));
    if (t) used.add(t);
    return t ?? null;
  };
  const slots = items.map((it) => {
    if (it.track) return take(byId, it.track.id);
    const id = spIdOf(it.song);
    return (id ? take(byId, id) : null) ?? take(byKey, songKey(it.song));
  });
  return { slots, unused: existing.filter((t) => !used.has(t)) };
}

type Read = { items: SrcItem[]; limited: boolean } | { skip: "liked-other" } | { error: SyncError };

const SP_CODES: Record<string, MusicErrorCode> = { quota: "quota", network: "offline", "signed-out": "login", aborted: "aborted", "not-found": "not-found" };

/** Reads the source again. Never throws. */
async function readSource(src: SourceInfo): Promise<Read> {
  try {
    if (src.kind === "youtube-playlist") {
      const r = await fetchYtPlaylist(src.id);
      if ("error" in r) return { error: r.error };
      const tracks = (r.tracks ?? []).filter((t) => t?.id);
      return { items: tracks.map((track) => ({ track })), limited: !!r.total && r.total > tracks.length };
    }
    const signedIn = !!spotifyUserToken();
    if (src.kind === "spotify-liked") {
      // Only the account that imported them can read them; anyone else skips (not a failure).
      if (!signedIn) return { skip: "liked-other" };
      // The account is asked fresh with the token in hand (never a cached id of another
      // person picked earlier on this device), and the same person must still be picked
      // once the songs are read: else they could be someone else's liked songs.
      const owner = spotifyOwner();
      const me = await spotifyMe(undefined, { fresh: true });
      if (!me || me !== src.id) return { skip: "liked-other" };
      const r = await likedTracks();
      if (spotifyOwner() !== owner) {
        mlog("source-pl liked songs: another name was picked while reading, skipped", { from: owner });
        return { skip: "liked-other" };
      }
      return { items: r.tracks.map((t) => ({ song: songOf(t) })), limited: r.capped };
    }
    const kind = src.kind === "spotify-album" ? "album" : "playlist";
    if (signedIn) {
      const u = await readLinkAsUser(kind, src.id);
      mlog("source-pl read as the user", { id: src.id, result: typeof u === "string" ? u : u.songs.length });
      if (typeof u !== "string") return { items: u.songs.map((song) => ({ song })), limited: !!u.truncated };
    }
    const r = await fetchSpotify(`https://open.spotify.com/${kind}/${src.id}`);
    if ("error" in r) return { error: r.error };
    // The embed page gives a playlist's first 100: the songs past those are kept.
    const limited = !!r.limited || !!r.truncated || (r.via === "embed" && kind === "playlist" && r.songs.length >= 100);
    return { items: r.songs.map((song) => ({ song })), limited };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    mlog("source-pl read failed", { kind: src.kind, error: code ?? String(e) }, "warn");
    return { error: (code && SP_CODES[code]) || "server" };
  }
}

export const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Syncs a playlist with its source (or, for a radio, refreshes it). `force`
 * (the button): even when not due or detached, and a radio is refreshed now.
 * Joins a sync already running for it. Never throws.
 */
export function syncPlaylist(id: string, opts: { force?: boolean; now?: number } = {}): Promise<SyncResult> {
  const p = getPlaylist(id);
  if (!p) return Promise.resolve({ status: "error", error: "not-found" });
  const force = !!opts.force;
  if (p.radio) return guarded(id, force, () => refreshOne(id, force ? 0 : RADIO_STALE_MS));
  if (!p.source) return Promise.resolve({ status: "skipped", reason: "no-source" });
  mlog("source-pl sync", { id, kind: p.source.kind, forced: force });
  return guarded(id, force, () => syncSource(id, force));
}

async function syncSource(id: string, force: boolean): Promise<SyncResult> {
  const before = getPlaylist(id);
  if (!before?.source) return { status: "skipped", reason: "no-source" };
  const src = before.source;
  const read = await readSource(src);
  if ("skip" in read) {
    mlog("source-pl sync skipped: liked songs of another Spotify account", { id });
    return { status: "skipped", reason: read.skip };
  }
  if ("error" in read) return { status: "error", error: read.error };
  if (!read.items.length && before.tracks.length) {
    // An empty answer never wipes a playlist (a hiccup, a private list).
    mlog("source-pl sync: the source gave no songs, kept as is", { id }, "warn");
    return { status: "error", error: "empty" };
  }
  const { slots, unused } = planSync(before.tracks, read.items);
  // Only the NEW Spotify songs are looked for on YouTube.
  const toFind = read.items.map((it, i) => (slots[i] || it.track ? -1 : i)).filter((i) => i >= 0);
  const songs = toFind.map((i) => read.items[i].song!);
  const found: (Track | null)[] = [];
  if (songs.length) {
    setSyncState(id, { phase: "matching", n: 0, m: songs.length });
    const m = await matchSpotify(songs, (n) => setSyncState(id, { phase: "matching", n, m: songs.length }), () => false);
    found.push(...withSourceKeys(m, songs));
  }
  const missing: SyncMissing[] = [];
  const fill = new Map<number, Track | null>();
  toFind.forEach((i, k) => {
    fill.set(i, found[k] ?? null);
    if (!found[k]) missing.push({ title: read.items[i].song!.title, artist: read.items[i].song!.artist });
  });
  const seen = new Set<string>();
  const planned: Track[] = [];
  const put = (t: Track | null | undefined) => {
    if (t?.id && !seen.has(t.id)) {
      seen.add(t.id);
      planned.push(clean(t));
    }
  };
  read.items.forEach((it, i) => put(slots[i] ?? (it.track ? it.track : fill.get(i))));
  // Limited: only part of the source was read, so the songs not seen are kept (after it).
  if (read.limited) unused.forEach(put);

  // Detached, re-sourced or deleted meanwhile: the daily sync stops (the server checks too).
  const cur = getPlaylist(id);
  if (!cur?.source) return { status: "skipped", reason: "no-source" };
  if (!force && !cur.source.auto) return { status: "skipped", reason: "not-due" };
  setSyncState(id, { phase: "saving", n: songs.length, m: songs.length });
  // The plan was made from `before`; the list may have changed while the source was read
  // and the songs found (a song added or removed by hand, here or in another browser).
  // The write is checked against the list it was planned on (p_expect: its song ids):
  // the server refuses it if the row changed since, and it is planned again on that.
  let base = cur.tracks;
  for (let attempt = 0; ; attempt++) {
    const next = rebase(planned, before.tracks, base);
    const same = next.length === base.length && next.every((t, i) => t.id === base[i].id);
    const c = counts(base, next);
    mlog(same ? "source-pl sync: unchanged, stamp only" : "source-pl sync: changed", { id, ...c, missing: missing.length, limited: read.limited, forced: force, attempt });
    let data: unknown;
    let error: DbError | null;
    try {
      ({ data, error } = await supabase.rpc("music_playlist_source_sync", {
        p_id: id,
        p_tracks: same ? null : next,
        p_stale_ms: force ? 0 : SOURCE_STALE_MS,
        p_expect: base.map((t) => t.id),
      }));
    } catch (e) {
      error = { message: String(e) };
    }
    if (error) {
      const gone = missingFunction(error) || missingColumn(error);
      if (gone) hasSourceCols = false;
      mlog("source-pl sync: save failed", { id, error: error.code ?? error.message }, "warn");
      return { status: "error", error: gone ? "migration" : playlistErrorCode(error) };
    }
    hasSourceCols = true;
    const row = (Array.isArray(data) ? data : data ? [data] : [])[0] as Row | undefined;
    if (row?.id) {
      // Only the stored list changes; a queue playing it is a copy and goes on.
      const got = fromRow(row);
      const f = flights.get(id);
      if (f) offer(f, got);
      else putLocal(id, got);
      mlog("source-pl synced", { id, songs: got.tracks.length });
      return { status: "done", ...c, missing, unchanged: same, limited: read.limited };
    }
    // Refused: not due / detached (another browser did it), or the list changed since `base`.
    const now = attempt < 2 ? await readRow(id) : undefined;
    if (!now || !now.source || (!force && !now.source.auto) || sameIds(now.tracks, base)) {
      mlog("source-pl sync: not due on the server (another browser did it, or detached)", { id });
      return { status: "skipped", reason: "not-due" };
    }
    mlog("source-pl sync: the list changed during the sync, planned again on it", { id, was: base.length, now: now.tracks.length });
    base = now.tracks;
  }
}

const sameIds = (a: Track[], b: Track[]) => a.length === b.length && a.every((t, i) => t.id === b[i].id);

/** The playlist as the server has it now (undefined: gone or unreadable). */
async function readRow(id: string): Promise<Playlist | undefined> {
  try {
    const { data, error } = await supabase.from(TABLE).select("*").eq("id", id);
    const row = error ? undefined : (data as Row[] | null)?.[0];
    return row?.id ? fromRow(row) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sync planned on `before` applied to the list as it is `now`: songs added
 * by hand since `before` are kept (at the end), songs removed by hand since
 * stay removed; the rest follows the plan (the source's order).
 */
export function rebase(planned: Track[], before: Track[], now: Track[]): Track[] {
  if (now === before || sameIds(now, before)) return planned;
  const was = new Set(before.map((t) => t.id));
  const has = new Set(now.map((t) => t.id));
  const out = planned.filter((t) => !(was.has(t.id) && !has.has(t.id)));
  const seen = new Set(out.map((t) => t.id));
  for (const t of now) {
    if (!was.has(t.id) && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** "Stacca": no daily sync from now on (the source stays: Sincronizza still works). */
export function detachSource(id: string): Promise<WriteResult> {
  return setSourceAuto(id, false);
}
/** "Riattiva sync automatica". */
export function reattachSource(id: string): Promise<WriteResult> {
  return setSourceAuto(id, true);
}
function setSourceAuto(id: string, auto: boolean): Promise<WriteResult> {
  const cur = getPlaylist(id);
  if (!cur) return Promise.resolve(fail("not-found"));
  if (!cur.source || cur.source.auto === auto) return Promise.resolve(OK);
  mlog(auto ? "source-pl reattach" : "source-pl detach", { id });
  return write(id, { ...cur, source: { ...cur.source, auto }, updatedAt: Date.now() }, () => supabase.from(TABLE).update({ source_auto: auto }).eq("id", id).select());
}

// The daily sync: like the radio's (after the load and on the page coming back,
// at most once an hour per browser, one run at a time in this tab).
const SOURCE_CHECK_KEY = "gtd-music-source-check";
let lastSourceCheck = 0;
let sourcing: Promise<void> | null = null;

function readStamp(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}
function writeStamp(key: string, at: number) {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    /* no storage: the in-memory stamp still limits this tab */
  }
}

/** Syncs the imported playlists checked more than a day ago, if this browser hasn't looked in the last hour. Never throws. */
export function maybeSyncSources(now = Date.now(), force = false): Promise<void> {
  if (sourcing) return sourcing;
  if (hasSourceCols === false || !store.loaded) return Promise.resolve();
  if (!force && now - Math.max(lastSourceCheck, readStamp(SOURCE_CHECK_KEY)) < CHECK_EVERY_MS) return Promise.resolve();
  if (!store.playlists.some((p) => p.source?.auto)) return Promise.resolve();
  lastSourceCheck = now;
  writeStamp(SOURCE_CHECK_KEY, now);
  sourcing = syncSources(now)
    .catch((e) => mlog("source-pl daily sync failed", String(e), "warn"))
    .finally(() => {
      sourcing = null;
    });
  return sourcing;
}

async function syncSources(now: number): Promise<void> {
  const auto = store.playlists.filter((p) => p.source?.auto);
  const due = auto.filter((p) => p.source!.syncedAt == null || now - p.source!.syncedAt >= SOURCE_STALE_MS);
  mlog("source-pl check", { synced: auto.length, due: due.length });
  for (const p of due) {
    if (hasSourceCols === false) return;
    const r = await syncPlaylist(p.id);
    if (r.status !== "done") mlog("source-pl daily sync: not synced", { id: p.id, ...r });
  }
}
