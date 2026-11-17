// "La mia libreria Spotify" (lib/spotifyLibrary.ts): paging (liked songs past
// 50, the 2000 cap), the details-only playlist, 401 → one refresh, the 429
// message, Spotify track → Track keeping the Spotify id, the artist albums
// refused gracefully, search paging. Every call to Spotify is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_EN, TAB_IT } from "../i18n.music.tab";

vi.mock("../supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
    },
  },
}));

const id22 = (n: number | string) => `T${String(n)}`.padEnd(22, "x").slice(0, 22);
const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
const apiTrack = (n: number) => ({
  id: id22(n),
  name: `Song ${n}`,
  duration_ms: 200000 + n,
  artists: [{ name: "Artist A" }, { name: "Artist B" }],
  album: { name: "Alb", images: [{ url: "https://i.scdn.co/image/big", width: 640 }, { url: "https://i.scdn.co/image/small", width: 300 }, { url: "https://i.scdn.co/image/tiny", width: 64 }] },
  type: "track",
  external_urls: { spotify: `https://open.spotify.com/track/${id22(n)}` },
});

/**
 * Signed in as the person picked on this device (Tester), plus a window (node
 * test environment). The token is sealed at rest in the browser; here (no
 * IndexedDB) it lives in memory only. The returned `get("gtd-spotify-token")`
 * reads the token this tab holds, as JSON.
 */
async function signedIn(access = "user-tok") {
  const store = new Map<string, string>([["gtd-me", "Tester"]]);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const auth = await import("../spotifyAuth");
  await auth.__setSpotifyTokenForTests({ access, refresh: "ref", exp: Date.now() + 3600_000 });
  return {
    has: (k: string) => store.has(k),
    get: (k: string) => {
      if (k !== "gtd-spotify-token") return store.get(k);
      const t = auth.__spotifyTokenForTests();
      return t ? JSON.stringify(t) : undefined;
    },
  };
}

/** A paged Spotify list of `total` items, `limit` per page, with `next` links. */
function paged(url: URL, total: number, make: (i: number) => unknown, wrap?: string) {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const n = Math.max(0, Math.min(limit, total - offset));
  const next = offset + n < total ? `${url.origin}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), offset: String(offset + n), limit: String(limit) })}` : null;
  const page = { items: Array.from({ length: n }, (_, k) => make(offset + k)), next, total, limit, offset };
  return wrap ? { [wrap]: page } : page;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "cid");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("paging", () => {
  it("liked songs over 50: every page of 50 is read, each song with its Spotify id", async () => {
    await signedIn();
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-tok");
      expect(u.pathname).toBe("/v1/me/tracks");
      expect(Number(u.searchParams.get("limit"))).toBeLessThanOrEqual(50);
      return ok(paged(u, 130, (i) => ({ added_at: "", track: apiTrack(i) })));
    });
    vi.stubGlobal("fetch", f);
    const { likedTracks } = await import("../spotifyLibrary");
    const progress = vi.fn();
    const r = await likedTracks(undefined, progress);
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.tracks).toHaveLength(130);
    expect(r.total).toBe(130);
    expect(r.capped).toBe(false);
    expect(r.tracks[129]).toMatchObject({ id: id22(129), name: "Song 129", artists: "Artist A, Artist B", album: "Alb" });
    expect(progress).toHaveBeenLastCalledWith(130, 130);
  });

  it("liked songs are capped at 2000, and say so", async () => {
    await signedIn();
    const f = vi.fn(async (input: string | URL | Request) => ok(paged(new URL(String(input)), 2345, (i) => ({ track: apiTrack(i) }))));
    vi.stubGlobal("fetch", f);
    const { likedTracks, LIKED_CAP } = await import("../spotifyLibrary");
    const r = await likedTracks();
    expect(LIKED_CAP).toBe(2000);
    expect(r.tracks).toHaveLength(2000);
    expect(r.total).toBe(2345);
    expect(r.capped).toBe(true);
    expect(f).toHaveBeenCalledTimes(40);
  });

  it("my playlists: every page; own and collaborative marked, cover and count kept", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname === "/v1/me") return ok({ id: "me1" });
        return ok(
          paged(u, 120, (i) => ({
            id: id22("P" + i),
            name: `List ${i}`,
            owner: { id: i % 3 === 0 ? "me1" : "other", display_name: i % 3 === 0 ? "Me" : "Other" },
            collaborative: i % 3 === 1,
            images: [{ url: `https://i.scdn.co/p${i}`, width: 300 }],
            items: { total: i },
          }))
        );
      })
    );
    const { myPlaylists } = await import("../spotifyLibrary");
    const ps = await myPlaylists();
    expect(ps).toHaveLength(120);
    expect(ps[0]).toMatchObject({ kind: "playlist", name: "List 0", sub: "Me", mine: true, count: 0, cover: "https://i.scdn.co/p0", url: `https://open.spotify.com/playlist/${id22("P0")}` });
    expect(ps[1]).toMatchObject({ collaborative: true });
    expect(ps[1].mine).toBeUndefined();
  });

  it("followed artists: cursor pages under `artists`", async () => {
    await signedIn();
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const after = u.searchParams.get("after");
      const items = Array.from({ length: after ? 10 : 50 }, (_, k) => ({ id: id22(`A${after ? 50 + k : k}`), name: `Artist ${k}`, images: [] }));
      return ok({ artists: { items, next: after ? null : `${u.origin}${u.pathname}?type=artist&limit=50&after=x`, total: 60, cursors: { after: "x" } } });
    });
    vi.stubGlobal("fetch", f);
    const { followedArtists } = await import("../spotifyLibrary");
    expect(await followedArtists()).toHaveLength(60);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("one playlist / album", () => {
  it("a playlist that is not yours gives the details only (meta-only)", async () => {
    await signedIn();
    vi.stubGlobal("fetch", vi.fn(async () => ok({ id: id22("X"), name: "Editorial", owner: { id: "spotify", display_name: "Spotify" }, images: [{ url: "https://i.scdn.co/e", width: 640 }] })));
    const { playlistTracks } = await import("../spotifyLibrary");
    const r = await playlistTracks(id22("X"));
    expect(r.status).toBe("meta-only");
    expect(r.item).toMatchObject({ name: "Editorial", cover: "https://i.scdn.co/e" });
  });

  it("…/items answering 403 is details only too", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => (String(input).includes("/items") ? new Response("{}", { status: 403 }) : ok({ id: id22("Y"), name: "Party", items: { total: 140 } })))
    );
    const { playlistTracks } = await import("../spotifyLibrary");
    expect((await playlistTracks(id22("Y"))).status).toBe("meta-only");
  });

  it("your playlist: every …/items page (new `item` shape and the old `track` one)", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/items")) return ok(paged(u, 75, (i) => (i % 2 ? { item: apiTrack(i) } : { track: apiTrack(i) })));
        return ok({ id: id22("Z"), name: "Mine", owner: { id: "me1", display_name: "Me" }, items: { total: 75 } });
      })
    );
    const { playlistTracks } = await import("../spotifyLibrary");
    const r = await playlistTracks(id22("Z"));
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.tracks).toHaveLength(75);
      expect(r.tracks.map((t) => t.id)).toEqual(Array.from({ length: 75 }, (_, i) => id22(i)));
    }
  });

  it("an album: the first page with the album, the rest from /albums/{id}/tracks", async () => {
    await signedIn();
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/tracks")) return ok(paged(u, 60, (i) => ({ ...apiTrack(i), album: undefined })));
      const first = paged(new URL(`${u.origin}${u.pathname}/tracks?limit=50&offset=0`), 60, (i) => ({ ...apiTrack(i), album: undefined }));
      return ok({ id: id22("AL"), name: "Record", artists: [{ name: "Band" }], release_date: "2020-01-01", images: [{ url: "https://i.scdn.co/al", width: 640 }], total_tracks: 60, tracks: first });
    });
    vi.stubGlobal("fetch", f);
    const { albumTracks } = await import("../spotifyLibrary");
    const r = await albumTracks(id22("AL"));
    expect(r.status === "ok" && r.tracks).toHaveLength(60);
    expect(r.item).toMatchObject({ kind: "album", name: "Record", sub: "Band · 2020", count: 60 });
    // The album's cover on every song (album tracks have no album of their own).
    expect(r.status === "ok" && r.tracks[59].cover).toBe("https://i.scdn.co/al");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an artist whose albums Spotify refuses (403) shows none, not an error", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => (String(input).includes("/albums") ? new Response("{}", { status: 403 }) : ok({ id: id22("AR"), name: "Singer", images: [] })))
    );
    const { artistAlbums } = await import("../spotifyLibrary");
    const r = await artistAlbums(id22("AR"));
    expect(r.albums).toEqual([]);
    expect(r.artist).toMatchObject({ name: "Singer", kind: "artist" });
  });
});

describe("token and limits", () => {
  it("401: refreshes the token once and asks again", async () => {
    const store = await signedIn("old-tok");
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.host === "accounts.spotify.com") {
        expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
        return ok({ access_token: "new-tok", expires_in: 3600 });
      }
      if (new Headers(init?.headers).get("authorization") !== "Bearer new-tok") return new Response("{}", { status: 401 });
      return ok({ items: [{ track: apiTrack(1), played_at: "" }, { track: apiTrack(1), played_at: "" }, { track: apiTrack(2), played_at: "" }] });
    });
    vi.stubGlobal("fetch", f);
    const { recentlyPlayed } = await import("../spotifyLibrary");
    const r = await recentlyPlayed();
    expect(r.map((t) => t.id)).toEqual([id22(1), id22(2)]); // each song once
    expect(f.mock.calls.filter(([u]) => String(u).includes("accounts.spotify.com"))).toHaveLength(1);
    expect(JSON.parse(store.get("gtd-spotify-token")!)).toMatchObject({ access: "new-tok" });
  });

  it("401 again after the refresh: signed out (no loop)", async () => {
    await signedIn("old-tok");
    const f = vi.fn(async (input: string | URL | Request) => (String(input).includes("accounts") ? ok({ access_token: "x" }) : new Response("{}", { status: 401 })));
    vi.stubGlobal("fetch", f);
    const { recentlyPlayed, SpotifyApiError } = await import("../spotifyLibrary");
    const e = await recentlyPlayed().catch((x) => x);
    expect(e).toBeInstanceOf(SpotifyApiError);
    expect(e.code).toBe("signed-out");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("one caller leaving during the shared refresh does not cancel it for the others", async () => {
    const store = await signedIn("old-tok");
    let answerToken!: () => void;
    let tokenSignal: AbortSignal | null | undefined;
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.host === "accounts.spotify.com") {
        tokenSignal = init?.signal;
        await new Promise<void>((r) => (answerToken = r));
        if (init?.signal?.aborted) throw new DOMException("x", "AbortError");
        return ok({ access_token: "new-tok", refresh_token: "ref2", expires_in: 3600 });
      }
      if (new Headers(init?.headers).get("authorization") !== "Bearer new-tok") return new Response("{}", { status: 401 });
      return ok({ items: [{ album: { id: id22("AL"), name: "Kept" } }], next: null, total: 1 });
    });
    vi.stubGlobal("fetch", f);
    const { savedAlbums } = await import("../spotifyLibrary");
    const { refreshSpotifyToken } = await import("../spotifyAuth");
    const a = new AbortController();
    const pA = savedAlbums(a.signal); // a section: 401, starts the refresh
    await vi.waitFor(() => expect(tokenSignal).toBeDefined());
    const pB = refreshSpotifyToken(); // the player's getOAuthToken joins it
    a.abort(); // the section unmounts
    await expect(pA).rejects.toMatchObject({ code: "aborted" });
    answerToken();
    expect(await pB).toBe("new-tok");
    expect(tokenSignal?.aborted).toBe(false);
    expect(JSON.parse(store.get("gtd-spotify-token")!)).toMatchObject({ access: "new-tok", refresh: "ref2" });
    expect(await savedAlbums()).toMatchObject([{ name: "Kept" }]);
  });

  it("the refresh not answering (offline) says network, and keeps the sign-in", async () => {
    const store = await signedIn("old-tok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("accounts.spotify.com")) throw new TypeError("Failed to fetch");
        return new Response("{}", { status: 401 });
      })
    );
    const { savedAlbums } = await import("../spotifyLibrary");
    await expect(savedAlbums()).rejects.toMatchObject({ code: "network" });
    expect(store.get("gtd-spotify-token")).toBeTruthy();
  });

  it("401 with a fresh token signs out, so the page offers Accedi as the message says", async () => {
    const store = await signedIn("old-tok");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => (String(input).includes("accounts") ? ok({ access_token: "fresh" }) : new Response("{}", { status: 401 }))));
    const { savedAlbums } = await import("../spotifyLibrary");
    await expect(savedAlbums()).rejects.toMatchObject({ code: "signed-out" });
    expect(store.get("gtd-spotify-token")).toBeUndefined();
  });

  it("429: a clear quota message with the wait from Retry-After", async () => {
    await signedIn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { status: 429, message: "API rate limit exceeded" } }), { status: 429, headers: { "Retry-After": "120" } })));
    const { myPlaylists, spotifyErrorText, SpotifyApiError } = await import("../spotifyLibrary");
    const e = await myPlaylists().catch((x) => x);
    expect(e).toBeInstanceOf(SpotifyApiError);
    expect(e).toMatchObject({ code: "quota", status: 429, retryAfter: 120 });
    const t = (dict: Record<string, string>) => (k: string, v?: Record<string, string | number>) => dict[k].replace(/\{(\w+)\}/g, (_, n) => String(v?.[n] ?? ""));
    expect(spotifyErrorText(e, t(TAB_IT))).toBe("Spotify ha raggiunto il limite di richieste di quest'app (429). Riprova tra 120 s.");
    expect(spotifyErrorText(e, t(TAB_EN))).toContain("Try again in 120 s");
    expect(spotifyErrorText(new SpotifyApiError("quota", 429), t(TAB_EN))).toContain("Try again later");
  });

  it("429 with a short Retry-After is waited out once", async () => {
    await signedIn();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (n++ === 0 ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } }) : ok({ items: [{ track: apiTrack(7) }] })))
    );
    const { recentlyPlayed } = await import("../spotifyLibrary");
    expect((await recentlyPlayed()).map((t) => t.id)).toEqual([id22(7)]);
    expect(n).toBe(2);
  });

  it("not signed in: no call at all", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { savedAlbums } = await import("../spotifyLibrary");
    await expect(savedAlbums()).rejects.toMatchObject({ code: "signed-out" });
    expect(f).not.toHaveBeenCalled();
  });

  it("a cancelled call says aborted", async () => {
    await signedIn();
    vi.stubGlobal("fetch", vi.fn((_: unknown, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("x", "AbortError"))))));
    const { savedAlbums } = await import("../spotifyLibrary");
    const c = new AbortController();
    const p = savedAlbums(c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("search", () => {
  it("10 per type, offset for more", async () => {
    await signedIn();
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname === "/v1/me") return ok({ id: "me" });
      expect(u.searchParams.get("limit")).toBe("10");
      const off = Number(u.searchParams.get("offset"));
      const page = (make: (i: number) => unknown) => ({ items: Array.from({ length: 10 }, (_, k) => make(off + k)), next: off < 20 ? "https://api.spotify.com/v1/search?more" : null, total: 30 });
      const types = u.searchParams.get("type")!.split(",");
      return ok({
        ...(types.includes("track") ? { tracks: page(apiTrack) } : {}),
        ...(types.includes("album") ? { albums: page((i) => ({ id: id22("AL" + i), name: `Al ${i}`, images: [] })) } : {}),
        ...(types.includes("playlist") ? { playlists: page((i) => (i === 3 ? null : { id: id22("PL" + i), name: `Pl ${i}`, images: null, owner: i === 0 ? { id: "me", display_name: "Io" } : { display_name: "X" } })) } : {}),
      });
    });
    vi.stubGlobal("fetch", f);
    const { searchSpotify } = await import("../spotifyLibrary");
    const a = await searchSpotify("ferro", ["track", "album", "playlist"]);
    expect(a.tracks?.items).toHaveLength(10);
    expect(a.playlists?.items).toHaveLength(9); // null entries skipped
    expect(a.tracks?.more).toBe(true);
    // Searching first (no visit to "Le mie playlist"): your own playlist still says "Tua".
    expect(a.playlists?.items[0]).toMatchObject({ mine: true });
    expect(a.playlists?.items[1].mine).toBeUndefined();
    const b = await searchSpotify("ferro", ["track"], 20);
    const searches = f.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname === "/v1/search");
    expect(searches[1].searchParams.get("offset")).toBe("20");
    expect(searches[1].searchParams.get("type")).toBe("track");
    expect(b.tracks?.more).toBe(false);
    expect(b.albums).toBeUndefined();
  });
});

describe("Spotify track → Track keeps the Spotify id", () => {
  it("trackOf, songOf, withSpotifyIds, importListOf", async () => {
    const { trackOf, songOf, withSpotifyIds, importListOf, spotifyIdOf } = await import("../spotifyLibrary");
    expect(trackOf({ ...apiTrack(1), is_local: true })).toBeNull();
    expect(trackOf({ ...apiTrack(1), type: "episode" })).toBeNull();
    expect(trackOf({ ...apiTrack(1), id: null })).toBeNull();
    const t = trackOf(apiTrack(5))!;
    expect(t).toEqual({
      id: id22(5),
      name: "Song 5",
      artists: "Artist A, Artist B",
      ms: 200005,
      album: "Alb",
      cover: "https://i.scdn.co/image/small",
      url: `https://open.spotify.com/track/${id22(5)}`,
    });
    expect(songOf(t)).toEqual({ title: "Song 5", artist: "Artist A, Artist B", ms: 200005, id: id22(5) });

    const t2 = trackOf(apiTrack(6))!;
    const list = importListOf({ kind: "liked", name: "Liked", owner: "Spotify" }, [t, t2]);
    expect(list.songs.map(spotifyIdOf)).toEqual([id22(5), id22(6)]);
    // Spotify's art is not carried into the import (it becomes YouTube songs).
    expect(list.cover).toBe("");
    const yt = { id: "dQw4w9WgXcQ", title: "Song 5 (Official)", channel: "Artist A" };
    expect(withSpotifyIds([yt, null], list.songs)).toEqual([{ ...yt, spotify: id22(5) }, null]);
    // A song without an id (the server path) gives the match unchanged.
    expect(withSpotifyIds([yt], [{ title: "x", artist: "y", ms: 0 }])).toEqual([yt]);
  });

  it("the single-link import read as the user keeps the ids (album)", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ id: id22("AL"), name: "Record", artists: [{ name: "Band" }], images: [], total_tracks: 2, tracks: { items: [apiTrack(1), apiTrack(2)], next: null, total: 2 } }))
    );
    const { readLinkAsUser, spotifyIdOf, spotifyLinkTarget } = await import("../spotifyLibrary");
    expect(spotifyLinkTarget(`https://open.spotify.com/intl-it/album/${id22("AL")}?si=1`)).toEqual({ kind: "album", id: id22("AL") });
    expect(spotifyLinkTarget(`spotify:playlist:${id22("PL")}`)).toEqual({ kind: "playlist", id: id22("PL") });
    expect(spotifyLinkTarget("https://example.com")).toBeNull();
    const r = await readLinkAsUser("album", id22("AL"));
    expect(typeof r === "object" && r.songs.map(spotifyIdOf)).toEqual([id22(1), id22(2)]);
    expect(typeof r === "object" && r).toMatchObject({ kind: "album", id: id22("AL"), name: "Record", via: "api" });
  });

  it("the return flag counts only on a real return from Spotify with a code", async () => {
    const store = await signedIn();
    const { markLibraryReturn, takeLibraryReturn } = await import("../spotifyLibrary");
    markLibraryReturn();
    // Opening Importa da Spotify later, in a page not loaded at /callback: no redirect, flag gone.
    expect(takeLibraryReturn("https://site.example/#/music/spotify")).toBe(false);
    expect(store.has("gtd-splib-return")).toBe(false);
    markLibraryReturn();
    expect(takeLibraryReturn("https://site.example/callback?error=access_denied&state=s")).toBe(false);
    markLibraryReturn();
    expect(takeLibraryReturn("https://site.example/callback?code=abc&state=s")).toBe(true);
    expect(takeLibraryReturn("https://site.example/callback?code=abc&state=s")).toBe(false); // once
    // Back from Spotify's page (restored from the back/forward cache): cleared.
    const listeners: ((e: { persisted: boolean }) => void)[] = [];
    vi.stubGlobal("window", { addEventListener: (_: string, l: (e: { persisted: boolean }) => void) => listeners.push(l), removeEventListener() {} });
    markLibraryReturn();
    listeners.forEach((l) => l({ persisted: true }));
    expect(store.has("gtd-splib-return")).toBe(false);
  });

  it("“Aggiungi tutte” before signing in: the intent comes back once, only with a real return", async () => {
    await signedIn();
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const { markLibraryReturn, takeLibraryReturn, takeAddAllIntent } = await import("../spotifyLibrary");
    markLibraryReturn("add-all");
    expect(takeLibraryReturn("https://site.example/callback?error=access_denied&state=s")).toBe(false);
    expect(takeAddAllIntent()).toBe(false);
    markLibraryReturn("add-all");
    expect(takeLibraryReturn("https://site.example/callback?code=abc&state=s")).toBe(true);
    expect(takeAddAllIntent()).toBe(true);
    expect(takeAddAllIntent()).toBe(false); // once
    markLibraryReturn(); // the plain library sign-in: no import
    expect(takeLibraryReturn("https://site.example/callback?code=abc&state=s")).toBe(true);
    expect(takeAddAllIntent()).toBe(false);
  });

  it("a playlist opened straight from a link knows it is yours", async () => {
    await signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname === "/v1/me") return ok({ id: "me" });
        if (u.pathname.endsWith("/items")) return ok({ items: [{ item: apiTrack(1) }], next: null, total: 1 });
        return ok({ id: id22("MY"), name: "Mia", owner: { id: "me", display_name: "Io" }, items: { total: 1 } });
      })
    );
    const { playlistTracks } = await import("../spotifyLibrary");
    expect((await playlistTracks(id22("MY"))).item).toMatchObject({ mine: true });
  });

  it("the library route round-trips", async () => {
    const { parseView, viewSub } = await import("../musicTabRoute");
    for (const v of [
      { kind: "splib" as const },
      { kind: "splib" as const, sec: "liked" as const },
      { kind: "splib" as const, sec: "artists" as const, open: { type: "album" as const, id: id22("AL") } },
    ])
      expect(parseView(viewSub(v))).toEqual(v);
    expect(parseView("splib/nope/album/x")).toEqual({ kind: "splib" });
  });
});

describe("the Spotify user id (review fix F1)", () => {
  it("is cached per person picked and token: another name, a sign-out or fresh asks /me again", async () => {
    await signedIn("tok-a");
    let who = "user-a";
    const f = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === "/v1/me") return ok({ id: who });
      return ok({});
    });
    vi.stubGlobal("fetch", f);
    const auth = await import("../spotifyAuth");
    const lib = await import("../spotifyLibrary");
    expect(await lib.spotifyMe()).toBe("user-a");
    expect(await lib.spotifyMe()).toBe("user-a");
    expect(f).toHaveBeenCalledTimes(1); // cached for this session
    // Another person picked on this device, signed in to another Spotify account.
    localStorage.setItem("gtd-me", "Bruno");
    auth.spotifyOwnerChanged();
    await auth.__setSpotifyTokenForTests({ access: "tok-b", exp: Date.now() + 3600_000 });
    who = "user-b";
    expect(await lib.spotifyMe()).toBe("user-b");
    expect(f).toHaveBeenCalledTimes(2);
    // fresh: never the cache (the liked songs' owner check).
    who = "user-b2";
    expect(await lib.spotifyMe(undefined, { fresh: true })).toBe("user-b2");
    expect(f).toHaveBeenCalledTimes(3);
  });
});
