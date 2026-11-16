import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The music engine and its network helpers, with Supabase and YouTube faked.
vi.mock("../supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
    },
  },
}));

import {
  __resetMusicForTests,
  attachPlayer,
  errorCode,
  fetchExplore,
  fetchSuggestions,
  getMusic,
  getMusicTime,
  insertTracks,
  lastRequest,
  music,
  musicErrorText,
  nextIndex,
  onYtError,
  onYtState,
  prevIndex,
  searchMusic,
  selectMemo,
  setDockRect,
  setMusic,
  shuffleQueue,
  unshuffleQueue,
  YT_STATE as S,
  type MusicState,
  type SelMemo,
  type Track,
  type YtLike,
} from "../music";
import { supabase } from "../supabaseClient";

const tr = (n: number): Track => ({ id: `id${String(n).padStart(9, "0")}`, title: `Song ${n}`, channel: `Artist ${n}` });
const list = (n: number) => Array.from({ length: n }, (_, i) => tr(i));

/** A YouTube player that records commands; tests send its events by hand. */
function fakePlayer() {
  const log: string[] = [];
  const p = {
    ids: [] as string[],
    index: 0,
    state: S.UNSTARTED as number,
    time: 0,
    listReady: true,
    log,
    loadPlaylist(arg: unknown, index = 0, start = 0) {
      log.push(`load:${index}:${start}`);
      if (Array.isArray(arg)) this.ids = arg.slice();
      else this.ids = Array.from({ length: 10 }, (_, k) => `ls${String(k).padStart(9, "0")}`);
      this.index = index;
    },
    cuePlaylist(arg: unknown, index = 0, start = 0) {
      log.push(`cue:${index}:${start}`);
      if (Array.isArray(arg)) this.ids = arg.slice();
      else this.ids = Array.from({ length: 10 }, (_, k) => `ls${String(k).padStart(9, "0")}`);
      this.index = index;
    },
    playVideo: () => log.push("play"),
    pauseVideo: () => log.push("pause"),
    stopVideo: () => log.push("stop"),
    nextVideo: () => log.push("next"),
    playVideoAt(i: number) {
      log.push(`at:${i}`);
      this.index = i;
    },
    seekTo: (s: number) => log.push(`seek:${s}`),
    setVolume: (v: number) => log.push(`vol:${v}`),
    mute: () => log.push("mute"),
    unMute: () => log.push("unmute"),
    setLoop: (on: boolean) => log.push(`loop:${on}`),
    getPlaylist() {
      return this.listReady ? this.ids.slice() : null;
    },
    getPlaylistIndex() {
      return this.index;
    },
    getPlayerState() {
      return this.state;
    },
    getCurrentTime() {
      return this.time;
    },
    getDuration: () => 200,
    getVolume: () => 80,
    isMuted: () => false,
    getVideoData() {
      return { video_id: this.ids[this.index], title: `YT raw ${this.ids[this.index]}`, author: "VEVO" };
    },
  };
  return p;
}
type Fake = ReturnType<typeof fakePlayer>;

/** YouTube moving to `state` with its current video. */
function ev(p: Fake, state: number) {
  p.state = state;
  onYtState(state);
}

let p: Fake;
beforeEach(() => {
  __resetMusicForTests();
  p = fakePlayer();
  attachPlayer(p as unknown as YtLike);
  p.log.length = 0;
});

describe("queue logic", () => {
  it("next / previous with and without repeat", () => {
    expect(nextIndex(0, 3, false)).toBe(1);
    expect(nextIndex(2, 3, false)).toBeNull();
    expect(nextIndex(2, 3, true)).toBe(0);
    expect(nextIndex(0, 0, true)).toBeNull();
    expect(prevIndex(0, 3, false)).toBeNull();
    expect(prevIndex(0, 3, true)).toBe(2);
    expect(prevIndex(2, 3, false)).toBe(1);
  });

  it("shuffle keeps the current song first and every song once; unshuffle returns to it", () => {
    const q = list(20);
    const s = shuffleQueue(q, 7);
    expect(s.index).toBe(0);
    expect(s.queue[0]).toBe(q[7]);
    expect(new Set(s.queue).size).toBe(20);
    const back = unshuffleQueue(q, s.queue, 3);
    expect(back.queue).toBe(q);
    expect(back.index).toBe(q.indexOf(s.queue[3]));
  });

  it("inserts after the current song or at the end, as new entries, without the current one", () => {
    const q = list(3);
    const out = insertTracks(q, 0, [tr(9), q[0]], "next");
    expect(out.map((t) => t.id)).toEqual([q[0].id, tr(9).id, q[1].id, q[2].id]);
    expect(out[1]).not.toBe(tr(9));
    expect(insertTracks(q, 1, [tr(8)], "end").map((t) => t.id).pop()).toBe(tr(8).id);
  });
});

describe("the engine", () => {
  it("play sets the song and a loading status at once, then YouTube confirms", () => {
    const q = list(5);
    music.play({ kind: "videos", label: "L", key: "pl:1", tracks: q, start: 2 });
    let s = getMusic();
    expect(s.playing).toBe(true);
    expect(s.status).toBe("loading");
    expect(s.now?.title).toBe("Song 2");
    expect(s.source?.key).toBe("pl:1");
    expect(p.log).toEqual(["load:2:0"]);
    ev(p, S.BUFFERING);
    expect(getMusic().status).toBe("buffering");
    ev(p, S.PLAYING);
    s = getMusic();
    expect(s.status).toBe("playing");
    // The app's title wins over YouTube's raw one.
    expect(s.now?.title).toBe("Song 2");
    expect(s.index).toBe(2);
  });

  it("pause while loading is honoured when YouTube starts anyway", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    music.toggle();
    expect(getMusic().playing).toBe(false);
    expect(p.log[p.log.length - 1]).toBe("pause");
    p.log.length = 0;
    ev(p, S.PLAYING);
    expect(p.log).toContain("pause");
    expect(getMusic().playing).toBe(false);
  });

  it("next shows the next song at once and ignores the old song's late events", () => {
    music.play({ kind: "videos", label: "L", tracks: list(5), start: 0 });
    ev(p, S.PLAYING);
    music.next();
    music.next();
    expect(getMusic().now?.title).toBe("Song 2");
    expect(p.log.slice(-2)).toEqual(["at:1", "at:2"]);
    // A PLAYING for song 1 arrives late: still song 2 on screen.
    p.index = 1;
    ev(p, S.PLAYING);
    expect(getMusic().now?.title).toBe("Song 2");
    expect(getMusic().status).not.toBe("playing");
    p.index = 2;
    ev(p, S.PLAYING);
    expect(getMusic().status).toBe("playing");
    expect(getMusic().index).toBe(2);
  });

  it("shuffle reorders the app's queue (what is shown is what plays) and never YouTube's", () => {
    const q = list(10);
    music.play({ kind: "videos", label: "L", tracks: q, start: 0 });
    ev(p, S.PLAYING);
    music.setShuffle(true);
    const s = getMusic();
    expect(s.queue[0]).toBe(q[0]);
    expect(s.index).toBe(0);
    expect(p.log.some((l) => l.startsWith("shuffle"))).toBe(false);
    // Clicking the first song under "up next" plays exactly that song.
    p.log.length = 0;
    music.playAt(1);
    expect(getMusic().now?.id).toBe(s.queue[1].id);
    // YouTube's list was the old order: it gets the new one, at that song.
    expect(p.log).toEqual(["load:1:0"]);
    expect(p.ids).toEqual(s.queue.map((t) => t.id));
  });

  it("enqueue does not interrupt the song; YouTube gets the new list at the song's end", () => {
    const q = list(4);
    music.play({ kind: "videos", label: "L", tracks: q, start: 0 });
    ev(p, S.PLAYING);
    p.log.length = 0;
    music.enqueue([tr(50)], "next", "x");
    expect(p.log).toEqual([]);
    expect(getMusic().queue[1].id).toBe(tr(50).id);
    expect(getMusic().now?.title).toBe("Song 0");
    ev(p, S.ENDED);
    expect(getMusic().now?.id).toBe(tr(50).id);
    expect(p.log).toEqual(["load:1:0"]);
  });

  it("a failing song is skipped at once; the last one failing stops with Play shown", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 1 });
    onYtError(150);
    expect(getMusic().now?.title).toBe("Song 2");
    expect(getMusic().toast?.kind).toBe("error");
    p.index = 2;
    onYtError(150);
    const s = getMusic();
    expect(s.playing).toBe(false);
    expect(s.status).toBe("paused");
  });

  it("stops after a lap of failures with repeat on (no endless loop)", () => {
    music.setRepeat(true);
    music.play({ kind: "videos", label: "L", tracks: list(2), start: 0 });
    onYtError(150);
    p.index = 1;
    onYtError(150);
    expect(getMusic().playing).toBe(false);
  });

  it("an error about a song the user already left is ignored", () => {
    music.play({ kind: "videos", label: "L", tracks: list(4), start: 0 });
    music.playAt(3);
    p.index = 0; // YouTube still reports song 0
    onYtError(150);
    expect(getMusic().now?.title).toBe("Song 3");
    expect(getMusic().playing).toBe(true);
  });

  it("commands given before the player is ready are applied when it is", () => {
    __resetMusicForTests();
    music.play({ kind: "videos", label: "L", tracks: list(4), start: 1 });
    music.next();
    music.seek(30);
    const q = fakePlayer();
    attachPlayer(q as unknown as YtLike);
    expect(q.log).toContain("load:2:30");
    expect(getMusic().now?.title).toBe("Song 2");
  });

  it("a mix starts from a random song of the artist's list, with no first-song blip", () => {
    music.play({ kind: "mix" });
    expect(getMusic().status).toBe("loading");
    expect(p.log[0]).toMatch(/^cue:/);
    ev(p, S.CUED);
    const s = getMusic();
    expect(s.queue.length).toBe(10);
    expect(s.index).toBe(0);
    expect(p.log[p.log.length - 1]).toBe("load:0:0");
    expect(p.ids[0]).toBe(s.queue[0].id);
  });

  it("the seek position is held until YouTube catches up", () => {
    vi.useFakeTimers();
    try {
      attachPlayer(p as unknown as YtLike); // its 500 ms tick on the fake clock
      music.play({ kind: "videos", label: "L", tracks: list(2), start: 0 });
      p.time = 10;
      ev(p, S.PLAYING);
      music.seek(100);
      expect(getMusicTime().time).toBe(100);
      vi.advanceTimersByTime(500); // YouTube still says 10
      expect(getMusicTime().time).toBe(100);
      p.time = 100.4;
      vi.advanceTimersByTime(500);
      expect(getMusicTime().time).toBeCloseTo(100.4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a toast never replaces the title; the old notice becomes a toast", () => {
    music.play({ kind: "videos", label: "L", tracks: list(2), start: 0 });
    setMusic({ notice: "Aggiunto" });
    expect(getMusic().toast?.text).toBe("Aggiunto");
    expect(getMusic().now?.title).toBe("Song 0");
  });

  it("the dock rectangle is not in the state; only docked on / off is", () => {
    let n = 0;
    const before = getMusic();
    setDockRect({ x: 1, y: 2, w: 300, h: 200 });
    expect(getMusic().docked).toBe(true);
    const after = getMusic();
    setDockRect({ x: 1.2, y: 2.1, w: 300, h: 200 });
    expect(getMusic()).toBe(after);
    n += before === after ? 1 : 0;
    expect(n).toBe(0);
    setDockRect(null);
    expect(getMusic().docked).toBe(false);
  });
});

describe("errors", () => {
  it("maps HTTP answers to codes", () => {
    expect(errorCode(401, { error: "Log in first." })).toBe("login");
    expect(errorCode(429, { error: "x" })).toBe("quota");
    expect(errorCode(504, { error: "timeout" })).toBe("timeout");
    expect(errorCode(404, null)).toBe("no-functions");
    expect(errorCode(502, null)).toBe("unavailable");
    expect(errorCode(400, { error: "server" })).toBe("server");
    expect(errorCode(502, { error: "youtube" })).toBe("unavailable");
    expect(errorCode(500, { error: "not-found" })).toBe("not-found");
  });
  it("gives a translated message, never the raw text", () => {
    const t = (k: string) => `T(${k})`;
    expect(musicErrorText("quota", t)).toBe("T(music.quota)");
    expect(musicErrorText("Failed to fetch", t)).toBe("T(music.err.server)");
  });
});

describe("network helpers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("shares identical requests in flight and keeps the answer", async () => {
    const f = vi.fn(async () => json({ sections: [{ title: "T", tracks: [] }] }));
    globalThis.fetch = f as unknown as typeof fetch;
    const [a, b] = await Promise.all([fetchExplore(), fetchExplore()]);
    expect(a).toEqual(b);
    await fetchExplore();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("asks Supabase for the token once, not per request", async () => {
    globalThis.fetch = (async () => json({ suggestions: ["a"] })) as unknown as typeof fetch;
    const get = vi.mocked(supabase.auth.getSession);
    get.mockClear();
    await fetchSuggestions("aa");
    await fetchSuggestions("bb");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("an aborted caller gets 'aborted' at once (last request wins)", async () => {
    let release: (r: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((r) => (release = r))) as unknown as typeof fetch;
    const last = lastRequest();
    const first = searchMusic("tiz", { signal: last.next() });
    const second = searchMusic("tiziano", { signal: last.next() });
    expect(await first).toEqual({ error: "aborted" });
    release(json({ tracks: [tr(1)] }));
    expect(await second).toEqual({ tracks: [tr(1)] });
  });

  it("times out instead of spinning", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const r = searchMusic("slow");
    await vi.advanceTimersByTimeAsync(13000);
    expect(await r).toEqual({ error: "timeout" });
  });

  it("maps a server error code and keeps a definite failure briefly", async () => {
    const f = vi.fn(async () => json({ error: "quota" }, 429));
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await searchMusic("q1")).toEqual({ error: "quota" });
    expect(await searchMusic("q1")).toEqual({ error: "quota" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("review fixes", () => {
  it("F1: a play started in YouTube's frame (or a media key) is followed, not undone", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    music.toggle(); // the app's pause
    ev(p, S.PAUSED); // YouTube confirms
    p.log.length = 0;
    ev(p, S.BUFFERING); // the user taps Play inside the frame
    expect(p.log).not.toContain("pause");
    expect(getMusic().playing).toBe(true);
    expect(getMusic().status).toBe("buffering");
    ev(p, S.PLAYING);
    expect(p.log).not.toContain("pause");
    expect(getMusic().status).toBe("playing");
    expect(getMusic().now?.title).toBe("Song 0");
  });

  it("F1: a start from the frame after an autoplay block is followed too", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    setMusic({ playing: false, status: "paused" }); // as armBlocked does
    p.log.length = 0;
    ev(p, S.PLAYING);
    expect(p.log).not.toContain("pause");
    expect(getMusic().playing).toBe(true);
  });

  it("F1: the app's own pause still wins over a slow load starting later", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    music.toggle();
    p.log.length = 0;
    ev(p, S.BUFFERING);
    expect(p.log).toContain("pause");
    ev(p, S.PLAYING);
    expect(getMusic().playing).toBe(false);
  });

  it("F5: two volume moves in one frame while muted still unmute YouTube", () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
    try {
      music.setMuted(true);
      p.log.length = 0;
      music.setVolume(30);
      music.setVolume(40);
      frames.forEach((f) => f());
      expect(p.log).toEqual(["vol:40", "unmute"]);
      expect(getMusic().muted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("F6: a new selector is run again on the same state; an equal value keeps its reference", () => {
    const s = getMusic();
    const last: { current: SelMemo<string> | null } = { current: null };
    const label = (lang: string) => (st: MusicState) => `${lang}:${st.view}`;
    expect(selectMemo(last, s, label("it"))).toBe("it:closed");
    // Same state, new closure (the language changed): not the stale value.
    expect(selectMemo(last, s, label("en"))).toBe("en:closed");
    const objs: { current: SelMemo<{ v: string }> | null } = { current: null };
    const a = selectMemo(objs, s, (st) => ({ v: st.view }), (x, y) => x.v === y.v);
    const b = selectMemo(objs, s, (st) => ({ v: st.view }), (x, y) => x.v === y.v);
    expect(b).toBe(a);
  });

  it("F7: a title filled in by YouTube keeps the shuffled and original orders in step", () => {
    const q = list(6).map((t) => ({ id: t.id, title: "", channel: "" }));
    music.setShuffle(true);
    music.play({ kind: "videos", label: "L", tracks: q, start: 2 });
    const shuffledQ = getMusic().queue;
    p.ids = shuffledQ.map((t) => t.id);
    p.index = 0;
    ev(p, S.PLAYING);
    expect(getMusic().queue[0].title).toMatch(/^YT raw/);
    music.enqueue([tr(50)], "next", "x");
    music.setShuffle(false);
    const s = getMusic();
    // Back at the same song, with its title, and the added song right after it.
    expect(s.queue[s.index].id).toBe(q[2].id);
    expect(s.queue[s.index].title).toMatch(/^YT raw/);
    expect(s.queue[s.index + 1].id).toBe(tr(50).id);
  });
});
