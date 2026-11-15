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
// Quota (10,000 units a day, free): reading a playlist costs 1 unit per 50
// songs (+1 for its title), so importing is almost free; a playlist search
// costs 100, like a song search.
// -----------------------------------------------------------------------------

import { isTeamMember } from "../lib/teamAuth.mts";

const KEY = process.env.YOUTUBE_API_KEY ?? "";
const API = "https://www.googleapis.com/youtube/v3";
const MAX_SONGS = 200;

function json(status: number, body: unknown, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

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

async function yt(path: string, params: Record<string, string>): Promise<{ ok: true; data: any } | { ok: false; res: Response }> {
  const url = new URL(`${API}/${path}`);
  url.search = new URLSearchParams({ ...params, key: KEY }).toString();
  const res = await fetch(url);
  if (res.ok) return { ok: true, data: await res.json() };
  const text = await res.text().catch(() => "");
  if (/quota/i.test(text)) return { ok: false, res: json(429, { error: "quota" }) };
  if (res.status === 404 || /playlistNotFound/i.test(text)) return { ok: false, res: json(404, { error: "not-found" }) };
  return { ok: false, res: json(502, { error: `YouTube ${res.status}` }) };
}

async function readPlaylist(list: string): Promise<Response> {
  const meta = await yt("playlists", { part: "snippet,contentDetails", id: list, maxResults: "1" });
  if (!meta.ok) return meta.res;
  const info = meta.data.items?.[0];
  // Mixes (RD…) and private lists have no readable entry.
  if (!info) return json(404, { error: "not-found" });

  const tracks: { id: string; title: string; channel: string; thumb: string }[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  while (tracks.length < MAX_SONGS) {
    const page = await yt("playlistItems", {
      part: "snippet,status",
      playlistId: list,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
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
    "private, max-age=600"
  );
}

async function findPlaylists(q: string): Promise<Response> {
  const r = await yt("search", { part: "snippet", type: "playlist", q, maxResults: "18", safeSearch: "moderate" });
  if (!r.ok) return r.res;
  const lists = (r.data.items ?? [])
    .filter((it: any) => it.id?.playlistId)
    .map((it: any) => ({
      list: it.id.playlistId,
      title: decode(it.snippet?.title ?? ""),
      channel: cleanChannel(it.snippet?.channelTitle ?? ""),
      thumb: thumbOf(it.snippet?.thumbnails),
    }));
  return json(200, { lists }, "private, max-age=3600");
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return json(405, { error: "GET only" });
  const params = new URL(req.url).searchParams;
  const list = (params.get("list") ?? "").trim();
  const q = (params.get("q") ?? "").trim().slice(0, 120);
  if (list && !/^[\w-]{10,64}$/.test(list)) return json(400, { error: "Bad playlist" });
  if (!list && !q) return json(400, { error: "Empty request" });
  if (!(await isTeamMember(req.headers.get("authorization") ?? ""))) return json(403, { error: "Log in first." });
  if (!KEY) return json(501, { error: "no-key" });
  return list ? readPlaylist(list) : findPlaylists(q);
};
