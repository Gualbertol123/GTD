// -----------------------------------------------------------------------------
// GET /.netlify/functions/music-search?q=…[&channelId=UC…&order=viewCount]
// — finds songs for the music player (or an artist's most watched ones).
//
// Asks YouTube's official Data API for music videos that may be embedded, and
// answers with just what the player needs (id, title, channel, thumbnail).
// The API key stays here, on the server, in the YOUTUBE_API_KEY environment
// variable (free, from Google Cloud: see README §1e); without it the answer is
// 503 { error: "no-key" } and the player offers YouTube's own search instead.
// Errors follow lib/http.mts: { error: code }, never a raw message.
//
// Only a logged-in team account may use it (same check as report-pdf), so the
// key's daily quota cannot be spent by anyone else. Nothing is stored.
//
// First choice is YouTube.js (lib/ytjs.mts): YouTube's own search, no key and
// no quota. Only if that fails does it use the Data API below (100 units).
// -----------------------------------------------------------------------------

import { cacheFor, codeOf, fail, gate, isTimeout, json, msLeft } from "../lib/http.mts";
import { artistTop, searchSongs } from "../lib/ytjs.mts";

const KEY = process.env.YOUTUBE_API_KEY ?? "";

// The Data API needs about this long; with less time left it is not tried.
const FALLBACK_MS = 3000;

// The API returns titles with HTML entities (&#39; &amp; …).
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface ApiItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string }; default?: { url?: string } } };
}

export default async (req: Request): Promise<Response> => {
  const start = Date.now();
  if (req.method !== "GET") return fail("server", 405);
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 120);
  // An artist page: one channel, most watched first.
  const channelId = params.get("channelId") ?? "";
  const order = params.get("order") === "viewCount" ? "viewCount" : "relevance";
  if (channelId && !/^UC[\w-]{22}$/.test(channelId)) return fail("server");
  if (!q && !channelId) return fail("server");

  // Free first: YouTube.js (no quota) runs after the login check (alongside
  // it for a member already known, see gate()), and leaves time for the Data
  // API if it fails or is slow.
  const g = await gate(req, () => (channelId ? artistTop(channelId, msLeft(start) - FALLBACK_MS) : searchSongs(q, msLeft(start) - FALLBACK_MS)));
  if ("denied" in g) return g.denied;
  if (g.result.ok && g.result.value.length) return json(200, { tracks: g.result.value, via: "ytjs" }, cacheFor(600));
  if (!g.result.ok) {
    const e = g.result.error;
    console.warn("ytjs search failed, using the Data API:", e instanceof Error ? e.message : e);
    // A slow YouTube.js: the Data API still gets the time kept for it.
    if (isTimeout(e) && (!KEY || msLeft(start) < FALLBACK_MS)) return fail("timeout");
  }

  if (!KEY) return g.result.ok ? json(200, { tracks: [], via: "ytjs" }, cacheFor(600)) : fail("no-key");
  if (msLeft(start) < FALLBACK_MS) return fail("timeout");

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  const search = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    maxResults: "50", // same 100 units as 25
    safeSearch: "moderate",
    order,
    key: KEY,
  });
  if (q) search.set("q", q);
  if (channelId) search.set("channelId", channelId);
  else search.set("videoCategoryId", "10"); // Music (an artist's own channel needs no filter)
  url.search = search.toString();
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(msLeft(start)) });
  } catch (e) {
    return fail(codeOf(e));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return fail(/quota/i.test(text) ? "quota" : "unavailable");
  }
  const data = (await res.json()) as { items?: ApiItem[] };
  const tracks = (data.items ?? [])
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      id: it.id!.videoId!,
      title: decode(it.snippet?.title ?? ""),
      channel: decode(it.snippet?.channelTitle ?? ""),
      thumb: it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url ?? "",
    }));
  // The same words give the same songs for a while: let the browser reuse it.
  return json(200, { tracks, via: "api" }, cacheFor(600));
};
