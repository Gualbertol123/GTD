// "Importa da Spotify" past the first 100 songs: the official Web API with the
// site's own keys (netlify/lib/spotify.mts), the fallback to the public embed
// page, and songs pasted from the Spotify app (one track link per line).
// Every network call is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
    },
  },
}));

import { MAX_SONGS, entityOf, forgetSpotify, pageOffsets, readSpotify, readSpotifyTrack, songFromEntity } from "../../../netlify/lib/spotify.mts";
import { isSpotifyTrackList, parseSpotifyTracks } from "../music";

const PL = "3cEYpjA9oz9GiPac4AsH4n"; // a user's playlist id (22 chars)
const OWNED = "37i9dQZF1DXcBWIGoYBM5M"; // a Spotify editorial playlist id
const TRACK = "4uLU6hMCjMI75M1A2tKUQC";

/**
 * The public embed page of one track (open.spotify.com/embed/track/…), trimmed
 * to the part that is read: __NEXT_DATA__ → props.pageProps.state.data.entity.
 */
const TRACK_EMBED = {
  props: {
    pageProps: {
      state: {
        data: {
          entity: {
            type: "track",
            name: "Never Gonna Give You Up",
            uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
            id: "4uLU6hMCjMI75M1A2tKUQC",
            title: "Never Gonna Give You Up",
            artists: [{ name: "Rick Astley", uri: "spotify:artist:0gxyHStUsqpMadRV0Di1Qt" }],
            duration: 213573,
            isPlayable: true,
          },
        },
      },
    },
  },
};

const page = (data: unknown) => `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;

/** A playlist's embed page with `n` songs. */
const playlistEmbed = (n: number) =>
  page({
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name: "Embed list",
              subtitle: "Spotify",
              coverArt: { sources: [{ url: "https://i/small", width: 60 }, { url: "https://i/big", width: 640 }] },
              trackList: Array.from({ length: n }, (_, i) => ({ title: `Song ${i}`, subtitle: "Artist", duration: 1000 + i })),
            },
          },
        },
      },
    },
  });

const ok = (body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });

/** Fake Spotify: token, Web API (playlist of `total` songs) and embed pages. */
function fakeSpotify(opts: { total?: number; apiStatus?: number; embedSongs?: number } = {}) {
  const total = opts.total ?? 250;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === "accounts.spotify.com") {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toBe("grant_type=client_credentials");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
      return ok({ access_token: "app-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (u.host === "api.spotify.com") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-token");
      if (opts.apiStatus) return new Response("{}", { status: opts.apiStatus });
      const tracks = u.pathname.endsWith("/tracks");
      if (!tracks) return ok({ name: "API list", owner: { display_name: "Ann" }, images: [{ url: "https://i/a", width: 300 }, { url: "https://i/b", width: 640 }], tracks: { total } });
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => {
        const i = offset + k;
        // A local file, an episode and an empty slot are skipped.
        if (i === 1) return { is_local: true, track: { name: "Local", duration_ms: 1, artists: [], type: "track" } };
        if (i === 2) return { is_local: false, track: { name: "Podcast", duration_ms: 1, artists: [], type: "episode" } };
        if (i === 3) return { is_local: false, track: null };
        return { is_local: false, track: { name: `Song ${i}`, duration_ms: 1000 + i, artists: [{ name: "A" }, { name: "B" }], type: "track" } };
      });
      return ok({ items, total, next: null });
    }
    if (u.host === "open.spotify.com") {
      if (u.pathname.startsWith("/embed/track/")) return ok(page(TRACK_EMBED));
      return ok(playlistEmbed(opts.embedSongs ?? 100));
    }
    throw new Error(`unexpected ${u}`);
  });
}

const apiCalls = (f: ReturnType<typeof fakeSpotify>, host: string) => f.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.host === host);

describe("parseSpotifyTracks", () => {
  it("finds track ids in pasted text: links, ?si=, intl paths, URIs; unique, in order", () => {
    const text = [
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      "https://open.spotify.com/intl-it/track/7GhIk7Il098yCjg4BQjzvb?si=abc123",
      "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
      "some junk line",
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", // not a track
      "https://open.spotify.com/track/short", // not an id
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=again", // duplicate
      "",
      "https://open.spotify.com/embed/track/1301WleyT98MSxVHPZCA6M",
    ].join("\r\n");
    expect(parseSpotifyTracks(text)).toEqual(["4uLU6hMCjMI75M1A2tKUQC", "7GhIk7Il098yCjg4BQjzvb", "0VjIjW4GlUZAMYd2vXMi3b", "1301WleyT98MSxVHPZCA6M"]);
  });

  it("still finds them when a one-line field glued the lines together", () => {
    const glued = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQChttps://open.spotify.com/track/7GhIk7Il098yCjg4BQjzvb?si=xhttps://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b";
    expect(parseSpotifyTracks(glued)).toEqual(["4uLU6hMCjMI75M1A2tKUQC", "7GhIk7Il098yCjg4BQjzvb", "0VjIjW4GlUZAMYd2vXMi3b"]);
  });

  it("a pasted list is 2+ track links", () => {
    expect(isSpotifyTrackList("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toBe(false);
    expect(isSpotifyTrackList("spotify:track:4uLU6hMCjMI75M1A2tKUQC\nspotify:track:7GhIk7Il098yCjg4BQjzvb")).toBe(true);
    expect(isSpotifyTrackList("hello\nworld")).toBe(false);
    expect(parseSpotifyTracks("")).toEqual([]);
  });
});

describe("readSpotify with the site's keys (Web API)", () => {
  beforeEach(() => {
    forgetSpotify();
    vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads every page (total 250 → 3 pages) in order, skipping local files, episodes and empty slots", async () => {
    const f = fakeSpotify({ total: 250 });
    vi.stubGlobal("fetch", f);
    const list = await readSpotify("playlist", PL);
    expect(list).toMatchObject({ kind: "playlist", id: PL, name: "API list", owner: "Ann", cover: "https://i/b", via: "api", total: 250 });
    expect(list.limited).toBeUndefined();
    expect(list.truncated).toBeUndefined();
    expect(list.songs).toHaveLength(247);
    expect(list.songs[0]).toEqual({ title: "Song 0", artist: "A, B", ms: 1000 });
    expect(list.songs.map((s) => s.title).slice(0, 3)).toEqual(["Song 0", "Song 4", "Song 5"]);
    expect(list.songs[list.songs.length - 1].title).toBe("Song 249");
    const pages = apiCalls(f, "api.spotify.com").filter((u) => u.pathname.endsWith("/tracks"));
    expect(pages.map((u) => u.searchParams.get("offset")).sort()).toEqual(["0", "100", "200"]);
    expect(pages[0].searchParams.get("limit")).toBe("100");
    expect(pages[0].searchParams.get("fields")).toContain("items(is_local,track(name,duration_ms,artists(name),type))");
    expect(apiCalls(f, "open.spotify.com")).toHaveLength(0); // no embed page needed
  });

  it("asks for the token once and reuses it", async () => {
    const f = fakeSpotify({ total: 120 });
    vi.stubGlobal("fetch", f);
    await readSpotify("playlist", PL);
    await readSpotify("playlist", "0000000000000000000000"); // another list: new API calls, same token
    expect(apiCalls(f, "accounts.spotify.com")).toHaveLength(1);
    expect(apiCalls(f, "api.spotify.com").length).toBeGreaterThanOrEqual(6);
  });

  it("caps at 1000 songs and says so", async () => {
    const f = fakeSpotify({ total: 1500 });
    vi.stubGlobal("fetch", f);
    const list = await readSpotify("playlist", PL);
    expect(list).toMatchObject({ via: "api", total: 1500, truncated: true });
    expect(list.songs.length).toBeLessThanOrEqual(MAX_SONGS);
    const pages = apiCalls(f, "api.spotify.com").filter((u) => u.pathname.endsWith("/tracks"));
    expect(pages).toHaveLength(10);
    expect(pageOffsets(1500, 100).slice(-1)[0]).toBe(900);
    expect(pageOffsets(250, 100)).toEqual([0, 100, 200]);
    expect(pageOffsets(0, 100)).toEqual([]);
  });

  it("a Spotify-owned playlist (404 for new apps) falls back to the embed page, limited", async () => {
    const f = fakeSpotify({ apiStatus: 404, embedSongs: 100 });
    vi.stubGlobal("fetch", f);
    const list = await readSpotify("playlist", OWNED);
    expect(list).toMatchObject({ via: "embed", limited: true, reason: "spotify-owned", name: "Embed list", cover: "https://i/big" });
    expect(list.songs).toHaveLength(100);
    expect(apiCalls(f, "open.spotify.com")[0].pathname).toBe(`/embed/playlist/${OWNED}`);
  });

  it("another API failure falls back too, as api-error", async () => {
    vi.stubGlobal("fetch", fakeSpotify({ apiStatus: 500, embedSongs: 100 }));
    expect(await readSpotify("playlist", PL)).toMatchObject({ via: "embed", limited: true, reason: "api-error" });
  });

  it("reads an album with its own pages of 50", async () => {
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.host === "accounts.spotify.com") return ok({ access_token: "app-token", expires_in: 3600 });
      if (u.pathname.endsWith("/tracks")) {
        const offset = Number(u.searchParams.get("offset"));
        return ok({ items: Array.from({ length: Math.min(50, 70 - offset) }, (_, k) => ({ name: `T${offset + k}`, duration_ms: 5, artists: [{ name: "X" }], type: "track" })) });
      }
      return ok({ name: "Album", artists: [{ name: "X" }, { name: "Y" }], images: [{ url: "https://i/c", width: 640 }], tracks: { total: 70 } });
    });
    vi.stubGlobal("fetch", f);
    const list = await readSpotify("album", PL);
    expect(list).toMatchObject({ kind: "album", name: "Album", owner: "X, Y", via: "api", total: 70 });
    expect(list.songs.map((s) => s.title)).toEqual(Array.from({ length: 70 }, (_, i) => `T${i}`));
  });
});

describe("readSpotify without keys", () => {
  beforeEach(() => {
    forgetSpotify();
    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads the embed page, limited with reason no-key (and never calls the API)", async () => {
    const f = fakeSpotify({ embedSongs: 100 });
    vi.stubGlobal("fetch", f);
    const list = await readSpotify("playlist", PL);
    expect(list).toMatchObject({ via: "embed", limited: true, reason: "no-key" });
    expect(list.songs[0]).toEqual({ title: "Song 0", artist: "Artist", ms: 1000 });
    expect(apiCalls(f, "accounts.spotify.com")).toHaveLength(0);
    expect(apiCalls(f, "api.spotify.com")).toHaveLength(0);
  });

  it("a short playlist is complete: not limited", async () => {
    vi.stubGlobal("fetch", fakeSpotify({ embedSongs: 12 }));
    const list = await readSpotify("playlist", PL);
    expect(list).toMatchObject({ via: "embed", reason: "no-key" });
    expect(list.limited).toBeUndefined();
  });
});

describe("pasted songs: one track's embed page", () => {
  beforeEach(() => forgetSpotify());
  afterEach(() => vi.unstubAllGlobals());

  it("reads title, artists and length from __NEXT_DATA__", () => {
    expect(songFromEntity(entityOf(page(TRACK_EMBED)))).toEqual({ title: "Never Gonna Give You Up", artist: "Rick Astley", ms: 213573 });
    expect(songFromEntity({ type: "episode", title: "A podcast" })).toBeNull();
    expect(() => entityOf("<html>changed</html>")).toThrow("spotify-changed");
  });

  it("fetches the public embed page once per id (cached)", async () => {
    const f = fakeSpotify();
    vi.stubGlobal("fetch", f);
    const a = await readSpotifyTrack(TRACK, 3000);
    const b = await readSpotifyTrack(TRACK, 3000);
    expect(a).toEqual(b);
    expect(a.artist).toBe("Rick Astley");
    const calls = apiCalls(f, "open.spotify.com");
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe(`/embed/track/${TRACK}`);
    expect(apiCalls(f, "api.spotify.com")).toHaveLength(0);
  });
});

describe("music-spotify POST { tracks }", () => {
  afterEach(() => {
    vi.doUnmock("../../../netlify/lib/ytjs.mts");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("answers one song or null per id, with failures in `failed`", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon");
    vi.doMock("../../../netlify/lib/ytjs.mts", () => ({ matchSong: async () => null }));
    const BAD = "0000000000000000000404";
    const DOWN = "0000000000000000000500";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = String(input);
        if (u.includes("supabase.test")) return new Response("true", { status: 200 });
        if (u.endsWith(BAD)) return new Response("", { status: 404 });
        if (u.endsWith(DOWN)) return new Response("", { status: 500 });
        return ok(page(TRACK_EMBED));
      })
    );
    const fn = (await import("../../../netlify/functions/music-spotify.mts")).default;
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
    const res = await fn(
      new Request("http://x/", { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify({ tracks: [TRACK, "not-an-id", BAD, DOWN] }) })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      songs: [{ title: "Never Gonna Give You Up", artist: "Rick Astley", ms: 213573 }, null, null, null],
      failed: [3],
    });
  });
});
