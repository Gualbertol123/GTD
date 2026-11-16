import { afterEach, describe, expect, it, vi } from "vitest";

// music-browse: "?radio=ID" stays the ~50-song radio of "Avvia radio";
// "?radio=ID&full=1" is the longest radio (radio playlists), within the
// function's time budget.
const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

describe("music-browse ?radio", () => {
  afterEach(() => {
    vi.doUnmock("../../../netlify/lib/ytjs.mts");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function call(qs: string) {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon");
    const seen: { fn: string; id: string; until?: number }[] = [];
    vi.doMock("../../../netlify/lib/ytjs.mts", () => ({
      radio: async (id: string) => (seen.push({ fn: "radio", id }), [{ id, title: "S", channel: "", thumb: "" }]),
      radioFull: async (id: string, until: number) => (seen.push({ fn: "radioFull", id, until }), [{ id, title: "S", channel: "", thumb: "" }]),
      suggest: async () => [],
      charts: async () => ({}),
      explore: async () => [],
      musicArtist: async () => ({}),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("true", { status: 200 })));
    const fn = (await import("../../../netlify/functions/music-browse.mts")).default;
    const t0 = Date.now();
    const res = await fn(new Request(`http://x/?${qs}`, { headers: { authorization: `Bearer ${jwt(Math.floor(Date.now() / 1000) + 3600)}` } }));
    return { res, seen, t0 };
  }

  it("keeps ?radio=ID on the short radio", async () => {
    const { res, seen } = await call("radio=abcdefghijk");
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ fn: "radio", id: "abcdefghijk" }]);
  });

  it("sends ?radio=ID&full=1 to radioFull, with a deadline inside the 8.5 s budget", async () => {
    const { res, seen, t0 } = await call("radio=abcdefghijk&full=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tracks: [{ id: "abcdefghijk", title: "S", channel: "", thumb: "" }] });
    expect(seen[0].fn).toBe("radioFull");
    expect(seen[0].until! - t0).toBeLessThanOrEqual(8500 - 1000 + 50);
  });

  it("refuses a bad id", async () => {
    const { res } = await call("radio=nope&full=1");
    expect(res.status).toBe(400);
  });
});
