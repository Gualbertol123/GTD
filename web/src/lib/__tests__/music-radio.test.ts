import { beforeEach, describe, expect, it, vi } from "vitest";

// Radio playlists (lib/musicDb.ts, migration 021): the same stand-in for the
// Supabase client as music-data.test.ts, plus a stand-in for fetchRadio.
type Res = { data: unknown; error: { code?: string; message?: string } | null };
const db = vi.hoisted(() => ({
  calls: [] as { kind: string; args?: unknown }[],
  rows: [] as unknown[],
  rpc: [] as (Res | Promise<Res>)[],
  write: [] as (Res | Promise<Res>)[],
  row: null as unknown,
}));
const yt = vi.hoisted(() => ({
  radio: [] as unknown[], // queued fetchRadio answers
  asked: [] as { id: string; full?: boolean }[],
  gate: null as Promise<void> | null, // holds fetchRadio until resolved
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

vi.mock("../music", () => ({
  mlog: () => {},
  fetchRadio: async (id: string, opts: { full?: boolean } = {}) => {
    yt.asked.push({ id, full: opts.full });
    if (yt.gate) await yt.gate;
    return yt.radio.length ? yt.radio.shift() : { tracks: [] };
  },
}));

type Mod = typeof import("../musicDb");
let m: Mod;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const tr = (id: string) => ({ id, title: id.toUpperCase(), channel: "c" });
const songs = (...ids: string[]) => ({ tracks: ids.map(tr) });
const row = (id: string, tracks: string[], updated_at: number, radio?: { seed: string; at: number | null }) => ({
  id,
  name: "Radio · S",
  owner: "me",
  tracks: tracks.map(tr),
  created_at: 1,
  updated_at,
  ...(radio ? { radio_seed: radio.seed, radio_title: "S", radio_refreshed_at: radio.at } : { radio_seed: null }),
});
const ids = (id = "r") => m.getPlaylist(id)?.tracks.map((t) => t.id);
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const rpcCalls = () => db.calls.filter((c) => c.kind === "rpc:music_playlist_radio_refresh");

beforeEach(async () => {
  vi.resetModules();
  db.calls.length = 0;
  db.rpc.length = 0;
  db.write.length = 0;
  yt.radio.length = 0;
  yt.asked.length = 0;
  yt.gate = null;
  // A radio checked recently (not due on load) and an ordinary playlist.
  db.rows = [row("r", ["s", "a", "b"], 100, { seed: "s", at: Date.now() }), row("q", ["x"], 90)];
  db.row = null;
  m = await import("../musicDb");
  await m.reloadPlaylists();
  await m.maybeRefreshRadios(); // the load's own check (nothing due)
  db.calls.length = 0;
  yt.asked.length = 0;
});

describe("rows", () => {
  it("map the radio columns to playlist.radio, and none to an ordinary playlist", () => {
    expect(m.getPlaylist("r")?.radio).toMatchObject({ seed: "s", title: "S" });
    expect(m.getPlaylist("q")?.radio).toBeUndefined();
  });
});

describe("createRadioPlaylist", () => {
  it("asks for the full radio, puts the seed first, and saves the radio fields", async () => {
    yt.radio.push(songs("a", "s", "b", "a", "c"));
    const save = deferred<Res>();
    db.write.push(save.promise);
    const seed = tr("s");
    const r = await m.createRadioPlaylist(seed, "me");
    expect(yt.asked).toEqual([{ id: "s", full: true }]);
    if (!r.ok) throw new Error("not ok");
    // In the store at once, before the save answers.
    expect(m.getPlaylist(r.playlist.id)?.name).toBe("Radio · S");
    expect(m.getPlaylist(r.playlist.id)?.tracks.map((t) => t.id)).toEqual(["s", "a", "b", "c"]);
    save.resolve({ data: [row(r.playlist.id, ["s", "a", "b", "c"], 500, { seed: "s", at: 499 })], error: null });
    expect(await r.saved).toEqual({ ok: true, radioSaved: true });
    const up = db.calls.find((c) => c.kind === "upsert")!.args as Record<string, unknown>;
    expect(up).toMatchObject({ radio_seed: "s", radio_title: "S" });
    expect(typeof up.radio_refreshed_at).toBe("number");
    expect(m.getPlaylist(r.playlist.id)?.radio?.seed).toBe("s");
  });

  it("reports a radio that can't be read, and creates nothing", async () => {
    yt.radio.push({ error: "timeout" });
    expect(await m.createRadioPlaylist(tr("s"), "me")).toEqual({ ok: false, error: "timeout" });
    yt.radio.push(songs("s"));
    expect(await m.createRadioPlaylist(tr("s"), "me")).toEqual({ ok: false, error: "empty" });
    expect(db.calls.filter((c) => c.kind === "upsert")).toEqual([]);
  });

  it("before migration 021, saves a plain playlist and says radioSaved: false", async () => {
    yt.radio.push(songs("a", "b"));
    const plainSave = deferred<Res>();
    db.write.push({ data: null, error: { code: "PGRST204", message: "Could not find the 'radio_seed' column of 'music_playlists' in the schema cache" } }, plainSave.promise);
    const r = await m.createRadioPlaylist(tr("s"), "me", "Mine");
    if (!r.ok) throw new Error("not ok");
    expect(m.getPlaylist(r.playlist.id)?.name).toBe("Mine");
    plainSave.resolve({ data: [row(r.playlist.id, ["s", "a", "b"], 500)], error: null });
    expect(await r.saved).toEqual({ ok: true, radioSaved: false });
    const ups = db.calls.filter((c) => c.kind === "upsert").map((c) => c.args as Record<string, unknown>);
    expect(ups).toHaveLength(2);
    expect(ups[0]).toHaveProperty("radio_seed", "s");
    expect(ups[1]).not.toHaveProperty("radio_seed");
    expect(m.getPlaylist(r.playlist.id)?.radio).toBeUndefined();
    // No refresh is attempted without the columns.
    await m.maybeRefreshRadios(Date.now() + 2 * DAY, true);
    expect(yt.asked).toHaveLength(1);
  });
});

describe("daily refresh", () => {
  it("leaves a radio checked less than 24 h ago alone", async () => {
    await m.maybeRefreshRadios(Date.now() + DAY - 60_000, true);
    expect(yt.asked).toEqual([]);
    expect(rpcCalls()).toEqual([]);
  });

  it("unchanged songs: only stamps the check (p_tracks null)", async () => {
    yt.radio.push(songs("s", "a", "b"));
    db.rpc.push({ data: [row("r", ["s", "a", "b"], 200, { seed: "s", at: NOW })], error: null });
    await m.maybeRefreshRadios(Date.now() + DAY + 1);
    expect(yt.asked).toEqual([{ id: "s", full: true }]);
    expect(rpcCalls()).toEqual([{ kind: "rpc:music_playlist_radio_refresh", args: { p_id: "r", p_tracks: null, p_stale_ms: DAY } }]);
    expect(m.getPlaylist("r")?.radio?.refreshedAt).toBe(NOW);
  });

  it("changed songs: replaces them, seed first", async () => {
    yt.radio.push(songs("c", "a", "s", "d"));
    db.rpc.push({ data: [row("r", ["s", "c", "a", "d"], 200, { seed: "s", at: NOW })], error: null });
    await m.maybeRefreshRadios(Date.now() + DAY + 1);
    const args = rpcCalls()[0].args as { p_tracks: { id: string }[] };
    expect(args.p_tracks.map((t) => t.id)).toEqual(["s", "c", "a", "d"]);
    expect(ids()).toEqual(["s", "c", "a", "d"]);
    expect(m.getPlaylist("r")?.radio?.seed).toBe("s");
  });

  it("not due on the server (another browser refreshed it): nothing changes", async () => {
    yt.radio.push(songs("s", "z"));
    db.rpc.push({ data: [], error: null });
    await m.maybeRefreshRadios(Date.now() + DAY + 1);
    expect(rpcCalls()).toHaveLength(1);
    expect(ids()).toEqual(["s", "a", "b"]);
  });

  it("runs once at a time in a tab, and at most once an hour", async () => {
    let open!: () => void;
    yt.gate = new Promise<void>((r) => (open = r));
    yt.radio.push(songs("s", "a", "b"));
    const later = Date.now() + DAY + 1;
    const a = m.maybeRefreshRadios(later);
    const b = m.maybeRefreshRadios(later, true); // even forced: the same run
    expect(b).toBe(a);
    open();
    await Promise.all([a, b]);
    expect(yt.asked).toHaveLength(1);
    // Within the hour: not checked again (the radio would still look due here).
    db.rpc.length = 0;
    await m.maybeRefreshRadios(later + 30 * 60_000);
    expect(yt.asked).toHaveLength(1);
  });

  it("only the stored list changes: nothing here touches the play queue", async () => {
    // musicDb gets only fetchRadio and mlog from lib/music (mocked above): a
    // refresh can't call music.play / enqueue, so a queue playing it goes on.
    const mod = await import("../music");
    expect(Object.keys(mod).sort()).toEqual(["fetchRadio", "mlog"]);
  });
});

describe("editing a radio playlist's songs", () => {
  it("detaches it on the server first, then edits", async () => {
    db.row = row("r", ["s", "a", "b", "d"], 300);
    expect(await m.addToPlaylist("r", tr("d"))).toEqual({ ok: true });
    expect(db.calls[0]).toEqual({ kind: "update", args: { radio_seed: null } });
    expect(db.calls[1].kind).toBe("rpc:music_playlist_append");
    expect(m.getPlaylist("r")?.radio).toBeUndefined();
  });

  it("detaches on remove and move too, but not on rename", async () => {
    db.row = row("r", ["s", "a", "b"], 300, { seed: "s", at: 1 });
    await m.renamePlaylist("r", "New name");
    expect(db.calls.map((c) => c.kind)).toEqual(["rpc:music_playlist_rename"]);
    expect(m.getPlaylist("r")?.radio?.seed).toBe("s");

    db.calls.length = 0;
    db.row = row("r", ["a", "b"], 400);
    await m.removeFromPlaylist("r", "s", 0);
    expect(db.calls.map((c) => c.kind)).toEqual(["update", "rpc:music_playlist_remove"]);
    expect(m.getPlaylist("r")?.radio).toBeUndefined();
    // Already detached: a later move is a plain edit.
    db.calls.length = 0;
    db.row = row("r", ["b", "a"], 500);
    await m.moveInPlaylist("r", 0, 1);
    expect(db.calls.map((c) => c.kind)).toEqual(["rpc:music_playlist_move"]);
  });

  it("a detached playlist is no longer refreshed", async () => {
    db.row = row("r", ["s", "a"], 300);
    await m.detachRadio("r");
    expect(db.calls[0]).toEqual({ kind: "update", args: { radio_seed: null } });
    await m.maybeRefreshRadios(Date.now() + 2 * DAY, true);
    expect(yt.asked).toEqual([]);
  });
});
