#!/usr/bin/env node
// -----------------------------------------------------------------------------
// End-to-end check of the one-button import and its check (Playwright,
// Chromium, a production build). Nothing real is called: Supabase, the
// Netlify music functions and YouTube come from the perf harness mocks
// (scripts/perf/lib/mocks.mjs); api.spotify.com and accounts.spotify.com are
// answered here. The team playlists written to Supabase are kept by this
// script (upsert / update / the sync RPC answer with the rows, as Supabase
// does), so the check reads them back like the real thing.
//
//   node scripts/e2e/spotify-addall.mjs              build, serve, check
//   node scripts/e2e/spotify-addall.mjs --no-build   reuse the last build
//   node scripts/e2e/spotify-addall.mjs --out DIR    build into DIR
//
// It checks: signed out, "Aggiungi tutte le mie playlist" goes through the
// sign-in and starts by itself on the way back; the progress reads "Playlist
// i di n · brani x di y" (and the sidebar chip i/n); the check ends on "5 di
// 5 playlist aggiunte"; the team playlists exist with their sources (the
// mocked upsert bodies), the old "Ufficio chill" (Marco's earlier import) is
// linked and keeps its songs (no duplicate), a teammate's hand-made "Sera" is
// left alone, the Spotify-owned playlist is left out with a note; a second
// click adds nothing and keeps the focus on the button; a pasted YouTube
// playlist link is saved in one click, with a toast and "Apri"; a failing
// playlist listing says why on the Importa page. Exits 1 on any failure.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { installMocks, cat, PLAYLISTS as TEAM } from "../perf/lib/mocks.mjs";
import { routeSpotifyAccounts, signInWith } from "./lib/spotify-signin.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(process.env.TMPDIR || tmpdir(), "splib-e2e-dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The fake Spotify library -----------------------------------------------------------

const id22 = (s) => (cat.vid("sp22:" + s) + cat.vid("sp22b:" + s)).replace(/[^A-Za-z0-9]/g, "a").slice(0, 22);
const ME = "me-user";
const song = (i) => ({
  id: id22("song" + i),
  name: `Brano ${i}`,
  duration_ms: 180000 + i * 1000,
  artists: [{ name: `Artista ${i % 4}` }],
  album: { name: "Album finto", images: [{ url: "https://i.scdn.co/image/al" + i, width: 300 }] },
  type: "track",
  external_urls: { spotify: `https://open.spotify.com/track/${id22("song" + i)}` },
});
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => song(a + k));
// Each list is short (≤ 6 songs a request), so the mocked matcher (it drops every 7th of a request) finds them all.
const LISTS = [
  { id: id22("mattino"), name: "Mattino", songs: range(0, 5), owner: ME },
  { id: id22("sera"), name: "Sera", songs: range(3, 7), owner: ME }, // 3–5 also in Mattino: matched once
  { id: id22("ufficio"), name: "Ufficio chill", songs: range(8, 11), owner: ME }, // the team has an old import with this name
  { id: id22("collab"), name: "Collab", songs: range(12, 14), owner: "amico", collaborative: true },
  { id: id22("editorial"), name: "Hit editoriali", songs: range(20, 25), owner: "spotify" }, // details only: left out
];
const LIKED = [song(0), song(15), song(16)];
const apiCalls = [];
let listingFails = false;

function page(url, all) {
  const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const items = all.slice(offset, offset + limit);
  const next =
    offset + items.length < all.length
      ? `${url.origin}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), offset: String(offset + items.length), limit: String(limit) })}`
      : null;
  return { items, next, total: all.length, limit, offset };
}
const meta = (l) => ({
  id: l.id,
  name: l.name,
  owner: { id: l.owner, display_name: l.owner },
  collaborative: !!l.collaborative,
  images: [{ url: `https://i.scdn.co/image/${l.id}`, width: 300 }],
  external_urls: { spotify: `https://open.spotify.com/playlist/${l.id}` },
  ...(l.owner === "spotify" ? {} : { items: { total: l.songs.length } }),
});

function answerSpotify(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/v1/, "");
  apiCalls.push(p + u.search);
  if (p === "/me") return { id: ME, display_name: "Io" };
  if (p === "/me/playlists" && listingFails) return { __status: 403 };
  if (p === "/me/playlists") return page(u, LISTS.map((l) => ({ ...meta(l), items: { total: l.songs.length } })));
  if (p === "/me/tracks") return page(u, LIKED.map((s) => ({ track: s })));
  const m = p.match(/^\/playlists\/([A-Za-z0-9]{22})(\/items)?$/);
  const l = m && LISTS.find((x) => x.id === m[1]);
  if (l && !m[2]) return meta(l);
  if (l && m[2] && l.owner !== "spotify") return page(u, l.songs.map((s) => ({ is_local: false, item: s })));
  if (l && m[2]) return { __status: 403 };
  return null;
}

// ---- The team playlists, as the database keeps them ---------------------------------------

const rows = new Map(TEAM.map((r) => [r.id, structuredClone(r)]));
// "Ufficio chill": an earlier import of Marco's (the one signed in), every song from Spotify; one
// song is no longer on the Spotify playlist and must stay. "Sera" (Giulia's, made by hand): not linked.
const oldTrack = (sp, i) => ({ id: `oldyt${i}`.padEnd(11, "x"), title: `Vecchio ${i}`, channel: "c", thumb: "", spotify: sp });
rows.set("plufficio", { ...rows.get("plufficio"), owner: "Marco", tracks: [oldTrack(id22("song8"), 8), oldTrack(id22("song99"), 99)] });
rows.set("plsera", { id: "plsera", name: "Sera", owner: "Giulia", tracks: [oldTrack(undefined, 1), oldTrack(undefined, 2)].map(({ spotify, ...t }) => t), created_at: Date.now() - 5000, updated_at: Date.now() - 5000 });
const seraBefore = JSON.stringify(rows.get("plsera").tracks);
const upserts = [];
const patches = [];
const matchBodies = [];
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: { "content-range": "0-0/*" }, body: JSON.stringify(body) });

function answerPlaylists(req) {
  const u = new URL(req.url());
  const method = req.method();
  const idEq = (u.searchParams.get("id") ?? "").replace(/^eq\./, "");
  if (method === "GET") {
    let list = [...rows.values()];
    if (idEq) list = list.filter((r) => r.id === idEq);
    if (u.searchParams.get("limit")) list = list.slice(0, Number(u.searchParams.get("limit")));
    return json(list);
  }
  let body = null;
  try {
    body = JSON.parse(req.postData() || "null");
  } catch {}
  if (method === "POST" && body) {
    const list = Array.isArray(body) ? body : [body];
    for (const r of list) {
      upserts.push(r);
      rows.set(r.id, { ...rows.get(r.id), ...r });
    }
    return json(list.map((r) => rows.get(r.id)), 201);
  }
  if (method === "PATCH" && body && idEq && rows.has(idEq)) {
    patches.push({ id: idEq, body });
    const r = { ...rows.get(idEq), ...body, updated_at: Date.now() };
    rows.set(idEq, r);
    return json([r]);
  }
  if (method === "DELETE") {
    rows.delete(idEq);
    return json([]);
  }
  return json([]);
}

function answerSync(req) {
  let a = {};
  try {
    a = JSON.parse(req.postData() || "{}");
  } catch {}
  const r = rows.get(a.p_id);
  if (!r) return json([]);
  const next = { ...r, ...(a.p_tracks ? { tracks: a.p_tracks } : {}), source_synced_at: Date.now(), updated_at: Date.now() };
  rows.set(a.p_id, next);
  return json([next]);
}

// ---- Build + preview ---------------------------------------------------------------------

function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen({ port, host: "localhost" }, () => srv.close(() => res(true)));
  });
}

async function main() {
  if (!noBuild) {
    console.error("[addall-e2e] building →", OUT);
    execSync(`npx vite build --minify false --outDir "${OUT}" --emptyOutDir`, {
      cwd: WEB,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, VITE_SUPABASE_URL: "http://supabase.mock", VITE_SUPABASE_ANON_KEY: "anon", VITE_TEAM_EMAIL: "team@example.com", VITE_SPOTIFY_CLIENT_ID: "e2e-client-id" },
    });
  }
  let PORT = 4231;
  for (; PORT < 4260; PORT++) if (await portFree(PORT)) break;
  const BASE = `http://localhost:${PORT}`;
  const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", OUT], { cwd: WEB, detached: process.platform !== "win32", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => {
    try {
      // Windows: the shell's whole tree; elsewhere the detached group.
      if (process.platform === "win32") execSync(`taskkill /pid ${preview.pid} /T /F`, { stdio: "ignore" });
      else process.kill(-preview.pid, "SIGTERM");
    } catch {}
  };
  const fails = [];
  const check = (ok, what) => {
    console.error(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) fails.push(what);
  };
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(BASE + "/")).ok) break;
      } catch {}
      await sleep(200);
    }
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", locale: "it-IT" });
    await installMocks(context, { origin: BASE });
    // Registered after installMocks: these win over its catch-alls.
    await context.route("https://api.spotify.com/**", async (route) => {
      const req = route.request();
      if (req.headers()["authorization"] !== "Bearer fake-access") return route.fulfill({ status: 401, body: "{}" });
      const body = answerSpotify(req.url());
      await sleep(40);
      if (body?.__status) return route.fulfill({ status: body.__status, contentType: "application/json", body: "{}" });
      await route.fulfill(body ? { status: 200, contentType: "application/json", body: JSON.stringify(body) } : { status: 404, contentType: "application/json", body: '{"error":{"status":404}}' });
    });
    await routeSpotifyAccounts(context, { access: "fake-access" });
    await context.route("https://i.scdn.co/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64") })
    );
    // What is sent to YouTube matching (the songs of each request).
    await context.route("**/.netlify/functions/music-spotify", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        try {
          matchBodies.push(JSON.parse(req.postData() || "{}").songs ?? []);
        } catch {}
      }
      await route.fallback();
    });
    await context.route(/^http:\/\/supabase\.mock\/rest\/v1\/music_playlists/, async (route) => {
      await sleep(30);
      await route.fulfill(answerPlaylists(route.request()));
    });
    await context.route(/^http:\/\/supabase\.mock\/rest\/v1\/rpc\/music_playlist_source_sync/, async (route) => {
      await sleep(30);
      await route.fulfill(answerSync(route.request()));
    });

    const page_ = await context.newPage();
    const errors = [];
    page_.on("pageerror", (e) => errors.push(String(e.message || e)));
    await page_.goto(BASE + "/#/board");
    // Musica is in the ALTRO ▾ menu (since 2026-11-25).
    await page_.getByRole("button", { name: /^(ALTRO|MORE)/ }).first().waitFor({ timeout: 20000 });
    await page_.getByRole("button", { name: /^(ALTRO|MORE)/ }).first().click();
    await page_.getByRole("menuitem", { name: /^(musica|music)$/i }).first().click();
    await page_.locator(".mt").waitFor({ timeout: 10000 });

    // 1. Signed out, on the library: the one button goes through the sign-in, then starts by itself.
    await page_.locator(".mt-side").getByRole("button", { name: /Libreria Spotify/ }).click();
    const one = page_.getByRole("button", { name: "Aggiungi tutte le mie playlist" });
    await one.waitFor({ timeout: 8000 });
    check(await one.isEnabled(), "signed out, the one button is there");
    await signInWith(page_, one);
    const t0 = Date.now();
    await page_.locator(".oc-progress").waitFor({ timeout: 15000 });
    check(true, `back from the sign-in, the import started by itself (${Date.now() - t0} ms after the return)`);
    check(/#\/music\/splib/.test(page_.url()), "…on the library page");

    // 2. The progress: "Playlist i di n · brani x di y", and the sidebar chip i/n.
    const label = await page_
      .waitForFunction(() => {
        const el = document.querySelector(".oc-progress .mt-progress__label");
        return el && /Playlist \d+ di \d+ · brani \d+ di \d+/.test(el.textContent || "") ? el.textContent : null;
      }, null, { timeout: 15000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    check(!!label, `progress reads “${label ?? "?"}”`);
    const chip = await page_.locator(".mt-navchip").textContent({ timeout: 3000 }).catch(() => null);
    check(!!chip && /^\d+\/5$/.test(chip.trim()), `the sidebar chip shows n/m (“${chip}”)`);
    check((await page_.getByRole("button", { name: "Annulla" }).count()) >= 1, "it can be cancelled (Annulla)");

    // 3. The check: every list added.
    const sum = page_.locator(".oc-sum.is-ok");
    await sum.waitFor({ timeout: 60000 });
    const sumText = (await sum.textContent())?.trim();
    check(sumText === "5 di 5 playlist aggiunte", `the check says “${sumText}”`);
    check((await page_.locator(".oc-row.is-added").count()) === 5, "five rows show Aggiunta");
    check((await page_.locator(".oc-row.is-added svg").count()) >= 5, "…each with a drawn (SVG) icon");
    check((await page_.locator(".oc-note").textContent())?.includes("1 playlist") ?? false, "Spotify's own playlist is left out, with a note");
    check((await page_.getByText("Contenuti forniti da Spotify").count()) >= 1, "Spotify credited in words");

    // 4. The team playlists exist with their sources (the upsert bodies), nothing duplicated.
    const by = (name) => upserts.filter((r) => r.name === name);
    for (const l of LISTS.filter((x) => ["Mattino", "Sera", "Collab"].includes(x.name))) {
      const r = by(l.name);
      check(r.length === 1 && r[0].source_kind === "spotify-playlist" && r[0].source_id === l.id, `“${l.name}” saved once with source spotify-playlist/${l.id.slice(0, 6)}…`);
      check(r.length === 1 && r[0].tracks.length === l.songs.length && r[0].tracks.every((t, i) => t.spotify === l.songs[i].id), `…with its ${l.songs.length} songs, each keeping its Spotify id`);
    }
    const liked = by("Brani che ti piacciono");
    check(liked.length === 1 && liked[0].source_kind === "spotify-liked" && liked[0].source_id === ME, "the liked songs saved with source spotify-liked/<account>");
    check(by("Ufficio chill").length === 0, "the old “Ufficio chill” was not duplicated");
    const link = patches.find((p) => p.id === "plufficio" && p.body.source_kind);
    check(!!link && link.body.source_kind === "spotify-playlist" && link.body.source_id === id22("ufficio"), "…it was linked to its Spotify playlist");
    const uff = rows.get("plufficio").tracks.map((t) => t.title);
    check(uff.includes("Vecchio 99") && uff.includes("Vecchio 8") && uff.length === 5, `…and kept all its songs (${uff.length}: the source's new ones added, none removed)`);
    check(!patches.some((p) => p.id === "plsera") && JSON.stringify(rows.get("plsera").tracks) === seraBefore, "Giulia's hand-made “Sera” was not linked nor changed");
    check(by("Hit editoriali").length === 0, "Spotify's own playlist was not imported");
    check(upserts.every((r) => !JSON.stringify(r).includes("i.scdn.co")), "no Spotify cover art in the team playlists");
    // Songs 3–5 (Mattino + Sera) and song 0 (Mattino + liked) were matched once.
    const asked = matchBodies.flat().map((s) => s.title);
    check(["Brano 0", "Brano 3", "Brano 4", "Brano 5"].every((x) => asked.filter((y) => y === x).length === 1), `a song in several playlists is matched once (${asked.length} asked)`);
    check(apiCalls.filter((c) => c.startsWith("/playlists/") && c.includes(id22("editorial"))).length === 0, "the unreadable playlist was never read");

    // 5. Again: nothing new.
    const before = upserts.length;
    // By keyboard: the focus stays on the button while it runs (aria-disabled, not disabled).
    await page_.getByRole("button", { name: "Aggiungi tutte le mie playlist" }).focus();
    await page_.keyboard.press("Enter");
    const kept = await page_.evaluate(() => document.activeElement?.classList.contains("oc-all") ?? false);
    check(kept, "the focus stays on the one button after pressing it");
    await page_.locator(":is(.mp-toast, [data-undo-toast])", { hasText: "già nella libreria" }).waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(500);
    check(upserts.length === before, "a second click adds nothing");

    // 6. Importa: a pasted YouTube playlist link is saved in one click, with a toast and Apri.
    await page_.locator(".mt-side").getByRole("button", { name: /^Importa/ }).click();
    await page_.getByRole("button", { name: "Aggiungi tutte le mie playlist" }).waitFor({ timeout: 5000 });
    check(true, "the one button is on the Importa page too");
    const field = page_.getByPlaceholder("Link di YouTube, YouTube Music o Spotify");
    await field.fill("https://music.youtube.com/playlist?list=PLe2eOneClick123");
    const t1 = Date.now();
    await page_.getByRole("button", { name: "Aggiungi", exact: true }).click();
    const fb = await page_
      .waitForFunction(() => !!document.querySelector(".oc-progress, .mp-toast, [data-undo-toast]"), null, { timeout: 2000 })
      .then(() => Date.now() - t1)
      .catch(() => 9999);
    check(fb < 300, `the paste answers at once (${fb} ms)`);
    const toast = page_.locator(":is(.mp-toast, [data-undo-toast])", { hasText: "Aggiunta «" });
    await toast.waitFor({ timeout: 15000 });
    const yt = upserts.find((r) => r.source_kind === "youtube-playlist");
    check(!!yt && yt.source_id === "PLe2eOneClick123" && yt.tracks.length > 0, "the YouTube playlist saved with source youtube-playlist");
    await toast.getByRole("button", { name: "Apri" }).click();
    await page_.waitForFunction(() => /#\/music\/playlist\//.test(location.hash), null, { timeout: 5000 }).catch(() => {});
    check(!!yt && decodeURIComponent(page_.url()).includes(yt.id), "“Apri” opens it");

    // 7. Reading the playlists fails (403): the Importa page says why.
    listingFails = true;
    await page_.locator(".mt-side").getByRole("button", { name: /^Importa/ }).click();
    await page_.getByRole("button", { name: "Aggiungi tutte le mie playlist" }).click();
    const why = await page_.locator(":is(.mp-toast, [data-undo-toast])", { hasText: "Non riesco a leggere le tue playlist" }).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    check(why, "a failing listing shows a toast on the Importa page");
    listingFails = false;

    check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  } catch (e) {
    fails.push(String(e?.stack || e));
    console.error(e);
  } finally {
    await browser?.close().catch(() => {});
    stop();
  }
  if (fails.length) {
    console.error(`\n${fails.length} check(s) failed`);
    process.exit(1);
  }
  console.error("\nall checks passed");
}

main();
