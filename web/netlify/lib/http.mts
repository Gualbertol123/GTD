// -----------------------------------------------------------------------------
// Shared by the music functions: JSON answers, the error codes the app knows,
// time limits, and a small in-memory cache.
//
// Error contract (the app maps each code to an IT / EN message, never shows
// the raw value): every error is JSON { "error": code } with
//   401 / 403 login · 400 server (bad request) · 404 not-found · 429 quota
//   502 unavailable (YouTube / Spotify / Supabase failed) · 504 timeout
//   503 no-key (the Data API fallback is needed but has no key)
// -----------------------------------------------------------------------------

import { checkTeam } from "./teamAuth.mts";

export type ErrorCode = "login" | "server" | "not-found" | "quota" | "unavailable" | "timeout" | "no-key";

const STATUS: Record<ErrorCode, number> = {
  login: 403,
  server: 400,
  "not-found": 404,
  quota: 429,
  unavailable: 502,
  timeout: 504,
  "no-key": 503,
};

export function json(status: number, body: unknown, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

/** An error answer with the contract's status. `status` overrides it (401 vs 403 for login). */
export function fail(code: ErrorCode, status = STATUS[code]): Response {
  return json(status, { error: code });
}

/**
 * Only the team may read this, so the browser may reuse an answer but no
 * shared cache (CDN) may keep it.
 */
export const cacheFor = (seconds: number) => `private, max-age=${seconds}`;

// ---- Errors that are an answer, not a fault ------------------------------------

/** "Nothing there" (a missing playlist, no charts): the caller answers 404, and the YouTube.js client stays. */
export class NotFoundError extends Error {
  constructor(what = "not-found") {
    super(what);
    this.name = "NotFoundError";
  }
}

/** A time limit ran out. */
export class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

/** True for our TimeoutError and for fetch's AbortSignal.timeout() abort. */
export const isTimeout = (e: unknown) => e instanceof TimeoutError || (e instanceof Error && e.name === "TimeoutError");

/** The contract code for something thrown while asking YouTube / Spotify. */
export function codeOf(e: unknown): ErrorCode {
  if (e instanceof NotFoundError) return "not-found";
  if (isTimeout(e)) return "timeout";
  return "unavailable";
}

// ---- Time limits -----------------------------------------------------------------

/**
 * Netlify stops a synchronous function after 10 s and answers with an HTML
 * page the app cannot read. Every music request therefore finishes within
 * this budget and answers 504 { error: "timeout" } itself.
 */
export const BUDGET_MS = 8500;

/** Rejects with TimeoutError after `ms`. The work itself goes on (Innertube cannot be cancelled), so callers must not start a fallback after it. */
export function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return Promise.reject(new TimeoutError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** How long a request that started at `start` may still run. */
export const msLeft = (start: number, budget = BUDGET_MS) => budget - (Date.now() - start);

// ---- A small cache shared by the requests of one warm instance -----------------

interface Entry<T> {
  p: Promise<T>;
  until: number;
}

/**
 * Keeps answers for `ttl` ms, at most `max` of them (the oldest go first).
 * A request already on its way is shared with every caller asking the same
 * thing at the same time; a failed one is dropped at once so the next call
 * tries again.
 */
export class TtlCache {
  private map = new Map<string, Entry<unknown>>();
  constructor(private max = 300, private now: () => number = Date.now) {}

  get size() {
    return this.map.size;
  }

  get<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key) as Entry<T> | undefined;
    if (hit && hit.until > this.now()) return hit.p;
    if (hit) this.map.delete(key);
    const p = fn();
    const entry: Entry<T> = { p, until: this.now() + ttl };
    this.set(key, entry);
    p.catch(() => {
      if (this.map.get(key) === entry) this.map.delete(key);
    });
    return p;
  }

  private set(key: string, entry: Entry<unknown>) {
    this.map.delete(key);
    if (this.map.size >= this.max) {
      const t = this.now();
      for (const [k, e] of this.map) if (e.until <= t) this.map.delete(k);
      // Still full: drop the oldest (a Map keeps insertion order).
      while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, entry);
  }
}

/** Words as a cache key: case and spacing do not make a new entry. */
export const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// ---- Login check, side by side with the free work ------------------------------

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Never rejects, so work started early cannot become an unhandled rejection. */
export const settle = <T,>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );

/**
 * Checks the team login while `early` already runs, so the two waits overlap.
 * `early` must be free work only (YouTube.js, Spotify's page): never anything
 * that spends the Data API quota, which waits for the "yes". Its result is
 * handed back only after the "yes", so nothing reaches a stranger.
 */
export async function gate<T>(req: Request, early: () => Promise<T>): Promise<{ denied: Response } | { result: Settled<T> }> {
  const authorization = req.headers.get("authorization") ?? "";
  // No token at all: nothing to start.
  if (!/^Bearer\s+\S+$/.test(authorization)) return { denied: fail("login", 401) };
  const work = settle(Promise.resolve().then(early));
  const who = await checkTeam(authorization);
  if (who === "unavailable") return { denied: fail("unavailable") };
  if (who === "no") return { denied: fail("login") };
  return { result: await work };
}
