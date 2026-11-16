#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Music UI performance harness (Playwright, Chromium, production build).
//
//   node scripts/perf/run.mjs --label baseline         build, serve, measure
//   node scripts/perf/run.mjs --label after --no-build reuse the last build
//   node scripts/perf/run.mjs --only S2,S4 --reps 1    a subset, once
//   node scripts/perf/run.mjs --compare baseline after before/after table
//
// Everything outside the app is mocked (lib/mocks.mjs): Supabase, the Netlify
// music functions, and a deliberately SLOW fake YouTube IFrame API
// (lib/fakeYT.js). Results: scripts/perf/results/<label>.json. See README.md.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installMocks, TRENDS, PLAYLISTS, cat } from "./lib/mocks.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB = join(HERE, "..", "..");
let WEB = DEFAULT_WEB; // --web <dir>: build from another checkout (e.g. a frozen baseline)
const OUT = join(HERE, ".build", "dist");
const RESULTS = join(HERE, "results");
const PORT = 4179;
const BASE = `http://localhost:${PORT}`;

// =============================================================================
// SELECTORS — all in one place. Prefer roles / aria-labels / text (IT + EN),
// with the component class names as the fallback anchor.
// A string is a CSS selector; an object is { role, name, exact?, within? }
// (getByRole, optionally inside the `within` CSS scope).
// =============================================================================
const PLAY = /^(Riproduci|Pausa|Play|Pause)$/;
export const SEL = {
  // --- desktop shell
  boardReady: { role: "button", name: /^(MUSICA|MUSIC)$/ },
  tabMusic: { role: "button", name: /^(MUSICA|MUSIC)$/ },
  noteButton: 'button[aria-pressed][aria-label="Musica"], button[aria-pressed][aria-label="Music"]',
  // --- MUSICA tab
  musicRoot: ".mt",
  trendRows: ".mt-tgrid .mt-trow",
  trendRowN: (n) => `.mt-tgrid .mt-trow:nth-child(${n + 1})`,
  songPlayButton: (title, within = ".mt-main") => ({ within, role: "button", name: new RegExp(`^(Riproduci|Play) ${escapeRe(title)}$`) }),
  playAll: { within: ".mt-main", role: "button", name: /^(Riproduci tutto|Play all)$/ },
  chartCards: ".mt-main .mt-chips + .mt-cards .mt-card", // the country chips, then the chart lists
  libItems: ".mt-side .mt-libitem",
  playerReady: '.mp[data-ready="true"]',
  bar: "footer.mt-bar",
  barTitle: "footer.mt-bar .mt-bar__song b",
  barPlayBtn: "footer.mt-bar .mt-bar__controls .mt-play",
  nowTitle: ".mt-now .mt-now__title",
  queueFirst: ".mt-now .mt-queue .mt-qitem b",
  barPlayPause: { within: "footer.mt-bar", role: "button", name: PLAY },
  barNext: { within: "footer.mt-bar", role: "button", name: /^(Successivo|Next)$/ },
  barShuffle: { within: "footer.mt-bar", role: "button", name: /^(Casuale|Shuffle)$/ },
  barShuffleCss: 'footer.mt-bar button[aria-pressed][aria-label="Casuale"], footer.mt-bar button[aria-pressed][aria-label="Shuffle"]',
  volume: { within: "footer.mt-bar", role: "slider", name: /^Volume$/ },
  modeVideo: { within: "footer.mt-bar", role: "button", name: /Video$/ },
  dockSlot: ".mt-now .mt-now__video",
  playerFrame: ".mp",
  sideSearch: { within: ".mt-side", role: "button", name: /(Cerca|Search)$/ },
  searchInput: { within: ".mt-main", role: "textbox", name: /^(Cerca|Search)$/ },
  suggestions: '.mt-main [role="listbox"] [role="option"]',
  searchSpinner: ".mt-main .mt-search .mt-spin",
  tableRows: ".mt-main .mt-table .mt-tr:not(.mt-tr--head)",
  tableRowTitle: ".mt-tr__title b",
  // --- song menu
  songMenu: '[role="menu"].song-menu',
  menuPlayNext: { within: '[role="menu"]', role: "menuitem", name: /^(Riproduci dopo|Play next)$/ },
  // --- ♪ panel (floating player)
  panel: ".mp.mp--open",
  panelTrends: ".mp .mp-mix",
  panelTitle: ".mp .mp-now__title",
  panelPlayBtn: ".mp .mp-strip .mp-icon--main",
  panelMinimize: { within: ".mp", role: "button", name: /^(Riduci|Minimise)$/ },
  panelSearchInput: { within: ".mp", role: "textbox", name: /^(Cerca qualsiasi brano|Search any song)$/ },
  panelResults: ".mp .mp-result",
  // --- phone
  mobileDock: "nav.m-dock",
  mobileMore: { role: "button", name: /^(Altro|More)$/ },
  mobileMusicRow: { role: "button", name: /^(Musica|Music)\b/ },
};
// Text that is a status, not a song (the "can't play here" notice etc.).
const NOTICE_RE = /(riproducibile|cannot play|skipping|passo al successivo)/i;
// =============================================================================

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function loc(page, spec) {
  if (typeof spec === "string") return page.locator(spec);
  const root = spec.within ? page.locator(spec.within) : page;
  return root.getByRole(spec.role, { name: spec.name, exact: spec.exact });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI ----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const args = { label: "run", build: true, reps: 3, only: null, compare: null, headed: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--label") args.label = argv[++i];
  else if (a === "--no-build") args.build = false;
  else if (a === "--web") WEB = resolve(argv[++i]);
  else if (a === "--reps") args.reps = Number(argv[++i]) || 1;
  else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim().toUpperCase());
  else if (a === "--compare") args.compare = [argv[++i], argv[++i]];
  else if (a === "--help" || a === "-h") {
    console.log("usage: node scripts/perf/run.mjs [--label NAME] [--web DIR] [--no-build] [--reps N] [--only S1,S2] | --compare A B");
    process.exit(0);
  }
}

// ---- Build + preview ---------------------------------------------------------------------

function build() {
  console.error("[perf] building", WEB, "(minify off, names kept) →", OUT);
  execSync(`npx vite build --minify false --outDir "${OUT}" --emptyOutDir`, {
    cwd: WEB,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, VITE_SUPABASE_URL: "http://supabase.mock", VITE_SUPABASE_ANON_KEY: "anon", VITE_TEAM_EMAIL: "team@example.com" },
  });
}

async function startPreview() {
  const p = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", OUT], {
    cwd: WEB,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errText = "";
  p.stderr.on("data", (d) => (errText += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + "/");
      if (r.ok) return p;
    } catch {}
    if (p.exitCode !== null) throw new Error("vite preview exited: " + errText);
    await sleep(200);
  }
  throw new Error("vite preview did not start: " + errText);
}
function stopPreview(p) {
  try {
    process.kill(-p.pid, "SIGTERM");
  } catch {}
}

// ---- In-page helpers --------------------------------------------------------------------

async function snap(page) {
  return page.evaluate(() => ({ c: window.__commitsSnap(), lt: window.__lt.length, ev: window.__ev.length, t: performance.now(), scrolls: window.__scrolls }));
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
function topNames(byName, n = 6) {
  return Object.entries(byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}
/** Commits, renders, long tasks and input timing since a snapshot. */
async function since(page, s0) {
  const d = await page.evaluate((s0) => {
    const c = window.__commitsSnap();
    const by = {};
    for (const k in c.byName) {
      const v = c.byName[k] - (s0.c.byName[k] || 0);
      if (v) by[k] = v;
    }
    return {
      commits: c.commits - s0.c.commits,
      fibers: c.fibersRendered - s0.c.fibersRendered,
      byName: by,
      lt: window.__lt.slice(s0.lt),
      ev: window.__ev.slice(s0.ev),
      dt: performance.now() - s0.t,
      scrolls: window.__scrolls - s0.scrolls,
      hookErr: window.__commits.lastErr,
    };
  }, s0);
  const inter = new Map();
  for (const e of d.ev) {
    const key = e.id || `n${e.s}`;
    const cur = inter.get(key) ?? { d: 0, delay: Infinity, name: e.name };
    cur.d = Math.max(cur.d, e.d);
    cur.delay = Math.min(cur.delay, e.ps - e.s);
    inter.set(key, cur);
  }
  const durs = [...inter.values()].map((x) => x.d);
  const delays = [...inter.values()].map((x) => x.delay);
  return {
    commits: d.commits,
    fibers: d.fibers,
    byName: d.byName,
    seconds: d.dt / 1000,
    scrolls: d.scrolls,
    longTasks: d.lt.length,
    longTaskMaxMs: Math.round(Math.max(0, ...d.lt.map((x) => x.d))),
    longTaskTotalMs: Math.round(d.lt.reduce((a, x) => a + x.d, 0)),
    slowEvents: d.ev.length, // event-timing entries ≥16 ms
    inpMaxMs: Math.round(Math.max(0, ...durs)),
    inpP75Ms: Math.round(pct(durs, 75)),
    inputDelayMaxMs: Math.round(Math.max(0, ...delays.filter(isFinite))),
    inputDelayP75Ms: Math.round(pct(delays.filter(isFinite), 75)),
    hookErr: d.hookErr,
  };
}
const fakeLog = (page) => page.evaluate(() => (window.__fake ? window.__fake.log.slice() : []));
const fakeNow = (page) => page.evaluate(() => (window.__fake && window.__fake.current ? window.__fake.current() : null));
const arm = (page, watch) => page.evaluate((w) => window.__rec.arm(w), watch);
const collect = (page) => page.evaluate(() => window.__rec.collect());
async function waitFake(page, fnSrc, timeout = 8000) {
  // fnSrc: body of (log, cur) => boolean
  await page.waitForFunction(
    (src) => {
      const f = new Function("log", "cur", src);
      return window.__fake && f(window.__fake.log, window.__fake.current && window.__fake.current());
    },
    fnSrc,
    { timeout, polling: 50 }
  );
}
const r0 = (x) => (x == null || !isFinite(x) ? null : Math.round(x));

/** [{t, v}] for one watched key, starting with the value at arm time. */
function timeline(rec, key) {
  const tl = [{ t: rec.armedAt, v: rec.initial[key] }];
  for (const c of rec.changes) if (c.k === key) tl.push({ t: c.t, v: c.v });
  return tl;
}
function valueAt(tl, t) {
  let v = tl[0].v;
  for (const x of tl) if (x.t <= t) v = x.v;
  return v;
}
/** First time after `from` that key's value satisfies pred (ms after from), or null. */
function firstWhen(rec, key, pred, from) {
  if (pred(valueAt(timeline(rec, key), from))) return 0;
  for (const c of rec.changes) if (c.k === key && c.t >= from && pred(c.v)) return c.t - from;
  return null;
}
/** First change of any (or the given) key after `from`. */
function firstChange(rec, from, keys) {
  for (const c of rec.changes) if (c.t >= from && (!keys || keys.includes(c.k))) return c.t - from;
  return null;
}
/** ms during [from, to] where key showed a song title other than `expected`. */
function wrongSongTime(rec, key, from, to, expected) {
  const tl = timeline(rec, key);
  let ms = 0;
  const titles = new Set();
  for (let i = 0; i < tl.length; i++) {
    const a = Math.max(tl[i].t, from);
    const b = Math.min(i + 1 < tl.length ? tl[i + 1].t : to, to);
    const v = tl[i].v;
    if (b > a && typeof v === "string" && cat.SONG_TITLE_RE.test(v) && v !== expected) {
      ms += b - a;
      titles.add(v);
    }
  }
  return { ms: Math.round(ms), titles: [...titles] };
}

// ---- Page set-up -------------------------------------------------------------------------

async function newContext(browser, mobile = false) {
  const opts = mobile
    ? (() => {
        const { defaultBrowserType, ...d } = devices["iPhone 13"];
        return { ...d };
      })()
    : { viewport: { width: 1440, height: 900 } };
  const context = await browser.newContext({ ...opts, serviceWorkers: "block", locale: "it-IT" });
  const reqs = await installMocks(context, { origin: BASE });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 200)));
  return { context, page, reqs, consoleErrors };
}

async function openBoard(page) {
  await page.goto(BASE + "/#/board");
  await loc(page, SEL.boardReady).first().waitFor({ timeout: 20000 });
}
async function waitTrends(page) {
  await page.locator(SEL.trendRows).first().waitFor({ timeout: 15000 });
}
async function openMusic(page) {
  await openBoard(page);
  await loc(page, SEL.tabMusic).first().click();
  await page.locator(SEL.musicRoot).waitFor({ timeout: 10000 });
  await waitTrends(page);
  await page.locator(SEL.playerReady).waitFor({ state: "attached", timeout: 10000 });
  await sleep(400);
}
async function waitPlayingId(page, id, timeout = 9000) {
  await waitFake(page, `const c = cur; return c && c.state === 1 && c.id === ${JSON.stringify(id)};`, timeout);
}
async function playAllTrends(page) {
  await loc(page, SEL.playAll).first().click();
  await waitPlayingId(page, TRENDS[0].id);
}
/** A track-table row's play button only shows on hover. */
async function playTableRow(page, title) {
  const row = page.locator(SEL.tableRows).filter({ hasText: title }).first();
  await row.hover();
  const btn = row.getByRole("button", { name: SEL.songPlayButton(title).name }).first();
  if (await btn.isVisible().catch(() => false)) return btn.click();
  // No visible play button (layout changed): a double-click plays in every version.
  await row.locator(SEL.tableRowTitle).first().dblclick();
}
function fakeAfter(log, t0) {
  return log.filter((e) => e.t >= t0);
}
function firstCmd(log, t0, names) {
  const e = log.find((x) => x.t >= t0 && x.cmd && (!names || names.includes(x.cmd)));
  return e ? e.t - t0 : null;
}
function firstState(log, t0, state, id) {
  const e = log.find((x) => x.t >= t0 && x.state === state && (!id || x.id === id));
  return e ? e : null;
}
const titleWatch = () => ({
  bar: { sel: SEL.barTitle, kind: "text" },
  now: { sel: SEL.nowTitle, kind: "text" },
  play: { sel: SEL.barPlayBtn, kind: "attr", attr: "aria-label" },
});

// =============================================================================
// SCENARIOS — each returns a flat {metric: number|boolean|string} object.
// =============================================================================

const SCENARIOS = [];
const def = (id, title, fn, opts = {}) => SCENARIOS.push({ id, title, fn, ...opts });

def("S0", "Sanity: idle board 5 s, nothing playing (commit counter ≈ 0)", async ({ page, reqs }) => {
  await openBoard(page);
  await sleep(2500);
  const mark = reqs.mark();
  const s0 = await snap(page);
  await sleep(5000);
  const d = await since(page, s0);
  return {
    commits: d.commits,
    fibersRendered: d.fibers,
    longTasks: d.longTasks,
    requests: Object.entries(reqs.since(mark)).map(([k, v]) => `${k}=${v}`).join(" ") || "0",
    topRenders: topNames(d.byName),
  };
});

def("S1", "Open MUSICA tab (from the board)", async ({ page, reqs }) => {
  await openBoard(page);
  await sleep(1500);
  const mark = reqs.mark();
  const s0 = await snap(page);
  await arm(page, {
    shell: { sel: SEL.musicRoot, kind: "exists" },
    trends: { sel: SEL.trendRows, kind: "count" },
    charts: { sel: SEL.chartCards, kind: "count" },
    lib: { sel: SEL.libItems, kind: "count" },
    ready: { sel: SEL.playerReady, kind: "exists" },
  });
  await loc(page, SEL.tabMusic).first().click();
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, SEL.trendRows, { timeout: 15000 });
  await sleep(2000);
  const rec = await collect(page);
  const d = await since(page, s0);
  const t0 = rec.t0;
  const req = reqs.since(mark);
  return {
    shellMs: r0(firstWhen(rec, "shell", (v) => v === true, t0)),
    playlistsMs: r0(firstWhen(rec, "lib", (v) => v > 0, t0)),
    trendsMs: r0(firstWhen(rec, "trends", (v) => v > 0, t0)),
    chartsMs: r0(firstWhen(rec, "charts", (v) => v > 0, t0)),
    playerReadyMs: r0(firstWhen(rec, "ready", (v) => v === true, t0)),
    requests: Object.values(req).reduce((a, b) => a + b, 0),
    requestsFns: Object.entries(req).filter(([k]) => k.startsWith("fn:")).reduce((a, [, v]) => a + v, 0),
    requestsSupabase: Object.entries(req).filter(([k]) => k.startsWith("sb:")).reduce((a, [, v]) => a + v, 0),
    requestsImages: req["img:ytimg"] ?? 0,
    requestsBreakdown: Object.entries(req).filter(([k]) => !k.startsWith("img")).map(([k, v]) => `${k}=${v}`).join(" "),
    commits: d.commits,
    fibersRendered: d.fibers,
    longTasks: d.longTasks,
    longTaskMaxMs: d.longTaskMaxMs,
    inpMaxMs: d.inpMaxMs,
    topRenders: topNames(d.byName),
  };
});

async function measurePlayClick(page, tr, rowIndex) {
  const watch = { ...titleWatch(), row: { sel: SEL.trendRowN(rowIndex), kind: "class" } };
  await arm(page, watch);
  await loc(page, SEL.songPlayButton(tr.title)).first().click();
  let playingOk = true;
  try {
    await waitPlayingId(page, tr.id, 9000);
  } catch {
    playingOk = false;
  }
  await sleep(800);
  const rec = await collect(page);
  const log = await fakeLog(page);
  const t0 = rec.t0;
  const playing = firstState(log, t0, 1);
  const end = rec.now;
  // Wrong song = after the app has reacted to the click (its first DOM change),
  // a song title other than the clicked one is on screen.
  const feedback = firstChange(rec, t0);
  const from = t0 + (feedback ?? 0) + 1;
  const wrongBar = wrongSongTime(rec, "bar", from, end, tr.title);
  const wrongNow = wrongSongTime(rec, "now", from, end, tr.title);
  return {
    feedbackMs: r0(feedback),
    titleShownMs: r0(firstWhen(rec, "bar", (v) => v === tr.title, t0)),
    rowHighlightMs: r0(firstWhen(rec, "row", (v) => /is-on/.test(v ?? ""), t0)),
    // 0 = the button already said "Pausa" (the previous song) while the new one buffers.
    pauseIconMs: r0(firstWhen(rec, "play", (v) => /^(Pausa|Pause)$/.test(v ?? ""), t0)),
    commandMs: r0(firstCmd(log, t0)),
    playingMs: playing ? r0(playing.t - t0) : null,
    playingIdCorrect: !!playing && playing.id === tr.id && playingOk,
    titleAtPlayingCorrect: playing ? valueAt(timeline(rec, "bar"), playing.t + 1) === tr.title : false,
    wrongSongShownMs: Math.max(wrongBar.ms, wrongNow.ms),
    wrongSongTitles: [...new Set([...wrongBar.titles, ...wrongNow.titles])].join(" / ") || "",
  };
}

def("S2", "Click play on a trending song (cold, then while another plays)", async ({ page }) => {
  await openMusic(page);
  const s0 = await snap(page);
  const cold = await measurePlayClick(page, TRENDS[2], 2);
  const d = await since(page, s0);
  await sleep(1000);
  const warm = await measurePlayClick(page, TRENDS[4], 4);
  const out = {};
  for (const [k, v] of Object.entries(cold)) out[`cold.${k}`] = v;
  for (const [k, v] of Object.entries(warm)) out[`warm.${k}`] = v;
  out["cold.commits"] = d.commits;
  out["cold.inpMaxMs"] = d.inpMaxMs;
  return out;
});

def("S3", "Toggle pause/play while BUFFERING and while PLAYING", async ({ page }) => {
  await openMusic(page);
  const tr = TRENDS[1];
  await loc(page, SEL.songPlayButton(tr.title)).first().click();
  await waitFake(page, `return cur && cur.state === 3 && cur.id === ${JSON.stringify(tr.id)};`, 6000);
  // 1) While buffering: the user presses the main button.
  await arm(page, titleWatch());
  const labelBefore = await page.locator(SEL.barPlayBtn).getAttribute("aria-label");
  await loc(page, SEL.barPlayPause).first().click();
  await sleep(2600);
  let rec = await collect(page);
  let log = await fakeLog(page);
  const cmdsBuf = fakeAfter(log, rec.t0).filter((e) => e.cmd).map((e) => e.cmd);
  const afterBuf = await fakeNow(page);
  const out = {
    "buffering.labelShown": labelBefore,
    "buffering.feedbackMs": r0(firstChange(rec, rec.t0, ["play"])),
    "buffering.commandSent": cmdsBuf.join(",") || "none",
    "buffering.stateAfter": { 1: "PLAYING", 2: "PAUSED", 3: "BUFFERING", [-1]: "UNSTARTED" }[afterBuf?.state] ?? String(afterBuf?.state),
    // The user pressed while it was not yet audible: did it end up paused (the intent) or playing?
    "buffering.pressHonoured": afterBuf?.state === 2,
  };
  // 2) While playing: pause.
  await waitPlayingId(page, tr.id, 6000).catch(() => {});
  await sleep(1000);
  await arm(page, titleWatch());
  await loc(page, SEL.barPlayPause).first().click();
  await page.waitForFunction((sel) => /^(Riproduci|Play)$/.test(document.querySelector(sel)?.getAttribute("aria-label") ?? ""), SEL.barPlayBtn, { timeout: 4000 }).catch(() => {});
  await sleep(300);
  rec = await collect(page);
  log = await fakeLog(page);
  out["pause.feedbackMs"] = r0(firstChange(rec, rec.t0, ["play"]));
  out["pause.commandMs"] = r0(firstCmd(log, rec.t0, ["pauseVideo"]));
  out["pause.pausedMs"] = r0(firstState(log, rec.t0, 2)?.t - rec.t0);
  // 3) While paused: play.
  await sleep(500);
  await arm(page, titleWatch());
  await loc(page, SEL.barPlayPause).first().click();
  await page.waitForFunction((sel) => /^(Pausa|Pause)$/.test(document.querySelector(sel)?.getAttribute("aria-label") ?? ""), SEL.barPlayBtn, { timeout: 5000 }).catch(() => {});
  await sleep(300);
  rec = await collect(page);
  log = await fakeLog(page);
  out["resume.feedbackMs"] = r0(firstChange(rec, rec.t0, ["play"]));
  out["resume.commandMs"] = r0(firstCmd(log, rec.t0, ["playVideo"]));
  out["resume.playingMs"] = r0(firstState(log, rec.t0, 1)?.t - rec.t0);
  return out;
});

def("S4", "Next ×3 quickly", async ({ page }) => {
  await openMusic(page);
  await playAllTrends(page);
  await sleep(1000);
  const s0 = await snap(page);
  await arm(page, titleWatch());
  const next = loc(page, SEL.barNext).first();
  for (let i = 0; i < 3; i++) {
    await next.click();
    await sleep(100);
  }
  // Settle: the fake player idle (no new log entry) for 2.5 s, max 15 s.
  const tEnd = Date.now() + 15000;
  while (Date.now() < tEnd) {
    const quiet = await page.evaluate(() => performance.now() - (window.__fake.log.at(-1)?.t ?? 0));
    if (quiet > 2500) break;
    await sleep(250);
  }
  const rec = await collect(page);
  const d = await since(page, s0);
  const log = await fakeLog(page);
  const cur = await fakeNow(page);
  const t0 = rec.t0;
  const tLast = rec.inputs.filter((x) => x.type === "pointerdown").at(-1)?.t ?? t0;
  const bar = rec.last.bar;
  const after = fakeAfter(log, t0);
  const wrong = wrongSongTime(rec, "bar", t0, rec.now, cur?.title);
  const shown = new Set(timeline(rec, "bar").filter((x) => x.t >= t0).map((x) => x.v));
  return {
    feedbackFirstClickMs: r0(firstChange(rec, t0, ["bar", "now"])),
    feedbackAfterLastClickMs: r0(firstChange(rec, tLast, ["bar", "now"])),
    settledPlayingMs: r0((after.filter((e) => e.state === 1).at(-1)?.t ?? NaN) - t0),
    nextCommands: after.filter((e) => e.cmd === "nextVideo").length,
    playingEvents: after.filter((e) => e.state === 1).length,
    fakeIndex: cur?.index,
    expectedIndex: 3,
    finalShownMatchesPlayer: bar === cur?.title,
    finalShown: bar,
    finalPlayer: cur?.title ?? "",
    titlesShownDuring: shown.size,
    staleTitleShownMs: wrong.ms,
    commits: d.commits,
    inpMaxMs: d.inpMaxMs,
  };
});

async function steady(page, reqs, label) {
  const mark = reqs.mark();
  const s0 = await snap(page);
  await sleep(10000);
  const d = await since(page, s0);
  const req = reqs.since(mark);
  return {
    [`${label}.commitsPerSec`]: +(d.commits / d.seconds).toFixed(2),
    [`${label}.fibersPerSec`]: +(d.fibers / d.seconds).toFixed(1),
    [`${label}.longTasks`]: d.longTasks,
    [`${label}.requests`]: Object.entries(req).filter(([k]) => !k.startsWith("img")).map(([k, v]) => `${k}=${v}`).join(" ") || "0",
    [`${label}.topRenders`]: topNames(d.byName, 8),
  };
}

def("S5", "Steady playback 10 s: MUSICA tab / ♪ panel / board (mini)", async ({ page, reqs, browser }) => {
  // a) MUSICA tab open (NowPlaying + PlayerBar)
  await openMusic(page);
  await playAllTrends(page);
  await sleep(1500);
  const out = { ...(await steady(page, reqs, "tab")) };
  // b) ♪ panel open on the board (a fresh page)
  const b = await newContext(browser);
  try {
    await openBoard(b.page);
    await b.page.locator(SEL.noteButton).first().click();
    await b.page.locator(SEL.panel).waitFor({ timeout: 5000 });
    await b.page.locator(SEL.playerReady).waitFor({ state: "attached", timeout: 10000 });
    await b.page.locator(SEL.panelTrends).click();
    await waitPlayingId(b.page, TRENDS[0].id, 10000);
    await sleep(1500);
    Object.assign(out, await steady(b.page, b.reqs, "panel"));
    // c) panel minimised: plain board with the music on
    await loc(b.page, SEL.panelMinimize).first().click();
    await sleep(1500);
    Object.assign(out, await steady(b.page, b.reqs, "board"));
  } finally {
    await b.context.close();
  }
  return out;
});

def("S6", "Volume drag (20 moves)", async ({ page }) => {
  await openMusic(page);
  await playAllTrends(page);
  await sleep(1000);
  const slider = loc(page, SEL.volume).first();
  const box = await slider.boundingBox();
  if (!box) throw new Error("volume slider has no box");
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.2;
  const x1 = box.x + box.width * 0.85;
  const logLen = (await fakeLog(page)).length;
  const s0 = await snap(page);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 20, y);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(600);
  const d = await since(page, s0);
  const log = (await fakeLog(page)).slice(logLen);
  const cur = await fakeNow(page);
  const shown = Number(await slider.inputValue());
  return {
    commits: d.commits,
    fibersRendered: d.fibers,
    commitsPerMove: +(d.commits / 20).toFixed(2),
    setVolumeCommands: log.filter((e) => e.cmd === "setVolume").length,
    unMuteCommands: log.filter((e) => e.cmd === "unMute").length,
    longTasks: d.longTasks,
    longTaskMaxMs: d.longTaskMaxMs,
    slowEvents: d.slowEvents,
    inpMaxMs: d.inpMaxMs,
    inputDelayMaxMs: d.inputDelayMaxMs,
    inputDelayP75Ms: d.inputDelayP75Ms,
    sliderMatchesPlayer: shown === cur?.volume,
    topRenders: topNames(d.byName),
  };
});

def("S7", "Search: type 'tiziano' char by char, then submit", async ({ page, reqs }) => {
  await openMusic(page);
  await loc(page, SEL.sideSearch).first().click();
  const input = loc(page, SEL.searchInput).first();
  await input.waitFor({ timeout: 5000 });
  await input.focus();
  const mark = reqs.mark();
  const s0 = await snap(page);
  const word = "tiziano";
  const CHAR_MS = 250;
  for (const ch of word) {
    await page.keyboard.type(ch);
    await sleep(CHAR_MS);
  }
  await sleep(1500);
  const d = await since(page, s0);
  const typing = reqs.since(mark);
  const sugs = await page.locator(SEL.suggestions).allTextContents();
  const stale = sugs.filter((s) => !s.trim().toLowerCase().startsWith(word)).length;
  const mark2 = reqs.mark();
  await arm(page, { spin: { sel: SEL.searchSpinner, kind: "exists" }, rows: { sel: SEL.tableRows, kind: "count" } });
  await page.keyboard.press("Enter");
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, SEL.tableRows, { timeout: 8000 });
  await sleep(300);
  const rec = await collect(page);
  const submit = reqs.since(mark2);
  return {
    charDelayMs: CHAR_MS,
    suggestRequests: typing["fn:browse:suggest"] ?? 0,
    otherRequestsWhileTyping: Object.entries(typing).filter(([k]) => k !== "fn:browse:suggest" && !k.startsWith("img")).map(([k, v]) => `${k}=${v}`).join(" ") || "0",
    typingCommits: d.commits,
    typingFibers: d.fibers,
    typingInpMaxMs: d.inpMaxMs,
    typingTopRenders: topNames(d.byName),
    suggestionsShown: sugs.length,
    staleSuggestions: stale,
    submitSpinnerMs: r0(firstWhen(rec, "spin", (v) => v === true, rec.t0)),
    submitResultsMs: r0(firstWhen(rec, "rows", (v) => v > 0, rec.t0)),
    submitSearchRequests: submit["fn:search"] ?? 0,
  };
});

def("S8", "Shuffle on, then 'Riproduci dopo' via the song menu", async ({ page }) => {
  await openMusic(page);
  const pl = PLAYLISTS[0];
  await page.locator(SEL.libItems).filter({ hasText: pl.name }).first().click();
  await page.locator(SEL.tableRows).first().waitFor({ timeout: 5000 });
  await playTableRow(page, pl.tracks[0].title);
  await waitPlayingId(page, pl.tracks[0].id, 9000);
  await sleep(2000); // the player's list has loaded
  await loc(page, SEL.barShuffle).first().click();
  await sleep(1500);
  const q1 = await page.locator(SEL.queueFirst).first().textContent({ timeout: 1000 }).catch(() => null);
  const c1 = await fakeNow(page);
  const fakeNext1 = c1?.order && c1.order[c1.index + 1] ? cat.titleFor(c1.order[c1.index + 1]) : null;
  const out = {
    "shuffle.fakeShuffled": !!c1?.shuffle,
    "shuffle.queueNextMatchesPlayer": q1 === fakeNext1,
    "shuffle.appNext": q1 ?? "",
    "shuffle.playerNext": fakeNext1 ?? "",
  };
  // Right-click song #10 of the table → "Riproduci dopo".
  const target = pl.tracks[10];
  await page.locator(SEL.tableRows).nth(10).click({ button: "right" });
  await page.locator(SEL.songMenu).waitFor({ timeout: 3000 });
  await arm(page, { ...titleWatch(), q: { sel: SEL.queueFirst, kind: "text" } });
  const logLen = (await fakeLog(page)).length;
  await loc(page, SEL.menuPlayNext).first().click();
  await sleep(4000);
  const rec = await collect(page);
  const log = (await fakeLog(page)).slice(logLen);
  const c2 = await fakeNow(page);
  const fakeNext2 = c2?.order && c2.order[c2.index + 1] ? cat.titleFor(c2.order[c2.index + 1]) : null;
  const shuffleOn = (await page.locator(SEL.barShuffleCss).first().getAttribute("aria-pressed")) === "true";
  // Interruption: time the music was not PLAYING after the enqueue.
  let gap = 0;
  let downAt = null;
  for (const e of log) {
    if (e.state === undefined) continue;
    if (e.state !== 1 && downAt === null) downAt = e.t;
    if (e.state === 1 && downAt !== null) {
      gap += e.t - downAt;
      downAt = null;
    }
  }
  Object.assign(out, {
    "enqueue.feedbackMs": r0(firstChange(rec, rec.t0)),
    "enqueue.commands": log.filter((e) => e.cmd).map((e) => e.cmd).join(","),
    "enqueue.playbackGapMs": r0(gap),
    "enqueue.nowMatchesPlayer": rec.last.bar === c2?.title,
    "enqueue.playerNextIsEnqueued": fakeNext2 === target.title,
    "enqueue.queueShowsEnqueuedNext": rec.last.q === target.title,
    "enqueue.queueNextMatchesPlayer": rec.last.q === fakeNext2,
    "enqueue.shuffleButtonOn": shuffleOn,
    "enqueue.playerShuffle": !!c2?.shuffle,
  });
  // Next: does the enqueued song play?
  await loc(page, SEL.barNext).first().click();
  await waitFake(page, `return cur && cur.state === 1 && cur.id === ${JSON.stringify(target.id)};`, 6000).catch(() => {});
  const c3 = await fakeNow(page);
  out["next.playsEnqueued"] = c3?.id === target.id;
  return out;
});

async function errorCase(page, click, watchMs) {
  await arm(page, titleWatch());
  const logLen = (await fakeLog(page)).length;
  await click();
  await sleep(watchMs);
  const rec = await collect(page);
  const log = (await fakeLog(page)).slice(logLen);
  const t0 = rec.t0;
  const errs = log.filter((e) => e.error);
  const firstErr = errs[0];
  const skip = firstErr ? log.find((e) => e.t > firstErr.t && (e.cmd === "nextVideo" || e.cmd === "playVideoAt" || e.cmd === "loadPlaylist")) : null;
  const playing = log.find((e) => e.state === 1);
  const cur = await fakeNow(page);
  return {
    errorAtMs: firstErr ? r0(firstErr.t - t0) : null,
    noticeShownMs: r0(firstWhen(rec, "bar", (v) => NOTICE_RE.test(v ?? ""), t0)),
    skipCommandAfterErrorMs: skip && firstErr ? r0(skip.t - firstErr.t) : null,
    recoveredPlayingMs: playing ? r0(playing.t - t0) : null,
    errors: errs.length,
    nextCommands: log.filter((e) => e.cmd === "nextVideo").length,
    loop: errs.length > 3,
    endState: { 1: "PLAYING", 2: "PAUSED", 3: "BUFFERING", 0: "ENDED", 5: "CUED", [-1]: "UNSTARTED" }[cur?.state] ?? String(cur?.state),
    barAtEnd: rec.last.bar ?? "",
    barMatchesPlayer: (rec.last.bar ?? "") === (cur?.state === 1 ? cur.title : "(nothing playing)"),
    playLabelAtEnd: rec.last.play ?? "",
  };
}

def("S9", "A song that fails (onError 150): skip, time, loops", async ({ page }) => {
  await openMusic(page);
  const out = {};
  // a) trend #6 fails, #7 plays
  const a = await errorCase(page, () => loc(page, SEL.songPlayButton(TRENDS[5].title)).first().click(), 6000);
  for (const [k, v] of Object.entries(a)) out[`one.${k}`] = v;
  // b) playlist "Errori": songs 1 and 2 fail, 3 plays
  const pl = PLAYLISTS[2];
  await page.locator(SEL.libItems).filter({ hasText: pl.name }).first().click();
  await page.locator(SEL.tableRows).first().waitFor({ timeout: 5000 });
  const b = await errorCase(page, () => playTableRow(page, pl.tracks[0].title), 9000);
  for (const [k, v] of Object.entries(b)) out[`twoInARow.${k}`] = v;
  // c) the LAST song of the list fails (nothing to skip to)
  const last = pl.tracks.at(-1);
  const c = await errorCase(page, () => playTableRow(page, last.title), 6000);
  for (const k of ["errorAtMs", "noticeShownMs", "errors", "nextCommands", "endState", "barAtEnd", "barMatchesPlayer", "playLabelAtEnd"]) out[`lastInList.${k}`] = c[k];
  return out;
});

def(
  "S10",
  "Phone (iPhone 13): Altro → Musica, tap play; long-press a song",
  async ({ page }) => {
    await page.goto(BASE + "/#/today");
    await page.locator(SEL.mobileDock).waitFor({ timeout: 20000 });
    await loc(page, SEL.mobileMore).first().tap();
    await loc(page, SEL.mobileMusicRow).first().tap();
    await page.locator(SEL.panel).waitFor({ timeout: 5000 });
    await page.locator(SEL.playerReady).waitFor({ state: "attached", timeout: 10000 });
    await sleep(400);
    await arm(page, {
      title: { sel: SEL.panelTitle, kind: "text" },
      mix: { sel: SEL.panelTrends, kind: "text" },
      play: { sel: SEL.panelPlayBtn, kind: "attr", attr: "aria-label" },
      dis: { sel: SEL.panelTrends, kind: "attr", attr: "disabled" },
    });
    await page.locator(SEL.panelTrends).tap();
    await waitPlayingId(page, TRENDS[0].id, 10000).catch(() => {});
    await sleep(500);
    const rec = await collect(page);
    const log = await fakeLog(page);
    const playing = firstState(log, rec.t0, 1);
    const out = {
      "tap.feedbackMs": r0(firstChange(rec, rec.t0)),
      "tap.titleMs": r0(firstWhen(rec, "title", (v) => v === TRENDS[0].title, rec.t0)),
      "tap.commandMs": r0(firstCmd(log, rec.t0)),
      "tap.playingMs": playing ? r0(playing.t - rec.t0) : null,
    };
    // Long-press a search result.
    const input = loc(page, SEL.panelSearchInput).first();
    await input.fill("tiziano");
    await input.press("Enter");
    await page.locator(SEL.panelResults).nth(2).waitFor({ timeout: 8000 });
    await sleep(500);
    const target = page.locator(SEL.panelResults).nth(2);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const logLen = (await fakeLog(page)).length;
    await arm(page, { menu: { sel: SEL.songMenu, kind: "exists" }, title: { sel: SEL.panelTitle, kind: "text" } });
    await page.evaluate(() => {
      window.__clicksAfter = 0;
      window.__ctxAfter = 0;
      window.addEventListener("click", () => window.__clicksAfter++, true);
      window.addEventListener("contextmenu", () => window.__ctxAfter++, true);
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(800);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(1500);
    const rec2 = await collect(page);
    const log2 = (await fakeLog(page)).slice(logLen);
    const ev = await page.evaluate(() => ({ clicks: window.__clicksAfter, ctx: window.__ctxAfter }));
    out["longPress.menuOpened"] = rec2.last.menu === true;
    out["longPress.menuMs"] = r0(firstWhen(rec2, "menu", (v) => v === true, rec2.t0));
    out["longPress.alsoPlayed"] = log2.some((e) => e.cmd === "loadPlaylist" || e.cmd === "playVideoAt");
    out["longPress.clickEventsAfterRelease"] = ev.clicks;
    out["longPress.contextmenuEvents"] = ev.ctx;
    return out;
  },
  { mobile: true }
);

def("S11", "Scroll the MUSICA page with Video mode on (dock)", async ({ page }) => {
  await openMusic(page);
  await playAllTrends(page);
  await loc(page, SEL.modeVideo).first().click();
  await sleep(1000);
  const docked = await page.locator(".mp.mp--docked").count();
  const main = await page.locator(".mt-main").boundingBox();
  await page.mouse.move(main.x + main.width / 2, main.y + Math.min(400, main.height / 2));
  const s0 = await snap(page);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, i < 20 ? 120 : -120);
    await sleep(30);
  }
  await sleep(600);
  const d = await since(page, s0);
  const mismatch = await page.evaluate(
    ([a, b]) => {
      const x = document.querySelector(a)?.getBoundingClientRect();
      const y = document.querySelector(b)?.getBoundingClientRect();
      if (!x || !y) return null;
      return Math.round(Math.abs(x.left - y.left) + Math.abs(x.top - y.top) + Math.abs(x.width - y.width) + Math.abs(x.height - y.height));
    },
    [SEL.playerFrame, SEL.dockSlot]
  );
  return {
    docked: docked > 0,
    scrollEvents: d.scrolls,
    commits: d.commits,
    commitsPerScrollEvent: d.scrolls ? +(d.commits / d.scrolls).toFixed(2) : null,
    fibersRendered: d.fibers,
    longTasks: d.longTasks,
    longTaskMaxMs: d.longTaskMaxMs,
    dockMismatchPx: mismatch,
    topRenders: topNames(d.byName),
  };
});

// ---- Runner -------------------------------------------------------------------------------

function median(nums) {
  const s = nums.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 100) / 100;
}
function summarize(runs) {
  const ok = runs.filter((r) => !r.na);
  const out = {};
  if (ok.length < runs.length) out.na = `${runs.length - ok.length}/${runs.length} n/a: ${[...new Set(runs.filter((r) => r.na).map((r) => r.na))].join(" | ")}`;
  const keys = [...new Set(ok.flatMap((r) => Object.keys(r)))].filter((k) => k !== "consoleErrors");
  for (const k of keys) {
    const vals = ok.map((r) => r[k]);
    if (vals.every((v) => v === null || v === undefined)) out[k] = null;
    else if (vals.some((v) => typeof v === "number")) out[k] = median(vals);
    else if (vals.every((v) => typeof v === "boolean" || v == null)) out[k] = `${vals.filter((v) => v === true).length}/${vals.length}`;
    else {
      const u = [...new Set(vals.map((v) => String(v ?? "")))];
      out[k] = u.length === 1 ? u[0] : u.join(" ‖ ");
    }
  }
  const errs = [...new Set(runs.flatMap((r) => r.consoleErrors ?? []))];
  if (errs.length) out.pageErrors = errs.slice(0, 3).join(" ‖ ");
  return out;
}

function cell(v) {
  if (v === null || v === undefined) return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function markdown(result) {
  const lines = [`### Music UI perf — ${result.label} (${result.date}, ${result.git}, reps=${result.reps}, medians)`, "", "| Scenario | Metric | Value |", "|---|---|---|"];
  for (const sc of result.scenarios) {
    const s = result.summary[sc.id];
    let first = true;
    for (const [k, v] of Object.entries(s)) {
      lines.push(`| ${first ? `**${sc.id}** ${sc.title}` : ""} | ${k} | ${cell(v)} |`);
      first = false;
    }
  }
  return lines.join("\n");
}
function compare(a, b) {
  const A = JSON.parse(readFileSync(join(RESULTS, `${a}.json`), "utf8"));
  const B = JSON.parse(readFileSync(join(RESULTS, `${b}.json`), "utf8"));
  const lines = [`### Music UI perf — ${a} → ${b}`, "", `| Scenario | Metric | ${a} | ${b} | Δ |`, "|---|---|---|---|---|"];
  const ids = [...new Set([...Object.keys(A.summary), ...Object.keys(B.summary)])];
  for (const id of ids) {
    const sa = A.summary[id] ?? {};
    const sb = B.summary[id] ?? {};
    let first = true;
    for (const k of [...new Set([...Object.keys(sa), ...Object.keys(sb)])]) {
      const va = sa[k];
      const vb = sb[k];
      const delta = typeof va === "number" && typeof vb === "number" ? (vb - va > 0 ? "+" : "") + Math.round((vb - va) * 100) / 100 : va === vb ? "" : "changed";
      lines.push(`| ${first ? `**${id}**` : ""} | ${k} | ${cell(va)} | ${cell(vb)} | ${delta} |`);
      first = false;
    }
  }
  return lines.join("\n");
}

async function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timeout ${ms} ms in ${what}`)), ms)))]).finally(() => clearTimeout(t));
}

async function main() {
  if (args.compare) {
    console.log(compare(...args.compare));
    return;
  }
  if (args.build || !existsSync(join(OUT, "index.html"))) build();
  const preview = await startPreview();
  const browser = await chromium.launch();
  const result = { label: args.label, web: WEB, date: new Date().toISOString(), git: gitRev(), reps: args.reps, scenarios: [], runs: {}, summary: {} };
  try {
    for (const sc of SCENARIOS) {
      if (args.only && !args.only.includes(sc.id)) continue;
      result.scenarios.push({ id: sc.id, title: sc.title });
      result.runs[sc.id] = [];
      for (let rep = 0; rep < args.reps; rep++) {
        const t = Date.now();
        const ctx = await newContext(browser, !!sc.mobile);
        let r;
        try {
          r = await withTimeout(sc.fn({ ...ctx, browser }), 120000, sc.id);
          if (ctx.consoleErrors.length) r.consoleErrors = ctx.consoleErrors;
          const hookErr = await ctx.page.evaluate(() => window.__commits?.lastErr).catch(() => null);
          if (hookErr) r.hookError = hookErr;
        } catch (e) {
          r = { na: String(e.message || e).split("\n")[0].slice(0, 200) };
        } finally {
          await ctx.context.close().catch(() => {});
        }
        result.runs[sc.id].push(r);
        console.error(`[perf] ${sc.id} rep ${rep + 1}/${args.reps} ${r.na ? "n/a: " + r.na : "ok"} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
      }
      result.summary[sc.id] = summarize(result.runs[sc.id]);
    }
  } finally {
    await browser.close().catch(() => {});
    stopPreview(preview);
  }
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${args.label}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(markdown(result));
  console.error(`[perf] wrote ${file}`);
}

function gitRev() {
  try {
    const rev = execSync("git rev-parse --short HEAD", { cwd: WEB }).toString().trim();
    const dirty = execSync("git status --porcelain -- src netlify", { cwd: WEB }).toString().trim() ? "+dirty" : "";
    return rev + dirty;
  } catch {
    return "?";
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
