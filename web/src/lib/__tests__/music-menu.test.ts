import { describe, expect, it, vi } from "vitest";

// SongMenu pulls in the app's Supabase client through musicDb / identity.
vi.mock("../supabaseClient", () => ({ supabase: { from: () => ({}), channel: () => ({}), auth: { getSession: async () => ({ data: {} }), onAuthStateChange: () => {} } } }));

import { placeMenu, playlistErrorText } from "../../components/SongMenu";
import { MENU_EN, MENU_IT } from "../i18n.music.menu";

const view = { w: 400, h: 800 };
const size = { w: 250, h: 300 };

describe("placeMenu", () => {
  it("opens down-right at the point", () => {
    expect(placeMenu({ x: 20, y: 100 }, size, view)).toEqual({ left: 20, top: 100 });
  });
  it("stays inside the right edge and flips up near the bottom", () => {
    expect(placeMenu({ x: 390, y: 700 }, size, view)).toEqual({ left: 142, top: 400 });
  });
  it("never goes above the top margin", () => {
    expect(placeMenu({ x: 0, y: 700 }, { w: 250, h: 790 }, view).top).toBe(8);
  });
  it("sits under an anchor, right-aligned, or above it when there is no room", () => {
    const below = placeMenu({ x: 0, y: 0, anchor: { left: 300, top: 50, right: 340, bottom: 90 } }, size, view);
    expect(below).toEqual({ left: 90, top: 94 });
    const above = placeMenu({ x: 0, y: 0, anchor: { left: 300, top: 700, right: 340, bottom: 740 } }, size, view);
    expect(above).toEqual({ left: 90, top: 396 });
  });
});

describe("playlistErrorText", () => {
  const t = (k: string) => MENU_IT[k] ?? k;
  it("says what failed and why", () => {
    expect(playlistErrorText("Non aggiunto a «X»", "offline", t)).toBe("Non aggiunto a «X»: sei offline, riprova");
    expect(playlistErrorText("No", "missing-table", t)).toContain("018");
  });
  it("maps unknown codes to the server message", () => {
    expect(playlistErrorText("No", "boom", t)).toBe("No: " + MENU_IT["sm.why.server"]);
  });
  it("has the same keys in both languages", () => {
    expect(Object.keys(MENU_EN).sort()).toEqual(Object.keys(MENU_IT).sort());
  });
});
