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
  ytWindowStart,
  YT_MAX,
  attachPlayer,
  errorCode,
  fetchExplore,
  fetchSuggestions,
  getMusic,
  musicLog,
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

/**
 * A YouTube player that records commands; tests send its events by hand. Like
 * the real one, it keeps at most 200 ids, drops the ids in `drop` (ones that
 * do not exist) from its own list, and its index counts in that list.
 */
function fakePlayer() {
  const log: string[] = [];
  const p = {
    ids: [] as string[],
    index: 0,
    state: S.UNSTARTED as number,
    time: 0,
    listReady: true,
    muted: false,
    /** A phone that refuses unMute from a script. */
    refuseUnmute: false,
    drop: new Set<string>(),
    duration: 200,
    log,
    loadPlaylist(arg: unknown, index = 0, start = 0) {
      log.push(`load:${index}:${start}`);
      if (Array.isArray(arg)) this.ids = (arg as string[]).filter((id) => !this.drop.has(id)).slice(0, 200);
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
    mute() {
      log.push("mute");
      this.muted = true;
    },
    unMute() {
      log.push("unmute");
      if (!this.refuseUnmute) this.muted = false;
    },
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
    getDuration() {
      return this.duration;
    },
    getVolume: () => 80,
    isMuted() {
      return this.muted;
    },
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

describe("real YouTube behaviour (the 'loop playing, no sound' report)", () => {
  /** Fake clock (timers and performance.now), with the player's tick on it. */
  function clock() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    __resetMusicForTests();
    p = fakePlayer();
    attachPlayer(p as unknown as YtLike);
    p.log.length = 0;
  }
  afterEach(() => vi.useRealTimers());
  const run = (ms: number) => vi.advanceTimersByTime(ms);
  /** YouTube plays: the second moves for `ms`. */
  function playFor(ms: number) {
    for (let k = 0; k < ms; k += 500) {
      p.time += 0.5;
      run(500);
    }
  }

  it("YouTube's list differs from the app's (a dropped id): the app follows the song YouTube really plays", () => {
    const q = list(5);
    p.drop.add(q[2].id); // YouTube silently drops song 2
    music.play({ kind: "videos", label: "L", tracks: q, start: 0 });
    ev(p, S.PLAYING);
    p.log.length = 0;
    music.next();
    // YouTube's real list is not the queue: no index jump, the list is given again.
    expect(p.log).toEqual(["load:1:0"]);
    onYtError(150); // song 1 cannot play: on to song 2...
    expect(getMusic().now?.id).toBe(q[2].id);
    // ...but YouTube, without song 2, is at song 3: that is followed, not ignored.
    expect(p.getVideoData().video_id).toBe(q[3].id);
    ev(p, S.UNSTARTED);
    ev(p, S.PLAYING);
    expect(getMusic().status).toBe("playing");
    expect(getMusic().index).toBe(3);
    expect(getMusic().now?.title).toBe("Song 3");
  });

  it("an error on an entry ahead of the one asked for skips on from there (no dead end)", () => {
    const q = list(6);
    p.drop.add(q[2].id);
    music.play({ kind: "videos", label: "L", tracks: q, start: 1 });
    onYtError(150); // song 1 fails; app asks for 2, YouTube is at 3
    expect(getMusic().index).toBe(2);
    onYtError(150); // song 3 fails too
    const s = getMusic();
    expect(s.index).toBe(4);
    expect(s.now?.id).toBe(q[4].id);
    expect(s.playing).toBe(true);
  });

  it("a late event about the song the app left is still ignored", () => {
    music.play({ kind: "videos", label: "L", tracks: list(5), start: 0 });
    ev(p, S.PLAYING);
    music.playAt(3);
    p.index = 0; // YouTube still reports song 0
    ev(p, S.PLAYING);
    expect(getMusic().now?.title).toBe("Song 3");
    expect(getMusic().status).toBe("loading");
  });

  it("a queue longer than 200 is given as a 200-id window holding the song", () => {
    expect(ytWindowStart(150, 120)).toBe(0);
    expect(ytWindowStart(250, 220)).toBe(50);
    expect(ytWindowStart(250, 10)).toBe(10);
    const q = list(250);
    music.play({ kind: "videos", label: "L", tracks: q, start: 220 });
    expect(p.ids.length).toBeLessThanOrEqual(YT_MAX);
    expect(p.getVideoData().video_id).toBe(q[220].id);
    ev(p, S.PLAYING);
    expect(getMusic().index).toBe(220);
    // A jump inside the window is a jump in YouTube's list, at its own index.
    p.log.length = 0;
    music.playAt(230);
    expect(p.log).toEqual(["at:180"]);
    ev(p, S.PLAYING);
    expect(getMusic().index).toBe(230);
    // A song before the window: a new window.
    music.playAt(5);
    expect(p.getVideoData().video_id).toBe(q[5].id);
    // At the window's end YouTube cannot move on by itself: the next window is loaded.
    music.playAt(204);
    ev(p, S.PLAYING);
    expect(p.getVideoData().video_id).toBe(q[204].id);
  });

  it("a song ended inside the window: YouTube moves on by itself, nothing is reloaded", () => {
    clock();
    const q = list(250);
    music.play({ kind: "videos", label: "L", tracks: q, start: 220 });
    ev(p, S.PLAYING);
    p.log.length = 0;
    ev(p, S.ENDED);
    p.index++; // YouTube moves on
    ev(p, S.UNSTARTED);
    ev(p, S.PLAYING);
    expect(p.log.filter((l) => l.startsWith("load") || l.startsWith("at"))).toEqual([]);
    expect(getMusic().index).toBe(221);
    expect(getMusic().status).toBe("playing");
  });

  it("ENDED without a move-on: the list is given again, then the app gives up (no forever spinner)", () => {
    clock();
    const q = list(3);
    music.play({ kind: "videos", label: "L", tracks: q, start: 0 });
    ev(p, S.PLAYING);
    p.log.length = 0;
    ev(p, S.ENDED); // YouTube stays at the end
    expect(getMusic().now?.id).toBe(q[1].id);
    expect(getMusic().status).toBe("loading");
    run(4000);
    expect(p.log).toContain("load:1:0");
    p.state = S.UNSTARTED; // and nothing starts
    run(7000);
    const s = getMusic();
    expect(s.playing).toBe(false);
    expect(s.status).toBe("paused");
    expect(s.needsTap).toBe(true);
    expect(p.log).not.toContain("pause");
  });

  it("BUFFERING forever: one more wait, then paused with YouTube's frame; never pauses YouTube", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.BUFFERING);
    run(6100);
    expect(getMusic().playing).toBe(true); // slow network: waits more
    expect(getMusic().status).toBe("buffering");
    run(8000);
    let s = getMusic();
    expect(s.playing).toBe(false);
    expect(s.status).toBe("paused");
    expect(s.needsTap).toBe(true);
    expect(s.toast?.text).toBe("music.stalled");
    expect(p.log).not.toContain("pause");
    // Still buffering: the app does not flip back to a spinner.
    ev(p, S.BUFFERING);
    expect(getMusic().playing).toBe(false);
    // A late start is followed; once the second moves the frame steps back.
    ev(p, S.PLAYING);
    expect(getMusic().playing).toBe(true);
    expect(getMusic().status).toBe("playing");
    playFor(2000);
    s = getMusic();
    expect(s.needsTap).toBe(false);
    expect(p.log).not.toContain("pause");
  });

  it("autoplay refused silently (UNSTARTED): paused + frame after 6 s; Play is checked again, bounded", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.UNSTARTED);
    run(6100);
    expect(getMusic().status).toBe("paused");
    expect(getMusic().needsTap).toBe(true);
    expect(getMusic().toast?.text).toBe("music.tapToPlay");
    // The app's Play: sent again, and checked again (shorter), never a forever spinner.
    p.log.length = 0;
    music.toggle();
    expect(p.log).toContain("play");
    expect(getMusic().status).toBe("loading");
    run(3100);
    expect(getMusic().status).toBe("paused");
    expect(getMusic().needsTap).toBe(true);
    // The tap inside YouTube's frame: followed once it plays.
    ev(p, S.BUFFERING);
    expect(getMusic().playing).toBe(false);
    ev(p, S.PLAYING);
    playFor(1500);
    expect(getMusic().playing).toBe(true);
    expect(getMusic().status).toBe("playing");
    expect(getMusic().needsTap).toBe(false);
  });

  it("Next/Prev: YouTube's PAUSED while it leaves the old song is not a refusal (real log)", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(5), start: 0 });
    ev(p, S.PLAYING);
    playFor(1000);
    music.next();
    // Real order seen on a desktop: PAUSED (old song), UNSTARTED, BUFFERING, PLAYING.
    ev(p, S.PAUSED);
    let s = getMusic();
    expect(s.playing).toBe(true);
    expect(s.status).toBe("loading");
    expect(s.needsTap).toBe(false);
    expect(s.toast).toBeNull();
    ev(p, S.UNSTARTED);
    ev(p, S.BUFFERING);
    ev(p, S.PLAYING);
    s = getMusic();
    expect(s.status).toBe("playing");
    expect(s.index).toBe(1);
    expect(s.needsTap).toBe(false);
  });

  it("a real refusal (YouTube stays PAUSED) is still caught by the start check", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.UNSTARTED);
    ev(p, S.PAUSED);
    expect(getMusic().status).toBe("loading");
    run(6100);
    const s = getMusic();
    expect(s.playing).toBe(false);
    expect(s.status).toBe("paused");
    expect(s.needsTap).toBe(true);
    expect(s.toast?.text).toBe("music.tapToPlay");
    expect(p.log).not.toContain("pause");
  });

  it("stuck reloading in the middle of a song: nudge, reload at the same second, new player; never pauses (real log)", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    playFor(1500);
    const at = p.time;
    // YouTube reloads the song and stays stuck.
    ev(p, S.BUFFERING);
    p.log.length = 0;
    run(6100);
    // Step 1: nudge at the same point, and say why.
    expect(p.log).toContain(`seek:${at - 0.5}`);
    expect(getMusic().toast?.text).toBe("music.slowNetwork");
    expect(getMusic().status).toBe("buffering");
    run(8100);
    // Step 2: the song again, at the same second (a new stream connection).
    expect(p.log.some((l) => l.startsWith("load:") && l.endsWith(`:${at - 0.5}`))).toBe(true);
    const before = getMusic().rebuild;
    run(10100);
    // Step 3 (last resort): a new YouTube player is asked for.
    expect(getMusic().rebuild).toBe(before + 1);
    let s = getMusic();
    expect(s.playing).toBe(true);
    expect(s.needsTap).toBe(false);
    expect(p.log).not.toContain("pause");
    expect(p.log).not.toContain("stop");
    // It plays on: the ladder starts over.
    ev(p, S.PLAYING);
    playFor(2000);
    s = getMusic();
    expect(s.status).toBe("playing");
    expect(musicLog.some((e) => e.ev.startsWith("rescue worked"))).toBe(true);
  });

  it("slow but moving: no rescue", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    playFor(1500);
    ev(p, S.BUFFERING);
    p.log.length = 0;
    for (let k = 0; k < 20; k++) {
      p.time += 0.3;
      run(1000);
    }
    expect(p.log.filter((l) => l.startsWith("seek") || l.startsWith("load"))).toEqual([]);
  });

  it("a page in the background never gives up a start", () => {
    clock();
    const g = globalThis as unknown as { document?: unknown };
    const had = g.document;
    g.document = { hidden: true };
    try {
      music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
      ev(p, S.UNSTARTED);
      run(30000);
      expect(getMusic().playing).toBe(true);
      expect(getMusic().needsTap).toBe(false);
    } finally {
      g.document = had;
    }
  });

  it("Next on the last song says so instead of doing nothing", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 2 });
    ev(p, S.PLAYING);
    music.next();
    const s = getMusic();
    expect(s.index).toBe(2);
    expect(s.toast?.text).toBe("music.lastSong");
  });

  it("PAUSED right after a quick Pause then Play is the pause's echo: ignored", () => {
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    music.toggle();
    music.toggle();
    ev(p, S.PAUSED);
    expect(getMusic().playing).toBe(true);
    expect(getMusic().needsTap).toBe(false);
  });

  it("a pause pressed during buffering is honoured; no give-up later", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.BUFFERING);
    music.toggle();
    expect(getMusic().playing).toBe(false);
    run(8000); // past the start check
    expect(getMusic().needsTap).toBe(false);
    expect(getMusic().toast).toBeNull();
    p.log.length = 0;
    ev(p, S.PLAYING);
    expect(p.log).toContain("pause");
    expect(getMusic().playing).toBe(false);
  });

  it("starting muted: the app's sound setting wins in audio mode; refused twice, the frame is shown", () => {
    clock();
    __resetMusicForTests();
    p = fakePlayer();
    p.muted = true; // YouTube starts muted
    attachPlayer(p as unknown as YtLike);
    expect(p.muted).toBe(false);
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    // YouTube mutes itself again (muted autoplay) and refuses a script's unMute.
    p.muted = true;
    p.refuseUnmute = true;
    p.log.length = 0;
    playFor(1000);
    expect(p.log).toContain("unmute");
    expect(getMusic().muted).toBe(false);
    playFor(1000);
    expect(getMusic().needsTap).toBe(true);
    expect(getMusic().toast?.text).toBe("music.tapToUnmute");
    // The frame stays while YouTube is muted, though the second moves.
    playFor(3000);
    expect(getMusic().needsTap).toBe(true);
    // The user taps unmute in the frame: it steps back.
    p.muted = false;
    playFor(1500);
    expect(getMusic().needsTap).toBe(false);
  });

  it("in video mode a mute from YouTube's own controls is followed", () => {
    clock();
    music.setMode("video");
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    ev(p, S.PLAYING);
    p.muted = true;
    playFor(2000);
    expect(getMusic().muted).toBe(true);
  });

  it("PLAYING with a frozen second: nudge, reload at that second, new player; never pauses or destroys", () => {
    clock();
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    p.time = 42;
    ev(p, S.PLAYING);
    p.log.length = 0;
    run(12000);
    expect(p.log).toContain("seek:41.5");
    expect(getMusic().status).toBe("buffering");
    p.state = S.PLAYING; // YouTube says PLAYING again, still stuck
    run(12000);
    expect(p.log).toContain("load:0:41.5");
    p.state = S.PLAYING;
    const before = getMusic().rebuild;
    run(12000);
    expect(getMusic().rebuild).toBe(before + 1);
    const s = getMusic();
    expect(s.playing).toBe(true);
    expect(p.log).not.toContain("pause");
    expect(p.log).not.toContain("stop");
    // A real resume is followed.
    p.state = S.PLAYING;
    playFor(3000);
    expect(getMusic().playing).toBe(true);
    expect(getMusic().status).toBe("playing");
  });

  it("a YouTube list that never gives its ids stops waiting and plays as YouTube has it", () => {
    clock();
    p.listReady = false;
    music.play({ kind: "list", label: "L", list: "PLxxxxxxxxxxxx" });
    p.log.length = 0;
    run(10500);
    expect(p.log).toContain("play");
    // No forever spinner: if it never starts, the app gives up.
    run(7000);
    expect(getMusic().status).toBe("paused");
    expect(getMusic().needsTap).toBe(true);
    // A later Play sends playVideo (not stuck on the adopt wait).
    p.log.length = 0;
    music.toggle();
    expect(p.log).toContain("play");
  });

  it("a new play clears needsTap; the user's Pause clears it too", () => {
    setMusic({ needsTap: true });
    music.play({ kind: "videos", label: "L", tracks: list(3), start: 0 });
    expect(getMusic().needsTap).toBe(false);
    setMusic({ needsTap: true });
    music.toggle();
    expect(getMusic().needsTap).toBe(false);
  });

  it("the queue shown stays the order played after YouTube moves on by itself", () => {
    const q = list(5);
    p.drop.add(q[1].id);
    music.play({ kind: "videos", label: "L", tracks: q, start: 0 });
    ev(p, S.PLAYING);
    ev(p, S.ENDED); // YouTube's list lacks song 1: the app gives it the queue again
    // YouTube (without song 1) is at song 2: the app moves there, queue untouched.
    ev(p, S.PLAYING);
    expect(getMusic().queue.map((t) => t.id)).toEqual(q.map((t) => t.id));
    expect(getMusic().index).toBe(2);
  });
});
