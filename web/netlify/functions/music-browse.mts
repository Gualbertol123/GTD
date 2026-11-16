// -----------------------------------------------------------------------------
// GET /.netlify/functions/music-browse?…   — the MUSICA home and its extras,
// all through YouTube.js (lib/ytjs.mts): no API key, no daily quota.
//
//   ?suggest=tiz      what YouTube Music suggests while typing
//   ?radio=VIDEOID    "radio": ~50 songs like this one ("Avvia radio")
//   ?radio=VIDEOID&full=1
//                     the longest radio YouTube gives (up to 200; ~60-100 in
//                     practice), seed first: "Salva radio come playlist" and
//                     its daily refresh. Within the time budget: if the
//                     continuations run out of time, what was found so far
//                     is returned.
//   ?charts=IT        the country's chart playlists + most listened artists
//                     (ZZ = the world)
//   ?explore=1        YouTube Music's Explore: trends, new music videos
//   ?artist=UC…       any YouTube Music artist: name, picture, songs
//
// Only a logged-in team account may use it. There is no Data API fallback
// for these (the API has no equivalent): if YouTube.js fails, the app hides
// the section or says so. Errors follow lib/http.mts ({ error: code }).
// Answers are kept in this instance's memory too (lib/ytjs.mts), so Home is
// asked of YouTube once per instance, not once per user.
// -----------------------------------------------------------------------------

import { BUDGET_MS, cacheFor, codeOf, fail, gate, json } from "../lib/http.mts";
import { charts, explore, musicArtist, radio, radioFull, suggest } from "../lib/ytjs.mts";

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return fail("server", 405);
  const start = Date.now();
  const p = new URL(req.url).searchParams;
  const q = (p.get("suggest") ?? "").trim().slice(0, 100);
  const video = p.get("radio") ?? "";
  const country = (p.get("charts") ?? "").toUpperCase();
  const artist = p.get("artist") ?? "";
  const wantExplore = p.get("explore") === "1";
  const full = p.get("full") === "1";

  if (video && !/^[\w-]{11}$/.test(video)) return fail("server");
  if (country && !/^[A-Z]{2}$/.test(country)) return fail("server");
  if (artist && !/^UC[\w-]{22}$/.test(artist)) return fail("server");
  if (!q && !video && !country && !artist && !wantExplore) return fail("server");

  // YouTube.js (free) runs after the "yes" (alongside the check for a member
  // this instance already knows; see gate()).
  const g = await gate(req, async (): Promise<[unknown, number]> => {
    if (q) return [{ suggestions: await suggest(q) }, 3600];
    if (video && full) return [{ tracks: await radioFull(video, start + BUDGET_MS - 1000) }, 3600];
    if (video) return [{ tracks: await radio(video) }, 3600];
    if (country) return [await charts(country), 3600];
    if (artist) return [await musicArtist(artist), 3600];
    return [{ sections: await explore() }, 1800];
  });
  if ("denied" in g) return g.denied;
  if (g.result.ok) return json(200, g.result.value[0], cacheFor(g.result.value[1]));
  const e = g.result.error;
  console.warn("music-browse failed:", e instanceof Error ? e.message : e);
  return fail(codeOf(e));
};
