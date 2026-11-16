// The music functions' shared helpers (web/netlify/lib): the error contract,
// time limits, the in-memory cache and the cached team check.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, TimeoutError, TtlCache, codeOf, deadline, fail, isTimeout, normKey } from "../../../netlify/lib/http.mts";
import { forgetMembers, tokenExpiry } from "../../../netlify/lib/teamAuth.mts";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

describe("error contract", () => {
  it("answers { error: code } with the agreed status", async () => {
    const cases: [Parameters<typeof fail>[0], number][] = [
      ["login", 403],
      ["server", 400],
      ["not-found", 404],
      ["quota", 429],
      ["unavailable", 502],
      ["timeout", 504],
      ["no-key", 503],
    ];
    for (const [code, status] of cases) {
      const res = fail(code);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: code });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(fail("login", 401).status).toBe(401);
  });

  it("maps thrown errors to codes", () => {
    expect(codeOf(new NotFoundError())).toBe("not-found");
    expect(codeOf(new TimeoutError())).toBe("timeout");
    const abort = new Error("aborted");
    abort.name = "TimeoutError"; // what fetch throws for AbortSignal.timeout()
    expect(isTimeout(abort)).toBe(true);
    expect(codeOf(abort)).toBe("timeout");
    expect(codeOf(new Error("Request failed with status code 403"))).toBe("unavailable");
  });
});

describe("deadline", () => {
  it("passes the answer through in time, and times out after", async () => {
    await expect(deadline(Promise.resolve(1), 50)).resolves.toBe(1);
    await expect(deadline(new Promise(() => {}), 10)).rejects.toBeInstanceOf(TimeoutError);
    await expect(deadline(Promise.resolve(1), 0)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("TtlCache", () => {
  let now = 0;
  const cache = () => new TtlCache(3, () => now);
  beforeEach(() => (now = 0));

  it("shares a request in flight and keeps the answer for its ttl", async () => {
    const c = cache();
    const fn = vi.fn(async () => "a");
    const [x, y] = await Promise.all([c.get("k", 100, fn), c.get("k", 100, fn)]);
    expect([x, y]).toEqual(["a", "a"]);
    expect(fn).toHaveBeenCalledTimes(1);
    now = 99;
    await c.get("k", 100, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    now = 100;
    await c.get("k", 100, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("forgets a failure at once", async () => {
    const c = cache();
    await expect(c.get("k", 100, () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await Promise.resolve();
    await expect(c.get("k", 100, async () => "ok")).resolves.toBe("ok");
  });

  it("stays within its size, dropping the oldest", async () => {
    const c = cache();
    for (const k of ["a", "b", "c", "d"]) await c.get(k, 100, async () => k);
    expect(c.size).toBe(3);
    const fn = vi.fn(async () => "a2");
    expect(await c.get("a", 100, fn)).toBe("a2"); // "a" was dropped
    expect(await c.get("d", 100, fn)).toBe("d"); // "d" was kept
  });

  it("normalizes words for keys", () => {
    expect(normKey("  Tiziano   FERRO ")).toBe("tiziano ferro");
  });
});

describe("team check", () => {
  const req = (token?: string) => new Request("http://x/", { headers: token ? { authorization: `Bearer ${token}` } : {} });
  let rpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    forgetMembers();
    vi.stubEnv("VITE_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon");
    rpc = vi.fn(async () => new Response("true", { status: 200 }));
    vi.stubGlobal("fetch", rpc);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads the token's expiry without verifying it", () => {
    expect(tokenExpiry(jwt(2_000_000_000))).toBe(2_000_000_000_000);
    expect(tokenExpiry("not-a-jwt")).toBe(Infinity);
  });

  it("asks Supabase once per token, then remembers the yes", async () => {
    // teamAuth reads the env when loaded: load a fresh copy with the stubbed env.
    vi.resetModules();
    const { gate: g } = await import("../../../netlify/lib/http.mts");
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    const work = vi.fn(async () => 42);
    const a = await g(req(t), work);
    const b = await g(req(t), work);
    expect(a).toEqual({ result: { ok: true, value: 42 } });
    expect(b).toEqual({ result: { ok: true, value: 42 } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("never hands out the work's answer without a yes, and says why", async () => {
    vi.resetModules();
    const { gate: g } = await import("../../../netlify/lib/http.mts");
    const work = async () => "secret";

    const none = await g(req(), work);
    expect("denied" in none && none.denied.status).toBe(401);

    rpc.mockResolvedValueOnce(new Response("false", { status: 200 }));
    const no = await g(req("aaa"), work);
    expect("denied" in no && no.denied.status).toBe(403);
    expect("denied" in no && (await no.denied.json())).toEqual({ error: "login" });

    rpc.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const down = await g(req("bbb"), work);
    expect("denied" in down && (await down.denied.json())).toEqual({ error: "unavailable" });

    rpc.mockRejectedValueOnce(new Error("network"));
    const net = await g(req("ccc"), async () => {
      throw new Error("early work failed"); // must not leak as an unhandled rejection
    });
    expect("denied" in net && net.denied.status).toBe(502);
  });

  it("does not remember a no", async () => {
    vi.resetModules();
    const { gate: g } = await import("../../../netlify/lib/http.mts");
    rpc.mockResolvedValueOnce(new Response("false", { status: 200 }));
    await g(req("ddd"), async () => 1);
    const again = await g(req("ddd"), async () => 1);
    expect(again).toEqual({ result: { ok: true, value: 1 } });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  // F2: a stranger's token must not make the server call YouTube or Spotify.
  it("starts the work only after the yes, unless the token is already known", async () => {
    vi.resetModules();
    const { gate: g } = await import("../../../netlify/lib/http.mts");
    const { knownMember } = await import("../../../netlify/lib/teamAuth.mts");
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    let answer!: (r: Response) => void;
    rpc.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const work = vi.fn(async () => 1);
    const first = g(req(t), work);
    await new Promise((r) => setTimeout(r, 0));
    expect(work).not.toHaveBeenCalled(); // the check has not answered yet
    expect(knownMember(`Bearer ${t}`)).toBe(false);
    answer(new Response("true", { status: 200 }));
    expect(await first).toEqual({ result: { ok: true, value: 1 } });
    expect(work).toHaveBeenCalledTimes(1);
    expect(knownMember(`Bearer ${t}`)).toBe(true);

    // A refused token never runs the work at all.
    rpc.mockResolvedValueOnce(new Response("false", { status: 200 }));
    const never = vi.fn(async () => 1);
    await g(req("stranger"), never);
    expect(never).not.toHaveBeenCalled();
    expect(knownMember("Bearer stranger")).toBe(false);
  });
});

// F7: a slow YouTube.js must still leave the Data API its reserved time.
describe("music-search fallback", () => {
  afterEach(() => {
    vi.doUnmock("../../../netlify/lib/ytjs.mts");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(key: string) {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("YOUTUBE_API_KEY", key);
    vi.doMock("../../../netlify/lib/ytjs.mts", async () => {
      const { TimeoutError: T } = await import("../../../netlify/lib/http.mts");
      return {
        searchSongs: async () => {
          throw new T();
        },
        artistTop: async () => [],
      };
    });
    const fetch = vi.fn(async (u: string | URL) =>
      String(u).includes("supabase.test")
        ? new Response("true", { status: 200 })
        : new Response(JSON.stringify({ items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "A &amp; B", channelTitle: "C" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetch);
    const fn = (await import("../../../netlify/functions/music-search.mts")).default;
    const res = await fn(new Request("http://x/?q=hello", { headers: { authorization: `Bearer ${jwt(Math.floor(Date.now() / 1000) + 3600)}` } }));
    return { res, fetch };
  }

  it("uses the Data API when YouTube.js times out and a key is set", async () => {
    const { res, fetch } = await load("k");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ via: "api", tracks: [{ id: "abcdefghijk", title: "A & B" }] });
    expect(fetch.mock.calls.some(([u]) => String(u).includes("googleapis"))).toBe(true);
  });

  it("still says timeout when there is no key", async () => {
    const { res } = await load("");
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "timeout" });
  });
});
