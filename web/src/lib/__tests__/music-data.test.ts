import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for the Supabase client: records calls and answers with
// whatever the test queues (or a promise the test resolves later).
type Res = { data: unknown; error: { code?: string; message?: string } | null };
const db = vi.hoisted(() => ({
  calls: [] as { kind: string; args?: unknown }[],
  rows: [] as unknown[], // what a full select answers
  rpc: [] as (Res | Promise<Res>)[], // queued rpc answers (default: echo a row)
  write: [] as (Res | Promise<Res>)[], // queued insert/update/delete answers
  row: null as unknown, // what a successful rpc / write returns
}));

vi.mock("../supabaseClient", () => {
  const answer = (q: (Res | Promise<Res>)[], dflt: () => Res) => Promise.resolve(q.length ? q.shift()! : dflt());
  const ok = () => ({ data: db.row ? [db.row] : [], error: null });
  const writeChain = (kind: string, args?: unknown) => {
    const run = () => {
      db.calls.push({ kind, args });
      return answer(db.write, ok);
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
      rpc: (fn: string, args: unknown) => {
        db.calls.push({ kind: `rpc:${fn}`, args });
        return answer(db.rpc, ok);
      },
      from: () => ({
        select: () => ({
          order: () => Promise.resolve({ data: db.rows, error: null }),
          eq: () => Promise.resolve({ data: db.rows, error: null }),
        }),
        insert: (r: unknown) => writeChain("insert", r),
        upsert: (r: unknown) => writeChain("upsert", r),
        update: (r: unknown) => writeChain("update", r),
        delete: () => writeChain("delete"),
      }),
    },
  };
});

type Mod = typeof import("../musicDb");
let m: Mod;

const tr = (id: string) => ({ id, title: id.toUpperCase(), channel: "c" });
const row = (id: string, tracks: string[], updated_at: number, name = "P") => ({
  id,
  name,
  owner: "me",
  tracks: tracks.map(tr),
  created_at: 1,
  updated_at,
});
const ids = (id = "p") => m.getPlaylist(id)?.tracks.map((t) => t.id);
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  db.calls.length = 0;
  db.rpc.length = 0;
  db.write.length = 0;
  db.rows = [row("p", ["a", "b", "c"], 100), row("q", ["x"], 90, "Q")];
  db.row = null;
  m = await import("../musicDb");
  await m.reloadPlaylists();
});

describe("optimistic writes", () => {
  it("apply at once and roll back on failure, with an error code", async () => {
    db.rpc.push({ data: null, error: { code: "42501", message: "permission denied" } });
    const saved = m.addToPlaylist("p", tr("d"));
    expect(ids()).toEqual(["a", "b", "c", "d"]); // before any await
    expect(await saved).toEqual({ ok: false, error: "forbidden" });
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("never throw: a network failure is reported as offline", async () => {
    db.rpc.push(Promise.reject(new TypeError("Failed to fetch")));
    expect(await m.moveInPlaylist("p", 0, 2)).toEqual({ ok: false, error: "offline" });
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("keep the server's row once the write succeeds", async () => {
    db.row = row("p", ["a", "b", "c", "d"], 200);
    expect(await m.addToPlaylist("p", tr("d"))).toEqual({ ok: true });
    expect(db.calls[0]).toEqual({ kind: "rpc:music_playlist_append", args: { p_id: "p", p_tracks: [{ ...tr("d"), thumb: undefined }] } });
    expect(m.getPlaylist("p")?.updatedAt).toBe(200);
  });

  it("createPlaylist is in the store synchronously and removed if the save fails", async () => {
    db.write.push({ data: null, error: { code: "500", message: "boom" } });
    const { playlist, saved } = m.createPlaylist(" New ", "me", [tr("a"), tr("a")]);
    expect(m.getPlaylist(playlist.id)?.name).toBe("New");
    expect(m.getPlaylist(playlist.id)?.tracks.map((t) => t.id)).toEqual(["a"]);
    expect(await saved).toEqual({ ok: false, error: "server" });
    expect(m.getPlaylist(playlist.id)).toBeUndefined();
  });

  it("delete rolls back to the same place in the list", async () => {
    db.write.push({ data: null, error: { code: "42P01", message: "relation does not exist" } });
    expect(await m.deletePlaylist("q")).toEqual({ ok: false, error: "missing-table" });
    expect(m.getPlaylist("q")).toBeDefined();
  });

  it("remove can be undone at the same index", async () => {
    db.row = row("p", ["a", "c"], 200);
    const removed = m.getPlaylist("p")!.tracks[1];
    await m.removeFromPlaylist("p", "b", 1);
    expect(db.calls[0].args).toEqual({ p_id: "p", p_track_id: "b", p_index: 1 });
    db.row = row("p", ["a", "b", "c"], 300);
    await m.insertInPlaylist("p", removed, 1);
    expect(db.calls[1]).toMatchObject({ kind: "rpc:music_playlist_insert", args: { p_id: "p", p_index: 1 } });
    expect(ids()).toEqual(["a", "b", "c"]);
  });
});

describe("echo suppression", () => {
  it("an event arriving mid-write does not revert the optimistic state", async () => {
    const first = deferred<Res>();
    const second = deferred<Res>();
    db.rpc.push(first.promise, second.promise);
    void m.moveInPlaylist("p", 0, 1); // b a c
    void m.moveInPlaylist("p", 1, 2); // b c a
    expect(ids()).toEqual(["b", "c", "a"]);

    // The echo of the first move arrives while the second is in flight.
    m.applyChange({ eventType: "UPDATE", new: row("p", ["b", "a", "c"], 200), old: { id: "p" } });
    expect(ids()).toEqual(["b", "c", "a"]);

    first.resolve({ data: [row("p", ["b", "a", "c"], 200)], error: null });
    await Promise.resolve();
    expect(ids()).toEqual(["b", "c", "a"]);
    second.resolve({ data: [row("p", ["b", "c", "a"], 210)], error: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(ids()).toEqual(["b", "c", "a"]);
    expect(m.getPlaylist("p")?.updatedAt).toBe(210);

    // A late echo of the second write (or anything older) changes nothing.
    const before = m.getPlaylist("p");
    m.applyChange({ eventType: "UPDATE", new: row("p", ["b", "c", "a"], 210), old: { id: "p" } });
    m.applyChange({ eventType: "UPDATE", new: row("p", ["b", "a", "c"], 200), old: { id: "p" } });
    expect(m.getPlaylist("p")).toBe(before);
  });

  it("a teammate's newer change seen mid-write wins once the write settles", async () => {
    const d = deferred<Res>();
    db.rpc.push(d.promise);
    const done = m.renamePlaylist("p", "Mine");
    m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "z"], 220, "Mine"), old: { id: "p" } });
    expect(m.getPlaylist("p")?.name).toBe("Mine");
    expect(ids()).toEqual(["a", "b", "c"]); // held until our write settles
    d.resolve({ data: [row("p", ["a", "b", "c"], 210, "Mine")], error: null });
    await done;
    expect(ids()).toEqual(["a", "b", "c", "z"]);
  });
});

describe("realtime rows", () => {
  it("are applied one by one, leaving other playlists untouched", () => {
    const q = m.getPlaylist("q");
    m.applyChange({ eventType: "INSERT", new: row("n", ["k"], 300, "N"), old: {} });
    expect(m.getPlaylist("n")?.name).toBe("N");
    m.applyChange({ eventType: "UPDATE", new: row("p", ["c"], 301, "P2"), old: { id: "p" } });
    expect(m.getPlaylist("p")?.name).toBe("P2");
    expect(ids()).toEqual(["c"]);
    m.applyChange({ eventType: "DELETE", new: {}, old: { id: "n" } });
    expect(m.getPlaylist("n")).toBeUndefined();
    expect(m.getPlaylist("q")).toBe(q);
  });

  it("keep the songs when the event leaves the unchanged song list out", () => {
    const { tracks: _omit, ...rest } = row("p", [], 400, "Renamed");
    m.applyChange({ eventType: "UPDATE", new: rest, old: { id: "p" } });
    expect(m.getPlaylist("p")?.name).toBe("Renamed");
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("a deletion seen mid-write wins", async () => {
    const d = deferred<Res>();
    db.rpc.push(d.promise);
    const done = m.addToPlaylist("p", tr("d"));
    m.applyChange({ eventType: "DELETE", new: {}, old: { id: "p" } });
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    d.resolve({ data: [], error: null }); // the row was gone
    expect(await done).toEqual({ ok: false, error: "not-found" });
    expect(m.getPlaylist("p")).toBeUndefined();
  });
});

// F1: updated_at can come from different clocks (a browser's, the database's),
// so a realtime row is never dropped just because its stamp looks older.
describe("clock skew", () => {
  it("applies a teammate's change even when its stamp is below ours", () => {
    // Created by a teammate whose clock runs fast.
    m.applyChange({ eventType: "INSERT", new: row("g", ["a"], 9_000_000, "Gita"), old: {} });
    // Another teammate adds a song; the database stamps it with its own, lower clock.
    m.applyChange({ eventType: "UPDATE", new: row("g", ["a", "b"], 1_000, "Gita"), old: { id: "g" } });
    expect(ids("g")).toEqual(["a", "b"]);
  });

  it("late echoes of our settled writes still don't flicker, and later changes apply", async () => {
    db.rpc.push(
      { data: [row("p", ["a", "b", "c", "d"], 200)], error: null },
      { data: [row("p", ["a", "b", "c", "d", "e"], 210)], error: null }
    );
    const a = m.addToPlaylist("p", tr("d"));
    const b = m.addToPlaylist("p", tr("e"));
    await Promise.all([a, b]);
    const shown = m.getPlaylist("p");
    expect(ids()).toEqual(["a", "b", "c", "d", "e"]);

    // Commit order: a teammate's change made before our writes, then our two echoes.
    m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "z"], 190), old: { id: "p" } });
    expect(m.getPlaylist("p")).toBe(shown);
    m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "d"], 200), old: { id: "p" } });
    expect(m.getPlaylist("p")).toBe(shown);
    m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "d", "e"], 210), old: { id: "p" } });
    expect(m.getPlaylist("p")).toBe(shown);

    // After our last echo, a teammate's change applies even with a lower stamp.
    m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "d", "e", "f"], 150), old: { id: "p" } });
    expect(ids()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("an echo that never comes does not hold teammates' changes for long", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      db.rpc.push({ data: [row("p", ["a", "b", "c", "d"], 200)], error: null });
      await m.addToPlaylist("p", tr("d"));
      vi.setSystemTime(Date.now() + 5_000);
      m.applyChange({ eventType: "UPDATE", new: row("p", ["a", "b", "c", "d", "z"], 220), old: { id: "p" } });
      expect(ids()).toEqual(["a", "b", "c", "d", "z"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// F6: a reload answering while our delete is in flight must not bring it back.
describe("reload during a delete", () => {
  it("keeps the deleted playlist out of the store", async () => {
    const d = deferred<Res>();
    db.write.push(d.promise);
    const done = m.deletePlaylist("q");
    expect(m.getPlaylist("q")).toBeUndefined();
    await m.reloadPlaylists(); // the snapshot still has "q"
    expect(m.getPlaylist("q")).toBeUndefined();
    d.resolve({ data: null, error: null });
    expect(await done).toEqual({ ok: true });
    expect(m.getPlaylist("q")).toBeUndefined();
  });
});

describe("before migration 019", () => {
  it("falls back to writing the whole song list, and stops asking for the function", async () => {
    db.rpc.push({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    db.row = row("p", ["a", "b", "c", "d"], 200);
    expect(await m.addToPlaylist("p", tr("d"))).toEqual({ ok: true });
    expect(db.calls.map((c) => c.kind)).toEqual(["rpc:music_playlist_append", "update"]);
    expect((db.calls[1].args as { tracks: { id: string }[] }).tracks.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);

    db.calls.length = 0;
    db.row = row("p", ["b", "a", "c", "d"], 210);
    await m.moveInPlaylist("p", 1, 0);
    expect(db.calls.map((c) => c.kind)).toEqual(["update"]);
    expect(ids()).toEqual(["b", "a", "c", "d"]);
  });
});

describe("playlistErrorCode", () => {
  it("maps Supabase errors to the UI codes", () => {
    expect(m.playlistErrorCode({ code: "PGRST205", message: "Could not find the table" })).toBe("missing-table");
    expect(m.playlistErrorCode({ code: "42501", message: "new row violates row-level security" })).toBe("forbidden");
    expect(m.playlistErrorCode({ message: "TypeError: Failed to fetch" })).toBe("offline");
    expect(m.playlistErrorCode({ code: "XX000", message: "boom" })).toBe("server");
  });
});
