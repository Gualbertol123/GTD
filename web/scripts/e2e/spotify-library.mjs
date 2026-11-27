#!/usr/bin/env node
// -----------------------------------------------------------------------------
// End-to-end check of "La mia libreria Spotify" (Playwright, Chromium, a
// production build). Nothing real is called: Supabase, the Netlify music
// functions and YouTube come from the perf harness mocks
// (scripts/perf/lib/mocks.mjs); accounts.spotify.com, api.spotify.com and
// sdk.scdn.co are answered here, and the person signs in with the app's own
// "Accedi con Spotify" against a mocked accounts.spotify.com (lib/spotify-signin.mjs).
//
//   node scripts/e2e/spotify-library.mjs              build, serve, check
//   node scripts/e2e/spotify-library.mjs --no-build   reuse the last build
//   node scripts/e2e/spotify-library.mjs --out DIR    build into DIR
//
// It checks: the library opens on "Le mie playlist" with every page of
// /me/playlists; a playlist that is not yours shows the details-only note;
// your own playlist lists its songs, "Aggiungi alla libreria del team" saves
// it in one click (no review page; a toast with "Apri"), and the team playlist
// saved to Supabase (the mocked upsert body) has every song's Spotify id in
// `spotify`, its source and no Spotify cover art; "Indietro" on an item opened from a
// link goes to its section, never out of the app. Exits 1 on any failure.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { installMocks, cat } from "../perf/lib/mocks.mjs";
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
const MY_LIST = id22("mylist");
const OTHER_LIST = id22("editorial");
const SONGS = Array.from({ length: 12 }, (_, i) => ({
  id: id22("song" + i),
  name: `Canzone di prova ${i + 1}`,
  duration_ms: 180000 + i * 1000,
  artists: [{ name: `Artista ${i % 3}` }],
  album: { name: "Album finto", images: [{ url: "https://i.scdn.co/image/cover" + i, width: 300 }] },
  type: "track",
  external_urls: { spotify: `https://open.spotify.com/track/${id22("song" + i)}` },
}));
const PLAYLISTS = Array.from({ length: 63 }, (_, i) => {
  const id = i === 0 ? MY_LIST : i === 1 ? OTHER_LIST : id22("pl" + i);
  const mine = i !== 1;
  return {
    id,
    name: i === 0 ? "Viaggio Spotify" : i === 1 ? "Hit editoriali" : `Playlist ${i}`,
    owner: mine ? { id: ME, display_name: "Io" } : { id: "spotify", display_name: "Spotify" },
    collaborative: false,
    images: [{ url: `https://i.scdn.co/image/pl${i}`, width: 300 }],
    external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
    items: { total: i === 0 ? SONGS.length : 20 },
  };
});
const apiCalls = [];

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

function answerSpotify(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/v1/, "");
  apiCalls.push(p + u.search);
  if (p === "/me") return { id: ME, display_name: "Io" };
  if (p === "/me/playlists") return page(u, PLAYLISTS);
  if (p === `/playlists/${MY_LIST}`) {
    const { items, ...meta } = PLAYLISTS[0];
    return { ...meta, items: { total: items.total } };
  }
  if (p === `/playlists/${OTHER_LIST}`) {
    // Details only: Spotify gives a playlist you neither own nor collaborate on no items.
    const { items: _i, ...meta } = PLAYLISTS[1];
    return meta;
  }
  if (p === `/playlists/${MY_LIST}/items`) return page(u, SONGS.map((s) => ({ is_local: false, item: s })));
  if (p === "/me/tracks") return page(u, SONGS.map((s) => ({ track: s })));
  return null;
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
    console.error("[splib-e2e] building →", OUT);
    execSync(`npx vite build --minify false --outDir "${OUT}" --emptyOutDir`, {
      cwd: WEB,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, VITE_SUPABASE_URL: "http://supabase.mock", VITE_SUPABASE_ANON_KEY: "anon", VITE_TEAM_EMAIL: "team@example.com", VITE_SPOTIFY_CLIENT_ID: "e2e-client-id" },
    });
  }
  let PORT = 4201;
  for (; PORT < 4230; PORT++) if (await portFree(PORT)) break;
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
    // Registered after installMocks: these win over its catch-all.
    await context.route("https://api.spotify.com/**", async (route) => {
      const req = route.request();
      if (req.headers()["authorization"] !== "Bearer fake-access") return route.fulfill({ status: 401, body: "{}" });
      const body = answerSpotify(req.url());
      await sleep(40);
      await route.fulfill(body ? { status: 200, contentType: "application/json", body: JSON.stringify(body) } : { status: 404, contentType: "application/json", body: '{"error":{"status":404}}' });
    });
    await routeSpotifyAccounts(context, { access: "fake-access" });
    await context.route("https://sdk.scdn.co/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: "window.Spotify={Player:class{constructor(){}connect(){return Promise.resolve(true)}addListener(){return true}removeListener(){}disconnect(){}activateElement(){return Promise.resolve()}}};window.onSpotifyWebPlaybackSDKReady&&window.onSpotifyWebPlaybackSDKReady();",
      })
    );
    await context.route("https://i.scdn.co/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64") })
    );
    // The team playlist written to Supabase: capture the upsert body.
    const upserts = [];
    await context.route(/^http:\/\/supabase\.mock\/rest\/v1\/music_playlists/, async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        let body = null;
        try {
          body = JSON.parse(req.postData() || "null");
          upserts.push(body);
        } catch {}
        // As Supabase does with .select(): the rows written come back.
        if (body) return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? body : [body]) });
      }
      await route.fallback();
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

    // 1. The sidebar entry opens the library on "Le mie playlist": every page of /me/playlists.
    await page_.locator(".mt-side").getByRole("button", { name: /Libreria Spotify/ }).click();
    // Signed out: the app's own sign-in (mocked accounts.spotify.com) brings it back to the library.
    await signInWith(page_, page_.getByRole("button", { name: /^Accedi con Spotify$/ }));
    await page_.locator(".spl-card").first().waitFor({ timeout: 10000 });
    await page_.waitForFunction((n) => document.querySelectorAll(".spl-card").length === n, PLAYLISTS.length, { timeout: 5000 }).catch(() => {});
    check((await page_.locator(".spl-card").count()) === PLAYLISTS.length, `all ${PLAYLISTS.length} playlists listed (2 pages of 50)`);
    check(apiCalls.filter((c) => c.startsWith("/me/playlists")).length === 2, "/me/playlists paged with next");
    check((await page_.locator(".spl-card").first().locator(".spl-from").count()) === 1, "every card says “da Spotify”");
    check((await page_.locator('.spl-card a[href^="https://open.spotify.com/playlist/"]').count()) === PLAYLISTS.length, "every card links back to Spotify");
    check(/#\/music\/splib/.test(page_.url()), "the address is #/music/splib");

    // 2. Someone else's playlist: details only, with the paste method offered.
    await page_.getByRole("button", { name: "Apri Hit editoriali" }).click();
    await page_.locator(".spl-meta").waitFor({ timeout: 8000 });
    check(await page_.locator(".spl-meta").isVisible(), "a playlist that is not yours shows the details-only note");
    check((await page_.getByRole("button", { name: /Incolla i brani/ }).count()) === 1, "…and offers the paste method");
    await page_.goBack();
    await page_.locator(".spl-card").first().waitFor({ timeout: 8000 });

    // 3. Your own playlist: its songs, then the import.
    await page_.getByRole("button", { name: "Apri Viaggio Spotify" }).click();
    await page_.locator(".spl-row").first().waitFor({ timeout: 8000 });
    check((await page_.locator(".spl-row").count()) === SONGS.length, `the playlist lists its ${SONGS.length} songs`);
    check((await page_.locator('.spl-row a[href^="https://open.spotify.com/track/"]').count()) === SONGS.length, "every song links back to Spotify");
    const t0 = Date.now();
    await page_.getByRole("button", { name: /Aggiungi alla libreria del team/ }).click();
    const fb0 = await page_
      .waitForFunction(() => !!document.querySelector('.spl-import[aria-busy="true"], .mp-toast, [data-undo-toast]'), null, { timeout: 1500 })
      .then(() => Date.now() - t0)
      .catch(() => 9999);
    check(fb0 < 300, `"Aggiungi" answers at once (${fb0} ms)`);
    check(/#\/music\/splib/.test(page_.url()), "one click: no review page (still on the library)");
    for (let i = 0; i < 200 && !upserts.flat().some((r) => r && r.name === "Viaggio Spotify"); i++) await sleep(100);
    const row = upserts.flat().find((r) => r && r.name === "Viaggio Spotify");
    check(!!row, "the team playlist was upserted to Supabase, named after the list");
    check(!!row && row.source_kind === "spotify-playlist" && row.source_id === MY_LIST, "…with its source (spotify-playlist)");
    check(!!row && !JSON.stringify(row).includes("i.scdn.co"), "…and no Spotify cover art");
    await page_.locator(":is(.mp-toast, [data-undo-toast])", { hasText: "Aggiunta «Viaggio Spotify»" }).waitFor({ timeout: 8000 });
    check(true, "a toast says “Aggiunta «Viaggio Spotify» (…)”");
    await page_.locator(":is(.mp-toast, [data-undo-toast])").getByRole("button", { name: "Apri" }).click();
    await page_.waitForFunction(() => /#\/music\/playlist\//.test(location.hash), null, { timeout: 5000 }).catch(() => {});
    check(/playlist\//.test(decodeURIComponent(page_.url())), "“Apri” opens the new team playlist");
    if (row) {
      // The mock matches every song but each 7th (index 6): 11 of 12.
      const want = SONGS.filter((_, i) => i % 7 !== 6).map((s) => s.id);
      check(row.tracks.length === want.length, `${want.length} songs saved (${row.tracks.length})`);
      check(
        row.tracks.every((t, i) => t.spotify === want[i]),
        "every saved song carries its Spotify track id in `spotify`"
      );
      check(row.tracks.every((t) => typeof t.id === "string" && t.id.length === 11), "…and its YouTube id in `id`");
    }

    // 4. One song: "+" finds it on YouTube, then the tab's "+" menu makes a team playlist with it.
    await page_.locator(".mt-side").getByRole("button", { name: /Libreria Spotify/ }).click();
    await page_.getByRole("tab", { name: "Brani che ti piacciono" }).click();
    await page_.locator(".spl-row").first().waitFor({ timeout: 8000 });
    const before = upserts.length;
    const plus = page_.locator(".spl-row").nth(1).getByRole("button", { name: "Aggiungi a playlist" });
    const t1 = Date.now();
    await plus.click();
    const fb = await page_
      .waitForFunction(() => !!document.querySelector('.spl-row:nth-child(2) [aria-busy="true"], .mt-menu--float'), null, { timeout: 1000 })
      .then(() => Date.now() - t1)
      .catch(() => 9999);
    check(fb < 300, `"+" answers at once (spinner or menu in ${fb} ms)`);
    await page_.locator(".mt-menu--float").waitFor({ timeout: 8000 });
    await page_.locator(".mt-menu--float").getByRole("menuitem", { name: /Crea playlist/ }).click();
    await page_.locator(".mt-menu--float input").fill("Singolo da Spotify");
    await page_.locator(".mt-menu--float").getByRole("button", { name: "Crea" }).click();
    for (let i = 0; i < 80 && upserts.length === before; i++) await sleep(100);
    const one = upserts.slice(before).flat().find((r) => r && r.name === "Singolo da Spotify");
    check(!!one && one.tracks.length === 1 && one.tracks[0].spotify === SONGS[1].id, "a single song added with “+” keeps its Spotify id");

    // 5. An item reached from a link: "Indietro" goes to its section, inside the app.
    await page_.goto(BASE + "/#/board");
    await page_.goto(BASE + `/#/music/splib/playlists/playlist/${MY_LIST}`);
    await page_.locator(".spl-row").first().waitFor({ timeout: 10000 });
    check((await page_.locator(".spl-row img").count()) === 0, "song rows (with their “+”) show no Spotify cover art");
    await page_.getByRole("button", { name: "Indietro" }).click();
    await page_.locator(".spl-card").first().waitFor({ timeout: 8000 });
    check(/#\/music\/splib\/playlists$/.test(decodeURIComponent(page_.url())), `"Indietro" from a link opens the section (${page_.url()})`);

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
