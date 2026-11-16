import { beforeEach, describe, expect, it, vi } from "vitest";

// Imported playlists synced with their source (lib/musicDb.ts, migration 022).
// Everything outside is a stand-in: the Supabase client (as in
// music-radio.test.ts), the music functions (fetchSpotify, fetchYtPlaylist,
// matchSpotify, fetchRadio), the Spotify sign-in and La mia libreria.
type Res = { data: unknown; error: { code?: string; message?: string } | null };
const db = vi.hoisted(() => ({
  calls: [] as { kind: string; args?: unknown }[],
  rows: [] as Record<string, unknown>[],
  rpc: [] as (Res | Promise<Res>)[],
  write: [] as (Res | Promise<Res>)[],
}));
const fx = vi.hoisted(() => ({
  spotify: [] as unknown[], // fetchSpotify answers
  yt: [] as unknown[], // fetchYtPlaylist answers
  radio: [] as unknown[],
  matched: [] as string[][], // the titles each matchSpotify call was asked for
  notOnYt: new Set<string>(), // titles matchSpotify does not find
  gate: null as Promise<void> | null,
  token: null as string | null,
  me: null as string | null,
  meOpts: [] as unknown[], // the options each spotifyMe call had
  owner: "anna", // the name picked on this device (spotifyOwner)
  onLiked: null as (() => void) | null, // runs while the liked songs are read
  userList: null as unknown, // readLinkAsUser answer
  liked: null as unknown,
  read: [] as string[], // what was read
}));

vi.mock("../supabaseClient", () => {
  const answer = (q: (Res | Promise<Res>)[], dflt: () => Res) => Promise.resolve(q.length ? q.shift()! : dflt());
  const writeChain = (kind: string, args?: unknown) => {
    const run = () => {
      db.calls.push({ kind, args });
      return answer(db.write, () => ({ data: [], error: null }));
    };
    const chain = {
      eq: () => chain,
      select: () => chain,
      then: (a: (r: Res) => unknown, b?: (e: unknown) => unknown) => run().then(a, b),
    };
    return chain;
  };
  return {
    supabase: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.calls.push({ kind: `rpc:${fn}`, args });
        // By default the server writes: the row with the new songs (or the same), stamped.
        const dflt = (): Res => {
          const r = db.rows.find((x) => x.id === args.p_id);
          if (!r) return { data: [], error: null };
          const stamp = Date.now();
          const col = fn === "music_playlist_radio_refresh" ? { radio_refreshed_at: stamp } : { source_synced_at: stamp };
          return { data: [{ ...r, ...(args.p_tracks ? { tracks: args.p_tracks } : {}), ...col, updated_at: stamp }], error: null };
        };
        return answer(db.rpc, dflt);
      },
      from: () => ({
        select: () => ({
          order: () => Promise.resolve({ data: db.rows, error: null }),
          eq: () => Promise.resolve({ data: db.rows, error: null }),
        }),
        upsert: (r: unknown) => writeChain("upsert", r),
        update: (r: unknown) => writeChain("update", r),
        delete: () => writeChain("delete"),
      }),
    },
  };
});

vi.mock("../music", () => ({
  mlog: () => {},
  fetchRadio: async () => (fx.radio.length ? fx.radio.shift() : { tracks: [] }),
  fetchSpotify: async (url: string) => {
    fx.read.push(`server:${url}`);
    return fx.spotify.length ? fx.spotify.shift() : { error: "server" };
  },
  fetchYtPlaylist: async (list: string) => {
    fx.read.push(`yt:${list}`);
    return fx.yt.length ? fx.yt.shift() : { error: "server" };
  },
  matchSpotify: async (songs: { title: string }[], progress: (n: number) => void) => {
    fx.matched.push(songs.map((s) => s.title));
    if (fx.gate) await fx.gate;
    progress(songs.length);
    return songs.map((s) => (fx.notOnYt.has(s.title) ? null : { id: `yt-${s.title}`, title: s.title, channel: "c" }));
  },
}));

vi.mock("../spotifyAuth", () => ({ spotifyUserToken: () => fx.token, spotifyOwner: () => fx.owner }));

vi.mock("../spotifyLibrary", () => ({
  spotifyMe: async (_signal?: unknown, opts?: unknown) => {
    fx.meOpts.push(opts);
    return fx.me;
  },
  readLinkAsUser: async (kind: string, id: string) => {
    fx.read.push(`user:${kind}:${id}`);
    return fx.userList ?? "fail";
  },
  likedTracks: async () => {
    fx.read.push("liked");
    fx.onLiked?.();
    return fx.liked;
  },
  songOf: (t: { id: string; name: string; artists: string; ms: number }) => ({ title: t.name, artist: t.artists, ms: t.ms, id: t.id }),
}));

type Mod = typeof import("../musicDb");
let m: Mod;

const DAY = 24 * 60 * 60 * 1000;
// Spotify ids are 22 characters.
const sp = (c: string) => c.repeat(22).slice(0, 22);
const song = (title: string, id?: string) => ({ title, artist: "Art", ms: 1000, ...(id ? { id } : {}) });
const kept = (title: string, extra: Record<string, unknown> = {}) => ({ id: `old-${title}`, title, channel: "c", spotify: sp(title), src: `art|${title}`, ...extra });
function row(id: string, tracks: unknown[], source: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "List",
    owner: "me",
    tracks,
    created_at: 1,
    updated_at: 100,
    ...(source ? { source_kind: "spotify-playlist", source_id: "P", source_name: "Src", source_synced_at: Date.now(), source_auto: true, ...source } : {}),
    ...extra,
  };
}
const ids = (id: string) => m.getPlaylist(id)?.tracks.map((t) => t.id);
const rpcs = (fn = "music_playlist_source_sync") => db.calls.filter((c) => c.kind === `rpc:${fn}`).map((c) => c.args as Record<string, unknown>);

beforeEach(async () => {
  vi.resetModules();
  db.calls.length = 0;
  db.rpc.length = 0;
  db.write.length = 0;
  fx.spotify.length = 0;
  fx.yt.length = 0;
  fx.radio.length = 0;
  fx.matched.length = 0;
  fx.notOnYt.clear();
  fx.gate = null;
  fx.token = null;
  fx.me = null;
  fx.meOpts.length = 0;
  fx.owner = "anna";
  fx.onLiked = null;
  fx.userList = null;
  fx.liked = null;
  fx.read.length = 0;
  // A playlist synced just now (not due), from a Spotify playlist; and an ordinary one.
  db.rows = [row("s", [kept("a"), kept("b"), kept("c")], {}), row("q", [kept("x")], null)];
  m = await import("../musicDb");
  await m.reloadPlaylists();
  await m.maybeSyncSources(); // the load's own check (nothing due)
  db.calls.length = 0;
  fx.read.length = 0;
});

describe("rows and creating with a source", () => {
  it("map the source columns to playlist.source, and none to an ordinary playlist", () => {
    expect(m.getPlaylist("s")?.source).toMatchObject({ kind: "spotify-playlist", id: "P", name: "Src", auto: true });
    expect(m.getPlaylist("q")?.source).toBeUndefined();
  });

  it("createPlaylist with a source saves the source columns and keeps each song's source key", async () => {
    const { playlist, saved } = m.createPlaylist("Imp", "me", [{ id: "v1", title: "T", channel: "c", spotify: sp("t"), src: "art|t" } as never], {
      kind: "spotify-album",
      id: "AL",
      name: "Album",
    });
    expect(m.getPlaylist(playlist.id)?.source).toMatchObject({ kind: "spotify-album", id: "AL", auto: true });
    db.write.length = 0;
    const r = await saved;
    expect(r).toEqual({ ok: false, error: "not-found", sourceSaved: false }); // the stand-in returned no row
    const up = db.calls.find((c) => c.kind === "upsert")!.args as Record<string, unknown>;
    expect(up).toMatchObject({ source_kind: "spotify-album", source_id: "AL", source_name: "Album", source_auto: true });
    expect(typeof up.source_synced_at).toBe("number");
    expect((up.tracks as { src?: string }[])[0].src).toBe("art|t");
  });

  it("says sourceSaved: true when the server keeps it", async () => {
    db.write.push(Promise.resolve().then(() => ({ data: [row("n", [], { source_kind: "youtube-playlist", source_id: "PL1" })], error: null })));
    const { saved } = m.createPlaylist("Yt", "me", [], { kind: "youtube-playlist", id: "PL1", name: "Yt" });
    // The stand-in's row has another id: what matters here is the flag.
    expect((await saved).sourceSaved).toBe(true);
  });

  it("before migration 022, saves an ordinary playlist and says sourceSaved: false", async () => {
    db.write.push({ data: null, error: { code: "PGRST204", message: "Could not find the 'source_kind' column of 'music_playlists'" } });
    db.write.push({ data: [row("tmp", [], null)], error: null });
    const { saved } = m.createPlaylist("Imp", "me", [], { kind: "spotify-playlist", id: "P2", name: "P2" });
    const r = await saved;
    expect(r.sourceSaved).toBe(false);
    const ups = db.calls.filter((c) => c.kind === "upsert").map((c) => c.args as Record<string, unknown>);
    expect(ups).toHaveLength(2);
    expect(ups[1].source_kind).toBeUndefined();
    expect(m.sourcesMissing()).toBe(true);
    // Later imports go straight to the plain save, and the daily sync stays off.
    db.calls.length = 0;
    await m.createPlaylist("Imp2", "me", [], { kind: "spotify-playlist", id: "P3", name: "P3" }).saved;
    expect(db.calls.filter((c) => c.kind === "upsert")).toHaveLength(1);
    await m.maybeSyncSources(Date.now() + 2 * DAY, true);
    expect(fx.read).toEqual([]);
  });

  it("an ordinary playlist's save result has no sourceSaved", async () => {
    db.write.push({ data: null, error: { code: "XX", message: "boom" } });
    expect(await m.createPlaylist("Plain", "me").saved).toEqual({ ok: false, error: "server" });
  });

  it("spotifySourceOf: links, library lists, liked songs (with the importer's id), pasted songs", () => {
    const L = { kind: "playlist" as const, id: "x", name: "N" };
    expect(m.spotifySourceOf(L, { link: `https://open.spotify.com/intl-it/playlist/${sp("p")}?si=1` })).toEqual({ kind: "spotify-playlist", id: sp("p"), name: "N" });
    expect(m.spotifySourceOf({ ...L, kind: "album" }, { link: `spotify:album:${sp("a")}` })).toEqual({ kind: "spotify-album", id: sp("a"), name: "N" });
    expect(m.spotifySourceOf({ ...L, kind: "tracks" }, { link: `https://open.spotify.com/playlist/${sp("p")}` })).toBeNull();
    expect(m.spotifySourceOf({ ...L, id: "playlist:PID" }, { library: true })).toEqual({ kind: "spotify-playlist", id: "PID", name: "N" });
    expect(m.spotifySourceOf({ ...L, kind: "album", id: "album:AID" }, { library: true })).toEqual({ kind: "spotify-album", id: "AID", name: "N" });
    expect(m.spotifySourceOf({ ...L, id: "liked:liked" }, { library: true, me: "u1" })).toEqual({ kind: "spotify-liked", id: "u1", name: "N" });
    expect(m.spotifySourceOf({ ...L, id: "liked:liked" }, { library: true })).toBeNull();
    expect(m.spotifySourceOf({ ...L, id: "recent:recent" }, { library: true })).toBeNull();
  });

  it("withSourceKeys keeps the title + artist key and the Spotify id", () => {
    const out = m.withSourceKeys([{ id: "v", title: "T", channel: "c" }, null], [song("Tè!", sp("t")), song("Z")]);
    expect(out[0]).toMatchObject({ id: "v", spotify: sp("t"), src: "art|te" });
    expect(out[1]).toBeNull();
  });
});

describe("the daily sync", () => {
  it("syncs only playlists last checked more than a day ago, and only automatic ones", async () => {
    db.rows = [
      row("fresh", [kept("a")], {}),
      row("due", [kept("a")], { source_id: "DUE", source_synced_at: Date.now() - DAY - 1000 }),
      row("off", [kept("a")], { source_id: "OFF", source_synced_at: Date.now() - 3 * DAY, source_auto: false }),
    ];
    await m.reloadPlaylists();
    fx.read.length = 0;
    db.calls.length = 0;
    fx.spotify.push({ kind: "playlist", id: "DUE", name: "Src", owner: "o", cover: "", songs: [song("a")], via: "api" });
    await m.maybeSyncSources(Date.now(), true);
    expect(fx.read).toEqual([`server:https://open.spotify.com/playlist/DUE`]);
    const [call] = rpcs();
    expect(call).toMatchObject({ p_id: "due", p_tracks: null, p_stale_ms: m.SOURCE_STALE_MS }); // unchanged: stamp only
  });

  it("checks at most once an hour per browser unless forced", async () => {
    db.rows = [row("due", [kept("a")], { source_synced_at: 1 })];
    await m.reloadPlaylists(); // the load's own check runs the sync (no answer: a failure)
    await m.maybeSyncSources();
    fx.read.length = 0;
    await m.maybeSyncSources(); // within the hour: nothing
    expect(fx.read).toEqual([]);
    await m.maybeSyncSources(Date.now() + 61 * 60 * 1000);
    expect(fx.read).toHaveLength(1);
  });
});

describe("the diff", () => {
  it("keeps existing matches, matches only new songs, drops removed ones, follows the source's order", async () => {
    fx.token = "tok";
    // Read with the person's token: songs carry their Spotify ids.
    fx.userList = { kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("c", sp("c")), song("d", sp("d")), song("a", sp("a"))], via: "api" };
    const r = await m.syncPlaylist("s", { force: true });
    expect(fx.read).toEqual(["user:playlist:P"]);
    expect(fx.matched).toEqual([["d"]]);
    expect(r).toEqual({ status: "done", added: 1, removed: 1, missing: [], unchanged: false, limited: false });
    expect(ids("s")).toEqual(["old-c", "yt-d", "old-a"]);
    const sent = rpcs()[0].p_tracks as { id: string; spotify?: string; src?: string }[];
    expect(sent.map((t) => t.id)).toEqual(["old-c", "yt-d", "old-a"]);
    expect(sent[1]).toMatchObject({ spotify: sp("d"), src: "art|d" });
  });

  it("pairs by title + artist when the server gives no Spotify ids, and lists songs YouTube can't find", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("b"), song("a"), song("new"), song("lost")], via: "api" });
    fx.notOnYt.add("lost");
    const r = await m.syncPlaylist("s", { force: true });
    expect(fx.matched).toEqual([["new", "lost"]]);
    expect(r).toMatchObject({ status: "done", added: 1, removed: 1, missing: [{ title: "lost", artist: "Art" }], unchanged: false });
    expect(ids("s")).toEqual(["old-b", "old-a", "yt-new"]);
  });

  it("nothing changed: only the time is stamped (p_tracks null)", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("b"), song("c")], via: "api" });
    const r = await m.syncPlaylist("s", { force: true });
    expect(r).toEqual({ status: "done", added: 0, removed: 0, missing: [], unchanged: true, limited: false });
    expect(fx.matched).toEqual([]);
    expect(rpcs()[0].p_tracks).toBeNull();
    expect(m.getPlaylist("s")?.source?.syncedAt).toBeGreaterThan(0);
  });

  it("a reorder only is a change", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("c"), song("b"), song("a")], via: "api" });
    const r = await m.syncPlaylist("s", { force: true });
    expect(r).toMatchObject({ added: 0, removed: 0, unchanged: false });
    expect(ids("s")).toEqual(["old-c", "old-b", "old-a"]);
  });

  it("a YouTube playlist: compared by video id, nothing matched", async () => {
    db.rows = [row("y", [{ id: "v1", title: "1", channel: "c" }, { id: "v2", title: "2", channel: "c" }], { source_kind: "youtube-playlist", source_id: "PL" })];
    await m.reloadPlaylists();
    fx.yt.push({ list: "PL", title: "T", channel: "c", thumb: "", tracks: [{ id: "v3", title: "3", channel: "c" }, { id: "v1", title: "1", channel: "c" }] });
    const r = await m.syncPlaylist("y", { force: true });
    expect(fx.read).toContain("yt:PL");
    expect(fx.matched).toEqual([]);
    expect(r).toMatchObject({ status: "done", added: 1, removed: 1 });
    expect(ids("y")).toEqual(["v3", "v1"]);
  });

  it("an empty answer never wipes the playlist", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [], via: "embed" });
    expect(await m.syncPlaylist("s", { force: true })).toEqual({ status: "error", error: "empty" });
    expect(rpcs()).toEqual([]);
    expect(ids("s")).toEqual(["old-a", "old-b", "old-c"]);
  });

  it("a failed read is an error and writes nothing", async () => {
    fx.spotify.push({ error: "timeout" });
    expect(await m.syncPlaylist("s", { force: true })).toEqual({ status: "error", error: "timeout" });
    expect(rpcs()).toEqual([]);
  });
});

describe("limited reads", () => {
  it("the embed page's first 100: songs already there past those are kept, nothing removed", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `s${i}`);
    db.rows = [row("big", [...many.map((t) => kept(t)), kept("past1"), kept("past2")], {})];
    await m.reloadPlaylists();
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("fresh"), ...many.map((t) => song(t))], via: "embed", reason: "no-key" });
    const r = await m.syncPlaylist("big", { force: true });
    expect(r).toMatchObject({ status: "done", added: 1, removed: 0, limited: true });
    const got = ids("big")!;
    expect(got[0]).toBe("yt-fresh");
    expect(got.slice(-2)).toEqual(["old-past1", "old-past2"]);
    expect(got).toHaveLength(103);
  });

  it("the server saying limited keeps the extra songs too", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a")], via: "embed", limited: true });
    const r = await m.syncPlaylist("s", { force: true });
    expect(r).toMatchObject({ removed: 0, limited: true });
    expect(ids("s")).toEqual(["old-a", "old-b", "old-c"]);
  });
});

describe("liked songs", () => {
  beforeEach(async () => {
    db.rows = [row("l", [kept("a")], { source_kind: "spotify-liked", source_id: "u1" })];
    await m.reloadPlaylists();
    fx.read.length = 0;
  });

  it("are skipped (not failed) without a Spotify sign-in", async () => {
    expect(await m.syncPlaylist("l", { force: true })).toEqual({ status: "skipped", reason: "liked-other" });
    expect(fx.read).toEqual([]);
    expect(rpcs()).toEqual([]);
  });

  it("are skipped with another Spotify account's token", async () => {
    fx.token = "tok";
    fx.me = "u2";
    expect(await m.syncPlaylist("l", { force: true })).toEqual({ status: "skipped", reason: "liked-other" });
    expect(fx.read).toEqual([]);
  });

  it("sync with the importer's own token", async () => {
    fx.token = "tok";
    fx.me = "u1";
    fx.liked = { tracks: [{ id: sp("z"), name: "z", artists: "Art", ms: 1 }, { id: sp("a"), name: "a", artists: "Art", ms: 1 }], total: 2, capped: false };
    const r = await m.syncPlaylist("l", { force: true });
    expect(fx.read).toEqual(["liked"]);
    expect(r).toMatchObject({ status: "done", added: 1, removed: 0 });
    expect(ids("l")).toEqual(["yt-z", "old-a"]);
  });
});

describe("detaching", () => {
  it("a song edit detaches the daily sync first (source_auto false) and keeps the source", async () => {
    db.rpc.push({ data: [row("s", [kept("a"), kept("b"), kept("c"), kept("n")], { source_auto: false }, { updated_at: 200 })], error: null });
    const r = await m.addToPlaylist("s", { id: "old-n", title: "n", channel: "c" });
    expect(r.ok).toBe(true);
    const upd = db.calls.find((c) => c.kind === "update")!.args;
    expect(upd).toEqual({ source_auto: false });
    expect(db.calls.map((c) => c.kind)).toEqual(["update", "rpc:music_playlist_append"]);
    expect(m.getPlaylist("s")?.source).toMatchObject({ kind: "spotify-playlist", auto: false });
  });

  it("removing and moving detach too; an ordinary playlist sends no detach", async () => {
    void m.removeFromPlaylist("s", "old-a", 0);
    expect(m.getPlaylist("s")?.source?.auto).toBe(false);
    await Promise.resolve();
    void m.moveInPlaylist("q", 0, 0);
    await m.removeFromPlaylist("q", "old-x");
    expect(db.calls.filter((c) => c.kind === "update")).toHaveLength(1);
  });

  it("a rename keeps the sync", async () => {
    db.rpc.push({ data: [row("s", [kept("a"), kept("b"), kept("c")], {}, { name: "New", updated_at: 300 })], error: null });
    await m.renamePlaylist("s", "New");
    expect(db.calls.map((c) => c.kind)).toEqual(["rpc:music_playlist_rename"]);
    expect(m.getPlaylist("s")?.source?.auto).toBe(true);
  });

  it("Stacca / Riattiva set source_auto", async () => {
    db.write.push({ data: [row("s", [kept("a"), kept("b"), kept("c")], { source_auto: false }, { updated_at: 400 })], error: null });
    await m.detachSource("s");
    expect(db.calls[db.calls.length - 1]).toEqual({ kind: "update", args: { source_auto: false } });
    expect(m.getPlaylist("s")?.source?.auto).toBe(false);
    db.write.push({ data: [row("s", [kept("a"), kept("b"), kept("c")], {}, { updated_at: 500 })], error: null });
    await m.reattachSource("s");
    expect(db.calls[db.calls.length - 1]).toEqual({ kind: "update", args: { source_auto: true } });
    expect(m.getPlaylist("s")?.source?.auto).toBe(true);
  });
});

describe("the Sincronizza button (forced)", () => {
  it("syncs a detached playlist once (p_stale_ms 0) and leaves it detached; the daily sync skips it", async () => {
    db.rows = [row("d", [kept("a")], { source_auto: false, source_synced_at: 1 })];
    await m.reloadPlaylists();
    await m.maybeSyncSources(Date.now(), true);
    expect(fx.read).toEqual([]);
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("b")], via: "api" });
    const r = await m.syncPlaylist("d", { force: true });
    expect(r).toMatchObject({ status: "done", added: 1 });
    expect(rpcs()[0].p_stale_ms).toBe(0);
    expect(m.getPlaylist("d")?.source?.auto).toBe(false);
  });

  it("on a radio playlist refreshes the radio now (021's function, forced)", async () => {
    db.rows = [{ id: "r", name: "Radio", owner: "me", tracks: [{ id: "s", title: "S", channel: "c" }, { id: "a", title: "A", channel: "c" }], created_at: 1, updated_at: 1, radio_seed: "s", radio_title: "S", radio_refreshed_at: Date.now() }];
    await m.reloadPlaylists();
    await m.maybeRefreshRadios();
    db.calls.length = 0;
    fx.radio.push({ tracks: [{ id: "s", title: "S", channel: "c" }, { id: "b", title: "B", channel: "c" }] });
    const r = await m.syncPlaylist("r", { force: true });
    expect(rpcs("music_playlist_radio_refresh")[0]).toMatchObject({ p_id: "r", p_stale_ms: 0 });
    expect(r).toMatchObject({ status: "done", added: 1, removed: 1 });
    expect(ids("r")).toEqual(["s", "b"]);
  });

  it("an ordinary playlist has nothing to sync", async () => {
    expect(await m.syncPlaylist("q", { force: true })).toEqual({ status: "skipped", reason: "no-source" });
  });

  it("shows progress while matching, then clears it", async () => {
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("n1"), song("n2")], via: "api" });
    const p = m.syncPlaylist("s", { force: true });
    expect(m.getSyncState("s")).toMatchObject({ phase: "reading" }); // at once
    await vi.waitFor(() => expect(m.getSyncState("s")).toEqual({ phase: "matching", n: 0, m: 2 }));
    open();
    await p;
    expect(m.getSyncState("s")).toBeUndefined();
  });
});

describe("guards", () => {
  it("the RPC guard: another browser synced first, so nothing is written here", async () => {
    db.rpc.push({ data: [], error: null });
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("z")], via: "api" });
    const before = m.getPlaylist("s");
    const r = await m.syncPlaylist("s");
    expect(r).toEqual({ status: "skipped", reason: "not-due" });
    expect(rpcs()[0].p_stale_ms).toBe(m.SOURCE_STALE_MS);
    expect(m.getPlaylist("s")).toBe(before);
  });

  it("the module guard: two syncs of one playlist at once share one read", async () => {
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("z")], via: "api" });
    const a = m.syncPlaylist("s", { force: true });
    const b = m.syncPlaylist("s", { force: true });
    expect(b).toBe(a);
    open();
    await a;
    expect(fx.read).toHaveLength(1);
    expect(rpcs()).toHaveLength(1);
  });

  it("the daily sync stops if the playlist was detached while it read", async () => {
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("z")], via: "api" });
    const p = m.syncPlaylist("s");
    await vi.waitFor(() => expect(fx.matched).toHaveLength(1));
    m.applyChange({ eventType: "UPDATE", new: row("s", [kept("a")], { source_auto: false }, { updated_at: 999 }), old: null });
    open();
    expect(await p).toEqual({ status: "skipped", reason: "not-due" });
    expect(rpcs()).toEqual([]);
  });

  it("before migration 022 the sync's function is missing: said, and the daily sync stops", async () => {
    db.rpc.push({ data: null, error: { code: "PGRST202", message: "Could not find the function public.music_playlist_source_sync" } });
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("z")], via: "api" });
    expect(await m.syncPlaylist("s", { force: true })).toEqual({ status: "error", error: "migration" });
    expect(m.sourcesMissing()).toBe(true);
  });
});

describe("review fixes", () => {
  it("F1: the liked songs' account is asked fresh, never from a cache", async () => {
    db.rows = [row("l", [kept("a")], { source_kind: "spotify-liked", source_id: "u1" })];
    await m.reloadPlaylists();
    fx.token = "tok";
    fx.me = "u1";
    fx.liked = { tracks: [{ id: sp("a"), name: "a", artists: "Art", ms: 1 }], total: 1, capped: false };
    await m.syncPlaylist("l", { force: true });
    expect(fx.meOpts).toEqual([{ fresh: true }]);
  });

  it("F1: another name picked while the liked songs are read: skipped, nothing written", async () => {
    db.rows = [row("l", [kept("a"), kept("b")], { source_kind: "spotify-liked", source_id: "u1" })];
    await m.reloadPlaylists();
    fx.token = "tok";
    fx.me = "u1";
    fx.liked = { tracks: [{ id: sp("z"), name: "z", artists: "Art", ms: 1 }], total: 1, capped: false };
    fx.onLiked = () => (fx.owner = "bruno");
    expect(await m.syncPlaylist("l", { force: true })).toEqual({ status: "skipped", reason: "liked-other" });
    expect(rpcs()).toEqual([]);
    expect(ids("l")).toEqual(["old-a", "old-b"]);
  });

  it("F4: a song added (and one removed) by hand during a forced sync is kept as edited", async () => {
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("c"), song("b"), song("a"), song("n")], via: "api" });
    const p = m.syncPlaylist("s", { force: true });
    await vi.waitFor(() => expect(fx.matched).toHaveLength(1));
    // Meanwhile: "h" added by hand, "b" removed (the edit detached it).
    m.applyChange({ eventType: "UPDATE", new: row("s", [kept("a"), kept("c"), kept("h")], { source_auto: false }, { updated_at: 999 }), old: null });
    open();
    const r = await p;
    const [call] = rpcs();
    expect(call.p_expect).toEqual(["old-a", "old-c", "old-h"]);
    expect((call.p_tracks as { id: string }[]).map((t) => t.id)).toEqual(["old-c", "old-a", "yt-n", "old-h"]);
    expect(ids("s")).toEqual(["old-c", "old-a", "yt-n", "old-h"]);
    expect(r).toMatchObject({ status: "done", added: 1, removed: 0 });
  });

  it("F4: the server refuses a write planned on an old list (p_expect); planned again on the server's list", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("b"), song("c"), song("n")], via: "api" });
    // Another browser added "h" (its echo not here yet): the first write is refused.
    db.rpc.push({ data: [], error: null });
    db.rows = [row("s", [kept("a"), kept("b"), kept("c"), kept("h")], {}, { updated_at: 700 })];
    const r = await m.syncPlaylist("s", { force: true });
    const calls = rpcs();
    expect(calls).toHaveLength(2);
    expect(calls[0].p_expect).toEqual(["old-a", "old-b", "old-c"]);
    expect(calls[1].p_expect).toEqual(["old-a", "old-b", "old-c", "old-h"]);
    expect((calls[1].p_tracks as { id: string }[]).map((t) => t.id)).toEqual(["old-a", "old-b", "old-c", "yt-n", "old-h"]);
    expect(r).toMatchObject({ status: "done", added: 1, removed: 0 });
    expect(fx.matched).toEqual([["n"]]); // nothing matched twice
  });

  it("F4: refused and the list is the same: not due (no retry loop)", async () => {
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a")], via: "api" });
    db.rpc.push({ data: [], error: null });
    expect(await m.syncPlaylist("s", { force: true })).toEqual({ status: "skipped", reason: "not-due" });
    expect(rpcs()).toHaveLength(1);
  });

  it("F4: rebase keeps songs added since the plan, drops songs removed since", () => {
    const t = (id: string) => ({ id, title: id, channel: "c" });
    const before = [t("a"), t("b")];
    expect(m.rebase([t("b"), t("a"), t("n")], before, before).map((x) => x.id)).toEqual(["b", "a", "n"]);
    expect(m.rebase([t("b"), t("a"), t("n")], before, [t("a"), t("h")]).map((x) => x.id)).toEqual(["a", "n", "h"]);
  });

  it("F5: a song edit sends the detach even when this copy already says detached", async () => {
    db.rows = [row("s", [kept("a")], { source_auto: false })];
    await m.reloadPlaylists();
    db.calls.length = 0;
    db.rpc.push({ data: [row("s", [kept("a"), kept("n")], { source_auto: false }, { updated_at: 200 })], error: null });
    await m.addToPlaylist("s", { id: "old-n", title: "n", channel: "c" });
    expect(db.calls.map((c) => c.kind)).toEqual(["update", "rpc:music_playlist_append"]);
    expect(db.calls[0].args).toEqual({ source_auto: false });
  });

  it("F6: Sincronizza during a daily sync runs its own forced sync after it, not the daily's result", async () => {
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("b"), song("c"), song("z")], via: "api" });
    fx.spotify.push({ kind: "playlist", id: "P", name: "Src", owner: "o", cover: "", songs: [song("a"), song("b"), song("c"), song("z")], via: "api" });
    const daily = m.syncPlaylist("s");
    await vi.waitFor(() => expect(fx.matched).toHaveLength(1));
    // The user edits a song (detached), then presses Sincronizza.
    m.applyChange({ eventType: "UPDATE", new: row("s", [kept("a"), kept("b"), kept("c")], { source_auto: false }, { updated_at: 999 }), old: null });
    const forced = m.syncPlaylist("s", { force: true });
    expect(forced).not.toBe(daily);
    expect(m.syncPlaylist("s", { force: true })).toBe(forced); // a second press joins the queued one
    open();
    expect(await daily).toEqual({ status: "skipped", reason: "not-due" });
    const r = await forced;
    expect(r).toMatchObject({ status: "done", added: 1 });
    expect(rpcs()).toHaveLength(1);
    expect(rpcs()[0].p_stale_ms).toBe(0);
  });
});
