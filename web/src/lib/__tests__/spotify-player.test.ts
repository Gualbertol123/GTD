import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spotify mode (lib/spotifyPlayer.ts) with a fake Web Playback SDK and a mocked
// api.spotify.com. Nothing here reaches Spotify.

const env = vi.hoisted(() => {
  const mem = (): Storage => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    } as Storage;
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = mem();
  g.sessionStorage = mem();
  // Never the real network: work a test leaves running (a lookup, a PUT) fails here after the mock is gone.
  g.fetch = async (url: unknown) => {
    throw new Error("tests never reach the network: " + String(url));
  };
  // The SDK is "already loaded": window.Spotify is the fake below (no <script>).
  g.window = globalThis;
  /** Every command to either engine, in order: the switch must pause one before the other plays. */
  const order: string[] = [];
  return { order };
});

vi.mock("../supabaseClient", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })), onAuthStateChange: vi.fn() } },
}));

import { __resetMusicForTests, attachPlayer, getMusic, music, musicLog, onYtState, spotifyFailed, YT_STATE, type Track, type YtLike } from "../music";
import {
  __resetSpotifyForTests,
  checkWhere,
  spApi,
  SDK_URL,
  channelArtist,
  cleanTitle,
  guessSong,
  isEnded,
  knownMatch,
  mapState,
  MATCH_MIN,
  onState,
  pickMatch,
  scoreMatch,
  windowFrom,
  entryIndex,
  validWindowLength,
  prepareSpotifyPlayer,
  type SdkState,
  type SdkTrack,
} from "../spotifyPlayer";
import { __setSpotifyKeyStoreForTests, __setSpotifyTokenForTests, forgetSpotifyAuth, KEYSTORE_MS, spotifyAuthState, spotifyOwnerChanged } from "../spotifyAuth";

const { order } = env;

// ---- Fakes -------------------------------------------------------------------------

class FakeSpotifyPlayer {
  static last: FakeSpotifyPlayer | null = null;
  listeners: Record<string, (a: unknown) => void> = {};
  name: string;
  constructor(opts: { name: string }) {
    this.name = opts.name;
    FakeSpotifyPlayer.last = this;
  }
  addListener(ev: string, cb: (a: unknown) => void) {
    this.listeners[ev] = cb;
    return true;
  }
  emit(ev: string, a: unknown) {
    this.listeners[ev]?.(a);
  }
  /** Tests: the SDK's websocket never opens (no "ready"). */
  static noReady = false;
  connect() {
    order.push("sp:connect");
    if (!FakeSpotifyPlayer.noReady) setTimeout(() => this.emit("ready", { device_id: "dev1" }), 0);
    return Promise.resolve(true);
  }
  disconnect() {
    order.push("sp:disconnect");
  }
  getCurrentState() {
    return Promise.resolve(null);
  }
  setVolume(v: number) {
    order.push(`sp:volume:${v}`);
    return Promise.resolve();
  }
  pause() {
    order.push("sp:pause");
    return Promise.resolve();
  }
  resume() {
    order.push("sp:resume");
    return Promise.resolve();
  }
  seek(ms: number) {
    order.push(`sp:seek:${ms}`);
    return Promise.resolve();
  }
  nextTrack() {
    order.push("sp:next");
    return Promise.resolve();
  }
  previousTrack() {
    return Promise.resolve();
  }
  activateElement() {
    order.push("sp:activate");
    return Promise.resolve();
  }
}
(globalThis as unknown as { Spotify: unknown }).Spotify = { Player: FakeSpotifyPlayer };

function fakeYt(): YtLike & { state: number } {
  const p = {
    state: YT_STATE.UNSTARTED as number,
    ids: [] as string[],
    index: 0,
    loadPlaylist(ids: unknown, i = 0) {
      order.push(`yt:load:${i}`);
      this.ids = ids as string[];
      this.index = i;
    },
    cuePlaylist(ids: unknown, i = 0) {
      order.push(`yt:cue:${i}`);
      this.ids = ids as string[];
      this.index = i;
    },
    playVideo: () => order.push("yt:play"),
    pauseVideo: () => order.push("yt:pause"),
    stopVideo: () => order.push("yt:stop"),
    nextVideo: () => order.push("yt:next"),
    playVideoAt: (i: number) => order.push(`yt:at:${i}`),
    seekTo: () => {},
    setVolume: () => {},
    mute: () => {},
    unMute: () => {},
    setLoop: () => {},
    getPlaylist() {
      return this.ids;
    },
    getPlaylistIndex() {
      return this.index;
    },
    getPlayerState() {
      return this.state;
    },
    getCurrentTime: () => 0,
    getDuration: () => 200,
    getVolume: () => 80,
    isMuted: () => false,
    getVideoData() {
      return { video_id: this.ids[this.index] ?? "", title: "", author: "" };
    },
  };
  return p;
}

/** Spotify's catalogue for the mocked /search: title → track id ("" = not found). */
const CATALOGUE: Record<string, { id: string; name: string; artist: string }> = {
  "Song 0": { id: "sp0000000000000000000a", name: "Song 0", artist: "Artist 0" },
  "Song 1": { id: "sp0000000000000000000b", name: "Song 1", artist: "Artist 1" },
  "Song 2": { id: "sp0000000000000000000c", name: "Song 2", artist: "Artist 2" },
  "Song 3": { id: "sp0000000000000000000d", name: "Song 3", artist: "Artist 3" },
};
const calls: { method: string; path: string; body: unknown }[] = [];

function mockFetch() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const json = (status: number, j: unknown) => new Response(j === null ? null : JSON.stringify(j), { status });
    if (u.hostname !== "api.spotify.com") throw new Error("only api.spotify.com is mocked: " + url);
    if (u.pathname === "/v1/search") {
      const q = u.searchParams.get("q") ?? "";
      const hit = Object.entries(CATALOGUE).find(([title]) => q.endsWith(title));
      const items = hit ? [{ id: hit[1].id, name: hit[1].name, duration_ms: 200000, artists: [{ name: hit[1].artist }] }] : [];
      return json(200, { tracks: { items } });
    }
    if (u.pathname === "/v1/me/player/play") {
      order.push(`sp:PUT play ${(body as { uris: string[] }).uris.length}`);
      return json(204, null);
    }
    if (u.pathname.startsWith("/v1/me/player")) return json(204, null);
    return json(404, { error: { status: 404 } });
  });
}

const tr = (n: number): Track => ({ id: `yt${String(n).padStart(9, "0")}`, title: `Song ${n}`, channel: `Artist ${n}` });
const sdkTrack = (id: string, name = "x", images: SdkTrack["album"]["images"] = []): SdkTrack => ({
  id,
  uri: `spotify:track:${id}`,
  name,
  duration_ms: 200000,
  artists: [{ name: "A" }],
  album: { name: "Al", images },
});
const sdkState = (cur: SdkTrack | null, paused: boolean, position = 1000, extra: Partial<SdkState> = {}): SdkState => ({
  paused,
  position,
  duration: 200000,
  track_window: { current_track: cur, previous_tracks: [], next_tracks: [] },
  ...extra,
});

/** Signed in as the person picked on this device (memory only in node: no IndexedDB). */
function signIn() {
  forgetSpotifyAuth();
  void __setSpotifyTokenForTests({ access: "user-token", refresh: "r", exp: Date.now() + 3600_000 });
}

beforeEach(() => {
  __resetMusicForTests();
  __resetSpotifyForTests();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("gtd-me", "Tester");
  forgetSpotifyAuth();
  spotifyOwnerChanged();
  FakeSpotifyPlayer.noReady = false;
  order.length = 0;
  calls.length = 0;
  musicLog.length = 0;
  for (const k of Object.keys(CATALOGUE)) if (k.startsWith("Gone")) delete CATALOGUE[k];
  mockFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Matching ------------------------------------------------------------------------

describe("finding a YouTube song on Spotify", () => {
  it("reads title and artist out of YouTube's titles and channels", () => {
    expect(guessSong("Luis Fonsi - Despacito ft. Daddy Yankee (Official Video)", "LuisFonsiVEVO")).toEqual({ title: "Despacito", artist: "Luis Fonsi" });
    expect(guessSong("Sere Nere", "Tiziano Ferro - Topic")).toEqual({ title: "Sere Nere", artist: "Tiziano Ferro" });
    // "Song - Artist": the channel says which side is the artist.
    expect(guessSong("Bailando - Enrique Iglesias", "EnriqueIglesiasVEVO")).toEqual({ title: "Bailando", artist: "Enrique Iglesias" });
    expect(cleanTitle("Blinding Lights [Official Audio]")).toBe("Blinding Lights");
    expect(cleanTitle("La solitudine (Remastered 2013)")).toBe("La solitudine");
    expect(channelArtist("Queen Official")).toBe("Queen");
  });

  it("scores the right song highest and refuses covers, live and remixes not asked for", () => {
    const want = { title: "Despacito", artist: "Luis Fonsi" };
    const right = { id: "a", name: "Despacito - Remix", artists: ["Luis Fonsi", "Daddy Yankee", "Justin Bieber"] };
    const orig = { id: "b", name: "Despacito", artists: ["Luis Fonsi", "Daddy Yankee"] };
    const cover = { id: "c", name: "Despacito", artists: ["Karaoke Kings"] };
    const live = { id: "d", name: "Despacito - Live", artists: ["Luis Fonsi"] };
    expect(pickMatch(want, [right, cover, orig, live])?.cand.id).toBe("b");
    expect(scoreMatch(want, cover)).toBeLessThan(MATCH_MIN);
    expect(scoreMatch(want, live)).toBeLessThan(scoreMatch(want, orig));
    expect(pickMatch(want, [cover])).toBeNull();
    expect(pickMatch({ title: "Completely Different", artist: "Nobody" }, [orig])).toBeNull();
  });

  it("a big length difference costs a little, never all of it", () => {
    const want = { title: "Song", artist: "Band", ms: 200000 };
    const close = scoreMatch(want, { id: "a", name: "Song", artists: ["Band"], ms: 210000 });
    const far = scoreMatch(want, { id: "b", name: "Song", artists: ["Band"], ms: 400000 });
    expect(far).toBeLessThan(close);
    expect(far).toBeGreaterThanOrEqual(MATCH_MIN);
  });
});

// ---- The window ------------------------------------------------------------------------

describe("the queue window given to Spotify", () => {
  const q = Array.from({ length: 8 }, (_, i) => tr(i));
  const known = (t: Track) => ({ yt000000000: "s0", yt000000001: "s1", yt000000002: null, yt000000003: "s3", yt000000004: "s4" } as Record<string, string | null>)[t.id];

  it("takes the matched songs from the index on, skips the ones not on Spotify, stops at one not looked up", () => {
    expect(windowFrom(q, 0, known)).toEqual({ uris: ["spotify:track:s0", "spotify:track:s1", "spotify:track:s3", "spotify:track:s4"], idx: [0, 1, 3, 4], tracks: [q[0], q[1], q[3], q[4]] });
    expect(windowFrom(q, 3, known)).toEqual({ uris: ["spotify:track:s3", "spotify:track:s4"], idx: [3, 4], tracks: [q[3], q[4]] });
    expect(windowFrom(q, 5, known)).toEqual({ uris: [], idx: [], tracks: [] });
  });

  it("is at most WINDOW_MAX songs long", () => {
    const long = Array.from({ length: 120 }, (_, i) => tr(i));
    const w = windowFrom(long, 10, (t) => "s" + t.id);
    expect(w.uris).toHaveLength(50);
    expect(w.idx[0]).toBe(10);
    expect(w.idx[49]).toBe(59);
  });
});

// ---- State mapping --------------------------------------------------------------------

describe("Spotify's states become the music state", () => {
  const w = { uris: ["spotify:track:s0", "spotify:track:s1"], idx: [3, 5] };
  const m = { index: 3, playing: true, queue: [] as Track[] };

  it("playing, buffering, paused, and the queue entry from the window", () => {
    expect(mapState(sdkState(sdkTrack("s1"), false), m, w, null, false)).toEqual({ index: 5, playing: true, status: "playing", confirmed: true });
    expect(mapState(sdkState(sdkTrack("s0"), false, 0, { loading: true }), m, w, null, false)).toMatchObject({ index: 3, status: "buffering", confirmed: false });
    expect(mapState(sdkState(sdkTrack("s0"), true), m, w, null, false)).toEqual({ index: 3, playing: false, status: "paused", confirmed: false });
  });

  it("a late state about the song before the one asked for is ignored; the one asked for, paused, is still loading", () => {
    expect(mapState(sdkState(sdkTrack("s0"), false), m, w, 5, false)).toBeNull();
    expect(mapState(sdkState(sdkTrack("s1"), true, 0), m, w, 5, false)).toMatchObject({ index: 5, playing: true, status: "loading" });
  });

  it("a start echoing after the app paused stays paused; a relinked track is found by linked_from", () => {
    expect(mapState(sdkState(sdkTrack("s0"), false), { ...m, playing: false }, w, null, true)).toMatchObject({ playing: false, status: "paused" });
    const relinked = { ...sdkTrack("other"), linked_from: { uri: "spotify:track:s1", id: "s1" } };
    expect(mapState(sdkState(relinked, false), m, w, null, false)?.index).toBe(5);
  });

  it("an ended song: paused at 0 after playing to its end", () => {
    const last = { uri: "spotify:track:s1", pos: 199000, dur: 200000, paused: false };
    expect(isEnded(sdkState(sdkTrack("s1"), true, 0), last)).toBe(true);
    expect(isEnded(sdkState(sdkTrack("s1"), true, 0), { ...last, pos: 30000 })).toBe(false); // a pause, not an end
    expect(isEnded(sdkState(sdkTrack("s1"), true, 5000), last)).toBe(false);
  });
});

// ---- The engine ------------------------------------------------------------------------

describe("Spotify mode", () => {
  it("not signed in: the switch stays on YouTube (nothing stops, nothing plays)", () => {
    const yt = fakeYt();
    attachPlayer(yt);
    music.play({ kind: "videos", label: "L", tracks: [tr(0)], start: 0 });
    order.length = 0;
    music.setEngine("spotify");
    expect(getMusic().engine).toBe("youtube");
    expect(order).toEqual([]);
  });

  it("switching pauses YouTube FIRST, then Spotify plays the same song; switching back pauses Spotify first", async () => {
    signIn();
    const yt = fakeYt();
    attachPlayer(yt);
    const tracks = [tr(0), tr(1), tr(2)];
    music.play({ kind: "videos", label: "Team", key: "pl:x", tracks, start: 1 });
    yt.state = YT_STATE.PLAYING;
    onYtState(YT_STATE.PLAYING);
    expect(getMusic().status).toBe("playing");
    order.length = 0;

    music.setEngine("spotify");
    // At once: Spotify mode, loading (the spinner), and YouTube already paused.
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: true, status: "loading", index: 1 });
    expect(order[0]).toBe("yt:pause");
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    expect(order.indexOf("yt:pause")).toBeLessThan(order.findIndex((o) => o.startsWith("sp:PUT play")));
    const play = calls.find((c) => c.path.startsWith("/v1/me/player/play"))!;
    expect(play.method).toBe("PUT");
    expect(play.path).toContain("device_id=dev1");
    expect(play.body).toEqual({ uris: ["spotify:track:sp0000000000000000000b", "spotify:track:sp0000000000000000000c"], offset: { position: 0 }, position_ms: 0 });
    // The match is kept on the Track and per YouTube id.
    expect(tracks[1].spotify).toBe("sp0000000000000000000b");
    expect(knownMatch({ ...tr(1) })).toBe("sp0000000000000000000b");
    expect(FakeSpotifyPlayer.last?.name).toBe("Team GTD");

    // YouTube starting by itself in Spotify mode is paused again.
    order.length = 0;
    onYtState(YT_STATE.PLAYING);
    expect(order).toEqual(["yt:pause"]);

    // Spotify confirms: playing, with Spotify's own title and cover.
    onState(sdkState(sdkTrack("sp0000000000000000000b", "Song 1 (Spotify)", [{ url: "https://i.scdn.co/image/big", width: 640 }]), false));
    expect(getMusic()).toMatchObject({ status: "playing", playing: true, index: 1 });
    expect(getMusic().now?.title).toBe("Song 1 (Spotify)");
    expect(getMusic().spNow).toMatchObject({ cover: "https://i.scdn.co/image/big", url: "https://open.spotify.com/track/sp0000000000000000000b" });

    // Next: the next song is in Spotify's window, so its own nextTrack.
    order.length = 0;
    music.next();
    expect(getMusic()).toMatchObject({ index: 2, status: "loading", playing: true });
    expect(order).toContain("sp:next");

    // Pause: Spotify pauses, the state at once.
    music.toggle();
    expect(getMusic()).toMatchObject({ playing: false, status: "paused" });
    expect(order).toContain("sp:pause");

    // Back to YouTube: Spotify paused first, YouTube not started (it was paused).
    order.length = 0;
    music.setEngine("youtube");
    expect(getMusic()).toMatchObject({ engine: "youtube", spNow: null, playing: false });
    expect(order[0]).toBe("sp:pause");
    expect(order.some((o) => o.startsWith("yt:load") || o === "yt:play")).toBe(false);
  });

  it("switching back while Spotify plays: Spotify paused, then YouTube goes on at the same song", async () => {
    signIn();
    const yt = fakeYt();
    attachPlayer(yt);
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0), tr(1)], start: 0 });
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    onState(sdkState(sdkTrack("sp0000000000000000000a"), false));
    expect(getMusic().status).toBe("playing");
    order.length = 0;
    music.setEngine("youtube");
    expect(order[0]).toBe("sp:pause");
    expect(order[1]).toBe("yt:load:0");
    expect(getMusic()).toMatchObject({ engine: "youtube", playing: true, status: "loading", index: 0 });
    // A late "playing" from Spotify now is paused at once.
    order.length = 0;
    onState(sdkState(sdkTrack("sp0000000000000000000a"), false));
    expect(order).toEqual(["sp:pause"]);
    expect(getMusic().engine).toBe("youtube");
  });

  it("a song not on Spotify is skipped with a toast, never played from YouTube", async () => {
    signIn();
    const yt = fakeYt();
    attachPlayer(yt);
    music.setEngine("spotify");
    order.length = 0;
    const missing: Track = { id: "ytmissing01", title: "Gone Song", channel: "Nobody" };
    music.play({ kind: "videos", label: "Team", tracks: [missing, tr(2), tr(3)], start: 0 });
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    expect(getMusic().index).toBe(1);
    expect(musicLog.some((e) => e.ev.includes("not on Spotify: skipped"))).toBe(true);
    expect(order.some((o) => o.startsWith("yt:"))).toBe(false);
    const play = calls.find((c) => c.path.startsWith("/v1/me/player/play"))!;
    expect((play.body as { uris: string[] }).uris[0]).toBe("spotify:track:sp0000000000000000000c");
    expect(knownMatch(missing)).toBeNull();
  });

  it("no Premium (account_error): a toast, and back to YouTube, paused", async () => {
    signIn();
    attachPlayer(fakeYt());
    const realConnect = FakeSpotifyPlayer.prototype.connect;
    FakeSpotifyPlayer.prototype.connect = function () {
      setTimeout(() => this.emit("account_error", { message: "premium required" }), 0);
      return Promise.resolve(true);
    };
    try {
      music.play({ kind: "videos", label: "Team", tracks: [tr(0)], start: 0 });
      music.setEngine("spotify");
      expect(getMusic().engine).toBe("spotify");
      await vi.waitFor(() => expect(getMusic().engine).toBe("youtube"));
      expect(getMusic()).toMatchObject({ playing: false, status: "paused" });
      expect(getMusic().toast?.kind).toBe("error");
      expect(localStorage.getItem("gtd-music-engine")).toBe("youtube");
    } finally {
      FakeSpotifyPlayer.prototype.connect = realConnect;
    }
  });

  it("a song that ends with nothing after it in the window: the next one goes to Spotify", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    const q = [tr(0), { id: "ytlater0001", title: "Gone Later", channel: "X" }, tr(3)];
    // Song 1 is looked up only now: not on Spotify, so the first window is song 0 alone.
    music.play({ kind: "videos", label: "Team", tracks: q, start: 0 });
    await vi.waitFor(() => expect(order.filter((o) => o.startsWith("sp:PUT play"))).toHaveLength(1));
    onState(sdkState(sdkTrack("sp0000000000000000000a"), false, 198500));
    order.length = 0;
    onState(sdkState(sdkTrack("sp0000000000000000000a"), true, 0));
    // Song 1 is not on Spotify: skipped; song 2 plays.
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    expect(getMusic().index).toBe(2);
  });

  it("radio and the YouTube lists are refused in Spotify mode, with a hint", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    order.length = 0;
    music.play({ kind: "mix" });
    expect(getMusic().source).toBeNull();
    expect(getMusic().toast?.text).toBe("music.sp.ytOnly");
    const { playRadio } = await import("../music");
    expect(await playRadio(tr(0), "Radio")).toBeNull();
    expect(getMusic().toast?.text).toBe("music.sp.radioOff");
    // (The device connects meanwhile: that is all.)
    expect(order.filter((o) => o !== "sp:connect")).toEqual([]);
  });
});

// ---- Review fixes ----------------------------------------------------------------------

const ID = (n: number) => CATALOGUE[`Song ${n}`].id;

describe("the window follows the queue's Track objects, not old positions", () => {
  const known = (t: Track) => (t.title.startsWith("Gone") ? null : t.title.startsWith("New") ? undefined : "s" + t.id);
  it("entryIndex finds a song again after a song is put before it; validWindowLength cuts where the order changed", () => {
    const [a, b, c] = [tr(0), tr(1), tr(2)];
    const w = windowFrom([a, b, c], 0, known);
    const x: Track = { id: "ytx", title: "X", channel: "Y" };
    const gone: Track = { id: "ytg", title: "Gone", channel: "Y" };
    // Played next: X between A and B. B is now entry 2, and Spotify's "B after A" is wrong.
    const q1 = [a, x, b, c];
    expect(entryIndex(w, 1, q1)).toBe(2);
    expect(validWindowLength(w, q1, 0, known)).toBe(1);
    // Added at the end (after the window): the window is still right.
    expect(validWindowLength(w, [a, b, c, x], 0, known)).toBe(3);
    // A song known not to be on Spotify in between is skipped anyway: still right.
    expect(validWindowLength(w, [a, gone, b, c], 0, known)).toBe(3);
    // The states map to the Track's new place.
    expect(mapState(sdkState(sdkTrack("s" + b.id), false), { index: 0, playing: true, queue: q1 }, w, null, false)?.index).toBe(2);
  });

  it("play next while Spotify plays: Spotify's own next song is not followed; the queue's next is sent, and no Track gets another song's id", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    const [a, b, c] = [tr(0), tr(1), tr(2)];
    music.play({ kind: "videos", label: "Team", tracks: [a, b, c], start: 0 });
    await vi.waitFor(() => expect(order.filter((o) => o === "sp:PUT play 3")).toHaveLength(1));
    onState(sdkState(sdkTrack(ID(0)), false, 1000));
    expect(getMusic()).toMatchObject({ index: 0, status: "playing" });
    const x: Track = { id: "yt000000003", title: "Song 3", channel: "Artist 3" };
    music.enqueue([x], "next", "x");
    expect(getMusic().queue[1].id).toBe(x.id);
    expect(musicLog.some((e) => e.ev.includes("not the queue's any more"))).toBe(true);
    // Next pressed now: X is not in Spotify's window, so no nextTrack (that would play B).
    order.length = 0;
    music.next();
    expect(getMusic()).toMatchObject({ index: 1, spNow: null, status: "loading" });
    expect(order).not.toContain("sp:next");
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    const last = calls.filter((c) => c.path.startsWith("/v1/me/player/play")).pop()!;
    expect((last.body as { uris: string[] }).uris[0]).toBe(`spotify:track:${ID(3)}`);
    expect(getMusic().queue[1].spotify).toBe(ID(3));
    expect(getMusic().queue[2].spotify).toBe(ID(1));
  });

  it("A ends and Spotify goes on to B by itself after 'play next' X: Spotify is paused and X is sent; X keeps its own id", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    const [a, b, c] = [tr(0), tr(1), tr(2)];
    music.play({ kind: "videos", label: "Team", tracks: [a, b, c], start: 0 });
    await vi.waitFor(() => expect(order.filter((o) => o === "sp:PUT play 3")).toHaveLength(1));
    onState(sdkState(sdkTrack(ID(0)), false, 1000));
    const x: Track = { id: "yt000000004", title: "Other", channel: "Nobody" };
    x.spotify = undefined;
    music.enqueue([x], "next", "x");
    order.length = 0;
    onState(sdkState(sdkTrack(ID(1)), false, 0));
    expect(order[0]).toBe("sp:pause");
    expect(getMusic().index).toBe(1);
    expect(getMusic().spNow).toBeNull();
    expect(getMusic().queue[1].spotify).toBeUndefined();
  });
});

describe("review fixes: feedback, overlap, attribution", () => {
  it("Play in Spotify mode with no songs (a YouTube list not read yet): a toast, never a spinner", () => {
    signIn();
    attachPlayer(fakeYt());
    music.play({ kind: "mix" });
    expect(getMusic().queue).toHaveLength(0);
    music.setEngine("spotify");
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false, status: "paused" });
    music.toggle();
    expect(getMusic()).toMatchObject({ playing: false, status: "paused" });
    expect(getMusic().toast?.text).toBe("music.sp.nothing");
  });

  it("back to YouTube while the PUT is in flight: Spotify is paused the moment the PUT lands", async () => {
    signIn();
    const yt = fakeYt();
    attachPlayer(yt);
    let land: (() => void) | null = null;
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/me/player/play")) await new Promise<void>((r) => (land = r));
      return inner(url, init);
    });
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0), tr(1)], start: 0 });
    // The PUT is on its way to Spotify (not answered yet): back to YouTube.
    await vi.waitFor(() => expect(land).not.toBeNull());
    music.setEngine("youtube");
    order.length = 0;
    land!();
    await vi.waitFor(() => expect(calls.some((c) => c.path.startsWith("/v1/me/player/pause"))).toBe(true));
    expect(order).toContain("sp:pause");
    expect(getMusic().engine).toBe("youtube");
  });

  it("paused while the song is looked up: no PUT at all (Play sends it)", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0), tr(1)], start: 0 });
    music.toggle();
    expect(getMusic()).toMatchObject({ playing: false, status: "paused" });
    await vi.waitFor(() => expect(musicLog.some((e) => e.ev.includes("PUT /me/player/play not sent"))).toBe(true));
    expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(false);
    music.toggle();
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
  });

  it("Next in Spotify mode: the previous song's Spotify cover and link go at once", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0), tr(1)], start: 0 });
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    onState(sdkState(sdkTrack(ID(0)), false));
    expect(getMusic().spNow?.id).toBe(ID(0));
    music.next();
    expect(getMusic().spNow).toBeNull();
  });

  it("on a phone with no Spotify player at the click: no start that the browser would refuse; with the player made ahead, it is activated inside the click", async () => {
    signIn();
    attachPlayer(fakeYt());
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", maxTouchPoints: 5 });
    music.play({ kind: "videos", label: "Team", tracks: [tr(0)], start: 0 });
    music.setEngine("spotify");
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false, status: "paused" });
    expect(getMusic().toast?.text).toBe("music.sp.tapPlay");
    expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(false);

    // The device is made meanwhile (warm): the next click has a player to activate.
    await vi.waitFor(() => expect(order).toContain("sp:connect"));
    music.setEngine("youtube");
    order.length = 0;
    music.toggle(); // YouTube: playing
    music.setEngine("spotify");
    expect(order).toContain("sp:activate");
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: true, status: "loading" });
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
  });

  it("the Spotify player object is made ahead of the click when signed in (no device connected yet)", async () => {
    prepareSpotifyPlayer();
    expect(musicLog.some((e) => e.ev.includes("made ahead"))).toBe(false); // not signed in: nothing
    signIn();
    FakeSpotifyPlayer.last = null;
    prepareSpotifyPlayer();
    await vi.waitFor(() => expect(musicLog.some((e) => e.ev.includes("made ahead of the click"))).toBe(true));
    expect((FakeSpotifyPlayer.last as FakeSpotifyPlayer | null)?.name).toBe("Team GTD");
    expect(order).not.toContain("sp:connect");
  });

  it("signed out while Spotify plays: back to YouTube PAUSED (YouTube never carries on by itself)", async () => {
    signIn();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0)], start: 0 });
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    onState(sdkState(sdkTrack(ID(0)), false));
    order.length = 0;
    spotifyFailed("after signing out of Spotify");
    expect(getMusic()).toMatchObject({ engine: "youtube", playing: false, spNow: null });
    expect(order).toContain("sp:pause");
    expect(order.some((o) => o.startsWith("yt:load") || o === "yt:play")).toBe(false);
  });
});

// ---- Security: this device only, a blocked network, the person picked ------------------

/** Spotify mode playing song 0 on this browser's device (dev1). */
async function playingHere(tracks = [tr(0), tr(1)]) {
  signIn();
  attachPlayer(fakeYt());
  music.setEngine("spotify");
  music.play({ kind: "videos", label: "Team", tracks, start: 0 });
  await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
  onState(sdkState(sdkTrack(ID(0)), false));
  expect(getMusic()).toMatchObject({ engine: "spotify", status: "playing" });
}
const playerWrites = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/v1/me/player"));

describe("playback only on this browser's device", () => {
  it("every player command names this browser's device (device_id = the SDK's)", async () => {
    await playingHere();
    music.next();
    music.toggle();
    music.toggle();
    await vi.waitFor(() => expect(playerWrites().length).toBeGreaterThanOrEqual(3));
    for (const c of playerWrites()) {
      const dev = c.path === "/v1/me/player" ? (c.body as { device_ids: string[] }).device_ids.join() : new URL("https://x" + c.path).searchParams.get("device_id");
      expect(dev, c.path).toBe("dev1");
    }
  });

  it("a command for no device, or another device, is refused here and never sent (no 'active device' fallback)", async () => {
    // No device yet: even a command naming one is refused.
    signIn();
    expect((await spApi("PUT", "/me/player/play?device_id=dev1", { uris: [] })).status).toBe(-1);
    await playingHere();
    calls.length = 0;
    for (const [path, body] of [
      ["/me/player/play", { uris: ["spotify:track:x"] }],
      ["/me/player/pause", undefined],
      ["/me/player/next", undefined],
      ["/me/player/seek?position_ms=1000", undefined],
      ["/me/player/volume?volume_percent=10", undefined],
      ["/me/player/queue?uri=spotify:track:x", undefined],
      ["/me/player/play?device_id=phone", { uris: ["spotify:track:x"] }],
      ["/me/player", { device_ids: ["phone"] }],
      ["/me/player", { device_ids: ["dev1", "phone"] }],
    ] as const) {
      expect((await spApi("PUT", path, body)).status, path).toBe(-1);
    }
    expect(calls).toEqual([]);
    expect((await spApi("PUT", "/me/player/pause?device_id=dev1")).status).toBe(204);
    expect(musicLog.some((e) => e.ev.includes("REFUSED: a Spotify player command not for this browser's device"))).toBe(true);
  });

  it("the local device goes away before the play: NO play command at all, a toast", async () => {
    signIn();
    attachPlayer(fakeYt());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      // The device drops while the song is looked up.
      if (String(url).includes("/v1/search")) FakeSpotifyPlayer.last?.emit("not_ready", { device_id: "dev1" });
      return inner(url, init);
    });
    music.setEngine("spotify");
    music.play({ kind: "videos", label: "Team", tracks: [tr(0), tr(1)], start: 0 });
    await vi.waitFor(() => expect(getMusic().toast?.text).toBe("music.sp.noDevice"));
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false, status: "paused" });
    expect(playerWrites()).toEqual([]);
  });

  it("playback moved to another device (no SDK state): paused here with a toast, NOT transferred back", async () => {
    await playingHere();
    calls.length = 0;
    order.length = 0;
    onState(null);
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false, status: "paused" });
    expect(getMusic().toast?.text).toBe("music.sp.otherDevice");
    // Nothing goes on here by itself (no next song, no transfer), and repeated empty states say nothing new.
    const toastId = getMusic().toast?.id;
    onState(null);
    expect(getMusic().toast?.id).toBe(toastId);
    await new Promise((r) => setTimeout(r, 50));
    expect(playerWrites()).toEqual([]);
    expect(order.some((o) => o.startsWith("sp:PUT play") || o === "sp:resume")).toBe(false);
    // Play pressed HERE: played here (this device only), by the person's choice.
    music.toggle();
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    expect(playerWrites().every((c) => c.path.includes("device_id=dev1") || (c.body as { device_ids?: string[] })?.device_ids?.join() === "dev1")).toBe(true);
  });

  it("GET /me/player names another device: paused here with the toast, nothing sent", async () => {
    await playingHere();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (new URL(url).pathname === "/v1/me/player" && (init.method ?? "GET") === "GET") {
        calls.push({ method: "GET", path: "/v1/me/player", body: undefined });
        return new Response(JSON.stringify({ device: { id: "phone", name: "Anna's phone", type: "Smartphone" }, is_playing: true }), { status: 200 });
      }
      return inner(url, init);
    });
    calls.length = 0;
    expect(await checkWhere()).toBe(true);
    expect(getMusic()).toMatchObject({ playing: false, status: "paused" });
    expect(getMusic().toast?.text).toBe("music.sp.otherDevice");
    expect(playerWrites()).toEqual([]);
    expect(musicLog.some((e) => e.ev.includes("moved to another device") && JSON.stringify(e.data).includes("Anna's phone"))).toBe(true);
  });
});

describe("Spotify unreachable from this network", () => {
  it("the SDK script does not load (sdk.scdn.co blocked): a toast, back to YouTube with the queue, no other host tried", async () => {
    const g = globalThis as unknown as { Spotify?: unknown; document?: unknown };
    const saved = g.Spotify;
    delete g.Spotify;
    const scripts: { src: string; onerror?: () => void; remove(): void }[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const s = { src: "", async: false, onerror: undefined as undefined | (() => void), remove() {} };
        scripts.push(s);
        return s;
      },
      head: { appendChild: (s: { onerror?: () => void }) => setTimeout(() => s.onerror?.(), 0) },
    });
    try {
      signIn();
      attachPlayer(fakeYt());
      const tracks = [tr(0), tr(1)];
      music.play({ kind: "videos", label: "Team", tracks, start: 0 });
      music.setEngine("spotify");
      await vi.waitFor(() => expect(getMusic().engine).toBe("youtube"));
      expect(getMusic().toast).toMatchObject({ text: "music.sp.unreachable", kind: "error" });
      expect(getMusic().queue).toEqual(tracks);
      expect(scripts.map((s) => s.src)).toEqual([SDK_URL]);
      expect(musicLog.some((e) => e.ev.includes("not reachable from this network") && JSON.stringify(e.data).includes("sdk.scdn.co"))).toBe(true);
    } finally {
      g.Spotify = saved;
    }
  });

  it("api.spotify.com blocked (fetch TypeError): a toast, back to YouTube with the queue", async () => {
    signIn();
    attachPlayer(fakeYt());
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push({ method: "?", path: new URL(url).pathname, body: undefined });
      throw new TypeError("Failed to fetch");
    });
    const tracks = [tr(0), tr(1)];
    music.play({ kind: "videos", label: "Team", tracks, start: 0 });
    music.setEngine("spotify");
    await vi.waitFor(() => expect(getMusic().engine).toBe("youtube"));
    expect(getMusic().toast).toMatchObject({ text: "music.sp.unreachable", kind: "error" });
    expect(getMusic()).toMatchObject({ playing: false, queue: tracks });
    // Only Spotify's own hosts were ever asked.
    expect(calls.every((c) => c.path.startsWith("/v1/"))).toBe(true);
  });

  it("the SDK never says ready (its websocket is blocked): after 15 s a toast and back to YouTube", async () => {
    FakeSpotifyPlayer.noReady = true;
    vi.useFakeTimers();
    try {
      signIn();
      attachPlayer(fakeYt());
      music.play({ kind: "videos", label: "Team", tracks: [tr(0)], start: 0 });
      music.setEngine("spotify");
      await vi.advanceTimersByTimeAsync(14000);
      expect(getMusic().engine).toBe("spotify");
      await vi.advanceTimersByTimeAsync(1500);
      expect(getMusic().engine).toBe("youtube");
      expect(getMusic().toast?.text).toBe("music.sp.unreachable");
      expect(playerWrites()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the name picked on this device switches the Spotify session", () => {
  it("the new person is not signed in here: back to YouTube with a toast, the old device dropped", async () => {
    await playingHere();
    order.length = 0;
    localStorage.setItem("gtd-me", "Marco");
    spotifyOwnerChanged();
    expect(getMusic()).toMatchObject({ engine: "youtube", playing: false });
    expect(getMusic().toast).toMatchObject({ text: "music.sp.ownerOut", kind: "error" });
    expect(order).toContain("sp:disconnect");
  });

  it("the new person is signed in here: their own session, paused (the previous person's device is gone)", async () => {
    await playingHere();
    await __setSpotifyTokenForTests({ access: "marco-token", exp: Date.now() + 3600_000 }, "marco");
    order.length = 0;
    calls.length = 0;
    localStorage.setItem("gtd-me", "Marco");
    spotifyOwnerChanged();
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false, status: "paused" });
    expect(getMusic().toast?.text).toBe("music.sp.ownerSwitched");
    expect(order).toContain("sp:disconnect");
    // Play: a NEW device, made with Marco's token.
    music.toggle();
    await vi.waitFor(() => expect(order.some((o) => o.startsWith("sp:PUT play"))).toBe(true));
    expect(order).toContain("sp:connect");
  });

  it("no name picked: Spotify mode ends with a toast", async () => {
    await playingHere();
    localStorage.setItem("gtd-me", "");
    spotifyOwnerChanged();
    expect(getMusic().engine).toBe("youtube");
    expect(getMusic().toast?.text).toBe("music.sp.noIdentity");
  });

  it("the name changed in another tab (no event yet): a player command is not sent with the new person's token to the old person's device", async () => {
    await playingHere();
    await __setSpotifyTokenForTests({ access: "marco-token", exp: Date.now() + 3600_000 }, "marco");
    calls.length = 0;
    order.length = 0;
    localStorage.setItem("gtd-me", "Marco"); // written by another tab; this tab heard nothing yet
    expect((await spApi("PUT", "/me/player/pause?device_id=dev1")).status).toBe(-1);
    expect(calls).toEqual([]);
    expect(musicLog.some((e) => e.ev.includes("REFUSED: the person picked changed while a Spotify player command waited"))).toBe(true);
    // The switch is then heard: the old device is dropped, Marco's own session, paused.
    await vi.waitFor(() => expect(order).toContain("sp:disconnect"));
    expect(getMusic()).toMatchObject({ engine: "spotify", playing: false });
  });
});

describe("the device key store does not answer", () => {
  it("a toast, back to YouTube, and the sealed sign-in is kept", async () => {
    // A real key for this "device", then a store that never answers (a stuck IndexedDB open).
    let key: CryptoKey | null = null;
    __setSpotifyKeyStoreForTests({ get: async () => key, putIfAbsent: async (k) => (key ??= k) });
    await __setSpotifyTokenForTests({ access: "user-token", refresh: "r", exp: Date.now() + 3600_000 });
    const sealed = localStorage.getItem("gtd-spotify-token:tester");
    expect(sealed).toBeTruthy();
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    forgetSpotifyAuth();
    __setSpotifyKeyStoreForTests({ get: () => new Promise(() => {}), putIfAbsent: () => new Promise(() => {}) });
    vi.useFakeTimers();
    try {
      expect(spotifyAuthState().status).toBe("busy");
      await vi.advanceTimersByTimeAsync(KEYSTORE_MS + 10);
      expect(spotifyAuthState().status).toBe("out");
      expect(getMusic().toast).toMatchObject({ text: "music.sp.keystore", kind: "error" });
      expect(getMusic().engine).toBe("youtube");
      expect(localStorage.getItem("gtd-spotify-token:tester")).toBe(sealed);
    } finally {
      vi.useRealTimers();
      __setSpotifyKeyStoreForTests(undefined);
    }
  });
});
