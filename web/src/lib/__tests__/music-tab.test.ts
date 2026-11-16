import { describe, expect, it } from "vitest";
import { countryName, isFail, parseView, rowKeys, viewSub, type View } from "../musicTabRoute";
import { readRoute, routeHash } from "../history";

describe("music tab routes", () => {
  const views: View[] = [
    { kind: "home" },
    { kind: "search" },
    { kind: "search", q: "tiziano ferro" },
    { kind: "import" },
    { kind: "spotify" },
    { kind: "yt", list: "PLabc_123-x" },
    { kind: "artist", name: "Ricky Martin" },
    { kind: "martist", id: "UC123", name: "AC/DC" },
    { kind: "playlist", id: "p-1" },
  ];

  it("every page round-trips through its sub-route", () => {
    for (const v of views) expect(parseView(viewSub(v) || undefined)).toEqual(v);
  });

  it("round-trips through the real hash (history.ts encodes the sub once more)", () => {
    // Node has no window: a stand-in with just the hash.
    const g = globalThis as unknown as { window?: { location: { hash: string } } };
    const had = g.window;
    g.window = { location: { hash: "" } };
    for (const v of views) {
      const sub = viewSub(v) || undefined;
      g.window.location.hash = routeHash({ tab: "music", sub });
      const r = readRoute();
      expect(r.tab).toBe("music");
      expect(parseView(r.sub)).toEqual(v);
    }
    g.window = had;
  });

  it("unknown or broken sub-routes open Home", () => {
    expect(parseView("nonsense/1")).toEqual({ kind: "home" });
    expect(parseView("playlist")).toEqual({ kind: "home" });
    expect(parseView("")).toEqual({ kind: "home" });
    expect(parseView(undefined)).toEqual({ kind: "home" });
  });
});

describe("rowKeys", () => {
  it("is unique with duplicates and stable when other rows move or go", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(rowKeys([a, b, a])).toEqual(["a#0", "b#0", "a#1"]);
    // Removing b keeps the keys of a and c.
    expect(rowKeys([a, c])).toEqual(["a#0", "c#0"]);
    expect(rowKeys([c, a])).toEqual(["c#0", "a#0"]);
  });
});

describe("countryName / isFail", () => {
  it("names the world and falls back to the code", () => {
    expect(countryName("ZZ", "it", "Mondo")).toBe("Mondo");
    expect(typeof countryName("IT", "it", "Mondo")).toBe("string");
    expect(countryName("IT", "it", "Mondo")).toBe(countryName("IT", "it", "Mondo"));
  });
  it("tells a failure", () => {
    expect(isFail({ error: "timeout" })).toBe(true);
    expect(isFail({ tracks: [] })).toBe(false);
    expect(isFail(null)).toBe(false);
  });
});
