// -----------------------------------------------------------------------------
// "Accedi con Spotify": the Authorization Code flow with PKCE, entirely in the
// browser. No secret is involved: only the app's public Client ID
// (VITE_SPOTIFY_CLIENT_ID, public like the Supabase anon key).
//
// Why: since February 2026 a Spotify app in Development Mode gets a playlist's
// songs only for playlists the signed-in user owns or collaborates on. The
// site's own keys (server, Client Credentials) give only the details, so a
// person who signs in lets this tab read their own playlists in full
// (lib/music.ts readSpotifyAsUser).
//
//   1. beginSpotifyLogin(): a random verifier + state kept in sessionStorage,
//      then accounts.spotify.com/authorize (S256 challenge).
//   2. Spotify sends the browser back to `${origin}/callback?code&state`
//      (Netlify serves index.html there). main.tsx calls handleSpotifyCallback()
//      once, before React: the address becomes /#/music/spotify at once (the
//      hash router never sees /callback), then the code is exchanged.
//   3. The token (and refresh token, expiry) belongs to the PERSON picked in
//      the identity menu on THIS device (the team shares one login): sealed
//      with AES-GCM under a non-extractable key kept in this browser's
//      IndexedDB, so a copy of it is useless anywhere else (see "The token"
//      below). "Esci" forgets it.
// -----------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import { readMe } from "./prefs";

export const SPOTIFY_CLIENT_ID: string = (import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "").trim();
export const SPOTIFY_SCOPES = [
  // Import: your playlists (own + collaborative), liked songs, saved albums,
  // followed artists, recently played.
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-follow-read",
  "user-read-recently-played",
  // Spotify mode: the Web Playback SDK and the player endpoints (Premium).
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");
const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
/** Where the app goes after the callback (the Spotify import page). */
export const AFTER_LOGIN_HASH = "#/music/spotify";
const PENDING_KEY = "gtd-spotify-pkce";
/**
 * The token is kept per PERSON per DEVICE: the team shares one login, so a
 * Spotify sign-in belongs to the name picked in the identity menu on this
 * device (localStorage key gtd-spotify-token:<name>), never to the shared
 * account and never in the database. Another name on the same device sees its
 * own Spotify session (or none).
 */
const TOKEN_KEY = "gtd-spotify-token";
/** The identity pref's localStorage key (prefs.ts KEYS.me). */
const ME_KEY = "gtd-me";
/** The device key store (IndexedDB) answers within this, or is taken as not available (some WebKit builds never settle an open). */
export const KEYSTORE_MS = 3000;
/** Whose Spotify session is in use: the identity picked on this device ("" = none). */
export function spotifyOwner(): string {
  return readMe().trim().toLowerCase();
}
const tokenKey = (owner = spotifyOwner()) => `${TOKEN_KEY}:${owner}`;
const TOKEN_MS = 10000;
/** A login started more than this long ago is not finished. */
const PENDING_MAX_MS = 15 * 60_000;

/** Is "Accedi con Spotify" offered (the Client ID was set at build time)? */
export const spotifyLoginAvailable = () => !!SPOTIFY_CLIENT_ID;

// ---- PKCE helpers (pure, unit-tested) ---------------------------------------

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** base64url without padding (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random string of unreserved characters (RFC 7636: 43–128 long). */
export function randomString(length = 64): string {
  const n = Math.min(128, Math.max(43, length));
  // Bytes of 198 and above are dropped (198 = 3 × 66), so every character is equally likely.
  const limit = 256 - (256 % UNRESERVED.length);
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n))) {
      if (b < limit && out.length < n) out += UNRESERVED[b % UNRESERVED.length];
    }
  }
  return out;
}

/** The S256 code challenge: base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The state Spotify sent back matches the one stored before the redirect (and both exist). */
export function stateMatches(stored: string | null | undefined, got: string | null | undefined): boolean {
  if (!stored || !got || stored.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export type Callback = { code: string; state: string } | { error: string; state: string };

/** The answer in a /callback address (?code&state, or ?error&state); null for any other address. */
export function parseCallback(href: string): Callback | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.pathname !== "/callback") return null;
  const state = u.searchParams.get("state") ?? "";
  const code = u.searchParams.get("code");
  if (code) return { code, state };
  const error = u.searchParams.get("error");
  if (error) return { error, state };
  return null;
}

/** The authorize address for a verifier's challenge. */
export function authorizeUrl(challenge: string, state: string, redirectUri: string, clientId = SPOTIFY_CLIENT_ID): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SPOTIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${AUTHORIZE}?${q}`;
}

export const redirectUri = () => `${location.origin}/callback`;

// ---- The token (this person, this device) -----------------------------------
//
// At rest the token is sealed with AES-GCM under a key made on THIS device
// (WebCrypto, extractable: false) and kept in IndexedDB ("gtd-spotify" /
// "keys"). localStorage holds only {v, iv, ct} per person; the person's key
// name is the additional data, so an entry cannot be moved to another name
// either. A copy of the entry on another browser or device finds no key
// there: it is removed and that person is signed out. No WebCrypto or no
// IndexedDB (private mode, an old browser, http): the token lives in memory
// for this tab only, never in plain storage.

export interface SpotifyToken {
  access: string;
  refresh?: string;
  /** ms since epoch. */
  exp: number;
}
export type SpotifyAuthState = { status: "out" } | { status: "busy" } | { status: "in" } | { status: "error"; error: string };

function readJson<T>(key: string, store: "session" | "local" = "session"): T | null {
  try {
    const s = (store === "local" ? localStorage : sessionStorage).getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, v: unknown, store: "session" | "local" = "session"): void {
  try {
    const st = store === "local" ? localStorage : sessionStorage;
    if (v === null) st.removeItem(key);
    else st.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: the login lasts until reload */
  }
}

// ---- Logging and session events (lib/spotifyPlayer hooks mlog in) ---------------

type AuthLog = (ev: string, data?: unknown, level?: "info" | "warn") => void;
let logger: AuthLog | null = null;
const early: [string, unknown?, ("info" | "warn")?][] = [];
function alog(ev: string, data?: unknown, level: "info" | "warn" = "info"): void {
  if (logger) return logger(ev, data, level);
  early.push([ev, data, level]);
  if (early.length > 50) early.shift();
}
/** Where this module's decisions are logged (music.ts mlog, set by spotifyPlayer). Earlier lines are replayed. */
export function setSpotifyAuthLogger(f: AuthLog | null): void {
  logger = f;
  if (f) early.splice(0).forEach(([e, d, l]) => f(e, d, l));
}

export type SpotifySessionEvent =
  /** Another name was picked on this device: `name` as shown, `owner` lowercased. */
  | { kind: "owner"; owner: string; name: string; prev: string }
  /** The stored sign-in of `owner` was read (decrypted, or refused). keystore: this device's key store did not answer (the entry is kept). */
  | { kind: "loaded"; owner: string; signedIn: boolean; error?: "keystore" }
  /** "Accedi con Spotify" without a name picked. */
  | { kind: "no-identity" };
const sessionListeners = new Set<(e: SpotifySessionEvent) => void>();
/** Told BEFORE the auth state changes (so a listener acts before the views re-render). */
export function onSpotifySession(cb: (e: SpotifySessionEvent) => void): () => void {
  sessionListeners.add(cb);
  return () => void sessionListeners.delete(cb);
}
function notify(e: SpotifySessionEvent): void {
  sessionListeners.forEach((l) => {
    try {
      l(e);
    } catch (err) {
      console.warn("spotify session listener failed:", err);
    }
  });
}

// ---- The device key (AES-GCM, not extractable, in IndexedDB) ----------------------

/** Where this device's key is kept. IndexedDB in the browser; tests inject one. */
export interface DeviceKeyStore {
  get(): Promise<CryptoKey | null>;
  /** Keeps k unless a key is there already (another tab was first); returns the key kept. */
  putIfAbsent(k: CryptoKey): Promise<CryptoKey>;
}
export const KEY_DB = "gtd-spotify";
export const KEY_STORE = "keys";
const KEY_ID = "device";

function idbKeyStore(): DeviceKeyStore | null {
  if (typeof indexedDB === "undefined" || !indexedDB) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(KEY_DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(KEY_STORE)) r.result.createObjectStore(KEY_STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("indexedDB open failed"));
      r.onblocked = () => reject(new Error("indexedDB blocked"));
    }).catch((e) => {
      dbp = null;
      throw e;
    }));
  const run = <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest) =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const r = f(d.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
          r.onsuccess = () => resolve(r.result as T);
          r.onerror = (ev) => {
            ev.preventDefault();
            reject(r.error ?? new Error("indexedDB request failed"));
          };
        })
    );
  const get = async () => {
    const v = await run<unknown>("readonly", (s) => s.get(KEY_ID));
    return v && typeof v === "object" ? (v as CryptoKey) : null;
  };
  return {
    get,
    async putIfAbsent(k) {
      try {
        await run("readwrite", (s) => s.add(k, KEY_ID));
        return k;
      } catch (e) {
        const there = await get();
        if (there) return there;
        throw e;
      }
    },
  };
}

const subtleOk = () => typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.getRandomValues === "function";
/** undefined: not decided yet; null: no WebCrypto / IndexedDB (memory only). */
let keyStore: DeviceKeyStore | null | undefined;
let keyCache: CryptoKey | null = null;
function vault(): DeviceKeyStore | null {
  if (keyStore === undefined) {
    keyStore = subtleOk() ? idbKeyStore() : null;
    if (!keyStore) alog("Spotify sign-in: no WebCrypto or IndexedDB here: the token is kept in memory for this tab only", { webcrypto: subtleOk() }, "warn");
  }
  return keyStore;
}

/** The key store did not answer in KEYSTORE_MS (not the same as "no key"). */
class KeyStoreTimeout extends Error {}
function inTime<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KeyStoreTimeout(`${what}: no answer in ${KEYSTORE_MS} ms`)), KEYSTORE_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** This device's key: read once; made (not extractable) the first time a token is saved. Rejects when the store does not answer in time. */
async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const st = vault();
  if (!st) return null;
  if (keyCache) return keyCache;
  let k = await inTime(st.get(), "key store read");
  if (!k && create) {
    const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    k = await inTime(st.putIfAbsent(fresh), "key store write");
    alog("Spotify sign-in: this device's key was made (AES-GCM 256, not extractable, IndexedDB)");
  }
  if (k) keyCache = k;
  return k;
}

interface Sealed {
  v: 1;
  iv: string;
  ct: string;
}
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const isSealed = (v: unknown): v is Sealed => !!v && typeof v === "object" && typeof (v as Sealed).iv === "string" && typeof (v as Sealed).ct === "string";

async function seal(t: SpotifyToken, owner: string): Promise<Sealed> {
  const key = await deviceKey(true);
  if (!key) throw new Error("no device key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({ access: t.access, refresh: t.refresh, exp: t.exp }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(tokenKey(owner)) }, key, plain);
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Set when the last unseal could not reach the key store (timeout or error): the entry was kept. */
let keyStoreDown = false;
/** The token in a sealed entry, or null (removed) when this device cannot open it. */
async function unseal(s: Sealed, owner: string): Promise<SpotifyToken | null> {
  let key: CryptoKey | null;
  keyStoreDown = false;
  try {
    key = await deviceKey(false);
  } catch (e) {
    // The key store is not answering (not the same as "no key"): signed out in this tab, the entry kept.
    keyStoreDown = true;
    alog("Spotify sign-in: this device's key store is not available: signed out in this tab, the stored sign-in kept", { error: e instanceof Error ? e.message : String(e), timeout: e instanceof KeyStoreTimeout }, "warn");
    return null;
  }
  const drop = (why: string) => {
    alog(`Spotify sign-in for "${owner}" can't be read on this device (${why}): removed, sign in again`, undefined, "warn");
    writeJson(tokenKey(owner), null, "local");
    return null;
  };
  if (!key) return vault() ? drop("no key here: copied from another browser or device?") : null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: enc.encode(tokenKey(owner)) }, key, unb64(s.ct));
    const t = JSON.parse(new TextDecoder().decode(plain)) as SpotifyToken;
    if (!t || typeof t.access !== "string" || !t.access) return drop("not a token");
    return { access: t.access, refresh: typeof t.refresh === "string" ? t.refresh : undefined, exp: Number(t.exp) || 0 };
  } catch {
    return drop("another device's key, or changed");
  }
}

/** The sealed entry of `owner`; an old plain-text entry is removed (that person signs in again). */
function readSealed(owner: string): Sealed | null {
  const v = readJson<unknown>(tokenKey(owner), "local");
  if (v === null) return null;
  if (isSealed(v)) return v;
  alog(`Spotify sign-in for "${owner}" was stored in plain text (older version): removed, sign in again`, undefined, "warn");
  writeJson(tokenKey(owner), null, "local");
  return null;
}

let swept = false;
/** Once: tokens stored in plain text by older versions are removed (gtd-spotify-token, gtd-spotify-token:<name>). */
function sweepPlain(): void {
  if (swept) return;
  swept = true;
  let n = 0;
  try {
    if (sessionStorage.getItem(TOKEN_KEY) !== null) {
      sessionStorage.removeItem(TOKEN_KEY);
      n++;
    }
  } catch {
    /* no storage */
  }
  try {
    if (localStorage.getItem(TOKEN_KEY) !== null) {
      localStorage.removeItem(TOKEN_KEY);
      n++;
    }
    const keys: string[] = [];
    for (let i = 0; i < (localStorage.length ?? 0); i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(TOKEN_KEY + ":")) keys.push(k);
    }
    for (const k of keys) {
      if (!isSealed(readJson<unknown>(k, "local"))) {
        localStorage.removeItem(k);
        n++;
      }
    }
  } catch {
    /* no storage, or no key() in this storage */
  }
  if (n) alog("Spotify sign-ins stored in plain text by an older version were removed (sign in again)", { entries: n }, "warn");
}

// ---- The session in memory ----------------------------------------------------------

/** Whose token memToken is ("" = no name; undefined = not read yet). */
let memOwner: string | undefined;
let memToken: SpotifyToken | null = null;
/** This tab's tokens per person (decrypted once, or the memory-only fallback). */
const inMemory = new Map<string, SpotifyToken>();
let loadSeq = 0;
let loading: Promise<void> | null = null;
const writeGen = new Map<string, number>();
let writes: Promise<void> = Promise.resolve();
let authState: SpotifyAuthState | undefined;
const listeners = new Set<() => void>();
function emit(s: SpotifyAuthState) {
  authState = s;
  listeners.forEach((l) => l());
}

/** Reads `owner`'s sign-in into memory: at once from this tab's memory, or decrypted (state "busy" meanwhile). No emit (it may run during a render). */
function load(owner: string): void {
  memOwner = owner;
  memToken = null;
  loading = null;
  const seq = ++loadSeq;
  sweepPlain();
  const mem = owner ? inMemory.get(owner) : undefined;
  if (!owner || mem) {
    memToken = mem ?? null;
    authState = mem ? { status: "in" } : { status: "out" };
    return;
  }
  const sealed = readSealed(owner);
  if (!sealed) {
    authState = { status: "out" };
    return;
  }
  authState = { status: "busy" };
  loading = unseal(sealed, owner).then((t) => {
    if (seq !== loadSeq) return;
    loading = null;
    memToken = t;
    if (t) inMemory.set(owner, t);
    const down = !t && keyStoreDown;
    alog(t ? `Spotify sign-in of "${owner}" read on this device` : `Spotify: "${owner}" is not signed in on this device`, down ? { keyStore: "not answering" } : undefined);
    notify(down ? { kind: "loaded", owner, signedIn: false, error: "keystore" } : { kind: "loaded", owner, signedIn: !!t });
    emit(t ? { status: "in" } : { status: "out" });
  });
}

function storedToken(): SpotifyToken | null {
  const owner = spotifyOwner();
  if (memOwner !== owner) {
    // Another name was picked where this tab did not hear it (another tab): the same
    // owner switch as spotifyOwnerChanged, its events after this call (it may run
    // during a render), so the previous person's device and data are dropped too.
    const prev = memOwner;
    load(owner);
    if (prev !== undefined) {
      alog("Spotify session follows a name picked elsewhere (another tab)", { from: prev || null, to: owner || null, state: authState?.status });
      queueMicrotask(() => {
        if (memOwner !== owner) return;
        notify({ kind: "owner", owner, name: readMe().trim(), prev });
        emit(authState ?? { status: "out" });
      });
    }
  }
  return memToken;
}

function saveToken(t: SpotifyToken | null, owner = spotifyOwner()) {
  if (!owner) return;
  if (owner === spotifyOwner()) {
    memOwner = owner;
    memToken = t;
    loadSeq++; // a read still running for this person is now old
    loading = null;
  }
  const gen = (writeGen.get(owner) ?? 0) + 1;
  writeGen.set(owner, gen);
  if (!t) {
    inMemory.delete(owner);
    writeJson(tokenKey(owner), null, "local");
    return;
  }
  inMemory.set(owner, t);
  if (!vault()) return; // memory only (logged once)
  writes = writes
    .then(() => seal(t, owner))
    .then(
      (s) => {
        if (writeGen.get(owner) === gen) writeJson(tokenKey(owner), s, "local");
      },
      (e) => {
        // Kept for this tab only: never in plain storage.
        alog("Spotify sign-in could not be sealed on this device: kept in memory for this tab only", { error: e instanceof Error ? e.message : String(e) }, "warn");
      }
    );
}

/**
 * The name picked on this device changed (IdentityProvider): the Spotify
 * session is now that person's (or none). Nothing of the previous person's
 * is used. Listeners hear it first (Spotify mode drops the old device).
 */
export function spotifyOwnerChanged(): void {
  const owner = spotifyOwner();
  if (owner === memOwner) return;
  const prev = memOwner ?? "";
  load(owner);
  alog("Spotify session follows the name picked on this device", { from: prev || null, to: owner || null, state: authState?.status });
  notify({ kind: "owner", owner, name: readMe().trim(), prev });
  emit(authState ?? { status: "out" });
}

function currentState(): SpotifyAuthState {
  storedToken(); // first: a name changed elsewhere reads that person's sign-in
  if (!authState) authState = memToken ? { status: "in" } : { status: "out" };
  return authState;
}

/** The login state now (outside React). */
export const spotifyAuthState = (): SpotifyAuthState => currentState();

/** The login state, for the Spotify page. */
export function useSpotifyAuth(): SpotifyAuthState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    currentState,
    currentState
  );
}

/** Resolves once this person's stored sign-in has been read (decrypted) on this device. */
export function whenSpotifyAuthReady(): Promise<void> {
  storedToken();
  return loading ?? Promise.resolve();
}

/** The user's token, or null when not signed in (or still being read). */
export function spotifyUserToken(): string | null {
  return storedToken()?.access ?? null;
}

/** When the token in hand runs out (ms since epoch), or null when there is none. */
export function spotifyTokenExpiry(): number | null {
  return storedToken()?.exp ?? null;
}

/** "Esci": forget this person's token on this device. */
export function signOutSpotify(): void {
  saveToken(null);
  emit({ status: "out" });
}

// Another tab of this browser picked another name (gtd-me), signed in, refreshed or signed out: read it again.
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === ME_KEY || e.key === null) {
        // The name picked on this device changed in another tab: this tab's Spotify session follows it.
        spotifyOwnerChanged();
        return;
      }
      const owner = memOwner;
      if (!owner || e.key !== tokenKey(owner)) return;
      const v = (() => {
        try {
          return e.newValue ? (JSON.parse(e.newValue) as unknown) : null;
        } catch {
          return null;
        }
      })();
      if (!isSealed(v)) {
        alog("Spotify sign-out in another tab: signed out here too");
        inMemory.delete(owner);
        memToken = null;
        loadSeq++;
        emit({ status: "out" });
        return;
      }
      // Signed in or refreshed in another tab: the new token replaces this one when it is read (no gap).
      const seq = loadSeq;
      void unseal(v, owner).then((t) => {
        if (seq !== loadSeq || memOwner !== owner || !t) return;
        alog("Spotify sign-in changed in another tab: using it here too");
        inMemory.set(owner, t);
        memToken = t;
        emit({ status: "in" });
      });
    });
  }
} catch {
  /* not a browser */
}

/** "Accedi con Spotify": off to Spotify's login page. `link`: the playlist to import on return. */
export async function beginSpotifyLogin(link?: string): Promise<void> {
  if (!SPOTIFY_CLIENT_ID) return;
  // A Spotify session belongs to a person: pick your name first (the team shares one login).
  if (!spotifyOwner()) {
    alog("Accedi con Spotify refused: no name picked on this device (the Spotify session is personal)", undefined, "warn");
    notify({ kind: "no-identity" });
    emit({ status: "error", error: "no-identity" });
    return;
  }
  const verifier = randomString(64);
  const state = randomString(43);
  writeJson(PENDING_KEY, { verifier, state, at: Date.now(), link: link?.trim() || undefined, owner: spotifyOwner() });
  emit({ status: "busy" });
  // Back from Spotify's page without signing in (page restored from the back/forward cache): the button again.
  window.addEventListener("pageshow", (e) => e.persisted && authState?.status === "busy" && emit(storedToken() ? { status: "in" } : { status: "out" }), { once: true });
  location.assign(authorizeUrl(await codeChallenge(verifier), state, redirectUri()));
}

/** The link the person was importing when they went to sign in (asked once). */
let returnLink: string | null = null;
export function takeReturnLink(): string | null {
  const l = returnLink;
  returnLink = null;
  return l;
}

/** Spotify refused the grant itself (400 invalid_grant: revoked, expired or already used). Signs out. */
class TokenRefused extends Error {}
/** Spotify answered with another error (5xx, 429, a bad answer): not about the grant, the sign-in is kept. */
class TokenUnavailable extends Error {}

async function postToken(body: Record<string, string>, signal?: AbortSignal): Promise<SpotifyToken> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: ctrl.signal,
    });
    const j = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
    if (res.status === 400 && j?.error === "invalid_grant") throw new TokenRefused(`token ${res.status} invalid_grant`);
    if (!res.ok || !j?.access_token) throw new TokenUnavailable(`token ${res.status}${j?.error ? ` ${j.error}` : ""}`);
    return { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Called once at startup (main.tsx), before React renders. On /callback: the
 * address becomes /#/music/spotify at once, then the code is exchanged for a
 * token. Returns the exchange (resolves true when signed in), or null when
 * this is not a callback.
 */
export function handleSpotifyCallback(): Promise<boolean> | null {
  if (location.pathname !== "/callback") return null;
  const cb = parseCallback(location.href);
  // Whatever happened, leave /callback for the app's own address (keeps the hash routes).
  history.replaceState(null, "", "/" + AFTER_LOGIN_HASH);
  const pending = readJson<{ verifier?: string; state?: string; at?: number; link?: string; owner?: string }>(PENDING_KEY);
  writeJson(PENDING_KEY, null); // used once
  if (!cb) return Promise.resolve(false);
  if (pending?.link) returnLink = pending.link;
  if ("error" in cb) {
    emit(cb.error === "access_denied" ? { status: "out" } : { status: "error", error: cb.error });
    return Promise.resolve(false);
  }
  if (!pending?.verifier || !stateMatches(pending.state, cb.state) || !(Date.now() - (pending.at ?? 0) < PENDING_MAX_MS) || !SPOTIFY_CLIENT_ID) {
    emit({ status: "error", error: "state" });
    return Promise.resolve(false);
  }
  emit({ status: "busy" });
  return postToken({
    grant_type: "authorization_code",
    code: cb.code,
    redirect_uri: redirectUri(),
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: pending.verifier,
  }).then(
    (t) => {
      // Kept for the person who started the sign-in (the name picked then).
      const owner = pending.owner || spotifyOwner();
      if (!owner) {
        emit({ status: "error", error: "no-identity" });
        return false;
      }
      saveToken(t, owner);
      alog(`Spotify sign-in saved for "${owner}" on this device (sealed with this device's key)`);
      emit(owner === spotifyOwner() ? { status: "in" } : { status: "out" });
      return owner === spotifyOwner();
    },
    (e) => {
      console.warn("spotify login failed:", e instanceof Error ? e.message : e);
      emit({ status: "error", error: "token" });
      return false;
    }
  );
}

/** One refresh per PERSON, shared by everyone asking for that person at once (never across people). */
const refreshing = new Map<string, Promise<string | null>>();
let lastRefreshFailure: "refused" | "network" | null = null;
/** Why the last refresh failed: "network" = accounts.spotify.com did not answer, is blocked, or answered 5xx / 429. */
export const spotifyRefreshFailure = () => lastRefreshFailure;

/** Runs f under a lock shared by this browser's tabs (Web Locks), so two tabs never spend the same refresh token. */
function underLock<T>(name: string, f: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks || typeof locks.request !== "function") return f();
  return locks.request(name, f) as Promise<T>;
}

/**
 * A token of `owner` newer than `t`, saved by another tab of this browser (it refreshed first,
 * and Spotify rotates refresh tokens, so `t`'s may already be spent). Taken into memory.
 */
async function newerToken(owner: string, t: SpotifyToken): Promise<SpotifyToken | null> {
  const newer = (u: SpotifyToken | null | undefined): u is SpotifyToken => !!u && u.access !== t.access && (u.exp > t.exp || (!!u.refresh && u.refresh !== t.refresh));
  let u: SpotifyToken | null | undefined = inMemory.get(owner);
  if (!newer(u)) {
    const sealed = readSealed(owner);
    u = sealed ? await unseal(sealed, owner) : null;
  }
  if (!newer(u)) return null;
  inMemory.set(owner, u);
  if (memOwner === owner) memToken = u;
  return u;
}

async function runRefresh(owner: string, t: SpotifyToken, signal?: AbortSignal): Promise<string | null> {
  const used = t.refresh!;
  return underLock(`gtd-spotify-refresh:${owner}`, async () => {
    const first = await newerToken(owner, t);
    if (first) {
      alog(`Spotify token of "${owner}" was already refreshed in another tab: using it`);
      lastRefreshFailure = null;
      return first.access;
    }
    try {
      const n = await postToken({ grant_type: "refresh_token", refresh_token: used, client_id: SPOTIFY_CLIENT_ID }, signal);
      lastRefreshFailure = null;
      saveToken({ ...n, refresh: n.refresh ?? used }, owner);
      await writes; // sealed and stored before the lock is let go: the next tab finds it
      return n.access;
    } catch (e) {
      // Refused (400 invalid_grant): signed out. Offline, slow, 5xx / 429, or accounts.spotify.com blocked: kept for later.
      const refused = e instanceof TokenRefused;
      lastRefreshFailure = refused ? "refused" : "network";
      alog(`Spotify token refresh failed (${lastRefreshFailure})`, { owner, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "warn");
      if (!refused) return null;
      // Another tab may have spent this refresh token just before (no Web Locks in this browser): use its token.
      const other = await newerToken(owner, t);
      if (other) {
        alog(`Spotify refresh refused, but another tab had refreshed "${owner}": using its token, still signed in`);
        lastRefreshFailure = null;
        return other.access;
      }
      // Only the person this refresh was for is signed out, even if another name was picked meanwhile.
      alog(`Spotify sign-in of "${owner}" refused by Spotify: signed out on this device`, undefined, "warn");
      saveToken(null, owner);
      if (owner === spotifyOwner()) emit({ status: "out" });
      return null;
    }
  });
}

/**
 * A new access token from the refresh token (after a 401). Null, and signed out, when Spotify
 * refuses it (400 invalid_grant); null, still signed in, when it does not answer or answers
 * 5xx / 429. The refresh belongs to the person picked when it started: callers for another
 * person never join it, and if another name is picked meanwhile its token is saved for its
 * owner but not handed out (null).
 */
export function refreshSpotifyToken(signal?: AbortSignal): Promise<string | null> {
  const owner = spotifyOwner();
  const t = storedToken();
  if (!t?.refresh || !SPOTIFY_CLIENT_ID) {
    if (t) signOutSpotify();
    return Promise.resolve(null);
  }
  let p = refreshing.get(owner);
  if (!p) {
    const job: Promise<string | null> = runRefresh(owner, t, signal).finally(() => {
      if (refreshing.get(owner) === job) refreshing.delete(owner);
    });
    refreshing.set(owner, job);
    p = job;
  }
  return p.then((access) => {
    if (access && spotifyOwner() !== owner) {
      alog("Spotify token refreshed for a person no longer picked here: kept for them, not used now", { owner, now: spotifyOwner() || null });
      return null;
    }
    return access;
  });
}

/** Tests: forget everything kept in memory. */
export function forgetSpotifyAuth(): void {
  memToken = null;
  memOwner = undefined;
  authState = undefined;
  inMemory.clear();
  writeGen.clear();
  loadSeq++;
  loading = null;
  keyCache = null;
  swept = false;
  refreshing.clear();
  lastRefreshFailure = null;
  keyStoreDown = false;
  returnLink = null;
}

/** Tests: the device key store to use (null: none, memory only; undefined: decide again). */
export function __setSpotifyKeyStoreForTests(s: DeviceKeyStore | null | undefined): void {
  keyStore = s;
  keyCache = null;
}

/** Tests: sign a person in (the one picked now, by default) with this token, sealed like a real sign-in. Resolves when written. */
export function __setSpotifyTokenForTests(t: SpotifyToken | null, owner = spotifyOwner()): Promise<void> {
  saveToken(t, owner);
  if (owner === spotifyOwner()) emit(t ? { status: "in" } : { status: "out" });
  return writes;
}

/** Tests: the token this tab holds for the person picked (null: none). */
export const __spotifyTokenForTests = (): SpotifyToken | null => storedToken();

/** Tests: resolves when the sealed writes started so far are done. */
export const __spotifyWritesForTests = (): Promise<void> => writes;
