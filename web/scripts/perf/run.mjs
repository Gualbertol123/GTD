#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Music UI performance harness (Playwright, Chromium, production build).
//
//   node scripts/perf/run.mjs --label baseline         build, serve, measure
//   node scripts/perf/run.mjs --label after --no-build reuse the last build
//   node scripts/perf/run.mjs --only S2,S4 --reps 1    a subset, once
//   node scripts/perf/run.mjs --compare baseline-v2 after  clean before/after table (--all: every field)
//   node scripts/perf/run.mjs --check                  smoke: S2,S3,S4,S8,S9 once, exit 1 on a hard-check failure
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
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { installMocks, TRENDS, PLAYLISTS, cat } from "./lib/mocks.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB = join(HERE, "..", "..");
let WEB = DEFAULT_WEB; // --web <dir>: build from another checkout (e.g. a frozen baseline)
// The build dir: one per checkout (--web), so a run against another checkout
// (or another agent's run) cannot swap the files being served. --out overrides.
let OUT = null;
const RESULTS = join(HERE, "results");
// 4179, or the next free port up to 4199 (another run may hold 4179).
let PORT = 4179;
let BASE = `http://localhost:${PORT}`;

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
  // The bar's main play/pause button (CSS, for the DOM recorder): the old
  // .mt-play, or any bar button labelled play/pause (PlayButton).
  barPlayBtn:
    'footer.mt-bar .mt-bar__controls .mt-play, footer.mt-bar button[aria-label="Pausa"], footer.mt-bar button[aria-label="Riproduci"], footer.mt-bar button[aria-label="Pause"], footer.mt-bar button[aria-label="Play"]',
  nowTitle: ".mt-now .mt-now__title",
  queueFirst: ".mt-now .mt-queue .mt-qitem b",
  queueItems: ".mt-now .mt-queue .mt-qitem b",
  barPlayPause: { within: "footer.mt-bar", role: "button", name: PLAY },
  barNext: { within: "footer.mt-bar", role: "button", name: /^(Successivo|Next)$/ },
  barShuffle: { within: "footer.mt-bar", role: "button", name: /^(Casuale|Shuffle)$/ },
  barShuffleCss: 'footer.mt-bar button[aria-pressed][aria-label="Casuale"], footer.mt-bar button[aria-pressed][aria-label="Shuffle"]',
  volume: { within: "footer.mt-bar", role: "slider", name: /^Volume$/ },
  modeVideo: { within: "footer.mt-bar", role: "button", name: /Video$/ },
  dockSlot: ".mt-now .mt-now__video",
  playerFrame: ".mp",
  sideSearch: { within: ".mt-side", role: "button", name: /(Cerca|Search)$/ },
  // A textbox before, a combobox in wave 2: matched by its label.
  searchInput: '.mt-main input[aria-label="Cerca"], .mt-main input[aria-label="Search"]',
  suggestions: '.mt-main [role="listbox"] [role="option"]',
  searchSpinner: ".mt-main .mt-search .mt-spin, .mt-main .mt-search .mt-search__spin, .mt-main .mt-search [aria-busy=\"true\"]",
  tableRows: ".mt-main .mt-table .mt-tr:not(.mt-tr--head)",
  tableRowTitle: ".mt-tr__title b",
  // The "⋯" button on a row / card (wave 2) that opens the song menu.
  rowMenuButton: { role: "button", name: /^(Altre azioni|More actions|⋯|…|Altro|Altre opzioni|Opzioni|Menu|More|More options|Options)\b/i },
  // Notices / toasts anywhere (role=status pill, the old in-player notice).
  statusAny: '[role="status"], .mp-toast, .mp-failed',
  // "YouTube can't be reached" (S12) and its Retry.
  retryButton: { role: "button", name: /^(Riprova|Retry|Try again)$/i },
  // --- song menu
  songMenu: '[role="menu"].song-menu, [role="menu"]',
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
const NOTICE_RE = /(riproducibile|cannot play|can't play|skipping|passo al successivo|coda è finita|queue (is|has) (over|ended|finished)|non è partita|didn't start)/i;
// "YouTube can't be reached" (S12).
const API_FAIL_RE = /(raggiungibile|cannot be reached|can't be reached|unreachable|non risponde|not responding)/i;
const PLAY_LABEL_RE = /^(Riproduci|Play)$/;
const PAUSE_LABEL_RE = /^(Pausa|Pause)$/;
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
const args = { label: null, build: true, reps: null, only: null, compare: null, all: false, check: false, headed: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--label") args.label = argv[++i];
  else if (a === "--no-build") args.build = false;
  else if (a === "--web") WEB = resolve(argv[++i]);
  else if (a === "--reps") args.reps = Number(argv[++i]) || 1;
  else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim().toUpperCase());
  else if (a === "--compare") args.compare = [argv[++i], argv[++i]];
  else if (a === "--all") args.all = true;
  else if (a === "--out") OUT = resolve(argv[++i]);
  else if (a === "--check") args.check = true;
  else if (a === "--help" || a === "-h") {
    console.log("usage: node scripts/perf/run.mjs [--label NAME] [--web DIR] [--no-build] [--reps N] [--only S1,S2] [--check] | --compare A B [--all]");
    process.exit(0);
  }
}
// --check: the fast smoke mode (npm run perf:music:check). Exits 1 when a hard check fails.
export const CHECK_ONLY = ["S2", "S3", "S4", "S8", "S9"];
if (args.check) {
  args.reps ??= 1;
  args.only ??= CHECK_ONLY;
  args.label ??= "check";
}
OUT ??= join(HERE, ".build", WEB === DEFAULT_WEB ? "dist" : `dist-${createHash("sha1").update(WEB).digest("hex").slice(0, 8)}`);
args.reps ??= 3;
args.label ??= "run";

// ---- Build + preview ---------------------------------------------------------------------

function build() {
  console.error("[perf] building", WEB, "(minify off, names kept) →", OUT);
  execSync(`npx vite build --minify false --outDir "${OUT}" --emptyOutDir`, {
    cwd: WEB,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, VITE_SUPABASE_URL: "http://supabase.mock", VITE_SUPABASE_ANON_KEY: "anon", VITE_TEAM_EMAIL: "team@example.com" },
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
  for (let p = 4179; p <= 4199; p++)
    if (await portFree(p)) {
      PORT = p;
      break;
    }
  BASE = `http://localhost:${PORT}`;
  if (PORT !== 4179) console.error(`[perf] port 4179 busy, using ${PORT}`);
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
/**
 * Play one song of a track table. The old table plays on the hover button or
 * a double-click; wave 2 plays on a single click. A single click is tried
 * first only when there is no play button; if the fake player gets no
 * command within 400 ms, it falls back to a double-click.
 */
async function playTableRow(page, title) {
  const row = page.locator(SEL.tableRows).filter({ hasText: title }).first();
  await row.hover();
  const btn = row.getByRole("button", { name: SEL.songPlayButton(title).name }).first();
  if (await btn.isVisible().catch(() => false)) return btn.click();
  const n = (await fakeLog(page)).length;
  const cell = row.locator(SEL.tableRowTitle).first();
  await cell.click();
  await sleep(400);
  const cmds = (await fakeLog(page)).slice(n).filter((e) => e.cmd);
  const pending = await page.evaluate(() => !!document.querySelector('[aria-busy="true"]'));
  if (!cmds.length && !pending) await cell.dblclick();
}
/** Click a song's play button (by its "Riproduci <title>" name); else click its row / card. */
async function clickSong(page, title, within = ".mt-main") {
  const btn = loc(page, SEL.songPlayButton(title, within)).first();
  if (await btn.count()) return btn.click();
  return page.locator(`${within} .mt-trow, ${within} .mt-tr, ${within} .mt-card`).filter({ hasText: title }).first().click();
}
/** Open the song menu of a row: right-click (old + new), else its "⋯" button (wave 2). */
async function openRowMenu(page, row) {
  await row.click({ button: "right" });
  try {
    await page.locator(SEL.songMenu).first().waitFor({ timeout: 1500 });
    return "contextmenu";
  } catch {}
  await page.keyboard.press("Escape").catch(() => {});
  await row.hover();
  await row.getByRole(SEL.rowMenuButton.role, { name: SEL.rowMenuButton.name }).first().click();
  await page.locator(SEL.songMenu).first().waitFor({ timeout: 3000 });
  return "button";
}
/** The bar's main button: label, busy look (spinner / aria-busy) and icon. */
const btnWatch = () => ({
  label: { sel: SEL.barPlayBtn, kind: "attr", attr: "aria-label" },
  busy: { sel: SEL.barPlayBtn, kind: "busy" },
  icon: { sel: SEL.barPlayBtn, kind: "icon" },
});
/** Visible feedback on the main button: first change of its label, busy look or icon. */
const buttonFeedback = (rec, t0) => firstChange(rec, t0, ["label", "busy", "icon"]);
/** The spinner: ms until it shows after t0 (null = never), and ms shown during [t0, end]. */
function spinnerStats(rec, t0, end = rec.now) {
  const tl = timeline(rec, "busy");
  let ms = 0;
  for (let i = 0; i < tl.length; i++) {
    const a = Math.max(tl[i].t, t0);
    const b = Math.min(i + 1 < tl.length ? tl[i + 1].t : end, end);
    if (b > a && tl[i].v === true) ms += b - a;
  }
  return { appearMs: r0(firstWhen(rec, "busy", (v) => v === true, t0)), shownMs: Math.round(ms) };
}
/** ms the fake player was PLAYING during [from, to]. */
function playingTime(log, from, to) {
  let ms = 0;
  let on = null;
  for (const e of log) {
    if (e.state === undefined) continue;
    if (e.t > to) break;
    const t = Math.max(e.t, from);
    if (e.state === 1) {
      if (on === null) on = t;
    } else if (on !== null) {
      ms += Math.max(0, t - on);
      on = null;
    }
  }
  if (on !== null) ms += to - on;
  return Math.round(ms);
}
const STATE_NAME = { 1: "PLAYING", 2: "PAUSED", 3: "BUFFERING", 0: "ENDED", 5: "CUED", [-1]: "UNSTARTED" };
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
  busy: { sel: SEL.barPlayBtn, kind: "busy" },
  toast: { sel: SEL.statusAny, kind: "anytext" },
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
  await clickSong(page, tr.title);
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
    // The bar button's spinner / aria-busy while the song loads (null = never shown).
    spinnerMs: spinnerStats(rec, t0).appearMs,
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

// Each part starts from a known player state (set up, not measured), so a
// wrong result in one part cannot shift the next. Feedback = the first change
// of the bar button's aria-label, busy look (aria-busy / spinner) or icon.
def("S3", "Toggle pause/play while BUFFERING and while PLAYING", async ({ page }) => {
  await openMusic(page);
  const tr = TRENDS[1];
  const btn = () => loc(page, SEL.barPlayPause).first();
  const label = () => page.locator(SEL.barPlayBtn).first().getAttribute("aria-label").catch(() => null);
  const out = {};
  // 1) While buffering (the song was clicked and is not audible yet): the user presses the main button.
  await clickSong(page, tr.title);
  await waitFake(page, `return cur && cur.state === 3 && cur.id === ${JSON.stringify(tr.id)};`, 6000);
  await arm(page, { ...btnWatch(), toast: { sel: SEL.statusAny, kind: "anytext" } });
  out["buffering.labelShown"] = await label();
  await btn().click();
  await sleep(2600); // past the longest buffering (2 s)
  let rec = await collect(page);
  let log = await fakeLog(page);
  const cmdsBuf = fakeAfter(log, rec.t0).filter((e) => e.cmd).map((e) => e.cmd);
  const afterBuf = await fakeNow(page);
  let sp = spinnerStats(rec, rec.t0);
  Object.assign(out, {
    "buffering.feedbackMs": r0(buttonFeedback(rec, rec.t0)),
    "buffering.labelAfter": rec.last.label ?? "",
    "buffering.spinnerShownMs": sp.shownMs,
    "buffering.commandSent": cmdsBuf.join(",") || "none",
    "buffering.stateAfter": STATE_NAME[afterBuf?.state] ?? String(afterBuf?.state),
    // The user pressed while it was not yet audible: did it end up paused (the intent) or playing?
    "buffering.pressHonoured": afterBuf?.state === 2,
    // Audio heard anyway after the press (a blip before the pause still counts).
    "buffering.playedAnywayMs": playingTime(log, rec.t0, rec.now),
  });

  // 2) While PLAYING: pause. Set-up: get the song playing whatever part 1 left.
  let ok = true;
  try {
    const c = await fakeNow(page);
    if (c?.state !== 1) {
      if (PLAY_LABEL_RE.test((await label()) ?? "")) await btn().click();
      await waitPlayingId(page, tr.id, 6000);
    }
    await sleep(1000);
  } catch {
    ok = false;
  }
  out["pause.startState"] = ok ? "PLAYING" : "not PLAYING";
  if (ok) {
    await arm(page, btnWatch());
    await btn().click();
    await page.waitForFunction((sel) => /^(Riproduci|Play)$/.test(document.querySelector(sel)?.getAttribute("aria-label") ?? ""), SEL.barPlayBtn, { timeout: 4000 }).catch(() => {});
    await sleep(300);
    rec = await collect(page);
    log = await fakeLog(page);
    out["pause.feedbackMs"] = r0(buttonFeedback(rec, rec.t0));
    out["pause.commandMs"] = r0(firstCmd(log, rec.t0, ["pauseVideo"]));
    out["pause.pausedMs"] = r0(firstState(log, rec.t0, 2)?.t - rec.t0);
    out["pause.labelAfter"] = rec.last.label ?? "";
  }

  // 3) While PAUSED: play. Set-up: the player paused and the button offering Play.
  ok = true;
  try {
    const c = await fakeNow(page);
    if (c?.state !== 2) {
      if (PAUSE_LABEL_RE.test((await label()) ?? "")) await btn().click();
      await waitFake(page, "return cur && cur.state === 2;", 4000);
    }
    await page.waitForFunction((sel) => /^(Riproduci|Play)$/.test(document.querySelector(sel)?.getAttribute("aria-label") ?? ""), SEL.barPlayBtn, { timeout: 3000 });
    await sleep(500);
  } catch {
    ok = false;
  }
  out["resume.startState"] = ok ? "PAUSED" : "not PAUSED";
  if (ok) {
    await arm(page, btnWatch());
    await btn().click();
    await waitFake(page, "return cur && cur.state === 1;", 5000).catch(() => {});
    await page.waitForFunction((sel) => /^(Pausa|Pause)$/.test(document.querySelector(sel)?.getAttribute("aria-label") ?? ""), SEL.barPlayBtn, { timeout: 3000 }).catch(() => {});
    await sleep(300);
    rec = await collect(page);
    log = await fakeLog(page);
    const playing = firstState(log, rec.t0, 1);
    sp = spinnerStats(rec, rec.t0, playing ? playing.t : rec.now);
    out["resume.feedbackMs"] = r0(buttonFeedback(rec, rec.t0));
    out["resume.commandMs"] = r0(firstCmd(log, rec.t0, ["playVideo"]));
    out["resume.playingMs"] = r0(playing?.t - rec.t0);
    out["resume.spinnerMs"] = sp.appearMs;
    out["resume.spinnerShownMs"] = sp.shownMs;
    out["resume.labelAfter"] = rec.last.label ?? "";
  }
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
    // How long the title of the song playing before the first Next stays on screen after it.
    staleTitleMs: r0(firstWhen(rec, "bar", (v) => v !== rec.initial.bar, t0) ?? rec.now - t0),
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

// Correctness is judged by what PLAYS (the fake's PLAYING ids after each
// Next) against the queue the app SHOWS. YouTube's internal list is not the
// judge: the app may sync it only at the next song boundary.
// Legacy fields (kept so baseline.json still compares; not in the clean
// table): shuffle.fakeShuffled, shuffle.queueNextMatchesPlayer,
// shuffle.playerNext, enqueue.playerNextIsEnqueued,
// enqueue.queueNextMatchesPlayer, enqueue.playerShuffle.
const TITLE_TO_ID = new Map([...PLAYLISTS.flatMap((p) => p.tracks), ...TRENDS].map((t) => [t.title, t.id]));
async function queueShown(page) {
  return (await page.locator(SEL.queueItems).allTextContents().catch(() => [])).map((s) => s.trim());
}
/** Press Next and return the id of the next song that reaches PLAYING (an unplayable one is skipped by the app). */
async function nextAndWaitPlaying(page, prevId, timeout = 10000) {
  const from = await page.evaluate(() => performance.now());
  await loc(page, SEL.barNext).first().click();
  try {
    await page.waitForFunction(
      ([from, prev]) => window.__fake.log.some((e) => e.t >= from && e.state === 1 && e.id !== prev),
      [from, prevId],
      { timeout, polling: 50 }
    );
  } catch {
    return null;
  }
  return (await fakeLog(page)).find((e) => e.t >= from && e.state === 1 && e.id !== prevId)?.id ?? null;
}
/** The shown queue minus the songs that cannot play (they never reach PLAYING). */
function playableTitles(titles) {
  return titles.filter((t) => {
    const id = TITLE_TO_ID.get(t);
    return !id || !cat.isBad(id);
  });
}
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
  // What actually plays on Next after shuffle: the song the queue shows next?
  const shownAfterShuffle = playableTitles(await queueShown(page));
  const idS = await nextAndWaitPlaying(page, c1?.id);
  const playedS = idS ? cat.titleFor(idS) : null;
  out["shuffle.nextPlayed"] = playedS ?? "(nothing)";
  out["shuffle.nextPlaysShownNext"] = !!playedS && playedS === shownAfterShuffle[0];
  await sleep(1000);

  // Song #10 of the table → "Riproduci dopo" (right-click menu, or the "⋯" button).
  const target = pl.tracks[10];
  const how = await openRowMenu(page, page.locator(SEL.tableRows).nth(10));
  await arm(page, { ...titleWatch(), q: { sel: SEL.queueFirst, kind: "text" } });
  const logLen = (await fakeLog(page)).length;
  await loc(page, SEL.menuPlayNext).first().click();
  await sleep(4000);
  const rec = await collect(page);
  const log = (await fakeLog(page)).slice(logLen);
  const c2 = await fakeNow(page);
  const fakeNext2 = c2?.order && c2.order[c2.index + 1] ? cat.titleFor(c2.order[c2.index + 1]) : null;
  const shuffleOn = (await page.locator(SEL.barShuffleCss).first().getAttribute("aria-pressed").catch(() => null)) === "true";
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
  if (downAt !== null) gap += rec.now - downAt;
  Object.assign(out, {
    "enqueue.menuOpenedBy": how,
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
  // Next ×3, each after the previous song plays: is the order played the order shown?
  await waitFake(page, "return cur && cur.state === 1;", 6000).catch(() => {});
  const shown = playableTitles(await queueShown(page));
  const played = [];
  let prev = (await fakeNow(page))?.id;
  for (let i = 0; i < 3; i++) {
    const id = await nextAndWaitPlaying(page, prev);
    if (!id) break;
    played.push(cat.titleFor(id));
    prev = id;
    await sleep(600);
  }
  const k = Math.min(3, shown.length);
  const afterEnqueueOk = k > 0 && played.length >= k && played.slice(0, k).every((t, i) => t === shown[i]);
  out["next.playsEnqueued"] = played[0] === target.title;
  out["play.queueShown"] = shown.slice(0, 3).join(" / ");
  out["play.order"] = played.join(" / ") || "(nothing)";
  out["play.afterEnqueueMatchesQueue"] = afterEnqueueOk;
  // The new verdict (used by the compare table and --check): queue shown == order played, after shuffle AND after the enqueue.
  out["play.queueMatchesPlayed"] = out["shuffle.nextPlaysShownNext"] && afterEnqueueOk;
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
  const SKIP = ["nextVideo", "playVideoAt", "loadPlaylist", "loadVideoById", "cuePlaylist", "cueVideoById"];
  const skip = firstErr ? log.find((e) => e.t > firstErr.t && SKIP.includes(e.cmd)) : null;
  const playing = log.find((e) => e.state === 1);
  const cur = await fakeNow(page);
  const label = rec.last.play ?? "";
  // The notice anywhere: the toast pill (role=status), the old in-player notice, or the title.
  const inTitle = firstWhen(rec, "bar", (v) => NOTICE_RE.test(v ?? ""), t0);
  const inToast = firstWhen(rec, "toast", (v) => NOTICE_RE.test(v ?? ""), t0);
  const notice = [inTitle, inToast].filter((x) => x != null);
  const isPlaying = cur?.state === 1;
  return {
    errorAtMs: firstErr ? r0(firstErr.t - t0) : null,
    noticeShownMs: notice.length ? r0(Math.min(...notice)) : null,
    noticeWhere: inToast != null && inTitle != null ? "toast+title" : inToast != null ? "toast" : inTitle != null ? "title" : "none",
    skipCommandAfterErrorMs: skip && firstErr ? r0(skip.t - firstErr.t) : null,
    recoveredPlayingMs: playing ? r0(playing.t - t0) : null,
    errors: errs.length,
    nextCommands: log.filter((e) => e.cmd === "nextVideo").length,
    loop: errs.length > 3,
    endState: STATE_NAME[cur?.state] ?? String(cur?.state),
    barAtEnd: rec.last.bar ?? "",
    // The bar agrees with the player: when a song plays, its title and a Pause
    // button; when nothing plays, a button that offers Play (whatever title is shown).
    barMatchesPlayer: isPlaying ? (rec.last.bar ?? "") === cur.title && PAUSE_LABEL_RE.test(label) : PLAY_LABEL_RE.test(label),
    playLabelAtEnd: label,
    spinnerAtEnd: rec.last.busy === true,
  };
}

def("S9", "A song that fails (onError 150): skip, time, loops", async ({ page }) => {
  await openMusic(page);
  const out = {};
  // a) trend #6 fails, #7 plays
  const a = await errorCase(page, () => clickSong(page, TRENDS[5].title), 6000);
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
  for (const k of ["errorAtMs", "noticeShownMs", "noticeWhere", "errors", "nextCommands", "endState", "barAtEnd", "barMatchesPlayer", "playLabelAtEnd", "spinnerAtEnd"]) out[`lastInList.${k}`] = c[k];
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
    const row = page.locator(SEL.panelResults).nth(2);
    // Wave 2: the row is div.mp-result > button.mp-result__main + button.mp-result__more; press the main part.
    const main = row.locator(".mp-result__main");
    const target = (await main.count()) ? main.first() : row;
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
    out["longPress.alsoPlayed"] = log2.some((e) => ["loadPlaylist", "playVideoAt", "loadVideoById"].includes(e.cmd));
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

/** Is a "YouTube can't be reached" message, and a Retry button, shown to the user right now? */
async function apiFailShown(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const shown = window.__shown;
    let error = false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (re.test(n.textContent || "") && shown(n.parentElement)) {
      error = true;
      break;
    }
    const retry = [...document.querySelectorAll("button")].some((b) => /^(Riprova|Retry|Try again)$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()) && shown(b));
    return { error, retry };
  }, API_FAIL_RE.source);
}

def("S12", "YouTube API unreachable (iframe_api aborted): error + Retry within 13 s, Retry works", async ({ page }) => {
  // page.route wins over the context's iframe_api mock until it is removed.
  const API = "https://www.youtube.com/iframe_api*";
  await page.route(API, (r) => r.abort("internetdisconnected"));
  await openBoard(page);
  await sleep(1000);
  const tTab = Date.now();
  await loc(page, SEL.tabMusic).first().click();
  await page.locator(SEL.musicRoot).waitFor({ timeout: 10000 });
  await waitTrends(page);
  // The user tries to play a song.
  await clickSong(page, TRENDS[0].title);
  const tPlay = Date.now();
  let errorAt = null;
  let retryAt = null;
  while (Date.now() - tTab < 13000 && (errorAt === null || retryAt === null)) {
    const s = await apiFailShown(page);
    if (s.error && errorAt === null) errorAt = Date.now();
    if (s.retry && retryAt === null) retryAt = Date.now();
    await sleep(100);
  }
  const busyAt13 = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    return !!b && (b.getAttribute("aria-busy") === "true" || !!b.querySelector('[class*="spin"], [class*="busy"]'));
  }, SEL.barPlayBtn);
  const labelAt13 = await page.locator(SEL.barPlayBtn).first().getAttribute("aria-label").catch(() => null);
  const out = {
    errorShownMs: errorAt === null ? null : errorAt - tTab,
    retryShownMs: retryAt === null ? null : retryAt - tTab,
    errorAfterPlayClickMs: errorAt === null ? null : Math.max(0, errorAt - tPlay),
    errorAndRetryWithin13s: errorAt !== null && retryAt !== null,
    // Still "loading" with nothing ever going to play.
    spinnerStuck: busyAt13,
    playLabel: labelAt13 ?? "",
  };
  // YouTube is back: Retry.
  await page.unroute(API);
  const retry = loc(page, SEL.retryButton);
  let retryWorks = false;
  let retryPlayingMs = null;
  if (await retry.first().isVisible().catch(() => false)) {
    const t = Date.now();
    await retry.first().click();
    // Retry restarts the song if the app kept it; else the user presses play again.
    let playing = await waitFake(page, "return cur && cur.state === 1;", 8000).then(() => true, () => false);
    if (!playing && (await page.evaluate(() => !!(window.YT && window.YT.Player)))) {
      await clickSong(page, TRENDS[0].title).catch(() => {});
      playing = await waitFake(page, "return cur && cur.state === 1;", 8000).then(() => true, () => false);
    }
    retryWorks = playing;
    if (playing) retryPlayingMs = Date.now() - t;
  }
  out.retryWorks = retryWorks;
  out.retryPlayingMs = retryPlayingMs;
  // Without a Retry button: does pressing play again recover?
  if (!out.errorAndRetryWithin13s) {
    await clickSong(page, TRENDS[1].title).catch(() => {});
    out.playAgainWorks = await waitFake(page, "return cur && cur.state === 1;", 8000).then(() => true, () => false);
  }
  return out;
});

def("S13", "Re-renders per second while playing, on the Search results page (50 results)", async ({ page, reqs }) => {
  await openMusic(page);
  await playAllTrends(page);
  await loc(page, SEL.sideSearch).first().click();
  const input = loc(page, SEL.searchInput).first();
  await input.waitFor({ timeout: 5000 });
  await input.fill("tiziano 50");
  await input.press("Enter");
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, SEL.tableRows, { timeout: 8000 });
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(1500);
  const rows = await page.locator(SEL.tableRows).count();
  const cur = await fakeNow(page);
  const st = await steady(page, reqs, "search");
  return {
    resultsShown: rows,
    playing: cur?.state === 1,
    commitsPerSec: st["search.commitsPerSec"],
    fibersPerSec: st["search.fibersPerSec"],
    longTasks: st["search.longTasks"],
    requests: st["search.requests"],
    topRenders: st["search.topRenders"],
  };
});

def("S14", "Song stuck mid-play (dead stream connection): rescue ladder resumes the same song at the same second", async ({ page }) => {
  await openMusic(page);
  await playAllTrends(page);
  await sleep(3000);
  const before = await page.evaluate(() => ({ cur: window.__fake.current(), players: window.__fake.players.length }));
  const id0 = before.cur.id;
  await page.evaluate(() => window.__fake.stallCurrent());
  const start = Date.now();
  // The point the song froze at, as the stuck player reports it.
  await sleep(1000);
  const frozenAt = await page.evaluate(() => window.__fake.current()?.time ?? null);
  let uiShowedPaused = false;
  let needsTapShown = false;
  let recoveredMs = null;
  let after = null;
  while (Date.now() - start < 45000) {
    await sleep(250);
    const o = await page.evaluate(() => {
      const st = window.__music?.state?.() ?? {};
      return { cur: window.__fake.current(), players: window.__fake.players.length, playing: st.playing, needsTap: st.needsTap };
    });
    if (o.playing === false) uiShowedPaused = true;
    if (o.needsTap) needsTapShown = true;
    if (o.cur && o.cur.state === 1) {
      // PLAYING again and the second moves.
      await sleep(600);
      const o2 = await page.evaluate(() => window.__fake.current());
      if (o2 && o2.state === 1 && o2.time > o.cur.time) {
        recoveredMs = Date.now() - start;
        after = { ...o2, players: o.players };
        break;
      }
    }
  }
  const steps = await page.evaluate(() => (window.__music?.log ?? []).filter((e) => e.ev.startsWith("rescue step")).map((e) => e.ev.slice(0, 22)));
  // Where the player was asked to go on: the start second of the app's last load (its [music] log).
  const resumedFrom = await page.evaluate(() => {
    const l = (window.__music?.log ?? []).filter((e) => e.ev.startsWith("load song"));
    const d = l.length ? l[l.length - 1].data : null;
    return d && typeof d.start === "number" ? d.start : null;
  });
  return {
    recovered: recoveredMs !== null,
    recoveredMs,
    sameSong: after ? after.id === id0 : false,
    resumeOffsetSec: resumedFrom !== null && frozenAt !== null ? Math.round((resumedFrom - frozenAt) * 10) / 10 : null,
    newPlayer: after ? after.players > before.players : false,
    rescueSteps: steps.length,
    uiShowedPaused,
    needsTapShown,
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

// ---- Click → visible feedback (every control measured) ---------------------------------
// [scenario, key, control]. Pass = visible feedback within FEEDBACK_MS in
// every rep; no feedback at all is a fail.
const FEEDBACK_MS = 100;
const FEEDBACK = [
  ["S1", "shellMs", "Open MUSICA"],
  ["S2", "cold.feedbackMs", "Play a song (cold)"],
  ["S2", "warm.feedbackMs", "Play a song (another playing)"],
  ["S3", "buffering.feedbackMs", "Pause while buffering"],
  ["S3", "pause.feedbackMs", "Pause while playing"],
  ["S3", "resume.feedbackMs", "Play while paused"],
  ["S4", "feedbackFirstClickMs", "Next"],
  ["S7", "submitSpinnerMs", "Search submit"],
  ["S8", "enqueue.feedbackMs", "Riproduci dopo"],
  ["S10", "tap.feedbackMs", "Phone: tap Tendenze"],
];
function runVals(result, id, key) {
  return (result.runs?.[id] ?? []).filter((r) => !r.na).map((r) => r[key]);
}
/** "k/n" reps within the limit, or null when the scenario did not run. */
function feedbackPass(result, id, key, limit = FEEDBACK_MS) {
  const v = runVals(result, id, key);
  if (!v.length) return null;
  return `${v.filter((x) => typeof x === "number" && x <= limit).length}/${v.length}`;
}
function feedbackTable(result) {
  const lines = ["", `#### Click → visible feedback ≤ ${FEEDBACK_MS} ms`, "", "| Scenario | Control | Median ms | Pass |", "|---|---|---|---|"];
  for (const [id, key, name] of FEEDBACK) {
    const p = feedbackPass(result, id, key);
    if (p === null) continue;
    lines.push(`| ${id} | ${name} (${key}) | ${cell(result.summary[id]?.[key] ?? "never")} | ${allOf(p) ? "pass" : "FAIL"} ${p} |`);
  }
  return lines.join("\n");
}
const allOf = (frac) => typeof frac === "string" && /^(\d+)\/(\d+)$/.test(frac) && frac.split("/")[0] === frac.split("/")[1] && frac.split("/")[1] !== "0";

// ---- Hard checks (npm run perf:music:check) ----------------------------------------------
const CHECK_FEEDBACK_MS = 150;
function hardChecks(result) {
  const ran = (id) => (result.runs?.[id] ?? []).length > 0;
  const out = [];
  const add = (id, name, ok, detail) => out.push({ id, name, ok, detail });
  for (const sc of result.scenarios) {
    const na = (result.runs[sc.id] ?? []).filter((r) => r.na);
    if (na.length) add(sc.id, "scenario ran", false, na[0].na);
  }
  // ok: true / false, or null when the field was not measured (an older result).
  const every = (id, key, pred) => {
    const v = runVals(result, id, key);
    if (!v.length || v.every((x) => x === undefined)) return { ok: null, detail: "not measured" };
    return { ok: v.every(pred), detail: v.map((x) => cell(x)).join(", ") };
  };
  for (const [id, key, name] of FEEDBACK) {
    if (!["S2", "S3", "S4", "S8"].includes(id) || !ran(id)) continue;
    const r = every(id, key, (x) => typeof x === "number" && x <= CHECK_FEEDBACK_MS);
    add(id, `${name}: feedback ≤ ${CHECK_FEEDBACK_MS} ms`, r.ok, r.detail);
  }
  if (ran("S2"))
    for (const k of ["cold.wrongSongShownMs", "warm.wrongSongShownMs"]) {
      const r = every("S2", k, (x) => x === 0);
      add("S2", `wrong song shown = 0 ms (${k.split(".")[0]})`, r.ok, r.detail);
    }
  if (ran("S3")) {
    const r = every("S3", "buffering.pressHonoured", (x) => x === true);
    add("S3", "pause pressed while buffering is honoured", r.ok, r.detail);
  }
  if (ran("S14")) {
    for (const [k, name, pred] of [
      ["recovered", "song stuck mid-play: plays on by itself", (x) => x === true],
      ["sameSong", "song stuck mid-play: the same song", (x) => x === true],
      ["resumeOffsetSec", "song stuck mid-play: resumes within 3 s of where it stopped", (x) => typeof x === "number" && Math.abs(x) <= 3],
      ["uiShowedPaused", "song stuck mid-play: never shown as paused", (x) => x === false],
    ]) {
      const r = every("S14", k, pred);
      add("S14", name, r.ok, r.detail);
    }
  }
  if (ran("S8")) {
    const r = every("S8", "play.queueMatchesPlayed", (x) => x === true);
    add("S8", "queue shown = order played", r.ok, r.detail);
  }
  if (ran("S9")) {
    for (const c of ["one", "twoInARow"]) {
      const r = every("S9", `${c}.loop`, (x) => x === false);
      add("S9", `no skip loop (${c})`, r.ok, r.detail);
    }
    const l = every("S9", "lastInList.errors", (x) => typeof x === "number" && x <= 3);
    add("S9", "no skip loop (lastInList)", l.ok, l.detail);
    const m = every("S9", "lastInList.barMatchesPlayer", (x) => x === true);
    add("S9", "last song failed: nothing plays and the button offers Play", m.ok, m.detail);
    const sp = every("S9", "lastInList.spinnerAtEnd", (x) => x !== true);
    add("S9", "last song failed: no endless spinner", sp.ok, sp.detail);
  }
  return out;
}
const okText = (ok) => (ok === null ? "not measured" : ok ? "pass" : "FAIL");
function checksTable(checks) {
  const lines = ["", "#### Hard checks", "", "| Scenario | Check | Result | Values |", "|---|---|---|---|"];
  for (const c of checks) lines.push(`| ${c.id} | ${cell(c.name)} | ${okText(c.ok)} | ${cell(c.detail)} |`);
  return lines.join("\n");
}

function markdown(result) {
  const lines = [`### Music UI perf — ${result.label} (${result.date}, ${result.git}, reps=${result.reps}, medians)`, "", "| Scenario | Metric | Value |", "|---|---|---|"];
  for (const sc of result.scenarios) {
    const s = result.summary[sc.id];
    let first = true;
    for (const [k, v] of Object.entries(s)) {
      lines.push(`| ${first ? `**${sc.id}** ${sc.title}` : ""} | ${k}${LEGACY.has(`${sc.id} ${k}`) ? " †" : ""} | ${cell(v)} |`);
      first = false;
    }
  }
  lines.push("", "† legacy field, kept to compare with older results; not used by the compare table or --check.");
  lines.push(feedbackTable(result));
  lines.push(checksTable(hardChecks(result)));
  return lines.join("\n");
}

// ---- Before / after ---------------------------------------------------------------------
// Fields kept only so old results still load; the compare table uses the newer ones.
const LEGACY = new Set([
  "S8 shuffle.fakeShuffled",
  "S8 shuffle.queueNextMatchesPlayer",
  "S8 shuffle.playerNext",
  "S8 enqueue.playerNextIsEnqueued",
  "S8 enqueue.queueNextMatchesPlayer",
  "S8 enqueue.playerShuffle",
  "S4 staleTitleShownMs",
]);
// The clean table: [scenario, key, what, better]. better: "lower" | "higher"
// for numbers; "yes" / "no" for k/n booleans (which answer is the good one).
const HEADLINE = [
  ["S0", "commits", "Idle board: commits in 5 s", "lower"],
  ["S1", "shellMs", "Open MUSICA: page shown (ms)", "lower"],
  ["S1", "trendsMs", "Open MUSICA: trends shown (ms)", "lower"],
  ["S1", "playerReadyMs", "Open MUSICA: player ready (ms)", "lower"],
  ["S1", "requests", "Open MUSICA: requests", "lower"],
  ["S1", "fibersRendered", "Open MUSICA: components rendered", "lower"],
  ["S2", "cold.feedbackMs", "Play (cold): feedback (ms)", "lower"],
  ["S2", "cold.playingMs", "Play (cold): audio starts (ms)", "lower"],
  ["S2", "cold.wrongSongShownMs", "Play (cold): wrong song shown (ms)", "lower"],
  ["S2", "warm.feedbackMs", "Play (another playing): feedback (ms)", "lower"],
  ["S2", "warm.playingMs", "Play (another playing): audio starts (ms)", "lower"],
  ["S2", "warm.wrongSongShownMs", "Play (another playing): wrong song shown (ms)", "lower"],
  ["S3", "buffering.feedbackMs", "Pause while buffering: feedback (ms)", "lower"],
  ["S3", "buffering.pressHonoured", "Pause while buffering: honoured", "yes"],
  ["S3", "pause.feedbackMs", "Pause while playing: feedback (ms)", "lower"],
  ["S3", "resume.feedbackMs", "Play while paused: feedback (ms)", "lower"],
  ["S3", "resume.playingMs", "Play while paused: audio (ms)", "lower"],
  ["S4", "feedbackFirstClickMs", "Next ×3: feedback (ms)", "lower"],
  ["S4", "staleTitleMs", "Next ×3: old title stays (ms)", "lower"],
  ["S4", "settledPlayingMs", "Next ×3: audio of the last (ms)", "lower"],
  ["S4", "finalShownMatchesPlayer", "Next ×3: title = song playing", "yes"],
  ["S5", "tab.fibersPerSec", "Playing, MUSICA tab: renders/s", "lower"],
  ["S5", "panel.fibersPerSec", "Playing, ♪ panel: renders/s", "lower"],
  ["S5", "board.fibersPerSec", "Playing, board: renders/s", "lower"],
  ["S6", "fibersRendered", "Volume drag: components rendered", "lower"],
  ["S6", "setVolumeCommands", "Volume drag: player commands", "lower"],
  ["S6", "inpMaxMs", "Volume drag: worst input (ms)", "lower"],
  ["S7", "suggestRequests", "Search typing: suggest requests", "lower"],
  ["S7", "typingFibers", "Search typing: components rendered", "lower"],
  ["S7", "staleSuggestions", "Search typing: stale suggestions", "lower"],
  ["S7", "submitResultsMs", "Search submit: results (ms)", "lower"],
  ["S8", "enqueue.feedbackMs", "Riproduci dopo: feedback (ms)", "lower"],
  ["S8", "enqueue.playbackGapMs", "Riproduci dopo: music interrupted (ms)", "lower"],
  ["S8", "next.playsEnqueued", "Riproduci dopo: Next plays it", "yes"],
  ["S8", "play.queueMatchesPlayed", "Shuffle + enqueue: queue shown = order played", "yes"],
  ["S9", "one.noticeShownMs", "Failing song: notice (ms)", "lower"],
  ["S9", "one.recoveredPlayingMs", "Failing song: next one plays (ms)", "lower"],
  ["S9", "twoInARow.recoveredPlayingMs", "Two failing: a song plays (ms)", "lower"],
  ["S9", "twoInARow.loop", "Two failing: skip loop", "no"],
  ["S9", "lastInList.barMatchesPlayer", "Last song fails: bar = player", "yes"],
  ["S10", "tap.feedbackMs", "Phone tap: feedback (ms)", "lower"],
  ["S10", "tap.playingMs", "Phone tap: audio (ms)", "lower"],
  ["S10", "longPress.menuOpened", "Phone long-press: menu", "yes"],
  ["S10", "longPress.alsoPlayed", "Phone long-press: also played", "no"],
  ["S11", "commitsPerScrollEvent", "Scroll (video docked): commits/event", "lower"],
  ["S11", "fibersRendered", "Scroll: components rendered", "lower"],
  ["S11", "dockMismatchPx", "Scroll: video off its slot (px)", "lower"],
  ["S12", "errorAndRetryWithin13s", "YouTube unreachable: error + Retry ≤ 13 s", "yes"],
  ["S12", "errorShownMs", "YouTube unreachable: error shown (ms)", "lower"],
  ["S12", "retryWorks", "YouTube back: Retry plays", "yes"],
  ["S13", "fibersPerSec", "Playing on 50 search results: renders/s", "lower"],
  ["S13", "commitsPerSec", "Playing on 50 search results: commits/s", "lower"],
  ["S14", "recovered", "Song stuck mid-play: plays on by itself", "yes"],
  ["S14", "recoveredMs", "Song stuck mid-play: music back after (ms)", "lower"],
  ["S14", "sameSong", "Song stuck mid-play: same song", "yes"],
  ["S14", "uiShowedPaused", "Song stuck mid-play: UI showed paused", "no"],
];
function frac(v) {
  const m = typeof v === "string" && v.match(/^(\d+)\/(\d+)$/);
  return m && +m[2] ? +m[1] / +m[2] : null;
}
function verdict(a, b, better, key) {
  const isFb = FEEDBACK.some(([, k]) => k === key);
  if (better === "yes" || better === "no") {
    const fa = frac(a);
    const fb = frac(b);
    if (fa === null || fb === null) return fb === null ? "—" : "new";
    if (fa === fb) return "same";
    return (fb > fa) === (better === "yes") ? "better" : "worse";
  }
  // A missing feedback time means "no feedback seen": the worst.
  const na = typeof a === "number" ? a : isFb && a === null ? Infinity : null;
  const nb = typeof b === "number" ? b : isFb && b === null ? Infinity : null;
  if (nb === null) return "—";
  if (na === null) return "new";
  if (na === nb) return "same";
  if (!isFinite(na) || !isFinite(nb)) return (nb < na) === (better === "lower") ? "better" : "worse";
  const tol = Math.max(Math.abs(na) * 0.1, /Ms$/.test(key) ? 20 : 0.01);
  if (Math.abs(nb - na) <= tol) return "same";
  return (nb < na) === (better === "lower") ? "better" : "worse";
}
function loadResult(name) {
  const f = existsSync(name) ? name : join(RESULTS, `${name}.json`);
  return JSON.parse(readFileSync(f, "utf8"));
}
function compare(a, b) {
  const A = loadResult(a);
  const B = loadResult(b);
  const head = `### Music UI perf — ${A.label} (${A.git}, reps=${A.reps}) → ${B.label} (${B.git}, reps=${B.reps}), medians`;
  if (args.all) return head + "\n\n" + compareAll(A, B);
  const fbCol = (r, id, key) => {
    if (!FEEDBACK.some(([i, k]) => i === id && k === key)) return "";
    const p = feedbackPass(r, id, key);
    return p === null ? "—" : allOf(p) ? "pass" : "fail";
  };
  const lines = [head, "", `| Scenario | Metric | ${A.label} | ${B.label} | Verdict | ≤${FEEDBACK_MS} ms |`, "|---|---|---|---|---|---|"];
  let prev = null;
  for (const [id, key, what, better] of HEADLINE) {
    const sa = A.summary[id];
    const sb = B.summary[id];
    if (!sa && !sb) continue;
    const va = sa?.na && !(key in sa) ? `n/a` : sa?.[key];
    const vb = sb?.na && !(key in sb) ? `n/a` : sb?.[key];
    const isFb = FEEDBACK.some(([, k]) => k === key);
    const show = (s, v) => (!s ? "not run" : v === null && isFb ? "never" : cell(v));
    const fa = fbCol(A, id, key);
    const fbb = fbCol(B, id, key);
    lines.push(`| ${id === prev ? "" : `**${id}**`} | ${what} | ${show(sa, va)} | ${show(sb, vb)} | ${verdict(va, vb, better, key)} | ${fa || fbb ? `${fa || "—"} → ${fbb || "—"}` : ""} |`);
    prev = id;
  }
  // Hard checks, side by side.
  const ca = new Map(hardChecks(A).map((c) => [`${c.id} ${c.name}`, c.ok]));
  const cb = hardChecks(B);
  if (cb.length) {
    lines.push("", `#### Hard checks (${B.label}; ${A.label} in brackets)`, "", "| Scenario | Check | Result |", "|---|---|---|");
    for (const c of cb) {
      const o = ca.get(`${c.id} ${c.name}`);
      lines.push(`| ${c.id} | ${cell(c.name)} | ${okText(c.ok)}${o === undefined ? "" : ` (${okText(o)})`} |`);
    }
  }
  lines.push("", "Verdict: numbers within 10% (and 20 ms) count as the same. `--all` prints every field.");
  return lines.join("\n");
}
function compareAll(A, B) {
  const lines = [`| Scenario | Metric | ${A.label} | ${B.label} | Δ |`, "|---|---|---|---|---|"];
  const ids = [...new Set([...Object.keys(A.summary), ...Object.keys(B.summary)])];
  for (const id of ids) {
    const sa = A.summary[id] ?? {};
    const sb = B.summary[id] ?? {};
    let first = true;
    for (const k of [...new Set([...Object.keys(sa), ...Object.keys(sb)])]) {
      const va = sa[k];
      const vb = sb[k];
      const delta = typeof va === "number" && typeof vb === "number" ? (vb - va > 0 ? "+" : "") + Math.round((vb - va) * 100) / 100 : va === vb ? "" : "changed";
      lines.push(`| ${first ? `**${id}**` : ""} | ${k}${LEGACY.has(`${id} ${k}`) ? " †" : ""} | ${cell(va)} | ${cell(vb)} | ${delta} |`);
      first = false;
    }
  }
  lines.push("", "† legacy field (not used by the clean table).");
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
  // results/baseline.json is the committed reference: never overwritten.
  if (args.label === "baseline" && existsSync(join(RESULTS, "baseline.json")) && !argv.includes("--force-baseline")) {
    console.error("[perf] results/baseline.json is the committed reference; pick another --label (e.g. baseline-v2).");
    process.exitCode = 2;
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
  if (args.check) {
    const failed = hardChecks(result).filter((c) => c.ok !== true); // "not measured" fails too
    console.error(failed.length ? `[perf] check FAILED: ${failed.length} hard check(s)\n` + failed.map((c) => `  ${c.id} ${c.name}: ${c.detail}`).join("\n") : "[perf] check passed");
    if (failed.length) process.exitCode = 1;
  }
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
