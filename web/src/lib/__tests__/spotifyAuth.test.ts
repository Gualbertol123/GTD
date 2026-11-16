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

import { SPOTIFY_SCOPES, authorizeUrl, base64url, codeChallenge, parseCallback, randomString, stateMatches } from "../spotifyAuth";

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
  /** Every value ever written to either storage (the "no plain-text token" check reads it). */
  const written: string[] = [];
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      written.push(`${k}=${v}`);
      store.set(k, String(v));
    },
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  // The name picked on this device (the Spotify session belongs to it).
  if (!store.has("gtd-me")) store.set("gtd-me", "Tester");
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", history);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  return { store, location, history, written };
}

/** One device's key store (what IndexedDB keeps in the browser): another device is another of these. */
function deviceKeys() {
  let k: CryptoKey | null = null;
  return {
    get: async () => k,
    putIfAbsent: async (n: CryptoKey) => (k ??= n),
    get key() {
      return k;
    },
  };
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

  it("asks for the import and Spotify-mode permissions", () => {
    for (const sc of ["playlist-read-private", "user-library-read", "user-follow-read", "streaming", "user-modify-playback-state"]) expect(SPOTIFY_SCOPES.split(" ")).toContain(sc);
  });

  it("authorize address: code + S256, scopes, redirect", () => {
    const u = new URL(authorizeUrl("CH", "ST", "https://site.example/callback", "cid"));
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      scope: SPOTIFY_SCOPES,
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

  it("stores verifier + state, sends to Spotify; the callback checks the state, posts the verifier, keeps the token sealed for the person and goes to #/music/spotify", async () => {
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
    const keys = deviceKeys();
    auth2.__setSpotifyKeyStoreForTests(keys);
    const p = auth2.handleSpotifyCallback();
    expect(b2.history.replaceState).toHaveBeenCalledWith(null, "", "/#/music/spotify"); // at once, before the exchange
    expect(b2.location.pathname).toBe("/");
    expect(await p).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://accounts.spotify.com/api/token");
    expect(auth2.spotifyUserToken()).toBe("user-tok");
    await auth2.__spotifyWritesForTests();
    const sealed = JSON.parse(b2.store.get("gtd-spotify-token:tester")!);
    expect(Object.keys(sealed).sort()).toEqual(["ct", "iv", "v"]);
    expect(b2.store.get("gtd-spotify-token:tester")).not.toMatch(/user-tok|ref/);
    expect(keys.key?.extractable).toBe(false);
    expect(b2.store.has("gtd-spotify-pkce")).toBe(false); // used once
    expect(auth2.takeReturnLink()).toBe(`https://open.spotify.com/playlist/${PL}`);
    expect(auth2.takeReturnLink()).toBeNull();
    auth2.signOutSpotify();
    expect(auth2.spotifyUserToken()).toBeNull();
    expect(b2.store.has("gtd-spotify-token:tester")).toBe(false);
  });

  it("a Spotify session belongs to the person picked on this device, not to the shared login", async () => {
    const b = fakeBrowser("https://site.example/#/music/spotify");
    b.store.set("gtd-me", "Anna");
    const keys = deviceKeys();
    const auth0 = await import("../spotifyAuth");
    auth0.__setSpotifyKeyStoreForTests(keys);
    await auth0.__setSpotifyTokenForTests({ access: "anna-tok", exp: Date.now() + 3600e3 });
    // A reload: the sealed sign-in is read (decrypted) once, "busy" meanwhile.
    vi.resetModules();
    const auth = await import("../spotifyAuth");
    auth.__setSpotifyKeyStoreForTests(keys);
    expect(auth.spotifyUserToken()).toBeNull();
    expect(auth.spotifyAuthState().status).toBe("busy");
    await auth.whenSpotifyAuthReady();
    expect(auth.spotifyAuthState().status).toBe("in");
    expect(auth.spotifyUserToken()).toBe("anna-tok");
    // Marco picks his name on the same device: Anna's session is not his.
    b.store.set("gtd-me", "Marco");
    auth.spotifyOwnerChanged();
    expect(auth.spotifyUserToken()).toBeNull();
    // Back to Anna: hers again; Marco signing out never touches it.
    auth.signOutSpotify();
    b.store.set("gtd-me", "Anna");
    auth.spotifyOwnerChanged();
    expect(auth.spotifyUserToken()).toBe("anna-tok");
    expect(b.store.has("gtd-spotify-token:anna")).toBe(true);
  });

  it("no name picked: no Spotify sign-in", async () => {
    const b = fakeBrowser("https://site.example/#/music/spotify");
    b.store.set("gtd-me", "");
    const auth = await import("../spotifyAuth");
    await auth.beginSpotifyLogin();
    expect(b.location.assign).not.toHaveBeenCalled();
    expect(auth.spotifyUserToken()).toBeNull();
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

  /** Signed in as the person picked (Tester), in this tab's memory (no key store in node). */
  const signedIn = async (_b: ReturnType<typeof fakeBrowser>, access = "user-tok") => {
    const auth = await import("../spotifyAuth");
    await auth.__setSpotifyTokenForTests({ access, refresh: "ref", exp: Date.now() + 3600_000 });
  };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const entries = (offset: number, n: number, key: "item" | "track") =>
    Array.from({ length: n }, (_, k) => ({ is_local: false, [key]: { name: `S${offset + k}`, duration_ms: 1000, artists: [{ name: "A" }], type: "track" } }));

  it("new shape: …/items pages, `item` entries, all 250", async () => {
    const b = fakeBrowser("https://site.example/");
    await signedIn(b);
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
    await signedIn(b);
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
    await signedIn(b);
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
    await signedIn(b, "old-tok");
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
    const auth = await import("../spotifyAuth");
    expect(auth.spotifyUserToken()).toBe("new-tok");
    // No key store here (node): memory only, never in plain storage.
    expect([...b.store.keys()].filter((k) => k.startsWith("gtd-spotify-token"))).toEqual([]);

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

describe("the token at rest: sealed with this device's key, per person", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "cid");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A fresh page load on a device: a new module, the device's key store. */
  async function reload(keys: import("../spotifyAuth").DeviceKeyStore | null) {
    vi.resetModules();
    const auth = await import("../spotifyAuth");
    auth.__setSpotifyKeyStoreForTests(keys);
    return auth;
  }
  const TOK = { access: "SECRET-ACCESS", refresh: "SECRET-REFRESH", exp: Date.now() + 3600_000 };

  it("(a) round trip: sealed on save, decrypted once after a reload", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests(TOK);
    const entry = JSON.parse(b.store.get("gtd-spotify-token:tester")!);
    expect(entry.v).toBe(1);
    expect(atob(entry.iv)).toHaveLength(12);
    const auth2 = await reload(keys);
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBe("SECRET-ACCESS");
    expect(auth2.spotifyTokenExpiry()).toBe(TOK.exp);
  });

  it("(b) a sealed entry copied to another device (another key) is refused, removed, and signed out", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests(TOK);
    const copied = b.store.get("gtd-spotify-token:tester")!;

    // Another browser: its own key (made by its own sign-in), the copied entry pasted in.
    const other = deviceKeys();
    const authB = await reload(other);
    b.store.set("gtd-me", "Someone");
    await authB.__setSpotifyTokenForTests({ access: "theirs", exp: Date.now() + 3600_000 });
    const authB2 = await reload(other);
    b.store.set("gtd-me", "Tester");
    b.store.set("gtd-spotify-token:tester", copied);
    authB2.spotifyOwnerChanged();
    await authB2.whenSpotifyAuthReady();
    expect(authB2.spotifyUserToken()).toBeNull();
    expect(authB2.spotifyAuthState().status).toBe("out");
    expect(b.store.has("gtd-spotify-token:tester")).toBe(false);

    // A device with no key at all (IndexedDB cleared, or never signed in here): refused too.
    b.store.set("gtd-spotify-token:tester", copied);
    const authC = await reload(deviceKeys());
    await authC.whenSpotifyAuthReady();
    expect(authC.spotifyUserToken()).toBeNull();
    expect(b.store.has("gtd-spotify-token:tester")).toBe(false);
  });

  it("(b') an entry moved to another person's name on the same device is refused (the name is sealed in)", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests(TOK);
    b.store.set("gtd-spotify-token:marco", b.store.get("gtd-spotify-token:tester")!);
    const auth2 = await reload(keys);
    b.store.set("gtd-me", "Marco");
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBeNull();
    expect(b.store.has("gtd-spotify-token:marco")).toBe(false);
    expect(b.store.has("gtd-spotify-token:tester")).toBe(true);
  });

  it("(c) no plain-text token is ever written to localStorage or sessionStorage (sign-in, refresh, switch, sign-out)", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests(TOK);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "SECRET-NEW", refresh_token: "SECRET-REFRESH-2", expires_in: 3600 }), { status: 200 }))
    );
    expect(await auth.refreshSpotifyToken()).toBe("SECRET-NEW");
    await auth.__spotifyWritesForTests();
    b.store.set("gtd-me", "Anna");
    auth.spotifyOwnerChanged();
    await auth.__setSpotifyTokenForTests({ access: "SECRET-ANNA", exp: Date.now() + 1000 });
    b.store.set("gtd-me", "Tester");
    auth.spotifyOwnerChanged();
    const auth2 = await reload(keys);
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBe("SECRET-NEW");
    auth2.signOutSpotify();
    expect(b.written.length).toBeGreaterThan(0);
    for (const w of b.written) expect(w).not.toMatch(/SECRET/);
    expect(b.store.has("gtd-spotify-token:tester")).toBe(false);
    expect(b.store.has("gtd-spotify-token:anna")).toBe(true);
  });

  it("(d) per person: each name on this device gets its own session, switched by the identity menu", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests({ ...TOK, access: "tester-tok" });
    b.store.set("gtd-me", "Anna");
    auth.spotifyOwnerChanged();
    expect(auth.spotifyAuthState().status).toBe("out");
    await auth.__setSpotifyTokenForTests({ ...TOK, access: "anna-tok" });

    const auth2 = await reload(keys);
    const events: string[] = [];
    auth2.onSpotifySession((e) => events.push(e.kind === "owner" ? `owner:${e.owner}:${e.name}` : e.kind === "loaded" ? `loaded:${e.owner}:${e.signedIn}` : e.kind));
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBe("anna-tok");
    b.store.set("gtd-me", "Tester");
    auth2.spotifyOwnerChanged();
    expect(auth2.spotifyAuthState().status).toBe("busy");
    expect(auth2.spotifyUserToken()).toBeNull(); // never Anna's meanwhile
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBe("tester-tok");
    b.store.set("gtd-me", "Nobody");
    auth2.spotifyOwnerChanged();
    expect(auth2.spotifyUserToken()).toBeNull();
    expect(auth2.spotifyAuthState().status).toBe("out");
    expect(events).toEqual(["loaded:anna:true", "owner:tester:Tester", "loaded:tester:true", "owner:nobody:Nobody"]);
  });

  it("old plain-text entries (gtd-spotify-token, gtd-spotify-token:<name>) are removed: sign in again", async () => {
    const b = fakeBrowser("https://site.example/");
    b.store.set("gtd-spotify-token", JSON.stringify({ access: "legacy", exp: Date.now() + 1000 }));
    b.store.set("gtd-spotify-token:tester", JSON.stringify({ access: "plain-tester", exp: Date.now() + 1000 }));
    b.store.set("gtd-spotify-token:anna", JSON.stringify({ access: "plain-anna", exp: Date.now() + 1000 }));
    const auth = await reload(deviceKeys());
    expect(auth.spotifyUserToken()).toBeNull();
    await auth.whenSpotifyAuthReady();
    expect(auth.spotifyAuthState().status).toBe("out");
    expect([...b.store.keys()].filter((k) => k.startsWith("gtd-spotify-token"))).toEqual([]);
  });

  it("no WebCrypto / IndexedDB: the token lives in this tab's memory only, never in storage", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(null);
    await auth.__setSpotifyTokenForTests(TOK);
    expect(auth.spotifyUserToken()).toBe("SECRET-ACCESS");
    expect([...b.store.keys()].filter((k) => k.startsWith("gtd-spotify-token"))).toEqual([]);
    for (const w of b.written) expect(w).not.toMatch(/SECRET/);
    const auth2 = await reload(null);
    await auth2.whenSpotifyAuthReady();
    expect(auth2.spotifyUserToken()).toBeNull(); // a reload signs out
  });

  it("the callback saves the token for the person who STARTED the sign-in", async () => {
    const b = fakeBrowser("https://site.example/callback?code=C&state=S");
    b.store.set("gtd-spotify-pkce", JSON.stringify({ verifier: "v".repeat(64), state: "S", at: Date.now(), owner: "anna" }));
    b.store.set("gtd-me", "Marco"); // the name was changed meanwhile
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "anna-new", expires_in: 3600 }), { status: 200 })));
    const keys = deviceKeys();
    const auth = await reload(keys);
    expect(await auth.handleSpotifyCallback()).toBe(false);
    expect(auth.spotifyUserToken()).toBeNull(); // not Marco's
    await auth.__spotifyWritesForTests();
    b.store.set("gtd-me", "Anna");
    auth.spotifyOwnerChanged();
    expect(auth.spotifyUserToken()).toBe("anna-new");
  });

  // ---- Review fixes F2 / F3: the session never crosses people ----

  /** The storage listener the module added (another tab's writes arrive there). */
  const storageListener = () => {
    const add = (window as unknown as { addEventListener: ReturnType<typeof vi.fn> }).addEventListener;
    return add.mock.calls.filter(([k]) => k === "storage").map(([, f]) => f as (e: { key: string | null; newValue: string | null }) => void)[0];
  };

  it("F2: another tab picks another name (gtd-me): this tab switches with the owner event, never the old person's token", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests({ ...TOK, access: "tester-tok" });
    b.store.set("gtd-me", "Anna");
    auth.spotifyOwnerChanged();
    await auth.__setSpotifyTokenForTests({ ...TOK, access: "anna-tok" });
    b.store.set("gtd-me", "Tester");
    auth.spotifyOwnerChanged();
    await auth.whenSpotifyAuthReady();
    const events: string[] = [];
    auth.onSpotifySession((e) => events.push(e.kind === "owner" ? `owner:${e.prev}>${e.owner}` : e.kind));
    // Tab 2 picks Anna: the storage event reaches this tab.
    b.store.set("gtd-me", "Anna");
    storageListener()({ key: "gtd-me", newValue: "Anna" });
    expect(events).toEqual(["owner:tester>anna"]);
    expect(auth.spotifyUserToken()).toBe("anna-tok");
  });

  it("F2: a name changed without any event: the next read still runs the owner switch (events after it)", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests({ ...TOK, access: "tester-tok" });
    const events: string[] = [];
    auth.onSpotifySession((e) => events.push(e.kind === "owner" ? `owner:${e.prev}>${e.owner}` : e.kind));
    b.store.set("gtd-me", "Anna"); // e.g. the storage event was missed
    expect(auth.spotifyUserToken()).toBeNull(); // Anna is not signed in: never Tester's token
    expect(events).toEqual([]); // not during this call (it may be a render)
    await Promise.resolve();
    expect(events).toEqual(["owner:tester>anna"]);
    expect(auth.spotifyAuthState().status).toBe("out");
  });

  /** Spotify's token endpoint, answering each refresh token when told to. */
  function tokenEndpoint() {
    const waiting = new Map<string, (r: Response) => void>();
    const f = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((res) => waiting.set(new URLSearchParams(String(init?.body)).get("refresh_token")!, res))
    );
    vi.stubGlobal("fetch", f);
    return {
      f,
      answer: (refresh: string, r: Response) => waiting.get(refresh)!(r),
    };
  }

  it("F3: a refresh is per person: B never joins A's, and A's new token is not handed to B", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests({ access: "a-old", refresh: "a-ref", exp: Date.now() + 3600_000 });
    const ep = tokenEndpoint();
    const aRefresh = auth.refreshSpotifyToken();
    await vi.waitFor(() => expect(ep.f).toHaveBeenCalledTimes(1));
    b.store.set("gtd-me", "Bruno");
    auth.spotifyOwnerChanged();
    await auth.__setSpotifyTokenForTests({ access: "b-old", refresh: "b-ref", exp: Date.now() + 3600_000 });
    const bRefresh = auth.refreshSpotifyToken();
    expect(bRefresh).not.toBe(aRefresh);
    await vi.waitFor(() => expect(ep.f).toHaveBeenCalledTimes(2));
    ep.answer("a-ref", new Response(JSON.stringify({ access_token: "a-new", expires_in: 3600 }), { status: 200 }));
    ep.answer("b-ref", new Response(JSON.stringify({ access_token: "b-new", expires_in: 3600 }), { status: 200 }));
    expect(await aRefresh).toBeNull(); // A is no longer picked here: not used now
    expect(await bRefresh).toBe("b-new");
    expect(auth.spotifyUserToken()).toBe("b-new");
    b.store.set("gtd-me", "Tester");
    auth.spotifyOwnerChanged();
    expect(auth.spotifyUserToken()).toBe("a-new"); // kept for A
  });

  it("F3: A's refresh refused after B was picked signs out A, not B", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests({ access: "a-old", refresh: "a-ref", exp: Date.now() + 3600_000 });
    const ep = tokenEndpoint();
    const aRefresh = auth.refreshSpotifyToken();
    await vi.waitFor(() => expect(ep.f).toHaveBeenCalledTimes(1));
    b.store.set("gtd-me", "Bruno");
    auth.spotifyOwnerChanged();
    await auth.__setSpotifyTokenForTests({ access: "b-tok", exp: Date.now() + 3600_000 });
    ep.answer("a-ref", new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(await aRefresh).toBeNull();
    expect(auth.spotifyUserToken()).toBe("b-tok");
    expect(auth.spotifyAuthState().status).toBe("in");
    expect(b.store.has("gtd-spotify-token:bruno")).toBe(true);
    expect(b.store.has("gtd-spotify-token:tester")).toBe(false);
  });

  it("refused refresh, but another tab had refreshed first (rotated refresh token): its token is adopted, nobody is signed out", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    // Tab 1 and tab 2 both hold R1.
    const tab1 = await reload(keys);
    await tab1.__setSpotifyTokenForTests({ access: "old", refresh: "R1", exp: Date.now() + 1000 });
    const tab2 = await reload(keys);
    await tab2.whenSpotifyAuthReady();
    expect(tab2.spotifyUserToken()).toBe("old");
    const ep = tokenEndpoint();
    // Tab 2 asks with R1 ...
    const p2 = tab2.refreshSpotifyToken();
    await vi.waitFor(() => expect(ep.f).toHaveBeenCalledTimes(1));
    // ... meanwhile tab 1 refreshed and stored the rotated R2 (its write lands in the shared storage).
    await tab1.__setSpotifyTokenForTests({ access: "new-from-tab1", refresh: "R2", exp: Date.now() + 3600_000 });
    const stored = b.store.get("gtd-spotify-token:tester");
    // Spotify refuses tab 2's R1 (already spent).
    ep.answer("R1", new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(await p2).toBe("new-from-tab1");
    expect(tab2.spotifyUserToken()).toBe("new-from-tab1");
    expect(tab2.spotifyAuthState().status).toBe("in");
    expect(b.store.get("gtd-spotify-token:tester")).toBe(stored); // tab 1's fresh entry is not removed
    expect(tab2.spotifyRefreshFailure()).toBeNull();
  });

  it("a newer token stored by another tab is used without spending the refresh token again", async () => {
    fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const tab1 = await reload(keys);
    await tab1.__setSpotifyTokenForTests({ access: "old", refresh: "R1", exp: Date.now() + 1000 });
    const tab2 = await reload(keys);
    await tab2.whenSpotifyAuthReady();
    await tab1.__setSpotifyTokenForTests({ access: "fresh", refresh: "R2", exp: Date.now() + 3600_000 });
    const ep = tokenEndpoint();
    expect(await tab2.refreshSpotifyToken()).toBe("fresh");
    expect(ep.f).not.toHaveBeenCalled();
  });

  it.each([
    [500, { error: "server_error" }],
    [503, null],
    [429, { error: "rate_limited" }],
    [400, { error: "invalid_request" }],
  ])("refresh answered %i: not a refusal, the sign-in is kept (network)", async (status, body) => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests({ access: "a", refresh: "R", exp: Date.now() + 1000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body ? JSON.stringify(body) : "<html>", { status })));
    expect(await auth.refreshSpotifyToken()).toBeNull();
    expect(auth.spotifyRefreshFailure()).toBe("network");
    expect(auth.spotifyUserToken()).toBe("a");
    expect(b.store.has("gtd-spotify-token:tester")).toBe(true);
  });

  it("refresh answered 400 invalid_grant and no other tab refreshed: that person is signed out", async () => {
    const b = fakeBrowser("https://site.example/");
    const auth = await reload(deviceKeys());
    await auth.__setSpotifyTokenForTests({ access: "a", refresh: "R", exp: Date.now() + 1000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    expect(await auth.refreshSpotifyToken()).toBeNull();
    expect(auth.spotifyRefreshFailure()).toBe("refused");
    expect(auth.spotifyAuthState().status).toBe("out");
    expect(b.store.has("gtd-spotify-token:tester")).toBe(false);
  });

  it("the key store (IndexedDB) never answers: after KEYSTORE_MS signed out with a keystore event, the stored entry kept, nothing hangs", async () => {
    const b = fakeBrowser("https://site.example/");
    const keys = deviceKeys();
    const auth = await reload(keys);
    await auth.__setSpotifyTokenForTests(TOK);
    const entry = b.store.get("gtd-spotify-token:tester");
    vi.useFakeTimers();
    try {
      const auth2 = await reload({ get: () => new Promise<CryptoKey | null>(() => {}), putIfAbsent: () => new Promise<CryptoKey>(() => {}) });
      const events: unknown[] = [];
      auth2.onSpotifySession((e) => events.push(e));
      expect(auth2.spotifyAuthState().status).toBe("busy");
      let ready = false;
      void auth2.whenSpotifyAuthReady().then(() => (ready = true));
      await vi.advanceTimersByTimeAsync(auth2.KEYSTORE_MS - 10);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(ready).toBe(true);
      expect(auth2.spotifyAuthState().status).toBe("out");
      expect(auth2.spotifyUserToken()).toBeNull();
      expect(events).toEqual([{ kind: "loaded", owner: "tester", signedIn: false, error: "keystore" }]);
      expect(b.store.get("gtd-spotify-token:tester")).toBe(entry); // not removed: readable again once the store answers
    } finally {
      vi.useRealTimers();
    }
  });

  it("the key store never answers on a sign-in: the token is kept in memory only, never in plain storage", async () => {
    const b = fakeBrowser("https://site.example/");
    vi.useFakeTimers();
    try {
      const auth = await reload({ get: () => new Promise<CryptoKey | null>(() => {}), putIfAbsent: () => new Promise<CryptoKey>(() => {}) });
      const done = auth.__setSpotifyTokenForTests(TOK);
      await vi.advanceTimersByTimeAsync(auth.KEYSTORE_MS + 10);
      await done;
      expect(auth.spotifyUserToken()).toBe("SECRET-ACCESS");
      expect(b.written.some((w) => w.includes("SECRET"))).toBe(false);
      expect(b.store.has("gtd-spotify-token:tester")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
