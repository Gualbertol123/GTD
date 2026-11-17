import { beforeEach, describe, expect, it, vi } from "vitest";

// One-click imports and the check (lib/spotifyAddAll.ts). The team library is
// the real lib/musicDb over a mocked Supabase client (its upsert / update
// bodies are kept); Spotify (La mia libreria's readers) and the Netlify
// functions (matchSpotify, fetchSpotify, fetchYtPlaylist, readSpotifyTracks)
// are stand-ins.

type Res = { data: unknown; error: { code?: string; message?: string } | null };
const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  upserts: [] as Record<string, unknown>[],
  updates: [] as { values: Record<string, unknown>; id: string }[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
}));
const fx = vi.hoisted(() => ({
  token: "tok" as string | null,
  me: "me1",
  playlists: [] as unknown[],
  liked: [] as unknown[],
  /** readLinkAsUser answers, by playlist id ("fail" when absent). */
  lists: {} as Record<string, unknown>,
  /** fetchSpotify answers, by url. */
  server: {} as Record<string, unknown>,
  yt: {} as Record<string, unknown>,
  pasted: {} as Record<string, { title: string; artist: string; ms: number } | null>,
  matched: [] as string[][],
  notOnYt: new Set<string>(),
  gate: null as Promise<void> | null,
  /** The gate holds only a matching that asks for this title. */
  gateOn: "S1",
  onMatch: null as (() => void) | null,
}));

vi.mock("../supabaseClient", () => {
  const ok = (data: unknown): Res => ({ data, error: null });
  const chainOf = (run: () => Res) => {
    const chain = {
      eq: (_c: string, v: string) => ((chain as { id?: string }).id = v, chain),
      select: () => chain,
      then: (a: (r: Res) => unknown, b?: (e: unknown) => unknown) => Promise.resolve().then(run).then(a, b),
    };
    return chain;
  };
  return {
    supabase: {
      channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpcs.push({ fn, args });
        const r = db.rows.find((x) => x.id === args.p_id);
        if (!r) return Promise.resolve(ok([]));
        Object.assign(r, args.p_tracks ? { tracks: args.p_tracks } : {}, { source_synced_at: Date.now(), updated_at: Date.now() });
        return Promise.resolve(ok([{ ...r }]));
      },
      from: () => ({
        select: () => ({
          order: () => Promise.resolve(ok(db.rows.map((r) => ({ ...r })))),
          eq: (_c: string, id: string) => Promise.resolve(ok(db.rows.filter((r) => r.id === id))),
          limit: () => Promise.resolve(ok([])),
        }),
        upsert: (row: Record<string, unknown>) =>
          chainOf(() => {
            db.upserts.push(row);
            db.rows = [...db.rows.filter((r) => r.id !== row.id), { ...row }];
            return ok([{ ...row }]);
          }),
        update: (values: Record<string, unknown>) => {
          const c = chainOf(() => {
            const id = (c as { id?: string }).id!;
            db.updates.push({ values, id });
            const r = db.rows.find((x) => x.id === id);
            if (!r) return ok([]);
            Object.assign(r, values, { updated_at: Date.now() });
            return ok([{ ...r }]);
          });
          return c;
        },
        delete: () => chainOf(() => ok([])),
      }),
    },
  };
});

vi.mock("../music", () => ({
  mlog: () => {},
  fetchRadio: async () => ({ tracks: [] }),
  findYtPlaylists: async () => ({ lists: [] }),
  playlistIdFrom: (s: string) => s.match(/[?&]list=([\w-]+)/)?.[1] ?? null,
  fetchSpotify: async (url: string) => fx.server[url] ?? { error: "not-found" },
  fetchYtPlaylist: async (list: string) => fx.yt[list] ?? { error: "not-found" },
  readSpotifyTracks: async (ids: string[], progress: (n: number) => void) => {
    progress(ids.length);
    return ids.map((id) => fx.pasted[id] ?? null);
  },
  matchSpotify: async (songs: { title: string }[], progress: (n: number) => void, cancelled: () => boolean) => {
    fx.matched.push(songs.map((s) => s.title));
    fx.onMatch?.();
    if (fx.gate && songs.some((s) => s.title === fx.gateOn)) await fx.gate;
    if (cancelled()) return songs.map(() => null);
    progress(songs.length);
    return songs.map((s) => (fx.notOnYt.has(s.title) ? null : { id: `yt-${s.title}`, title: s.title, channel: "c", thumb: "" }));
  },
}));

vi.mock("../spotifyAuth", () => ({
  spotifyUserToken: () => fx.token,
  spotifyOwner: () => "anna",
  onSpotifySession: () => () => {},
  refreshSpotifyToken: async () => null,
  signOutSpotify: () => {},
}));

vi.mock("../spotifyLibrary", async (orig) => {
  const real = (await orig()) as typeof import("../spotifyLibrary");
  return {
    ...real,
    spotifyMe: async () => fx.me,
    myPlaylists: async () => fx.playlists,
    likedTotal: async () => fx.liked.length,
    likedTracks: async () => ({ tracks: fx.liked, total: fx.liked.length, capped: false }),
    readLinkAsUser: async (_kind: string, id: string) => fx.lists[id] ?? "fail",
  };
});

import * as A from "../spotifyAddAll";
import { forgetSourceStats, getPlaylists, recordSourceStats, reloadPlaylists, type Playlist } from "../musicDb";

// Spotify ids are 22 letters / digits.
const sid = (s: string) => (s + "x".repeat(22)).slice(0, 22);
const sptrack = (title: string) => ({ id: sid(title), name: title, artists: "Art", ms: 1000, url: `https://open.spotify.com/track/${sid(title)}` });
const song = (title: string) => ({ title, artist: "Art", ms: 1000, id: sid(title) });
const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ kind: "playlist", id: sid(id), name, sub: "Io", cover: "", count: 2, url: `https://open.spotify.com/playlist/${sid(id)}`, mine: true, ...extra });
const userList = (id: string, name: string, titles: string[]) => ({ kind: "playlist", id: sid(id), name, owner: "Io", cover: "", songs: titles.map(song), via: "api", total: titles.length });
const row = (id: string, name: string, tracks: number | { id: string; title: string; channel: string; thumb: string; spotify?: string }[], source?: { kind: string; id: string }, owner = "anna") => ({
  id,
  name,
  owner,
  tracks: typeof tracks === "number" ? Array.from({ length: tracks }, (_, i) => ({ id: `old-${id}-${i}`, title: `t${i}`, channel: "c", thumb: "" })) : tracks,
  created_at: 1,
  updated_at: 1,
  ...(source ? { source_kind: source.kind, source_id: source.id, source_name: name, source_synced_at: 5, source_auto: true } : {}),
});

async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const idle = () => until(() => !A.getImportState().job?.running);
const upserted = (name: string) => db.upserts.find((r) => r.name === name);

/** A song of an old import: its YouTube id and the Spotify id it came from. */
const oldSong = (title: string) => ({ id: `yt-${title}`, title, channel: "c", thumb: "", spotify: sid(title) });

beforeEach(async () => {
  A.resetImportJob();
  forgetSourceStats();
  db.rows = [];
  db.upserts = [];
  db.updates = [];
  db.rpcs = [];
  fx.token = "tok";
  fx.me = "me1";
  fx.playlists = [];
  fx.liked = [];
  fx.lists = {};
  fx.server = {};
  fx.yt = {};
  fx.pasted = {};
  fx.matched = [];
  fx.notOnYt = new Set();
  fx.gate = null;
  fx.onMatch = null;
  await reloadPlaylists();
});

describe("Aggiungi tutte le mie playlist", () => {
  async function library() {
    db.rows = [
      row("team-done", "Già fatta", 2, { kind: "spotify-playlist", id: sid("P1") }),
      // An old import of anna's: same name, no source, every song from Spotify (X: no longer on it).
      row("team-old", "Road Trip!", [oldSong("A"), oldSong("X")]),
    ];
    await reloadPlaylists();
    fx.playlists = [
      item("P1", "Già fatta"),
      item("P2", "road trip"),
      item("P3", "Estate", { count: 3 }),
      item("P4", "Inverno", { count: 2 }),
      item("ED", "Hit editoriali", { mine: false, sub: "Spotify" }),
    ];
    fx.lists[sid("P2")] = userList("P2", "road trip", ["A", "B", "C"]);
    fx.lists[sid("P3")] = userList("P3", "Estate", ["S1", "S2", "S3"]);
    fx.lists[sid("P4")] = userList("P4", "Inverno", ["S1", "S4"]);
    fx.liked = [sptrack("S2"), sptrack("L1")];
  }

  it("skips the added, links the old same-name one, imports the rest with their source, matching each song once", async () => {
    await library();
    fx.notOnYt.add("S3");
    await A.startAddAll({ owner: "anna", likedName: "Brani che ti piacciono" });
    await idle();
    const job = A.getImportState().job!;
    expect(job.excluded).toBe(1); // Spotify's own playlist: details only
    expect(job.already).toBe(1);
    // Nothing made for P1; the old import linked (update with its source) and synced once.
    expect(db.upserts.some((r) => r.source_id === sid("P1"))).toBe(false);
    expect(db.upserts.some((r) => r.name === "road trip" || r.name === "Road Trip!")).toBe(false);
    const link = db.updates.find((u) => u.id === "team-old");
    expect(link?.values).toMatchObject({ source_kind: "spotify-playlist", source_id: sid("P2"), source_auto: true });
    expect(db.rpcs.some((r) => r.fn === "music_playlist_source_sync" && r.args.p_id === "team-old")).toBe(true);
    // Its first sync keeps every song it had (X too) and adds the source's new ones.
    const linked = getPlaylists().find((p) => p.id === "team-old")!;
    expect(linked.tracks.map((t) => t.id)).toEqual(["yt-A", "yt-B", "yt-C", "yt-X"]);
    // The missing ones saved straight away, with the Spotify name and their source.
    const p3 = upserted("Estate")!;
    expect(p3).toMatchObject({ owner: "anna", source_kind: "spotify-playlist", source_id: sid("P3"), source_auto: true });
    expect((p3.tracks as { id: string; spotify?: string }[]).map((t) => t.id)).toEqual(["yt-S1", "yt-S2"]);
    expect((p3.tracks as { spotify?: string }[])[0].spotify).toBe(sid("S1"));
    expect(upserted("Inverno")).toMatchObject({ source_id: sid("P4") });
    expect(upserted("Brani che ti piacciono")).toMatchObject({ source_kind: "spotify-liked", source_id: "me1" });
    // S1 (Estate + Inverno) and S2 (Estate + liked) were asked once each.
    const asked = fx.matched.flat();
    expect(asked.filter((x) => x === "S1")).toHaveLength(1);
    expect(asked.filter((x) => x === "S2")).toHaveLength(1);
    expect((upserted("Inverno")!.tracks as { id: string }[]).map((t) => t.id)).toEqual(["yt-S1", "yt-S4"]);
    // The task knows what was not found.
    const t3 = job.tasks.find((t) => t.key === `spotify-playlist:${sid("P3")}`)!;
    expect(t3).toMatchObject({ status: "done", found: 2, missing: 1 });
    expect(t3.missingSongs).toEqual([{ title: "S3", artist: "Art" }]);
    // No cover art copied from Spotify.
    expect(db.upserts.every((r) => !JSON.stringify(r).includes("scdn"))).toBe(true);
  });

  it("running it again adds nothing (everything is found by its source)", async () => {
    await library();
    await A.startAddAll({ owner: "anna", likedName: "Brani che ti piacciono" });
    await idle();
    const n = db.upserts.length;
    await A.startAddAll({ owner: "anna", likedName: "Brani che ti piacciono" });
    await idle();
    expect(db.upserts.length).toBe(n);
    expect(A.getImportState().job!.tasks).toHaveLength(0);
    expect(A.getImportState().job!.already).toBe(5);
  });

  it("one playlist failing does not stop the others", async () => {
    await library();
    delete fx.lists[sid("P3")]; // read as the user fails, and the server says not found
    await A.startAddAll({ owner: "anna", likedName: "Liked" });
    await idle();
    const tasks = A.getImportState().job!.tasks;
    expect(tasks.find((t) => t.key === `spotify-playlist:${sid("P3")}`)).toMatchObject({ status: "error", error: "not-found" });
    expect(upserted("Inverno")).toBeTruthy();
    expect(upserted("Liked")).toBeTruthy();
  });

  it("Annulla stops the running playlist and drops the waiting ones", async () => {
    await library();
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    await A.startAddAll({ owner: "anna", likedName: "Liked" });
    // The link (and its sync) goes first; the first import's matching waits at the gate.
    await until(() => A.getImportState().job!.tasks.some((t) => t.status === "matching" && t.key.includes(sid("P3"))));
    A.cancelImport();
    open();
    await idle();
    const tasks = A.getImportState().job!.tasks;
    expect(A.getImportState().job!.cancelled).toBe(true);
    expect(tasks.find((t) => t.key.includes(sid("P3")))!.status).toBe("cancelled");
    expect(tasks.find((t) => t.key.includes(sid("P4")))!.status).toBe("cancelled");
    expect(upserted("Estate")).toBeUndefined();
    expect(upserted("Inverno")).toBeUndefined();
  });

  it("reports the progress: playlist i of n, songs n of m", async () => {
    await library();
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    await A.startAddAll({ owner: "anna", likedName: "Liked" });
    await until(() => A.getImportState().job!.tasks.some((t) => t.status === "matching" && t.key.includes(sid("P3"))));
    const st = A.importStep(A.getImportState().job)!;
    expect(st).toMatchObject({ i: 2, of: 4, n: 0, m: 3, name: "Estate" });
    open();
    await idle();
    expect(A.importStep(A.getImportState().job)).toBeNull();
  });
});

describe("the check", () => {
  const entries: A.SpEntry[] = [
    { key: `spotify-playlist:${sid("A")}`, kind: "playlist", id: sid("A"), name: "A", count: 3, url: "" },
    { key: `spotify-playlist:${sid("B")}`, kind: "playlist", id: sid("B"), name: "B", count: 5, url: "" },
    { key: `spotify-playlist:${sid("C")}`, kind: "playlist", id: sid("C"), name: "C", count: 2, url: "" },
    { key: `spotify-playlist:${sid("D")}`, kind: "playlist", id: sid("D"), name: "D", count: 2, url: "" },
    { key: A.LIKED_KEY, kind: "liked", id: "", name: "Liked", count: 4, url: "" },
  ];
  const pl = (id: string, n: number, source?: { kind: string; id: string }): Playlist =>
    ({ id, name: id, owner: "x", tracks: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}`, title: "", channel: "", thumb: "" })), createdAt: 0, updatedAt: 0, ...(source ? { source: { ...source, name: id, syncedAt: 1, auto: true } } : {}) }) as Playlist;
  const task = (key: string, p: Partial<A.ImportTask>): A.ImportTask => ({ seq: 1, key, name: key, spec: { kind: "liked" }, announce: false, status: "done", n: 0, m: 0, ...p });

  it("added / incomplete / to add / error / running, from the team playlists' sources", () => {
    const team = [
      pl("ta", 3, { kind: "spotify-playlist", id: sid("A") }),
      pl("tb", 3, { kind: "spotify-playlist", id: sid("B") }),
      pl("tl", 4, { kind: "spotify-liked", id: "me1" }),
      pl("other", 2), // same name, no source: not counted as added
    ];
    const history = new Map([[`spotify-playlist:${sid("C")}`, task(`spotify-playlist:${sid("C")}`, { status: "error", error: "sp:quota" })]]);
    const job: A.ImportJob = { run: 1, running: true, listing: false, cancelled: false, tasks: [task(`spotify-playlist:${sid("D")}`, { status: "matching", n: 1, m: 2 })] };
    // What the last import of B could not find, kept by this browser.
    recordSourceStats("tb", { readable: 5, missing: 2, at: 1 });
    const rows = A.checkRows(entries, team, { job, history }, "me1");
    expect(rows.map((r) => r.state)).toEqual(["added", "incomplete", "error", "running", "added"]);
    expect(rows[1]).toMatchObject({ have: 3, missing: 2 });
    expect(rows[0].playlist?.id).toBe("ta");
    const sum = A.checkSummary(rows);
    expect(sum).toMatchObject({ total: 5, added: 2, incomplete: 1, error: 1, running: 1, todo: 0, complete: false });
  });

  it("the import's own count of songs not found wins over Spotify's count; a deleted playlist is to add again", () => {
    const team = [pl("tb", 3, { kind: "spotify-playlist", id: sid("B") })];
    const history = new Map([[`spotify-playlist:${sid("B")}`, task(`spotify-playlist:${sid("B")}`, { playlistId: "tb", missing: 0 })]]);
    const rows = A.checkRows(entries.slice(0, 2), team, { job: null, history }, "me1");
    expect(rows.map((r) => r.state)).toEqual(["todo", "added"]);
  });

  it("another account's liked songs are not this person's", () => {
    const rows = A.checkRows([entries[4]], [pl("tl", 4, { kind: "spotify-liked", id: "someone" })], { job: null, history: new Map() }, "me1");
    expect(rows[0].state).toBe("todo");
  });

  it("all in: complete", () => {
    const team = entries.slice(0, 4).map((e, i) => pl(`t${i}`, e.count!, { kind: "spotify-playlist", id: e.id }));
    const sum = A.checkSummary(A.checkRows(entries.slice(0, 4), team, { job: null, history: new Map() }, null));
    expect(sum).toMatchObject({ total: 4, added: 4, complete: true });
  });

  it("entriesOf keeps own and collaborative playlists and the liked songs, and leaves out the unreadable ones", () => {
    const r = A.entriesOf(
      [item("M", "Mia"), item("C", "Collab", { mine: false, collaborative: true }), item("X", "Spotify", { mine: false })] as never,
      { name: "Liked", count: 0 }
    );
    expect(r.entries.map((e) => e.name)).toEqual(["Mia", "Collab"]);
    expect(r.excluded.map((e) => e.name)).toEqual(["Spotify"]);
    expect(A.entriesOf([], { name: "Liked", count: 3 }).entries[0]).toMatchObject({ key: A.LIKED_KEY, count: 3 });
  });
});

describe("one click elsewhere", () => {
  const opts = { pastedName: (n: number) => `Da Spotify (${n} brani)`, ytList: (s: string) => s.match(/[?&]list=([\w-]+)/)?.[1] ?? null, trackIds: (s: string) => [...s.matchAll(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/g)].map((m) => m[1]) };

  it("a pasted Spotify playlist link is saved at once with its source and announced", async () => {
    fx.lists[sid("P9")] = userList("P9", "Festa", ["F1", "F2"]);
    fx.notOnYt.add("F2");
    const events: A.ImportEvent[] = [];
    const off = A.onImportEvent((e) => events.push(e));
    const r = A.addFromLink(`https://open.spotify.com/playlist/${sid("P9")}?si=abc`, "anna", opts);
    expect(r.kind).toBe("queued");
    await idle();
    off();
    expect(upserted("Festa")).toMatchObject({ source_kind: "spotify-playlist", source_id: sid("P9") });
    const done = events.find((e) => e.type === "task") as { type: "task"; task: A.ImportTask };
    expect(done.task).toMatchObject({ name: "Festa", status: "done", found: 1, missing: 1 });
    expect(done.task.playlistId).toBe(upserted("Festa")!.id);
    // Pasted again: already in, nothing duplicated.
    expect(A.addFromLink(`https://open.spotify.com/playlist/${sid("P9")}`, "anna", opts).kind).toBe("already");
  });

  it("signed out, a Spotify album link is read by the server and saved with its source", async () => {
    fx.token = null;
    const url = `https://open.spotify.com/album/${sid("AL")}`;
    fx.server[url] = { kind: "album", id: sid("AL"), name: "Disco", owner: "Art", cover: "https://i.scdn.co/x", songs: [{ title: "D1", artist: "Art", ms: 1 }], via: "embed" };
    A.addFromLink(url, "anna", opts);
    await idle();
    expect(upserted("Disco")).toMatchObject({ source_kind: "spotify-album", source_id: sid("AL") });
  });

  it("pasted track links: 'Da Spotify (N brani)', no source", async () => {
    const ids = [sid("T1"), sid("T2"), sid("T3")];
    fx.pasted = { [ids[0]]: { title: "T1", artist: "a", ms: 1 }, [ids[1]]: { title: "T2", artist: "a", ms: 1 }, [ids[2]]: null };
    A.addFromLink(ids.map((i) => `https://open.spotify.com/track/${i}`).join("\n"), "anna", opts);
    await idle();
    const r = upserted("Da Spotify (2 brani)")!;
    expect(r).toBeTruthy();
    expect(r.source_kind).toBeUndefined();
    expect((r.tracks as { spotify?: string }[]).map((t) => t.spotify)).toEqual([ids[0], ids[1]]);
  });

  it("a YouTube Music playlist link is saved at once with source youtube-playlist", async () => {
    fx.yt["PLabc"] = { list: "PLabc", title: "Lista YT", channel: "c", thumb: "", tracks: [{ id: "v1", title: "v1", channel: "c", thumb: "" }] };
    expect(A.addFromLink("https://music.youtube.com/playlist?list=PLabc", "anna", opts).kind).toBe("queued");
    await idle();
    expect(upserted("Lista YT")).toMatchObject({ source_kind: "youtube-playlist", source_id: "PLabc" });
    expect(A.addFromLink("https://example.com/nothing", "anna", opts).kind).toBe("bad");
  });

  it("a library list's Aggiungi saves it with its source, and Riprova i mancanti syncs that same playlist", async () => {
    const list = { kind: "playlist" as const, id: `playlist:${sid("LB")}`, name: "Lib", owner: "Io", cover: "", songs: [song("G1"), song("G2")], via: "api" as const };
    fx.notOnYt.add("G2");
    A.addSpotifyList(list, "Lib", "anna");
    await idle();
    const saved = upserted("Lib")!;
    expect(saved).toMatchObject({ source_kind: "spotify-playlist", source_id: sid("LB") });
    const p = getPlaylists().find((x) => x.id === saved.id)!;
    fx.notOnYt.clear();
    fx.lists[sid("LB")] = userList("LB", "Lib", ["G1", "G2"]);
    A.retryMissing(p, `spotify-playlist:${sid("LB")}`, "anna");
    await idle();
    const sync = db.rpcs.find((r) => r.fn === "music_playlist_source_sync" && r.args.p_id === saved.id)!;
    expect((sync.args.p_tracks as { id: string }[]).map((t) => t.id)).toEqual(["yt-G1", "yt-G2"]);
    expect(db.upserts.filter((r) => r.name === "Lib")).toHaveLength(1); // the same playlist, not a new one
    const rows = A.checkRows([{ key: `spotify-playlist:${sid("LB")}`, kind: "playlist", id: sid("LB"), name: "Lib", count: 2, url: "" }], getPlaylists(), A.getImportState(), null);
    expect(rows[0]).toMatchObject({ state: "added", have: 2, missing: 0 });
  });
});

describe("review fixes", () => {
  const go = () => A.startAddAll({ owner: "anna", likedName: "Liked" });

  it("F1: a teammate's hand-made playlist with the same name is never linked; the Spotify list is added as its own", async () => {
    db.rows = [row("team-hand", "Road Trip!", 3, undefined, "marco")];
    await reloadPlaylists();
    fx.playlists = [item("P2", "road trip")];
    fx.lists[sid("P2")] = userList("P2", "road trip", ["A", "B"]);
    await go();
    await idle();
    expect(db.updates.some((u) => u.id === "team-hand")).toBe(false);
    expect(db.rpcs.some((r) => r.args.p_id === "team-hand")).toBe(false);
    expect(getPlaylists().find((p) => p.id === "team-hand")!.tracks.map((t) => t.id)).toEqual(["old-team-hand-0", "old-team-hand-1", "old-team-hand-2"]);
    expect(upserted("road trip")).toMatchObject({ source_kind: "spotify-playlist", source_id: sid("P2") });
  });

  it("F1: my own same-name playlist made by hand (songs not from Spotify) is not linked either", () => {
    const team = [{ id: "mine", name: "Road Trip", owner: "anna", tracks: [{ id: "v", title: "v", channel: "c", thumb: "" }], createdAt: 0, updatedAt: 0 }] as Playlist[];
    const e: A.SpEntry = { key: `spotify-playlist:${sid("P")}`, kind: "playlist", id: sid("P"), name: "road trip", url: "" };
    expect(A.planAddAll([e], team, "me1", "anna").add).toHaveLength(1);
    const imported = [{ ...team[0], tracks: [oldSong("A")] }] as Playlist[];
    expect(A.planAddAll([e], imported, "me1", "anna").link).toHaveLength(1);
    expect(A.planAddAll([e], imported, "me1", "marco").link).toHaveLength(0);
  });

  it("F2: an Aggiungi clicked after Annulla, while the cancelled task still winds down, runs in a new job", async () => {
    fx.playlists = [item("P3", "Estate", { count: 3 }), item("P4", "Inverno")];
    fx.lists[sid("P3")] = userList("P3", "Estate", ["S1", "S2", "S3"]);
    fx.lists[sid("P4")] = userList("P4", "Inverno", ["S4", "S5"]);
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    await go();
    await until(() => A.getImportState().job!.tasks.some((t) => t.status === "matching"));
    const first = A.getImportState().job!.run;
    A.cancelImport();
    const entry: A.SpEntry = { key: `spotify-playlist:${sid("P4")}`, kind: "playlist", id: sid("P4"), name: "Inverno", count: 2, url: "" };
    A.addEntry(entry, "anna", "me1");
    expect(A.getImportState().job!.run).not.toBe(first);
    open();
    await idle();
    const s = A.getImportState();
    expect(A.lastTask(s, entry.key)).toMatchObject({ status: "done" });
    expect(A.isActive(A.lastTask(s, entry.key))).toBe(false);
    expect(A.lastTask(s, `spotify-playlist:${sid("P3")}`)?.status).toBe("cancelled");
    expect(upserted("Inverno")).toBeTruthy();
    expect(upserted("Estate")).toBeUndefined();
  });

  it("F2: a finished run never leaves a task waiting", async () => {
    fx.playlists = [item("P3", "Estate")];
    fx.lists[sid("P3")] = userList("P3", "Estate", ["S1"]);
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    await go();
    await until(() => A.getImportState().job!.tasks.some((t) => t.status === "matching"));
    A.cancelImport();
    open();
    await idle();
    expect(A.getImportState().job!.tasks.every((t) => !A.isActive(t))).toBe(true);
  });

  it("F3: Annulla during Riprova i mancanti stops the sync before it writes", async () => {
    db.rows = [row("tl", "Lib", [oldSong("G1")], { kind: "spotify-playlist", id: sid("LB") })];
    await reloadPlaylists();
    fx.lists[sid("LB")] = userList("LB", "Lib", ["G1", "S1"]);
    let open!: () => void;
    fx.gate = new Promise<void>((r) => (open = r));
    A.retryMissing(getPlaylists()[0], `spotify-playlist:${sid("LB")}`, "anna");
    await until(() => fx.matched.length > 0);
    A.cancelImport();
    open();
    await idle();
    expect(db.rpcs.filter((r) => r.fn === "music_playlist_source_sync")).toHaveLength(0);
    expect(A.lastTask(A.getImportState(), `spotify-playlist:${sid("LB")}`)?.status).toBe("cancelled");
  });

  it("F6: an empty playlist is not followed; songs Spotify counts but can't give don't make a list incomplete", async () => {
    expect(A.entriesOf([item("E", "Vuota", { count: 0 }), item("M", "Mia")] as never, null).entries.map((e) => e.name)).toEqual(["Mia"]);
    // 20 on Spotify, 18 readable (local files / episodes), all 18 found.
    fx.playlists = [item("P5", "Venti", { count: 20 })];
    fx.lists[sid("P5")] = userList("P5", "Venti", Array.from({ length: 18 }, (_, i) => `V${i}`));
    await go();
    await idle();
    const entry: A.SpEntry = { key: `spotify-playlist:${sid("P5")}`, kind: "playlist", id: sid("P5"), name: "Venti", count: 20, url: "" };
    A.resetImportJob(); // a reload: the job's memory is gone
    const [r] = A.checkRows([entry], getPlaylists(), A.getImportState(), "me1");
    expect(r).toMatchObject({ state: "added", have: 18, missing: 0 });
  });

  it("F6: the songs not found are known after a reload too", async () => {
    fx.playlists = [item("P6", "Sei", { count: 3 })];
    fx.lists[sid("P6")] = userList("P6", "Sei", ["Q1", "Q2", "Q3"]);
    fx.notOnYt.add("Q3");
    await go();
    await idle();
    A.resetImportJob();
    const entry: A.SpEntry = { key: `spotify-playlist:${sid("P6")}`, kind: "playlist", id: sid("P6"), name: "Sei", count: 3, url: "" };
    expect(A.checkRows([entry], getPlaylists(), A.getImportState(), "me1")[0]).toMatchObject({ state: "incomplete", missing: 1 });
  });

  it("F8 / F4: with the Spotify account unknown, a teammate's liked songs never count as mine", async () => {
    const liked: A.SpEntry = { key: A.LIKED_KEY, kind: "liked", id: "", name: "Liked", count: 2, url: "" };
    const theirs = [{ id: "tm", name: "Liked", owner: "marco", tracks: [], createdAt: 0, updatedAt: 0, source: { kind: "spotify-liked", id: "marco-sp", name: "Liked", syncedAt: 1, auto: true } }] as Playlist[];
    expect(A.teamFor(liked, theirs, null)).toBeUndefined();
    expect(A.teamFor(liked, theirs, "marco-sp")?.id).toBe("tm");
    const plan = A.planAddAll([liked], theirs, null, "anna");
    expect(plan.already).toHaveLength(0);
    expect(plan.add).toHaveLength(1);
    // In a run: the liked task reads the account fresh and saves mine.
    db.rows = [row("tm", "Liked", 1, { kind: "spotify-liked", id: "marco-sp" }, "marco")];
    await reloadPlaylists();
    fx.liked = [sptrack("L1"), sptrack("L2")];
    await go();
    await idle();
    expect(upserted("Liked")).toMatchObject({ source_kind: "spotify-liked", source_id: "me1" });
  });

  it("F5: a recent list's Aggiungi returns its task, followed by its key until it ends", async () => {
    const list = { kind: "playlist" as const, id: "recent:recent", name: "Recenti", owner: "Io", cover: "", songs: [song("R1")], via: "api" as const };
    const t = A.addSpotifyList(list, "Recenti", "anna")!;
    expect(t.key).toMatch(/^recent:/);
    expect(A.isActive(A.lastTask(A.getImportState(), t.key))).toBe(true);
    await idle();
    expect(A.lastTask(A.getImportState(), t.key)?.status).toBe("done");
  });
});
