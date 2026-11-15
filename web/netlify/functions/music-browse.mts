// -----------------------------------------------------------------------------
// GET /.netlify/functions/music-browse?…   — the MUSICA home and its extras,
// all through YouTube.js (lib/ytjs.mts): no API key, no daily quota.
//
//   ?suggest=tiz      what YouTube Music suggests while typing
//   ?radio=VIDEOID    "radio": ~50 songs like this one
//   ?charts=IT        the country's chart playlists + most listened artists
//                     (ZZ = the world)
//   ?explore=1        YouTube Music's Explore: trends, new music videos
//   ?artist=UC…       any YouTube Music artist: name, picture, songs
//
// Only a logged-in team account may use it. There is no Data API fallback
// for these (the API has no equivalent): if YouTube.js fails, the app hides
// the section or says so.
// -----------------------------------------------------------------------------

import { isTeamMember } from "../lib/teamAuth.mts";
import { charts, explore, musicArtist, radio, suggest } from "../lib/ytjs.mts";

function json(status: number, body: unknown, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return json(405, { error: "GET only" });
  const p = new URL(req.url).searchParams;
  const q = (p.get("suggest") ?? "").trim().slice(0, 100);
  const video = p.get("radio") ?? "";
  const country = (p.get("charts") ?? "").toUpperCase();
  const artist = p.get("artist") ?? "";
  const wantExplore = p.get("explore") === "1";

  if (video && !/^[\w-]{11}$/.test(video)) return json(400, { error: "Bad video" });
  if (country && !/^[A-Z]{2}$/.test(country)) return json(400, { error: "Bad country" });
  if (artist && !/^UC[\w-]{22}$/.test(artist)) return json(400, { error: "Bad artist" });
  if (!q && !video && !country && !artist && !wantExplore) return json(400, { error: "Empty request" });
  if (!(await isTeamMember(req.headers.get("authorization") ?? ""))) return json(403, { error: "Log in first." });

  try {
    if (q) return json(200, { suggestions: await suggest(q) }, "private, max-age=3600");
    if (video) return json(200, { tracks: await radio(video) }, "private, max-age=3600");
    if (country) return json(200, await charts(country), "private, max-age=3600");
    if (artist) return json(200, await musicArtist(artist), "private, max-age=3600");
    return json(200, { sections: await explore() }, "private, max-age=1800");
  } catch (e) {
    console.warn("music-browse failed:", e instanceof Error ? e.message : e);
    return json(502, { error: "youtube" });
  }
};
