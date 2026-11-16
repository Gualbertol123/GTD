import { beforeEach, describe, expect, it, vi } from "vitest";

// Spotify mode with a sign-in older than an hour: the token is refreshed
// BEFORE Spotify's SDK or Web API get it. A fake SDK, a mocked refresh and a
// mocked api.spotify.com: nothing here reaches Spotify.

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
  g.window = globalThis;
  g.fetch = async (url: unknown) => {
    throw new Error("tests never reach the network: " + String(url));
  };
  const tokens: string[] = [];
  const refresh = { calls: 0 };
  class FakePlayer {
    static last: FakePlayer | null = null;
    listeners: Record<string, (a: unknown) => void> = {};
    constructor(public opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void }) {
      FakePlayer.last = this;
    }
    addListener(ev: string, cb: (a: unknown) => void) {
      this.listeners[ev] = cb;
      return true;
    }
    connect() {
      // Like the SDK: it asks for a token, then says ready (or authentication_error for a dead one).
      this.opts.getOAuthToken((t) => {
        tokens.push(t);
        if (t === "old-token") this.listeners.authentication_error?.({ message: "invalid token" });
        else this.listeners.ready?.({ device_id: "dev1" });
      });
      return Promise.resolve(true);
    }
    disconnect() {}
    getCurrentState() {
      return Promise.resolve(null);
    }
    setVolume() {
      return Promise.resolve();
    }
    pause() {
      return Promise.resolve();
    }
    resume() {
      return Promise.resolve();
    }
    seek() {
      return Promise.resolve();
    }
    nextTrack() {
      return Promise.resolve();
    }
    previousTrack() {
      return Promise.resolve();
    }
    activateElement() {
      return Promise.resolve();
    }
  }
  g.Spotify = { Player: FakePlayer };
  return { tokens, refresh, FakePlayer };
});

vi.mock("../supabaseClient", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })), onAuthStateChange: vi.fn() } },
}));
vi.mock("../spotifyAuth", async (orig) => {
  const real = await orig<typeof import("../spotifyAuth")>();
  return {
    ...real,
    refreshSpotifyToken: vi.fn(async () => {
      env.refresh.calls++;
      sessionStorage.setItem("gtd-spotify-token", JSON.stringify({ access: "new-token", refresh: "r", exp: Date.now() + 3600_000 }));
      real.forgetSpotifyAuth();
      return "new-token";
    }),
  };
});

import { __resetMusicForTests, attachPlayer, getMusic, music, type YtLike } from "../music";
import { __resetSpotifyForTests, freshSpotifyToken, spApi } from "../spotifyPlayer";
import { forgetSpotifyAuth } from "../spotifyAuth";

const auths: string[] = [];

function signInHoursAgo(expiresInMs: number) {
  sessionStorage.setItem("gtd-spotify-token", JSON.stringify({ access: "old-token", refresh: "r", exp: Date.now() + expiresInMs }));
  forgetSpotifyAuth();
}

function fakeYt(): YtLike {
  const noop = () => {};
  return {
    loadPlaylist: noop,
    cuePlaylist: noop,
    playVideo: noop,
    pauseVideo: noop,
    stopVideo: noop,
    nextVideo: noop,
    playVideoAt: noop,
    seekTo: noop,
    setVolume: noop,
    mute: noop,
    unMute: noop,
    setLoop: noop,
    getPlaylist: () => [],
    getPlaylistIndex: () => 0,
    getPlayerState: () => -1,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    getVolume: () => 80,
    isMuted: () => false,
    getVideoData: () => ({ video_id: "", title: "", author: "" }),
  } as unknown as YtLike;
}

beforeEach(() => {
  __resetMusicForTests();
  __resetSpotifyForTests();
  sessionStorage.clear();
  localStorage.clear();
  forgetSpotifyAuth();
  env.tokens.length = 0;
  env.refresh.calls = 0;
  auths.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (new URL(url).hostname !== "api.spotify.com") throw new Error("only api.spotify.com is mocked");
    auths.push(String((init.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});

describe("an expired Spotify sign-in is refreshed before use", () => {
  it("a token with an hour left is used as it is", async () => {
    signInHoursAgo(3600_000);
    expect(await freshSpotifyToken()).toBe("old-token");
    expect(env.refresh.calls).toBe(0);
  });

  it("a token that ran out (or runs out within a minute) is refreshed first, for the Web API too", async () => {
    signInHoursAgo(-5 * 60_000);
    await spApi("GET", "/me/player");
    expect(env.refresh.calls).toBe(1);
    expect(auths).toEqual(["Bearer new-token"]);
    signInHoursAgo(30_000);
    expect(await freshSpotifyToken()).toBe("new-token");
    expect(env.refresh.calls).toBe(2);
  });

  it("the Spotify switch after an hour: the SDK gets the refreshed token, so Spotify mode does not end with 'sign in again'", async () => {
    signInHoursAgo(-60_000);
    attachPlayer(fakeYt());
    music.setEngine("spotify");
    await vi.waitFor(() => expect(env.tokens).toEqual(["new-token"]));
    expect(getMusic().engine).toBe("spotify");
    expect(getMusic().toast).toBeNull();
  });
});
