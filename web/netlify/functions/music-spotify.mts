// -----------------------------------------------------------------------------
// "Importa da Spotify" (MUSICA tab → Importa):
//
//   GET  ?url=<Spotify playlist or album link>
//        → { kind, id, name, owner, cover, songs: [{ title, artist, ms }],
//            via: "api" | "embed", total?, truncated?, limited?, reason? }
//          via "api": the official Web API with the site's own keys (env
//          SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET), all songs up to 1000
//          (`truncated` beyond; `total` = the real count). via "embed":
//          Spotify's public embed page (no key, a playlist's first 100);
//          `limited` = a playlist of 100+ songs, there may be more; `reason`
//          = "no-key" | "spotify-owned" | "api-error" | "owner-only" (the
//          API gave only the details: since February 2026 a Development
//          Mode app reads the songs only of the signed-in user's own
//          playlists; name and cover then come from the API). lib/spotify.mts.
//   POST { tracks: ["<22-char track id>", …] }   (up to 50 at a time)
//        → { songs: [{ title, artist, ms } | null, …], failed: [i, …] }
//          songs copied from the Spotify app and pasted (one track link per
//          line), each read from its public embed page. null with its index in
//          `failed`: Spotify did not answer in time or failed, worth asking
//          again; null alone: no such song.
//   POST { songs: [{ title, artist, ms }, …] }   (up to 20 at a time)
//        → { matches: [{ id, title, channel, thumb } | null, …], failed: [i, …] }
//          each song found on YouTube (lib/ytjs.mts matchSong). null with its
//          index in `failed`: YouTube did not answer in time or failed, worth
//          asking again; null alone: YouTube has no good match.
//
// The app asks for the songs in small batches and shows the progress, so no
// single call comes near Netlify's time limit. No Spotify account needed, no
// YouTube quota. Only a logged-in team account may use it. Errors follow
// lib/http.mts ({ error: code }).
// -----------------------------------------------------------------------------

import { BUDGET_MS, type ErrorCode, codeOf, cacheFor, deadline, fail, gate, json, msLeft } from "../lib/http.mts";
import { isTrackId, parseSpotify, readSpotify, readSpotifyTrack, type SpotifySong } from "../lib/spotify.mts";
import { matchSong } from "../lib/ytjs.mts";

/** Songs per POST: ~20 YouTube searches at once take ~1 s; the cap keeps a call far from the time limit. */
const BATCH = 20;
/** Track links per POST, and how many of their pages are read at once. */
const TRACKS = 50;
const TRACKS_AT_ONCE = 8;

type Match = Awaited<ReturnType<typeof matchSong>>;
type Failed = { failed: ErrorCode };

export default async (req: Request): Promise<Response> => {
  const start = Date.now();
  if (req.method !== "GET" && req.method !== "POST") return fail("server", 405);

  if (req.method === "GET") {
    const target = parseSpotify(new URL(req.url).searchParams.get("url") ?? "");
    if (!target) return fail("server");
    // Spotify's page is read once the login is a "yes" (overlapped with the
    // check for a member this instance already knows; see gate()).
    const g = await gate(req, () => readSpotify(target.kind, target.id, start));
    if ("denied" in g) return g.denied;
    if (g.result.ok) return json(200, g.result.value, cacheFor(600));
    const e = g.result.error;
    console.warn("spotify read failed:", e instanceof Error ? e.message : e);
    return fail(codeOf(e));
  }

  let body: { songs?: { title?: unknown; artist?: unknown; ms?: unknown }[]; tracks?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return fail("server");
  }
  if (Array.isArray(body?.tracks)) return readTracks(req, body.tracks.slice(0, TRACKS), start);
  const songs = (Array.isArray(body?.songs) ? body.songs : []).slice(0, BATCH).map((s) => ({
    title: String(s?.title ?? "").slice(0, 200),
    artist: String(s?.artist ?? "").slice(0, 200),
    ms: Number(s?.ms) || 0,
  }));
  if (!songs.length) return fail("server");

  // Every song is searched at once, after the login check (see gate()). A
  // failure or timeout is reported in `failed`, not hidden as "no match".
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

/** POST { tracks }: each pasted song read from its own public embed page, 8 at a time. */
async function readTracks(req: Request, ids: unknown[], start: number): Promise<Response> {
  if (!ids.length) return fail("server");
  const g = await gate(req, async () => {
    const out: (SpotifySong | null | Failed)[] = new Array(ids.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const id = ids[i];
        if (!isTrackId(id)) continue; // not a song: null
        const ms = msLeft(start, BUDGET_MS - 500);
        out[i] = await deadline(readSpotifyTrack(id, ms), ms).catch((e): SpotifySong | null | Failed => {
          if (codeOf(e) === "not-found") return null;
          console.warn("spotify track failed:", e instanceof Error ? e.message : e);
          return { failed: codeOf(e) };
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRACKS_AT_ONCE, ids.length) }, worker));
    return out;
  });
  if ("denied" in g) return g.denied;
  if (!g.result.ok) return fail(codeOf(g.result.error));
  const failed: number[] = [];
  const codes = new Set<ErrorCode>();
  const songs = g.result.value.map((s, i) => {
    if (!s || !("failed" in s)) return s;
    failed.push(i);
    codes.add(s.failed);
    return null;
  });
  if (failed.length === ids.length) return fail(codes.has("timeout") ? "timeout" : "unavailable");
  return json(200, { songs, failed });
}
