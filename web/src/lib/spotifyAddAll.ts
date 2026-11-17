// -----------------------------------------------------------------------------
// One-click imports into the team library, and the check that says what is in.
//
//   startAddAll        "Aggiungi tutte le mie playlist": every playlist of the
//                      signed-in person (own + collaborative) and the liked
//                      songs. Already added (a team playlist with that source)
//                      → skipped; an old import of this person's with the same
//                      name and no source (made by them, every song from
//                      Spotify) → linked to it (setPlaylistSource + one sync
//                      that keeps its songs); the rest → read, matched on
//                      YouTube and SAVED, no edit step.
//   addEntry / addSpotifyList / addFromLink / retryMissing
//                      the same job for one list (a library "Aggiungi", a
//                      pasted link, "Riprova i mancanti").
//   checkRows / checkSummary
//                      the check: each Spotify playlist against the team
//                      playlists' sources (the real state, not the job's memory).
//
// The job is a module store (it outlives the page; the sidebar chip reads it).
// Tasks run one at a time; a song in several playlists is matched once per run
// (by Spotify track id); one failing task never stops the others; "Annulla"
// aborts the current one and drops the queued ones. Spotify's cover art is
// never copied: the team playlists hold YouTube songs (README §1e).
// -----------------------------------------------------------------------------

import { fetchSpotify, fetchYtPlaylist, matchSpotify, mlog, readSpotifyTracks, type SpotifyList, type SpotifySong, type Track } from "./music";
import { createPlaylist, getPlaylists, getSyncState, normListName, recordSourceStats, setPlaylistSource, sourceStats, spotifySourceOf, syncPlaylist, withSourceKeys, type NewSource, type Playlist, type SourcedTrack } from "./musicDb";
import { LIKED_CAP, SpotifyApiError, likedTotal, likedTracks, myPlaylists, readLinkAsUser, songOf, spotifyIdOf, spotifyLinkTarget, spotifyMe, withSpotifyIds, type SpItem } from "./spotifyLibrary";
import { spotifyUserToken } from "./spotifyAuth";

// ---- The person's Spotify lists, and what the team has --------------------------------

export const LIKED_KEY = "spotify-liked";

/** One list of the person's Spotify library the check follows. */
export interface SpEntry {
  /** "spotify-playlist:<id>" or "spotify-liked" (the team playlist source's key). */
  key: string;
  kind: "playlist" | "liked";
  /** The playlist id ("" for the liked songs). */
  id: string;
  name: string;
  /** Songs on Spotify, when known. */
  count?: number;
  url: string;
}

/** A source's key, comparable with SpEntry.key (the liked songs: one per Spotify account, see teamFor). */
export function keyOfSource(s: { kind: string; id: string }): string {
  return s.kind === "spotify-liked" ? LIKED_KEY : `${s.kind}:${s.id}`;
}

/**
 * The lists the check follows: own and collaborative playlists (their songs
 * are readable) and the liked songs (when there are any). Anyone else's or
 * Spotify's own playlists give only their details (Spotify's 2026 rule): they
 * are `excluded` and the page says so.
 */
export function entriesOf(items: SpItem[], liked: { name: string; count?: number } | null): { entries: SpEntry[]; excluded: SpItem[] } {
  const entries: SpEntry[] = [];
  const excluded: SpItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "playlist" || seen.has(it.id)) continue;
    seen.add(it.id);
    if (!(it.mine || it.collaborative)) {
      excluded.push(it);
      continue;
    }
    // An empty playlist has nothing to add: not followed (it could never be "in").
    if (it.count === 0) continue;
    entries.push({ key: `spotify-playlist:${it.id}`, kind: "playlist", id: it.id, name: it.name, ...(typeof it.count === "number" ? { count: it.count } : {}), url: it.url });
  }
  if (liked && liked.count !== 0)
    entries.push({ key: LIKED_KEY, kind: "liked", id: "", name: liked.name, ...(typeof liked.count === "number" ? { count: liked.count } : {}), url: "https://open.spotify.com/collection/tracks" });
  return { entries, excluded };
}

/**
 * The team playlist made from this list (by its source), if any. Liked songs:
 * this Spotify account's (`me`) only; with the account unknown, none (another
 * person's liked songs are never taken for these).
 */
export function teamFor(entry: Pick<SpEntry, "key" | "kind">, team: Playlist[], me?: string | null): Playlist | undefined {
  if (entry.kind === "liked" && !me) return undefined;
  return team.find((p) => p.source && keyOfSource(p.source) === entry.key && (entry.kind !== "liked" || p.source.id === me));
}

/** A song that came from Spotify (an import keeps its Spotify id, or its source key). */
const fromSpotify = (t: SourcedTrack) => !!(t.spotify || t.src);

/**
 * An older import of this list, safe to link to it: a team playlist with the
 * same name, no source (nor a radio), made by this person (`who`), holding
 * songs that all came from Spotify. A playlist made by hand, or by someone
 * else, is never linked (the Spotify list is then added as its own playlist).
 */
export function sameNameFor(entry: Pick<SpEntry, "name">, team: Playlist[], taken: Set<string> = new Set(), who = ""): Playlist | undefined {
  const want = normListName(entry.name);
  if (!want || !who) return undefined;
  return team.find(
    (p) => !p.source && !p.radio && !taken.has(p.id) && p.owner === who && normListName(p.name) === want && p.tracks.length > 0 && (p.tracks as SourcedTrack[]).every(fromSpotify)
  );
}

export interface AddAllPlan {
  already: { entry: SpEntry; playlist: Playlist }[];
  link: { entry: SpEntry; playlist: Playlist; source: NewSource }[];
  add: SpEntry[];
}

/**
 * What "Aggiungi tutte" does with each list: skip it, link an old import to
 * it, or add it. `me`: the Spotify account (unknown: the liked songs are
 * added, their task reads the account fresh); `who`: the person on the team.
 */
export function planAddAll(entries: SpEntry[], team: Playlist[], me?: string | null, who = ""): AddAllPlan {
  const plan: AddAllPlan = { already: [], link: [], add: [] };
  const taken = new Set<string>();
  for (const entry of entries) {
    const have = teamFor(entry, team, me);
    if (have) {
      plan.already.push({ entry, playlist: have });
      continue;
    }
    const old = sameNameFor(entry, team, taken, who);
    const source: NewSource | null = entry.kind === "liked" ? (me ? { kind: "spotify-liked", id: me, name: entry.name } : null) : { kind: "spotify-playlist", id: entry.id, name: entry.name };
    if (old && source) {
      taken.add(old.id);
      plan.link.push({ entry, playlist: old, source });
    } else plan.add.push(entry);
  }
  return plan;
}

// ---- The job ------------------------------------------------------------------------

export type TaskStatus = "queued" | "reading" | "matching" | "saving" | "done" | "error" | "cancelled";
const ACTIVE = new Set<TaskStatus>(["queued", "reading", "matching", "saving"]);
export const isActive = (t: ImportTask | undefined): boolean => !!t && ACTIVE.has(t.status);

export type TaskSpec =
  /** A Spotify playlist / album by id (the library, a pasted link). */
  | { kind: "spotify"; target: "playlist" | "album"; id: string; url: string }
  /** The liked songs, read now. */
  | { kind: "liked" }
  /** Songs already read (a list open in the library). `source` "liked": resolved with the account, fresh. */
  | { kind: "list"; list: SpotifyList; source: NewSource | null | "liked" }
  /** Track links pasted from the Spotify app: read one by one, no source. */
  | { kind: "tracks"; ids: string[]; nameFor: (n: number) => string }
  /** A YouTube / YouTube Music playlist link. */
  | { kind: "yt"; list: string }
  /** An old import with the same name: link it to its source, then sync once. */
  | { kind: "link"; playlistId: string; source: NewSource }
  /** "Riprova i mancanti": a sync of the team playlist (only songs not in it are looked for). */
  | { kind: "retry"; playlistId: string };

export type ErrorCode = string;

export interface ImportTask {
  seq: number;
  /** The check's key (SpEntry.key), or a unique key for other imports. */
  key: string;
  name: string;
  spec: TaskSpec;
  /** One list asked for by itself: a toast says when it is in. */
  announce: boolean;
  status: TaskStatus;
  /** Songs done / to do in the step running. */
  n: number;
  m: number;
  found?: number;
  missing?: number;
  missingSongs?: { title: string; artist: string }[];
  error?: ErrorCode;
  /** The team playlist made, linked or synced. */
  playlistId?: string;
  /** Linked an old import instead of making a new playlist. */
  linked?: boolean;
  /** Already in the library when its turn came (another browser added it): nothing made. */
  existed?: boolean;
  /** Saved without its source (migration 022 missing). */
  noSource?: boolean;
}

export interface ImportJob {
  run: number;
  running: boolean;
  /** "Aggiungi tutte": reading the person's playlists before the tasks are known. */
  listing: boolean;
  tasks: ImportTask[];
  cancelled: boolean;
  /** "Aggiungi tutte": lists that could not be read (someone else's / Spotify's own). */
  excluded?: number;
  /** "Aggiungi tutte": lists already in the library (skipped). */
  already?: number;
  /** "Aggiungi tutte": reading the person's playlists failed. */
  listError?: ErrorCode;
}

export interface ImportState {
  job: ImportJob | null;
  /** The last finished task per key, from earlier runs (errors, missing songs). */
  history: ReadonlyMap<string, ImportTask>;
}

let state: ImportState = { job: null, history: new Map() };
const listeners = new Set<() => void>();
function emit(next: ImportState) {
  state = next;
  listeners.forEach((l) => l());
}
export function subscribeImport(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const getImportState = (): ImportState => state;

export type ImportEvent = { type: "task"; task: ImportTask } | { type: "run"; job: ImportJob };
const eventListeners = new Set<(e: ImportEvent) => void>();
/** A task asked for by itself finished (announce), or a run ended. */
export function onImportEvent(cb: (e: ImportEvent) => void): () => void {
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
}
const fire = (e: ImportEvent) => eventListeners.forEach((l) => l(e));

let ctrl = new AbortController();
let owner = "";
let seq = 0;
let runSeq = 0;
let looping = false;
/** Matches made in this run, by Spotify track id: a song in several playlists is matched once. */
let memo = new Map<string, Track | null>();

function setJob(job: ImportJob | null) {
  emit({ ...state, job });
}

function patchTask(run: number, s: number, p: Partial<ImportTask>) {
  const j = state.job;
  if (!j || j.run !== run) return;
  setJob({ ...j, tasks: j.tasks.map((t) => (t.seq === s ? { ...t, ...p } : t)) });
}
const taskOf = (run: number, s: number) => (state.job?.run === run ? state.job.tasks.find((t) => t.seq === s) : undefined);

export interface NewTask {
  key: string;
  name: string;
  spec: TaskSpec;
  announce?: boolean;
}

/**
 * A job "Annulla" stopped, still waiting for its task to end: its tasks go to
 * the history (the running one as cancelled) and it is let go, so a new job
 * can start at once (its loop starts when the old one ends).
 */
function retireCancelled(): void {
  const j = state.job;
  if (!j?.running || !j.cancelled) return;
  const tasks = j.tasks.map((t) => (isActive(t) ? { ...t, status: "cancelled" as const } : t));
  mlog("import: cancelled run let go for a new one", { run: j.run });
  finish({ ...j, listing: false, tasks });
}

/** The job to add to: the one running, unless it was cancelled (then a new one). */
function liveJob(): ImportJob {
  retireCancelled();
  return state.job?.running ? state.job : newJob();
}

function newJob(): ImportJob {
  ctrl = new AbortController();
  memo = new Map();
  return { run: ++runSeq, running: true, listing: false, tasks: [], cancelled: false };
}

/**
 * Adds tasks to the job running (or starts one). A key already waiting or
 * running is not added twice. Returns the tasks queued.
 */
export function enqueue(tasks: NewTask[], who: string): ImportTask[] {
  if (who) owner = who;
  let j = liveJob();
  const busy = new Set(j.tasks.filter(isActive).map((t) => t.key));
  const add: ImportTask[] = [];
  for (const t of tasks) {
    if (busy.has(t.key)) continue;
    busy.add(t.key);
    add.push({ seq: ++seq, key: t.key, name: t.name, spec: t.spec, announce: !!t.announce, status: "queued", n: 0, m: 0 });
  }
  if (!add.length && j !== state.job) return [];
  j = { ...j, tasks: [...j.tasks, ...add] };
  setJob(j);
  mlog("import: queued", { run: j.run, n: add.length, keys: add.map((t) => t.key).slice(0, 20) });
  kick();
  return add;
}

function kick() {
  const j = state.job;
  if (!j?.running || looping) return;
  void loop(j.run);
}

async function loop(run: number) {
  looping = true;
  try {
    for (;;) {
      const j = state.job;
      if (!j || j.run !== run || j.cancelled) break;
      const next = j.tasks.find((t) => t.status === "queued");
      if (!next) break;
      await runTask(run, next.seq);
    }
  } finally {
    looping = false;
  }
  const j = state.job;
  // A new job started meanwhile (after "Annulla"): its loop starts now.
  if (j && j.run !== run) return kick();
  if (!j || j.listing) return;
  finish(j);
}

function finish(j0: ImportJob) {
  // Nothing is left waiting in a finished run (it would show "In coda" for good).
  const j = j0.tasks.some((t) => isActive(t)) ? { ...j0, tasks: j0.tasks.map((t) => (isActive(t) ? { ...t, status: "cancelled" as const } : t)) } : j0;
  const history = new Map(state.history);
  for (const t of j.tasks) if (!isActive(t)) history.set(t.key, t);
  const done = { ...j, running: false };
  emit({ job: done, history });
  const c = (s: TaskStatus) => j.tasks.filter((t) => t.status === s).length;
  mlog("import: run ended", { run: j.run, done: c("done"), errors: c("error"), cancelled: c("cancelled") });
  fire({ type: "run", job: done });
}

/** "Annulla": the task running stops, the waiting ones are dropped. */
export function cancelImport(): void {
  const j = state.job;
  if (!j?.running) return;
  mlog("import: cancelled", { run: j.run });
  ctrl.abort();
  setJob({ ...j, cancelled: true, listing: false, tasks: j.tasks.map((t) => (t.status === "queued" ? { ...t, status: "cancelled" } : t)) });
  if (!looping) finish(state.job!);
}

class Cancelled extends Error {}
class TaskError extends Error {
  constructor(public code: ErrorCode) {
    super(code);
  }
}

const SP_ERR = new Set(["signed-out", "quota", "forbidden", "not-found", "network", "server"]);
/** A thrown error as a task error code. */
function codeOf(e: unknown): ErrorCode {
  if (e instanceof TaskError) return e.code;
  if (e instanceof SpotifyApiError) return SP_ERR.has(e.code) ? `sp:${e.code}` : "server";
  return "server";
}

interface Read {
  name: string;
  songs: SpotifySong[];
  source: NewSource | null;
}

async function readSongs(run: number, task: ImportTask, signal: AbortSignal): Promise<Read> {
  const spec = task.spec;
  const live = () => state.job?.run === run && !signal.aborted;
  if (spec.kind === "list") {
    let source = spec.source === "liked" ? null : spec.source;
    if (spec.source === "liked") {
      const me = await spotifyMe(signal, { fresh: true }).catch(() => null);
      source = spotifySourceOf(spec.list, { library: true, me });
    }
    return { name: task.name, songs: spec.list.songs, source };
  }
  if (spec.kind === "liked") {
    // The account asked fresh with the token in hand: the liked songs are this account's.
    const me = await spotifyMe(signal, { fresh: true });
    const r = await likedTracks(signal, (n, m) => live() && patchTask(run, task.seq, { n, m: Math.min(m ?? n, LIKED_CAP) }));
    return { name: task.name, songs: r.tracks.map(songOf), source: me ? { kind: "spotify-liked", id: me, name: task.name } : null };
  }
  if (spec.kind === "tracks") {
    patchTask(run, task.seq, { n: 0, m: spec.ids.length });
    const read = await readSpotifyTracks(spec.ids, (n) => live() && patchTask(run, task.seq, { n }), () => !live(), { signal });
    if (!live()) throw new Cancelled();
    const songs = read.map((s, i) => (s ? { ...s, id: spec.ids[i] } : null)).filter((s): s is SpotifySong & { id: string } => !!s);
    if (!songs.length) throw new TaskError("unavailable");
    return { name: spec.nameFor(songs.length), songs, source: null };
  }
  if (spec.kind === "spotify") {
    // Read as the person (their own / collaborative playlist whole, each song with its id);
    // else, or when Spotify gives only the details, the server (the embed page's first 100).
    if (spotifyUserToken()) {
      const u = await readLinkAsUser(spec.target, spec.id, signal);
      if (!live()) throw new Cancelled();
      mlog("import: read as the user", { id: spec.id, result: typeof u === "string" ? u : u.songs.length });
      if (typeof u !== "string") return { name: u.name || task.name, songs: u.songs, source: { kind: spec.target === "album" ? "spotify-album" : "spotify-playlist", id: spec.id, name: u.name || task.name } };
    }
    const r = await fetchSpotify(spec.url, { signal });
    if (!live()) throw new Cancelled();
    if ("error" in r) throw new TaskError(r.error);
    return { name: r.name || task.name, songs: r.songs, source: spotifySourceOf(r, { link: spec.url }) };
  }
  throw new TaskError("server");
}

/** The songs found on YouTube; each Spotify id matched once per run. */
async function matchSongs(run: number, task: ImportTask, songs: SpotifySong[], signal: AbortSignal): Promise<(Track | null)[]> {
  const live = () => state.job?.run === run && !signal.aborted;
  const out: (Track | null | undefined)[] = new Array(songs.length).fill(undefined);
  const need: number[] = [];
  const first = new Set<string>();
  songs.forEach((s, i) => {
    const id = spotifyIdOf(s);
    if (id && memo.has(id)) out[i] = memo.get(id)!;
    else if (id && first.has(id)) return; // the same song twice in this list: filled below
    else {
      need.push(i);
      if (id) first.add(id);
    }
  });
  const base = songs.length - need.length;
  patchTask(run, task.seq, { status: "matching", n: base, m: songs.length });
  if (base) mlog("import: songs already matched in this run", { key: task.key, reused: base });
  const found = need.length
    ? await matchSpotify(
        need.map((i) => songs[i]),
        (d) => live() && patchTask(run, task.seq, { n: base + d }),
        () => !live(),
        { signal }
      )
    : [];
  if (!live()) throw new Cancelled();
  need.forEach((i, k) => {
    out[i] = found[k] ?? null;
    const id = spotifyIdOf(songs[i]);
    if (id) memo.set(id, out[i] ?? null);
  });
  return out.map((m, i) => (m === undefined ? memo.get(spotifyIdOf(songs[i]) ?? "") ?? null : m));
}

/** Saves the team playlist (no edit step). Skips it when one with this source appeared meanwhile. */
async function save(run: number, task: ImportTask, name: string, tracks: Track[], source: NewSource | null, stats: { readable: number; missing: number } = { readable: tracks.length, missing: 0 }): Promise<void> {
  if (source) {
    const have = getPlaylists().find((p) => p.source && keyOfSource(p.source) === keyOfSource(source) && (source.kind !== "spotify-liked" || p.source.id === source.id));
    if (have) {
      mlog("import: already in the library, nothing made", { key: task.key, playlist: have.id });
      patchTask(run, task.seq, { status: "done", playlistId: have.id, existed: true, found: have.tracks.length });
      return;
    }
  }
  if (!tracks.length) throw new TaskError("none-found");
  patchTask(run, task.seq, { status: "saving", name });
  const { playlist, saved } = createPlaylist(name, owner, tracks, source);
  mlog("import: saved", { key: task.key, playlist: playlist.id, songs: tracks.length, source: source?.kind ?? null });
  patchTask(run, task.seq, { playlistId: playlist.id });
  const r = await saved;
  if (!r.ok) throw new TaskError(`db:${r.error}`);
  // What could not be found, kept for the check (after a reload too).
  recordSourceStats(playlist.id, { ...stats, at: Date.now() });
  patchTask(run, task.seq, { status: "done", ...(source && r.sourceSaved === false ? { noSource: true } : {}) });
}

async function runTask(run: number, s: number): Promise<void> {
  const signal = ctrl.signal;
  const task = taskOf(run, s);
  if (!task) return;
  const spec = task.spec;
  mlog("import: task", { key: task.key, kind: spec.kind });
  try {
    patchTask(run, s, { status: "reading", n: 0, m: 0 });
    if (spec.kind === "link" || spec.kind === "retry") {
      if (spec.kind === "link") {
        if (signal.aborted) throw new Cancelled();
        const r = await setPlaylistSource(spec.playlistId, spec.source);
        if (!r.ok) throw new TaskError(r.error === "migration" ? "migration" : `db:${r.error}`);
        mlog("import: old import linked to its source", { key: task.key, playlist: spec.playlistId });
      }
      patchTask(run, s, { status: "matching", playlistId: spec.playlistId, linked: spec.kind === "link" });
      // The sync's own "n of m" (only the songs not in the playlist are looked for), shown as this task's.
      const follow = setInterval(() => {
        const st = getSyncState(spec.playlistId);
        if (st?.phase === "matching") patchTask(run, s, { n: st.n, m: st.m });
      }, 200);
      // Linked: its first sync keeps every song it has (only the source's new ones are added).
      const res = await syncPlaylist(spec.playlistId, { force: true, signal, keepUnused: spec.kind === "link" }).finally(() => clearInterval(follow));
      // Written already: done, even if "Annulla" came during the write.
      if (signal.aborted && res.status !== "done") throw new Cancelled();
      if (res.status === "error") throw new TaskError(res.error === "migration" ? "migration" : `sync:${res.error}`);
      if (res.status === "skipped" && res.reason === "liked-other") throw new TaskError("liked-other");
      const missing = res.status === "done" ? res.missing : undefined;
      patchTask(run, s, { status: "done", ...(missing ? { missing: missing.length, missingSongs: missing } : {}) });
      return;
    }
    if (spec.kind === "yt") {
      const r = await fetchYtPlaylist(spec.list, { signal });
      if (signal.aborted) throw new Cancelled();
      if ("error" in r) throw new TaskError(r.error);
      const tracks = (r.tracks ?? []).filter((t) => t?.id);
      const name = r.title || task.name;
      patchTask(run, s, { name, n: tracks.length, m: tracks.length, found: tracks.length, missing: 0 });
      await save(run, task, name, tracks, { kind: "youtube-playlist", id: r.list || spec.list, name });
      return;
    }
    const read = await readSongs(run, task, signal);
    if (signal.aborted) throw new Cancelled();
    patchTask(run, s, { name: read.name });
    if (!read.songs.length) throw new TaskError("empty");
    const matches = await matchSongs(run, { ...task, name: read.name }, read.songs, signal);
    // Each song keeps its Spotify id (Spotify mode plays it without searching) and its source key (the sync).
    const keyed = withSourceKeys(withSpotifyIds(matches, read.songs), read.songs);
    const tracks = keyed.filter((m): m is Track => !!m);
    const missingSongs = read.songs.filter((_, i) => !keyed[i]).map((x) => ({ title: x.title, artist: x.artist }));
    patchTask(run, s, { found: tracks.length, missing: missingSongs.length, missingSongs });
    await save(run, { ...task, name: read.name }, read.name, tracks, read.source, { readable: read.songs.length, missing: missingSongs.length });
  } catch (e) {
    if (e instanceof Cancelled || signal.aborted || (e instanceof SpotifyApiError && e.code === "aborted")) {
      patchTask(run, s, { status: "cancelled" });
      return;
    }
    const code = codeOf(e);
    mlog("import: task failed", { key: task.key, error: code, detail: e instanceof TaskError || e instanceof SpotifyApiError ? undefined : String(e) }, "warn");
    patchTask(run, s, { status: "error", error: code });
  } finally {
    const t = taskOf(run, s);
    if (t?.announce && !isActive(t)) fire({ type: "task", task: t });
  }
}

// ---- What the buttons call -----------------------------------------------------------------

/** The task for one list of the check. */
export function taskForEntry(entry: SpEntry, announce = false): NewTask {
  if (entry.kind === "liked") return { key: entry.key, name: entry.name, spec: { kind: "liked" }, announce };
  return { key: entry.key, name: entry.name, spec: { kind: "spotify", target: "playlist", id: entry.id, url: `https://open.spotify.com/playlist/${entry.id}` }, announce };
}

/**
 * "Aggiungi" / "Riprova" on one row of the check: the same plan as "Aggiungi
 * tutte" for that list (already in → nothing; an old same-name import → linked).
 * `me`: the Spotify account id, when known (the liked songs' source).
 */
export function addEntry(entry: SpEntry, who: string, me?: string | null): void {
  const plan = planAddAll([entry], getPlaylists(), me, who || owner);
  if (plan.already.length) return void mlog("import: already in the library", { key: entry.key });
  const l = plan.link[0];
  enqueue([l ? { key: entry.key, name: l.playlist.name, spec: { kind: "link", playlistId: l.playlist.id, source: l.source }, announce: true } : taskForEntry(entry, true)], who);
}

/** A library list's key ("spotify-playlist:<id>", "spotify-album:<id>", "spotify-liked"); null for the recent list. */
export function keyOfList(list: Pick<SpotifyList, "id">): string | null {
  const [kind, id] = list.id.split(":");
  if (kind === "liked") return LIKED_KEY;
  if ((kind === "playlist" || kind === "album") && id) return `spotify-${kind}:${id}`;
  return null;
}

/**
 * "Aggiungi" on a list open in the library (its songs already read): saved
 * at once with its source. `key`: "spotify-playlist:<id>", "spotify-album:<id>",
 * "spotify-liked" or "recent:…".
 */
export function addSpotifyList(list: SpotifyList, name: string, who: string): ImportTask | null {
  const kind = list.id.split(":")[0];
  const key = keyOfList(list) ?? `recent:${Date.now()}`;
  const source: NewSource | null | "liked" = kind === "liked" ? "liked" : spotifySourceOf(list, { library: true });
  return enqueue([{ key, name, spec: { kind: "list", list: { ...list, name }, source }, announce: true }], who)[0] ?? null;
}

export type LinkAdd = { kind: "queued"; task: ImportTask } | { kind: "already"; playlist: Playlist } | { kind: "busy" } | { kind: "bad" };

/**
 * The Importa page's link field, one click: a Spotify playlist / album link,
 * track links pasted from the Spotify app (2+), or a YouTube / YouTube Music
 * playlist link — read, matched and saved with its source. A list already in
 * the library (by its source) is not added again.
 */
export function addFromLink(input: string, who: string, opts: { pastedName: (n: number) => string; ytList: (s: string) => string | null; trackIds: (s: string) => string[] }): LinkAdd {
  const s = input.trim();
  const team = getPlaylists();
  const ids = opts.trackIds(s);
  let task: NewTask | null = null;
  if (ids.length >= 2) task = { key: `tracks:${ids.length}-${ids[0]}`, name: opts.pastedName(ids.length), spec: { kind: "tracks", ids, nameFor: opts.pastedName }, announce: true };
  else {
    const sp = spotifyLinkTarget(s);
    if (sp) {
      const key = `spotify-${sp.kind}:${sp.id}`;
      const have = team.find((p) => p.source && keyOfSource(p.source) === key);
      if (have) return { kind: "already", playlist: have };
      task = { key, name: "Spotify", spec: { kind: "spotify", target: sp.kind, id: sp.id, url: `https://open.spotify.com/${sp.kind}/${sp.id}` }, announce: true };
    } else {
      const list = opts.ytList(s);
      if (!list || /^RD/.test(list)) return { kind: "bad" };
      const key = `youtube-playlist:${list}`;
      const have = team.find((p) => p.source && keyOfSource(p.source) === key);
      if (have) return { kind: "already", playlist: have };
      task = { key, name: "YouTube", spec: { kind: "yt", list }, announce: true };
    }
  }
  const [t] = enqueue([task], who);
  return t ? { kind: "queued", task: t } : { kind: "busy" };
}

/** "Riprova i mancanti" on a team playlist with a source: a sync (only songs not in it are looked for). */
export function retryMissing(playlist: Playlist, key: string, who: string): ImportTask | null {
  return enqueue([{ key, name: playlist.name, spec: { kind: "retry", playlistId: playlist.id }, announce: true }], who)[0] ?? null;
}

/**
 * "Aggiungi tutte le mie playlist": reads the person's playlists and liked
 * songs, then skips what is in, links old same-name imports and adds the rest.
 * Needs the Spotify sign-in (the caller starts it otherwise).
 */
export async function startAddAll(opts: { owner: string; likedName: string }): Promise<void> {
  if (state.job?.listing && !state.job.cancelled) return;
  owner = opts.owner || owner;
  const j = liveJob();
  const run = j.run;
  setJob({ ...j, listing: true, listError: undefined });
  const signal = ctrl.signal;
  mlog("add-all: start", { run });
  try {
    const [items, likedN, me] = await Promise.all([myPlaylists(signal), likedTotal(signal).catch(() => undefined), spotifyMe(signal).catch(() => null)]);
    if (state.job?.run !== run || signal.aborted) return;
    const { entries, excluded } = entriesOf(items, { name: opts.likedName, count: likedN });
    const plan = planAddAll(entries, getPlaylists(), me, owner);
    mlog("add-all: plan", { lists: entries.length, already: plan.already.length, link: plan.link.length, add: plan.add.length, excluded: excluded.length });
    const cur = state.job!;
    setJob({ ...cur, listing: false, excluded: excluded.length, already: plan.already.length });
    const tasks: NewTask[] = [
      ...plan.link.map((l) => ({ key: l.entry.key, name: l.playlist.name, spec: { kind: "link" as const, playlistId: l.playlist.id, source: l.source } })),
      ...plan.add.map((e) => taskForEntry(e)),
    ];
    if (tasks.length) enqueue(tasks, owner);
    else if (!looping) finish(state.job!);
  } catch (e) {
    if (state.job?.run !== run) return;
    const aborted = signal.aborted || (e instanceof SpotifyApiError && e.code === "aborted");
    mlog("add-all: listing failed", { error: aborted ? "aborted" : codeOf(e) }, aborted ? "info" : "warn");
    setJob({ ...state.job!, listing: false, ...(aborted ? {} : { listError: codeOf(e) }) });
    if (!looping) {
      if (state.job!.tasks.some((t) => t.status === "queued")) kick();
      else finish(state.job!);
    }
  }
}

// ---- Progress and the check -----------------------------------------------------------------

export interface ImportStep {
  /** The list running now (1-based) of all in this run. */
  i: number;
  of: number;
  /** Songs of that list done / to do. */
  n: number;
  m: number;
  name: string;
}

/** "Playlist 3 di 12 · brani 40 di 85", or null when nothing runs. */
export function importStep(j: ImportJob | null): ImportStep | null {
  if (!j?.running) return null;
  const at = j.tasks.findIndex((t) => t.status === "reading" || t.status === "matching" || t.status === "saving");
  const cur = at >= 0 ? j.tasks[at] : undefined;
  const finished = j.tasks.filter((t) => !isActive(t)).length;
  return { i: at >= 0 ? at + 1 : Math.min(finished + 1, Math.max(1, j.tasks.length)), of: j.tasks.length, n: cur?.n ?? 0, m: cur?.m ?? 0, name: cur?.name ?? "" };
}

export type CheckState = "added" | "running" | "incomplete" | "error" | "todo";
export interface CheckRow {
  entry: SpEntry;
  state: CheckState;
  playlist?: Playlist;
  /** Songs in the team playlist. */
  have?: number;
  /** Songs of the Spotify list not in the team playlist (not found on YouTube). */
  missing?: number;
  task?: ImportTask;
}

/** The newest task for a key: this run's, else the last finished one. */
export function lastTask(s: ImportState, key: string): ImportTask | undefined {
  const cur = s.job?.tasks.filter((t) => t.key === key).pop();
  return cur ?? s.history.get(key);
}

/**
 * The check, from the team playlists' sources (realtime) — never from the
 * job's memory alone: "added" means a team playlist has that source now. The
 * songs missing: the last import / sync of it (this run, else what this
 * browser kept: sourceStats), never Spotify's raw count (it counts local
 * files, episodes and the same song twice, none of which can be added).
 */
export function checkRows(entries: SpEntry[], team: Playlist[], s: ImportState, me?: string | null): CheckRow[] {
  return entries.map((entry) => {
    const task = lastTask(s, entry.key);
    const playlist = teamFor(entry, team, me);
    if (isActive(task)) return { entry, state: "running", task, ...(playlist ? { playlist, have: playlist.tracks.length } : {}) };
    if (playlist) {
      const have = playlist.tracks.length;
      const fromTask = task?.status === "done" && task.playlistId === playlist.id && typeof task.missing === "number" && !task.existed ? task.missing : undefined;
      const missing = fromTask ?? sourceStats(playlist.id)?.missing ?? 0;
      return { entry, state: missing > 0 ? "incomplete" : "added", playlist, have, missing, ...(task ? { task } : {}) };
    }
    if (task?.status === "error") return { entry, state: "error", task };
    return { entry, state: "todo", ...(task ? { task } : {}) };
  });
}

export interface CheckSummary {
  total: number;
  added: number;
  incomplete: number;
  running: number;
  error: number;
  todo: number;
  /** Every list is in, none incomplete. */
  complete: boolean;
}

export function checkSummary(rows: CheckRow[]): CheckSummary {
  const c = (s: CheckState) => rows.filter((r) => r.state === s).length;
  const sum = { total: rows.length, added: c("added"), incomplete: c("incomplete"), running: c("running"), error: c("error"), todo: c("todo") };
  return { ...sum, complete: sum.total > 0 && sum.added === sum.total };
}

/** Tests: forget the job. */
export function resetImportJob(): void {
  ctrl.abort();
  looping = false;
  memo = new Map();
  owner = "";
  emit({ job: null, history: new Map() });
}
