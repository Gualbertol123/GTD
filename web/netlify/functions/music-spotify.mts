// -----------------------------------------------------------------------------
// "Importa da Spotify" (MUSICA tab → Importa):
//
//   GET  ?url=<Spotify playlist or album link>
//        → { kind, id, name, owner, cover, songs: [{ title, artist, ms }] }
//          (a playlist's first 100 songs, an album's all; lib/spotify.mts)
//   POST { songs: [{ title, artist, ms }, …] }   (up to 20 at a time)
//        → { matches: [{ id, title, channel, thumb } | null, …], failed: [i, …] }
//          each song found on YouTube (lib/ytjs.mts matchSong). null with its
//          index in `failed`: YouTube did not answer in time or failed, worth
//          asking again; null alone: YouTube has no good match.
//
// The app asks for the songs in small batches and shows the progress, so no
// single call comes near Netlify's time limit. No Spotify account, no API key,
// no YouTube quota. Only a logged-in team account may use it. Errors follow
// lib/http.mts ({ error: code }).
// -----------------------------------------------------------------------------

import { BUDGET_MS, type ErrorCode, codeOf, cacheFor, deadline, fail, gate, json, msLeft } from "../lib/http.mts";
import { parseSpotify, readSpotify } from "../lib/spotify.mts";
import { matchSong } from "../lib/ytjs.mts";

/** Songs per POST: ~20 YouTube searches at once take ~1 s; the cap keeps a call far from the time limit. */
const BATCH = 20;

type Match = Awaited<ReturnType<typeof matchSong>>;
type Failed = { failed: ErrorCode };

export default async (req: Request): Promise<Response> => {
  const start = Date.now();
  if (req.method !== "GET" && req.method !== "POST") return fail("server", 405);

  if (req.method === "GET") {
    const target = parseSpotify(new URL(req.url).searchParams.get("url") ?? "");
    if (!target) return fail("server");
    // Spotify's page is read while the login is checked.
    const g = await gate(req, () => readSpotify(target.kind, target.id));
    if ("denied" in g) return g.denied;
    if (g.result.ok) return json(200, g.result.value, cacheFor(600));
    const e = g.result.error;
    console.warn("spotify read failed:", e instanceof Error ? e.message : e);
    return fail(codeOf(e));
  }

  let body: { songs?: { title?: unknown; artist?: unknown; ms?: unknown }[] };
  try {
    body = await req.json();
  } catch {
    return fail("server");
  }
  const songs = (Array.isArray(body?.songs) ? body.songs : []).slice(0, BATCH).map((s) => ({
    title: String(s?.title ?? "").slice(0, 200),
    artist: String(s?.artist ?? "").slice(0, 200),
    ms: Number(s?.ms) || 0,
  }));
  if (!songs.length) return fail("server");

  // Every song is searched at once, while the login is checked. A failure or
  // timeout is reported in `failed`, not hidden as "no match".
  const g = await gate(req, () => {
    const ms = msLeft(start, BUDGET_MS - 500);
    return Promise.all(
      songs.map((s): Promise<Match | Failed> =>
        s.title
          ? deadline(matchSong(s.title, s.artist, s.ms), ms).catch((e) => {
              console.warn("spotify match failed:", e instanceof Error ? e.message : e);
              return { failed: codeOf(e) };
            })
          : Promise.resolve(null)
      )
    );
  });
  if ("denied" in g) return g.denied;
  if (!g.result.ok) return fail(codeOf(g.result.error)); // not expected: each song catches its own
  const failed: number[] = [];
  const codes = new Set<ErrorCode>();
  const matches = g.result.value.map((m, i) => {
    if (!m || !("failed" in m)) return m;
    failed.push(i);
    codes.add(m.failed);
    return null;
  });
  // Nothing answered at all: YouTube is down for us, say so (the app retries).
  if (failed.length === songs.length) return fail(codes.has("timeout") ? "timeout" : "unavailable");
  return json(200, { matches, failed });
};
