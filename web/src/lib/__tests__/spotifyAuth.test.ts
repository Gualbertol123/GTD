// "Accedi con Spotify" (lib/spotifyAuth.ts): the PKCE helpers, the state
// check, the /callback parsing and exchange, and the browser's own playlist
// reader (lib/music.ts readSpotifyAsUser). Every network call is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
    },
  },
}));

import { authorizeUrl, base64url, codeChallenge, parseCallback, randomString, stateMatches } from "../spotifyAuth";

const PL = "0jAWhVakmxvxg2aLaYAMXk";

/** A tiny sessionStorage, location and history for the node test environment. */
function fakeBrowser(href: string) {
  const store = new Map<string, string>();
  const loc = new URL(href);
  const location = {
    get href() {
      return loc.href;
    },
    get pathname() {
      return loc.pathname;
    },
    get origin() {
      return loc.origin;
    },
    assign: vi.fn(),
  };
  const history = {
    replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
      const n = new URL(url, loc.href);
      loc.href = n.href;
    }),
  };
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", history);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  return { store, location, history };
}

describe("PKCE helpers", () => {
  it("base64url: no padding, - and _ instead of + and /", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
    expect(base64url(new Uint8Array([]))).toBe("");
  });

  it("S256 challenge matches RFC 7636 appendix B", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifier: 43–128 unreserved characters, different every time", () => {
    const a = randomString(64);
    expect(a).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(randomString(64)).not.toBe(a);
    expect(randomString(5)).toHaveLength(43);
    expect(randomString(500)).toHaveLength(128);
  });

  it("state check: equal and non-empty only", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "abcd")).toBe(false);
    expect(stateMatches("", "")).toBe(false);
    expect(stateMatches(null, "abc")).toBe(false);
    expect(stateMatches("abc", undefined)).toBe(false);
  });

  it("callback parsing: /callback with code or error; anything else is null", () => {
    expect(parseCallback("https://site.example/callback?code=C1&state=S1")).toEqual({ code: "C1", state: "S1" });
    expect(parseCallback("https://site.example/callback?error=access_denied&state=S1")).toEqual({ error: "access_denied", state: "S1" });
    expect(parseCallback("https://site.example/callback")).toBeNull();
    expect(parseCallback("https://site.example/?code=C1&state=S1#/board")).toBeNull();
    expect(parseCallback("https://site.example/#/callback?code=x")).toBeNull();
    expect(parseCallback("not a url")).toBeNull();
  });

  it("authorize address: code + S256, scopes, redirect", () => {
    const u = new URL(authorizeUrl("CH", "ST", "https://site.example/callback", "cid"));
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      scope: "playlist-read-private playlist-read-collaborative",
      redirect_uri: "https://site.example/callback",
      state: "ST",
      code_challenge_method: "S256",
      code_challenge: "CH",
    });
  });
});

describe("login round trip (begin → /callback → token)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "cid");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stores verifier + state, sends to Spotify; the callback checks the state, posts the verifier, keeps the token in sessionStorage and goes to #/music/spotify", async () => {
    const b = fakeBrowser("https://site.example/#/music/spotify");
    const auth = await import("../spotifyAuth");
    expect(auth.spotifyLoginAvailable()).toBe(true);
    await auth.beginSpotifyLogin(`https://open.spotify.com/playlist/${PL}`);
    const to = new URL(b.location.assign.mock.calls[0][0]);
    const pending = JSON.parse(b.store.get("gtd-spotify-pkce")!);
    expect(to.searchParams.get("state")).toBe(pending.state);
    expect(to.searchParams.get("code_challenge")).toBe(await auth.codeChallenge(pending.verifier));
    expect(to.searchParams.get("redirect_uri")).toBe("https://site.example/callback");

    // Spotify sends the browser back (a fresh page load).
    vi.resetModules();
    const b2 = fakeBrowser(`https://site.example/callback?code=THE-CODE&state=${pending.state}`);
    b2.store.set("gtd-spotify-pkce", JSON.stringify(pending));
    const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toEqual({
        grant_type: "authorization_code",
        code: "THE-CODE",
        redirect_uri: "https://site.example/callback",
        client_id: "cid",
        code_verifier: pending.verifier,
      });
      return new Response(JSON.stringify({ access_token: "user-tok", refresh_token: "ref", expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const auth2 = await import("../spotifyAuth");
    const p = auth2.handleSpotifyCallback();
    expect(b2.history.replaceState).toHaveBeenCalledWith(null, "", "/#/music/spotify"); // at once, before the exchange
    expect(b2.location.pathname).toBe("/");
    expect(await p).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://accounts.spotify.com/api/token");
    expect(auth2.spotifyUserToken()).toBe("user-tok");
    expect(JSON.parse(b2.store.get("gtd-spotify-token")!)).toMatchObject({ access: "user-tok", refresh: "ref" });
    expect(b2.store.has("gtd-spotify-pkce")).toBe(false); // used once
    expect(auth2.takeReturnLink()).toBe(`https://open.spotify.com/playlist/${PL}`);
    expect(auth2.takeReturnLink()).toBeNull();
    auth2.signOutSpotify();
    expect(auth2.spotifyUserToken()).toBeNull();
    expect(b2.store.has("gtd-spotify-token")).toBe(false);
  });

  it("a wrong state is refused without asking Spotify", async () => {
    const b = fakeBrowser("https://site.example/callback?code=C&state=WRONG");
    b.store.set("gtd-spotify-pkce", JSON.stringify({ verifier: "v".repeat(64), state: "RIGHT", at: Date.now() }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const auth = await import("../spotifyAuth");
    expect(await auth.handleSpotifyCallback()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.spotifyUserToken()).toBeNull();
    expect(b.history.replaceState).toHaveBeenCalledWith(null, "", "/#/music/spotify");
  });

  it("not /callback: nothing happens", async () => {
    const b = fakeBrowser("https://site.example/#/board");
    const auth = await import("../spotifyAuth");
    expect(auth.handleSpotifyCallback()).toBeNull();
    expect(b.history.replaceState).not.toHaveBeenCalled();
  });

  it("without VITE_SPOTIFY_CLIENT_ID the login is not offered", async () => {
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "");
    fakeBrowser("https://site.example/");
    const auth = await import("../spotifyAuth");
    expect(auth.spotifyLoginAvailable()).toBe(false);
  });
});

describe("readSpotifyAsUser (the browser, with the person's token)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "cid");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const signedIn = (b: ReturnType<typeof fakeBrowser>, access = "user-tok") =>
    b.store.set("gtd-spotify-token", JSON.stringify({ access, refresh: "ref", exp: Date.now() + 3600_000 }));
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const entries = (offset: number, n: number, key: "item" | "track") =>
    Array.from({ length: n }, (_, k) => ({ is_local: false, [key]: { name: `S${offset + k}`, duration_ms: 1000, artists: [{ name: "A" }], type: "track" } }));

  it("new shape: …/items pages, `item` entries, all 250", async () => {
    const b = fakeBrowser("https://site.example/");
    signedIn(b);
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-tok");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (u.pathname.endsWith("/items")) {
        const o = Number(u.searchParams.get("offset"));
        return ok({ items: entries(o, Math.min(100, 250 - o), "item"), total: 250 });
      }
      return ok({ name: "party", owner: { display_name: "Gca" }, images: [{ url: "https://i/p", width: 640 }], items: { total: 250 } });
    });
    vi.stubGlobal("fetch", f);
    const { readSpotifyAsUser } = await import("../music");
    const r = await readSpotifyAsUser(PL);
    expect(r).toMatchObject({ kind: "playlist", name: "party", owner: "Gca", cover: "https://i/p", via: "api", total: 250 });
    expect(typeof r === "object" && r.songs.length).toBe(250);
    expect(f.mock.calls.filter(([u]) => String(u).includes("/tracks"))).toHaveLength(0);
  });

  it("old shape: …/items 404 → …/tracks with `track` entries", async () => {
    const b = fakeBrowser("https://site.example/");
    signedIn(b);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/items")) return new Response("{}", { status: 404 });
        if (u.pathname.endsWith("/tracks")) return ok({ items: entries(Number(u.searchParams.get("offset")), 30, "track") });
        return ok({ name: "old", images: [], tracks: { total: 30 } });
      })
    );
    const { readSpotifyAsUser } = await import("../music");
    const r = await readSpotifyAsUser(PL);
    expect(typeof r === "object" && r.songs.map((s) => s.title).slice(0, 2)).toEqual(["S0", "S1"]);
  });

  it("details only (not the person's playlist) → meta-only; 403 on the songs → meta-only", async () => {
    const b = fakeBrowser("https://site.example/");
    signedIn(b);
    vi.stubGlobal("fetch", vi.fn(async () => ok({ name: "party", owner: { display_name: "Gca" }, images: [] })));
    const { readSpotifyAsUser } = await import("../music");
    expect(await readSpotifyAsUser(PL)).toBe("meta-only");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/items") ? new Response("{}", { status: 403 }) : ok({ name: "party", images: [], items: { total: 140 } })
      )
    );
    expect(await readSpotifyAsUser(PL)).toBe("meta-only");
  });

  it("401: refreshes the token once and asks again; a second 401 gives up (fail)", async () => {
    const b = fakeBrowser("https://site.example/");
    signedIn(b, "old-tok");
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.host === "accounts.spotify.com") {
        expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
        return ok({ access_token: "new-tok", expires_in: 3600 });
      }
      if (new Headers(init?.headers).get("authorization") !== "Bearer new-tok") return new Response("{}", { status: 401 });
      if (u.pathname.endsWith("/items")) return ok({ items: entries(0, 5, "item") });
      return ok({ name: "mine", images: [], items: { total: 5 } });
    });
    vi.stubGlobal("fetch", f);
    const { readSpotifyAsUser } = await import("../music");
    const r = await readSpotifyAsUser(PL);
    expect(typeof r === "object" && r.songs).toHaveLength(5);
    expect(f.mock.calls.filter(([u]) => String(u).includes("accounts.spotify.com"))).toHaveLength(1);
    expect(JSON.parse(b.store.get("gtd-spotify-token")!)).toMatchObject({ access: "new-tok", refresh: "ref" });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => (String(input).includes("accounts") ? ok({ access_token: "x" }) : new Response("{}", { status: 401 }))));
    expect(await readSpotifyAsUser(PL)).toBe("fail");
  });

  it("not signed in → fail (the server path is used)", async () => {
    fakeBrowser("https://site.example/");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { readSpotifyAsUser } = await import("../music");
    expect(await readSpotifyAsUser(PL)).toBe("fail");
    expect(f).not.toHaveBeenCalled();
  });
});
