import { describe, expect, it, vi } from "vitest";

// SongMenu pulls in the app's Supabase client through musicDb / identity.
vi.mock("../supabaseClient", () => ({ supabase: { from: () => ({}), channel: () => ({}), auth: { getSession: async () => ({ data: {} }), onAuthStateChange: () => {} } } }));

import { menuPlayAction, placeMenu, playlistErrorText } from "../../components/SongMenu";
import { readFileSync } from "node:fs";
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

describe("menuPlayAction (Riproduci keeps the queue)", () => {
  const a = { id: "a", title: "A", channel: "" };
  const b = { id: "b", title: "B", channel: "" };
  const c = { id: "c", title: "C", channel: "" };
  const queue = [a, b, c];
  it("jumps to a queue row instead of replacing the queue", () => {
    expect(menuPlayAction({ track: b, queueIndex: 1 }, queue)).toEqual({ kind: "at", index: 1 });
  });
  it("falls back when the queue moved on while the menu was open", () => {
    expect(menuPlayAction({ track: b, queueIndex: 2 }, queue)).toEqual({ kind: "single", track: b });
    expect(menuPlayAction({ track: b, queueIndex: 9 }, queue).kind).toBe("single");
  });
  it("restarts the song now playing", () => {
    expect(menuPlayAction({ track: a, current: true }, queue)).toEqual({ kind: "restart" });
  });
  it("plays a shown list in context, or the lone song", () => {
    const list = { tracks: queue, label: "L", index: 2, key: "pl:x" };
    expect(menuPlayAction({ track: c, list }, [])).toEqual({ kind: "list", label: "L", key: "pl:x", tracks: queue, start: 2 });
    expect(menuPlayAction({ track: c }, [])).toEqual({ kind: "single", track: c });
  });
});

describe("skip link CSS", () => {
  // It once sat at top:-60px, visible over the app's tab row, eating BOARD's clicks.
  const css = readFileSync(new URL("../../styles/musicTab.css", import.meta.url), "utf8");
  const rule = css.match(/\.mt-skip\s*\{([^}]*)\}/)?.[1] ?? "";
  it("is hidden and click-through until focused", () => {
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule).not.toMatch(/top:\s*-/);
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(css).toMatch(/\.mt-skip:focus[^{]*\{[^}]*pointer-events:\s*auto/);
  });
});
