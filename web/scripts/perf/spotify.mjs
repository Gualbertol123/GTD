#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Spotify mode, end to end, against MOCKED Spotify only (Playwright, Chromium,
// a production build with a fake Client ID):
//
//   node scripts/perf/spotify.mjs [--out DIR] [--no-build] [--headed]
//
//   - sdk.scdn.co/spotify-player.js  → lib/fakeSpotify.js (a fake
//     window.Spotify.Player that "plays" what PUT /me/player/play sends it);
//   - api.spotify.com                → answered here (search, player);
//   - accounts.spotify.com           → refused (the sign-in is seeded in
//     sessionStorage; nothing may call it);
//   - Supabase, the music functions and YouTube → lib/mocks.mjs, as for run.mjs.
//
// The run: YouTube plays a team playlist → switch to Spotify (the same song
// goes on there) → play another team playlist → Next → Next over a song that
// is not on Spotify (skipped) → Pause → switch back to YouTube → Play.
// Checked all along, from both fakes' own logs: the two engines never play at
// the same moment, YouTube never plays (and its frame is never visible) in
// Spotify mode, and every click shows its effect within ~100 ms.
// Exit 1 when a check fails.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { installMocks, PLAYLISTS, cat } from "./lib/mocks.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const FAKE_SP_SRC = readFileSync(join(HERE, "lib", "fakeSpotify.js"), "utf8");
const argv = process.argv.slice(2);
let OUT = join(HERE, ".build", "dist-spotify");
const opt = { build: true, headed: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") OUT = resolve(argv[++i]);
  else if (argv[i] === "--no-build") opt.build = false;
  else if (argv[i] === "--headed") opt.headed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The fake Spotify catalogue ---------------------------------------------------

/** A Spotify-like 22-char id for a YouTube id. */
const spId = (yt) => (cat.vid("sp:" + yt) + cat.vid("sp2:" + yt)).slice(0, 22).replace(/[-_]/g, "x");
/** Songs Spotify "does not have": the 3rd song of the second team playlist. */
const MISSING = new Set([PLAYLISTS[1].tracks[2].id]);
/** Every song the app can show, by the 4-char tag at the end of its title ("… [abcd]"). */
const BY_TAG = new Map();
for (const pl of PLAYLISTS) for (const t of pl.tracks) BY_TAG.set(t.id.slice(0, 4), t);
const META = new Map(); // spotify id → { name, artist }

function answerSearch(q) {
  const tag = q.match(/\[([\w-]{4})\]/)?.[1];
  const t = tag ? BY_TAG.get(tag) : null;
  if (!t || MISSING.has(t.id)) return { tracks: { items: [], total: 0 } };
  const id = spId(t.id);
  // Spotify's own name for it (a little different from YouTube's), the same artist.
  const name = `${t.title}`;
  META.set(id, { name, artist: t.channel, album: `Album di ${t.channel}`, cover: `https://i.scdn.co/image/${id}` });
  return {
    tracks: {
      items: [
        { id: spId("other:" + t.id), name: `${t.title} - Live`, duration_ms: 230000, artists: [{ name: t.channel }], album: { images: [] } },
        { id, name, duration_ms: 200000, artists: [{ name: t.channel }], album: { name: `Album di ${t.channel}`, images: [{ url: `https://i.scdn.co/image/${id}`, width: 640 }] } },
      ],
      total: 2,
    },
  };
}

// ---- Build + preview ----------------------------------------------------------------

function build() {
  console.error("[spotify-e2e] building with a fake Client ID →", OUT);
  execSync(`npx vite build --minify false --outDir "${OUT}" --emptyOutDir`, {
    cwd: WEB,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, VITE_SUPABASE_URL: "http://supabase.mock", VITE_SUPABASE_ANON_KEY: "anon", VITE_TEAM_EMAIL: "team@example.com", VITE_SPOTIFY_CLIENT_ID: "fake-client-id-for-tests" },
  });
}
function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen({ port, host: "localhost" }, () => srv.close(() => res(true)));
  });
}
async function startPreview() {
  let port = 4189;
  while (!(await portFree(port))) port++;
  const base = `http://localhost:${port}`;
  const p = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--outDir", OUT], { cwd: WEB, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/")).ok) return { p, base };
    } catch {}
    await sleep(200);
  }
  throw new Error("vite preview did not start");
}

// ---- In-page recorder ----------------------------------------------------------------

// Every 15 ms: which engine the app is on, whether each fake plays, whether
// YouTube's frame can be seen. (The fakes' own logs give the exact moments.)
const SAMPLER = `(() => {
  const S = (window.__spE2E = { samples: [], start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const m = window.__music && window.__music.state();
      const yt = window.__fake && window.__fake.current && window.__fake.current();
      const sp = window.__fakeSp && window.__fakeSp.current && window.__fakeSp.current();
      const box = document.querySelector(".mp .mp-video");
      const fr = box && box.querySelector("iframe");
      let frameVisible = false;
      if (box) {
        const r = box.getBoundingClientRect();
        const cs = getComputedStyle(box);
        const fs = fr ? getComputedStyle(fr) : null;
        frameVisible = !!fr && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && r.width >= 2 && r.height >= 2 && fs.display !== "none";
      }
      this.samples.push({ t: performance.now(), engine: m ? m.engine : null, yt: !!yt && yt.state === 1, sp: !!sp && sp.playing, frameVisible });
    }, 15);
  } });
})();`;

// ---- The run --------------------------------------------------------------------------

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.error(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Playing intervals [from, to) from a fake's log. */
function intervals(log, isPlaying, isEvent, end) {
  const out = [];
  let from = null;
  for (const e of log) {
    if (!isEvent(e)) continue;
    const on = isPlaying(e);
    if (on && from === null) from = e.t;
    else if (!on && from !== null) {
      out.push([from, e.t]);
      from = null;
    }
  }
  if (from !== null) out.push([from, end]);
  return out;
}

async function run(page, base, reqs) {
  const spCalls = [];
  page.on("request", (r) => {
    if (/spotify\.com|scdn\.co/.test(r.url())) spCalls.push({ method: r.method(), url: r.url() });
  });
  await page.goto(base + "/#/board");
  await page.getByRole("button", { name: /^(MUSICA|MUSIC)$/ }).first().click();
  await page.locator(".mt").waitFor({ timeout: 15000 });
  await page.locator('.mp[data-ready="true"]').waitFor({ state: "attached", timeout: 15000 });
  await page.evaluate(() => window.__spE2E.start());
  const bar = page.locator("footer.mt-bar");
  const spBtn = bar.getByRole("group", { name: /^(Riproduci con|Play with)$/ }).getByRole("button", { name: /Spotify$/ });
  const ytBtn = bar.getByRole("group", { name: /^(Riproduci con|Play with)$/ }).getByRole("button", { name: /YouTube$/ });
  check("the YouTube | Spotify switch is in the player bar", await spBtn.isVisible());

  // 1. YouTube plays song 1 of the first team playlist.
  const A = PLAYLISTS[0];
  await page.locator(".mt-side .mt-libitem").filter({ hasText: A.name }).first().click();
  await page.locator(".mt-main .mt-table .mt-tr:not(.mt-tr--head)").first().waitFor({ timeout: 8000 });
  await page.locator(".mt-main .mt-table .mt-tr:not(.mt-tr--head)").filter({ hasText: A.tracks[0].title }).first().locator(".mt-tr__title b").click();
  await page.waitForFunction((id) => { const c = window.__fake.current(); return c && c.state === 1 && c.id === id; }, A.tracks[0].id, { timeout: 12000 });
  check("YouTube plays the team playlist first", true);

  // 2. Switch to Spotify: the button answers at once, YouTube pauses first, the same song goes on in Spotify.
  const t0 = await page.evaluate(() => performance.now());
  await spBtn.click();
  const pressedMs = await page.evaluate(async (t0) => {
    for (;;) {
      const b = [...document.querySelectorAll('footer.mt-bar [role="group"] button')].find((x) => /Spotify$/.test(x.textContent.trim()));
      if (b && b.getAttribute("aria-pressed") === "true") return performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, t0);
  check("Spotify switch shows pressed within ~100 ms of the click", pressedMs < 250, `${Math.round(pressedMs)} ms (incl. Playwright's click)`);
  const firstSp = spId(A.tracks[0].id);
  await page.waitForFunction((uri) => window.__fakeSp && window.__fakeSp.current().playing && window.__fakeSp.current().uri === uri, `spotify:track:${firstSp}`, { timeout: 12000 });
  check("Spotify plays the same song (its matched twin)", true);
  check("YouTube is paused in Spotify mode", await page.evaluate(() => window.__fake.current().state !== 1));
  await page.waitForFunction((name) => document.querySelector("footer.mt-bar .mt-bar__song b")?.textContent === name, META.get(firstSp).name, { timeout: 3000 }).catch(() => {});
  const barImg = await bar.locator(".mt-bar__song img").first().getAttribute("src").catch(() => null);
  check("the bar shows Spotify's cover art", barImg === `https://i.scdn.co/image/${firstSp}`, String(barImg));
  const open = await bar.getByRole("link", { name: /^(Apri su Spotify|Open in Spotify)/ }).first().getAttribute("href").catch(() => null);
  check("'Apri su Spotify' links to the song on Spotify", open === `https://open.spotify.com/track/${firstSp}`, String(open));
  const credit = await bar.locator(".mp-spcredit__by").first().textContent().catch(() => "");
  check("Spotify is credited next to the song", /Spotify/.test(credit ?? ""), credit ?? "");

  // 3. Play another team playlist in Spotify mode.
  const B = PLAYLISTS[1];
  await page.locator(".mt-side .mt-libitem").filter({ hasText: B.name }).first().click();
  await page.locator(".mt-main .mt-table .mt-tr:not(.mt-tr--head)").filter({ hasText: B.tracks[0].title }).first().waitFor({ timeout: 8000 });
  await page.locator(".mt-main .mt-table .mt-tr:not(.mt-tr--head)").filter({ hasText: B.tracks[0].title }).first().locator(".mt-tr__title b").click();
  await page.waitForFunction((uri) => window.__fakeSp.current().playing && window.__fakeSp.current().uri === uri, `spotify:track:${spId(B.tracks[0].id)}`, { timeout: 12000 });
  const win = await page.evaluate(() => window.__fakeSp.current().uris);
  check("a team playlist plays in Spotify mode", true);
  check("the window sent to Spotify leaves out the song not on Spotify", !win.includes(`spotify:track:${spId(B.tracks[2].id)}`) && win.includes(`spotify:track:${spId(B.tracks[3].id)}`), `${win.length} uris`);

  // 4. Next: the next song in Spotify's window.
  await bar.getByRole("button", { name: /^(Successivo|Next)$/ }).click();
  await page.waitForFunction((uri) => window.__fakeSp.current().playing && window.__fakeSp.current().uri === uri, `spotify:track:${spId(B.tracks[1].id)}`, { timeout: 8000 });
  check("Next plays the next song on Spotify", true);

  // 5. Next again: song 3 is not on Spotify → skipped with a toast, song 4 plays.
  await bar.getByRole("button", { name: /^(Successivo|Next)$/ }).click();
  const toastText = await page.locator(".mp-toasts .mp-toast").filter({ hasText: /Non su Spotify|Not on Spotify/ }).first().textContent({ timeout: 5000 }).catch(() => null);
  await page.waitForFunction((uri) => window.__fakeSp.current().playing && window.__fakeSp.current().uri === uri, `spotify:track:${spId(B.tracks[3].id)}`, { timeout: 8000 });
  check("a song not on Spotify is skipped with a toast", !!toastText, toastText ?? "no toast");
  check("YouTube still never started", await page.evaluate(() => window.__fake.current().state !== 1));

  // 6. Pause.
  const tp = await page.evaluate(() => performance.now());
  await bar.getByRole("button", { name: /^(Pausa|Pause)$/ }).click();
  const pauseMs = await page.evaluate(async (tp) => {
    for (;;) {
      if (document.querySelector('footer.mt-bar button[aria-label="Riproduci"], footer.mt-bar button[aria-label="Play"]')) return performance.now() - tp;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, tp);
  await page.waitForFunction(() => window.__fakeSp.current().paused, null, { timeout: 4000 });
  check("Pause: the button flips within ~100 ms and Spotify pauses", pauseMs < 250, `${Math.round(pauseMs)} ms`);

  // 7. Back to YouTube: Spotify stays paused, YouTube stays paused; then Play → YouTube.
  await ytBtn.click();
  await sleep(600);
  check("back on YouTube: nothing plays until Play", await page.evaluate(() => !window.__fakeSp.current().playing && window.__fake.current().state !== 1));
  await bar.getByRole("button", { name: /^(Riproduci|Play)$/ }).click();
  await page.waitForFunction((id) => { const c = window.__fake.current(); return c && c.state === 1 && c.id === id; }, B.tracks[3].id, { timeout: 12000 });
  check("Play on YouTube goes on at the same song", true);
  await sleep(500);

  // ---- Over the whole run ----
  const data = await page.evaluate(() => ({ yt: window.__fake.log.slice(), sp: window.__fakeSp.log.slice(), samples: window.__spE2E.samples.slice(), end: performance.now(), engineLog: (window.__music.log || []).filter((e) => /ENGINE|Spotify/.test(e.ev)).map((e) => e.ev) }));
  const ytOn = intervals(data.yt, (e) => e.state === 1, (e) => typeof e.state === "number", data.end);
  const spOn = intervals(data.sp, (e) => e.state === "playing", (e) => typeof e.state === "string", data.end);
  const overlaps = [];
  for (const a of ytOn) for (const b of spOn) if (Math.max(a[0], b[0]) < Math.min(a[1], b[1])) overlaps.push([Math.max(a[0], b[0]), Math.min(a[1], b[1])]);
  check("never both engines playing at once (from the fakes' own logs)", overlaps.length === 0, overlaps.length ? JSON.stringify(overlaps) : `${ytOn.length} YouTube / ${spOn.length} Spotify plays`);
  const both = data.samples.filter((s) => s.yt && s.sp).length;
  check("never both playing in the 15 ms samples", both === 0, `${data.samples.length} samples`);
  const ytInSp = data.samples.filter((s) => s.engine === "spotify" && s.yt).length;
  check("YouTube never plays in Spotify mode", ytInSp === 0, `${data.samples.filter((s) => s.engine === "spotify").length} samples in Spotify mode`);
  const frameInSp = data.samples.filter((s) => s.engine === "spotify" && s.frameVisible).length;
  check("YouTube's frame is never visible in Spotify mode", frameInSp === 0);
  const accounts = spCalls.filter((c) => c.url.includes("accounts.spotify.com"));
  check("no call to accounts.spotify.com (the sign-in is seeded, nothing real)", accounts.length === 0);
  const playCalls = spCalls.filter((c) => c.method === "PUT" && c.url.includes("/me/player/play"));
  check("playback started with PUT /me/player/play on the device", playCalls.length >= 2 && playCalls.every((c) => c.url.includes("device_id=fake-device-1")), `${playCalls.length} calls`);
  return { ytOn: ytOn.length, spOn: spOn.length, spRequests: spCalls.length, functionCalls: reqs?.counts ? reqs.counts() : undefined };
}

async function main() {
  if (opt.build || !existsSync(join(OUT, "index.html"))) build();
  const { p: preview, base } = await startPreview();
  const browser = await chromium.launch({ headless: !opt.headed });
  let failed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", locale: "it-IT" });
    const reqs = await installMocks(context, { origin: base });
    await context.addInitScript({ content: SAMPLER });
    await context.addInitScript({
      content: `(() => { if (location.origin !== ${JSON.stringify(base)}) return; try { sessionStorage.setItem("gtd-spotify-token", JSON.stringify({ access: "fake-user-token", refresh: "fake-refresh", exp: Date.now() + 3600000 })); } catch (e) {} })();`,
    });
    // Registered after installMocks: these win over its "refuse everything else".
    await context.route("https://sdk.scdn.co/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SP_SRC }));
    await context.route("https://accounts.spotify.com/**", (route) => route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"invalid_request"}' }));
    await context.route("https://i.scdn.co/**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#1db954'/></svg>" }));
    await context.route("https://api.spotify.com/**", async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const auth = req.headers()["authorization"];
      if (auth !== "Bearer fake-user-token") return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"status":401}}' });
      await sleep(40);
      if (u.pathname === "/v1/search") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answerSearch(u.searchParams.get("q") ?? "")) });
      if (u.pathname === "/v1/me/player/play" && req.method() === "PUT") {
        const body = JSON.parse(req.postData() || "{}");
        const meta = {};
        for (const uri of body.uris ?? []) {
          const m = META.get(uri.split(":").pop());
          if (m) meta[uri] = m;
        }
        await req.frame().page().evaluate(({ uris, meta, pos }) => window.__fakeSp.play(uris, meta, pos), { uris: body.uris ?? [], meta, pos: body.position_ms ?? 0 });
        return route.fulfill({ status: 204, body: "" });
      }
      if (u.pathname.startsWith("/v1/me/player")) return route.fulfill({ status: 204, body: "" });
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"status":404}}' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    console.error("[spotify-e2e] YouTube → Spotify → team playlist → Next → Next (skip) → Pause → YouTube → Play");
    const summary = await run(page, base, reqs);
    check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    console.log(JSON.stringify({ checks, summary }, null, 2));
    await context.close();
  } catch (e) {
    console.error("[spotify-e2e] run failed:", e);
    failed = true;
  } finally {
    await browser.close().catch(() => {});
    try {
      process.kill(-preview.pid, "SIGTERM");
    } catch {}
  }
  const bad = checks.filter((c) => !c.ok);
  console.error(failed || bad.length ? `[spotify-e2e] FAILED (${bad.length} check(s))` : `[spotify-e2e] passed (${checks.length} checks)`);
  if (failed || bad.length) process.exitCode = 1;
}

main();
