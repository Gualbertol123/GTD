// -----------------------------------------------------------------------------
// "Importa da Spotify" (MUSICA tab → Importa):
//
//   GET  ?url=<Spotify playlist or album link>
//        → { kind, id, name, owner, cover, songs: [{ title, artist, ms }] }
//          (a playlist's first 100 songs, an album's all; lib/spotify.mts)
//   POST { songs: [{ title, artist, ms }, …] }   (up to 10 at a time)
//        → { matches: [{ id, title, channel, thumb } | null, …] }
//          each song found on YouTube (lib/ytjs.mts matchSong)
//
// The app asks for the songs in small batches and shows the progress, so no
// single call comes near Netlify's time limit. No Spotify account, no API key,
// no YouTube quota. Only a logged-in team account may use it.
// -----------------------------------------------------------------------------

import { isTeamMember } from "../lib/teamAuth.mts";
import { parseSpotify, readSpotify } from "../lib/spotify.mts";
import { matchSong } from "../lib/ytjs.mts";

const BATCH = 10;

function json(status: number, body: unknown, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "GET or POST" });
  if (!(await isTeamMember(req.headers.get("authorization") ?? ""))) return json(403, { error: "Log in first." });

  if (req.method === "GET") {
    const target = parseSpotify(new URL(req.url).searchParams.get("url") ?? "");
    if (!target) return json(400, { error: "bad-link" });
    try {
      return json(200, await readSpotify(target.kind, target.id), "private, max-age=600");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("spotify read failed:", msg);
      return json(msg === "not-found" ? 404 : 502, { error: msg === "not-found" ? "not-found" : "spotify" });
    }
  }

  let body: { songs?: { title?: unknown; artist?: unknown; ms?: unknown }[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Bad JSON" });
  }
  const songs = (body.songs ?? []).slice(0, BATCH).map((s) => ({
    title: String(s?.title ?? "").slice(0, 200),
    artist: String(s?.artist ?? "").slice(0, 200),
    ms: Number(s?.ms) || 0,
  }));
  if (!songs.length) return json(400, { error: "No songs" });
  const matches = await Promise.all(songs.map((s) => (s.title ? matchSong(s.title, s.artist, s.ms).catch(() => null) : Promise.resolve(null))));
  return json(200, { matches });
};
