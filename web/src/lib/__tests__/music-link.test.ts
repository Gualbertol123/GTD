import { describe, expect, it, vi } from "vitest";

vi.mock("../supabaseClient", () => ({ supabase: { from: vi.fn(), auth: { onAuthStateChange: vi.fn(), getSession: vi.fn(async () => ({ data: { session: null } })) }, channel: vi.fn() } }));

import { sourceFromLink } from "../musicDb";

describe("linking an old playlist to a source (Sincronizza on playlists without one)", () => {
  it("reads Spotify playlist and album links in their usual forms", () => {
    expect(sourceFromLink("https://open.spotify.com/playlist/0jAWhVakmxvxg2aLaYAMXk?si=abc&utm_source=whatsapp", "party")).toEqual({ kind: "spotify-playlist", id: "0jAWhVakmxvxg2aLaYAMXk", name: "party" });
    expect(sourceFromLink("https://open.spotify.com/intl-it/album/4aawyAB9vmqN3uQ7FjRGTy", "x")?.kind).toBe("spotify-album");
    expect(sourceFromLink("spotify:playlist:0jAWhVakmxvxg2aLaYAMXk", "x")?.id).toBe("0jAWhVakmxvxg2aLaYAMXk");
  });
  it("reads YouTube and YouTube Music playlist links, not mixes", () => {
    expect(sourceFromLink("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "y")).toEqual({ kind: "youtube-playlist", id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", name: "y" });
    expect(sourceFromLink("https://music.youtube.com/playlist?list=OLAK5uy_kxyz1234567890", "y")?.kind).toBe("youtube-playlist");
    expect(sourceFromLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ", "y")).toBeNull();
  });
  it("refuses anything else", () => {
    expect(sourceFromLink("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "z")).toBeNull();
    expect(sourceFromLink("ciao", "z")).toBeNull();
  });
});
