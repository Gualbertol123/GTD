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
//   3. The token (and refresh token, expiry) lives in sessionStorage: this
//      tab only, gone when it closes. "Esci" forgets it.
// -----------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

export const SPOTIFY_CLIENT_ID: string = (import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "").trim();
export const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative";
const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
/** Where the app goes after the callback (the Spotify import page). */
export const AFTER_LOGIN_HASH = "#/music/spotify";
const PENDING_KEY = "gtd-spotify-pkce";
const TOKEN_KEY = "gtd-spotify-token";
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

// ---- The token (this tab only) ----------------------------------------------

export interface SpotifyToken {
  access: string;
  refresh?: string;
  /** ms since epoch. */
  exp: number;
}
export type SpotifyAuthState = { status: "out" } | { status: "busy" } | { status: "in" } | { status: "error"; error: string };

function readJson<T>(key: string): T | null {
  try {
    const s = sessionStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: the login lasts until reload */
  }
}

let memToken: SpotifyToken | null | undefined;
let authState: SpotifyAuthState | undefined;
const listeners = new Set<() => void>();
function emit(s: SpotifyAuthState) {
  authState = s;
  listeners.forEach((l) => l());
}

function storedToken(): SpotifyToken | null {
  if (memToken === undefined) {
    const t = readJson<SpotifyToken>(TOKEN_KEY);
    memToken = t && typeof t.access === "string" && t.access ? t : null;
  }
  return memToken;
}
function saveToken(t: SpotifyToken | null) {
  memToken = t;
  writeJson(TOKEN_KEY, t);
}

function currentState(): SpotifyAuthState {
  if (!authState) authState = storedToken() ? { status: "in" } : { status: "out" };
  return authState;
}

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

/** The user's token, or null when not signed in. */
export function spotifyUserToken(): string | null {
  return storedToken()?.access ?? null;
}

/** "Esci": forget the token in this tab. */
export function signOutSpotify(): void {
  saveToken(null);
  emit({ status: "out" });
}

/** "Accedi con Spotify": off to Spotify's login page. `link`: the playlist to import on return. */
export async function beginSpotifyLogin(link?: string): Promise<void> {
  if (!SPOTIFY_CLIENT_ID) return;
  const verifier = randomString(64);
  const state = randomString(43);
  writeJson(PENDING_KEY, { verifier, state, at: Date.now(), link: link?.trim() || undefined });
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

/** Spotify answered the token request with an error (not a network failure or timeout). */
class TokenRefused extends Error {}

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
    if (!res.ok || !j?.access_token) throw new TokenRefused(j?.error || `token ${res.status}`);
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
  const pending = readJson<{ verifier?: string; state?: string; at?: number; link?: string }>(PENDING_KEY);
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
      saveToken(t);
      emit({ status: "in" });
      return true;
    },
    (e) => {
      console.warn("spotify login failed:", e instanceof Error ? e.message : e);
      emit({ status: "error", error: "token" });
      return false;
    }
  );
}

/** One refresh shared by everyone asking at once. */
let refreshing: Promise<string | null> | null = null;

/** A new access token from the refresh token (after a 401). Null, and signed out, when that fails. */
export function refreshSpotifyToken(signal?: AbortSignal): Promise<string | null> {
  const t = storedToken();
  if (!t?.refresh || !SPOTIFY_CLIENT_ID) {
    if (t) signOutSpotify();
    return Promise.resolve(null);
  }
  refreshing ??= postToken({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: SPOTIFY_CLIENT_ID }, signal)
    .then((n) => {
      saveToken({ ...n, refresh: n.refresh ?? t.refresh });
      return n.access;
    })
    .catch((e) => {
      // Refused (revoked, expired): signed out. Offline or slow: kept for later.
      if (e instanceof TokenRefused) signOutSpotify();
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Tests: forget everything kept in memory. */
export function forgetSpotifyAuth(): void {
  memToken = undefined;
  authState = undefined;
  refreshing = null;
  returnLink = null;
}
