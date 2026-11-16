// -----------------------------------------------------------------------------
// GET /.netlify/functions/music-playlist?list=PL…   → one YouTube playlist
// GET /.netlify/functions/music-playlist?q=…        → find playlists
//
// For "Importa" in the MUSICA tab: read a public YouTube / YouTube Music
// playlist (title + up to 200 songs) so the team can save it as its own, or
// search YouTube's playlists by words.
//
// Same rules as music-search: YOUTUBE_API_KEY stays here, only a logged-in
// team account may call it, nothing is stored.
//
// YouTube.js (lib/ytjs.mts) answers first, with no key and no quota. If it
// fails, the Data API does: reading a playlist costs 1 unit per 50 songs
// (+1 for its title), a playlist search 100. The Data API is asked only after
// the login check said yes. Errors follow lib/http.mts ({ error: code }).
// -----------------------------------------------------------------------------

import { BUDGET_MS, cacheFor, codeOf, fail, gate, isTimeout, json, msLeft } from "../lib/http.mts";
import * as ytjs from "../lib/ytjs.mts";

const KEY = process.env.YOUTUBE_API_KEY ?? "";
const API = "https://www.googleapis.com/youtube/v3";
const MAX_SONGS = 200;

// The Data API needs about this long; with less time left it is not tried.
const FALLBACK_MS = 3000;

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type Thumbs = { medium?: { url?: string }; high?: { url?: string }; default?: { url?: string } };
const thumbOf = (t?: Thumbs) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? "";

/** " - Topic" channels (YouTube Music's auto-generated artist channels). */
const cleanChannel = (s: string) => decode(s).replace(/\s+-\s+Topic$/, "");

/** One Data API call, stopped when the request's time (`until`) runs out. */
async function yt(path: string, params: Record<string, string>, until: number): Promise<{ ok: true; data: any } | { ok: false; res: Response }> {
  const url = new URL(`${API}/${path}`);
  url.search = new URLSearchParams({ ...params, key: KEY }).toString();
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, until - Date.now())) });
  } catch (e) {
    return { ok: false, res: fail(codeOf(e)) };
  }
  if (res.ok) return { ok: true, data: await res.json() };
  const text = await res.text().catch(() => "");
  if (/quota/i.test(text)) return { ok: false, res: fail("quota") };
  if (res.status === 404 || /playlistNotFound/i.test(text)) return { ok: false, res: fail("not-found") };
  return { ok: false, res: fail("unavailable") };
}

async function readPlaylist(list: string, until: number): Promise<Response> {
  const meta = await yt("playlists", { part: "snippet,contentDetails", id: list, maxResults: "1" }, until);
  if (!meta.ok) return meta.res;
  const info = meta.data.items?.[0];
  // Mixes (RD…) and private lists have no readable entry.
  if (!info) return fail("not-found");

  const tracks: { id: string; title: string; channel: string; thumb: string }[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  while (tracks.length < MAX_SONGS) {
    const page = await yt("playlistItems", {
      part: "snippet,status",
      playlistId: list,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    }, until);
    if (!page.ok) return page.res;
    for (const it of page.data.items ?? []) {
      const id = it.snippet?.resourceId?.videoId;
      const title = it.snippet?.title ?? "";
      // Deleted and private videos stay in a playlist as placeholders.
      if (!id || seen.has(id) || /^(Deleted|Private) video$/.test(title) || it.status?.privacyStatus === "private") continue;
      seen.add(id);
      tracks.push({
        id,
        title: decode(title),
        channel: cleanChannel(it.snippet?.videoOwnerChannelTitle ?? ""),
        thumb: thumbOf(it.snippet?.thumbnails),
      });
      if (tracks.length >= MAX_SONGS) break;
    }
    pageToken = page.data.nextPageToken ?? "";
    if (!pageToken) break;
  }

  return json(
    200,
    {
      list,
      title: decode(info.snippet?.title ?? "Playlist"),
      channel: cleanChannel(info.snippet?.channelTitle ?? ""),
      thumb: thumbOf(info.snippet?.thumbnails),
      total: info.contentDetails?.itemCount ?? tracks.length,
      tracks,
    },
    cacheFor(600)
  );
}

async function findPlaylists(q: string, until: number): Promise<Response> {
  const r = await yt("search", { part: "snippet", type: "playlist", q, maxResults: "18", safeSearch: "moderate" }, until);
  if (!r.ok) return r.res;
  const lists = (r.data.items ?? [])
    .filter((it: any) => it.id?.playlistId)
    .map((it: any) => ({
      list: it.id.playlistId,
      title: decode(it.snippet?.title ?? ""),
      channel: cleanChannel(it.snippet?.channelTitle ?? ""),
      thumb: thumbOf(it.snippet?.thumbnails),
    }));
  return json(200, { lists }, cacheFor(3600));
}

export default async (req: Request): Promise<Response> => {
  const start = Date.now();
  if (req.method !== "GET") return fail("server", 405);
  const params = new URL(req.url).searchParams;
  const list = (params.get("list") ?? "").trim();
  const q = (params.get("q") ?? "").trim().slice(0, 120);
  if (list && !/^[\w-]{10,64}$/.test(list)) return fail("server");
  if (!list && !q) return fail("server");

  // YouTube.js first (no quota, so it may start while the login is checked);
  // the Data API only if it fails, after the "yes", with time left for it.
  const ms = msLeft(start) - FALLBACK_MS;
  const g = await gate(req, async () => (list ? { ...(await ytjs.playlist(list, MAX_SONGS, ms)), via: "ytjs" } : { lists: await ytjs.findPlaylists(q, ms), via: "ytjs" }));
  if ("denied" in g) return g.denied;
  const r = g.result;
  if (r.ok) {
    if ("tracks" in r.value) return json(200, r.value, cacheFor(600));
    if (r.value.lists.length) return json(200, r.value, cacheFor(3600));
  } else {
    console.warn("ytjs playlist failed, using the Data API:", r.error instanceof Error ? r.error.message : r.error);
    // A timed-out YouTube.js call keeps running: no fallback on top of it.
    if (isTimeout(r.error)) return fail("timeout");
  }

  if (!KEY) return r.ok ? json(200, r.value, cacheFor(3600)) : fail(codeOf(r.error) === "not-found" ? "not-found" : "no-key");
  if (msLeft(start) < FALLBACK_MS) return fail("timeout");
  const until = start + BUDGET_MS;
  return list ? readPlaylist(list, until) : findPlaylists(q, until);
};
