// -----------------------------------------------------------------------------
// Reading a public Spotify playlist or album, for "Importa da Spotify".
//
// Spotify's own embed page (open.spotify.com/embed/…, the player websites put
// on their pages) carries the list of songs as data: name, artists, length.
// No Spotify account or key is needed. It lists the FIRST 100 songs of a
// playlist (all of an album's). Unofficial like YouTube.js: if Spotify changes
// that page, this stops working and the app says so.
//
// Only titles and artists are read; the music itself is then found on YouTube
// (lib/ytjs.mts matchSong) and plays in YouTube's player as usual.
// -----------------------------------------------------------------------------

export interface SpotifySong {
  title: string;
  artist: string;
  /** Length in ms (helps pick the right YouTube video). */
  ms: number;
}

export interface SpotifyList {
  kind: "playlist" | "album";
  id: string;
  name: string;
  owner: string;
  cover: string;
  songs: SpotifySong[];
}

/** "https://open.spotify.com/intl-it/playlist/ID?si=…", "spotify:playlist:ID", … → kind + id. */
export function parseSpotify(input: string): { kind: "playlist" | "album"; id: string } | null {
  const s = input.trim();
  const m =
    s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/) ??
    s.match(/^spotify:(playlist|album):([A-Za-z0-9]{22})$/);
  return m ? { kind: m[1] as "playlist" | "album", id: m[2] } : null;
}

export async function readSpotify(kind: "playlist" | "album", id: string): Promise<SpotifyList> {
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
    },
  });
  if (res.status === 404) throw new Error("not-found");
  if (!res.ok) throw new Error(`spotify ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("spotify-changed");
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw new Error("not-found");
  const songs: SpotifySong[] = (entity.trackList as any[])
    .filter((t) => t?.title)
    .map((t) => ({ title: String(t.title), artist: String(t.subtitle ?? "").replace(/ /g, " "), ms: Number(t.duration) || 0 }));
  const sources: { url: string; width?: number }[] = entity.coverArt?.sources ?? entity.visualIdentity?.image ?? [];
  const cover = [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";
  return {
    kind,
    id,
    name: String(entity.name ?? entity.title ?? "Spotify"),
    owner: String(entity.subtitle ?? entity.authors?.[0]?.name ?? ""),
    cover,
    songs,
  };
}
