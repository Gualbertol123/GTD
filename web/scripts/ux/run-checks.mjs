// -----------------------------------------------------------------------------
// The browser checks, run the way CI runs them (.github/workflows/ci.yml):
// the real app in Chromium against the in-memory fake Supabase (stub.mjs), so
// nothing touches a real database and no secrets are needed.
//
//   npm run test:browser                  (from web/; Chromium installed with
//                                          `npx playwright install chromium`)
//   node scripts/ux/run-checks.mjs [options]
//
//   --only=board,tabs,cards,offline,hover   which checks (default: all)
//   --no-retry                              no second try for a failed section
//
//   board    functional-board.mjs   board, recurring, In evidenza, projects, phone
//   tabs     functional-tabs.mjs    the other tabs, login, addresses, languages
//   cards    board-cards.mjs        memoised board cards (desktop and phone)
//   offline  offline-pwa.mjs        the installed app offline (production build)
//   hover    hoverdiff.mjs          the pointer sweep, cut down to one skin
//                                   (classic), one size (1440x900) and one
//                                   screen per page; the full sweep is
//                                   `node scripts/ux/hoverdiff.mjs`
//
//   DEV_PORT=5199      dev server for board / tabs / cards / hover
//   PREVIEW_PORT=5198  production preview for offline (the service worker
//                      only runs in a production build, built to dist-stub/)
//   OUT=ux-results     screenshots and one .log per check
//
// It starts and stops its own servers (with the stub's environment, whatever
// .env.local says), so nothing else should be listening on those ports.
// Exit code 1 if any check fails.
//
// A section that fails is run once more on its own: a few checks time
// animations and can miss under load (functional-board's phone.agenda). A
// section that then passes is reported as flaky, not as a failure.
// -----------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "../..");
const VITE = resolve(WEB, "node_modules/vite/bin/vite.js");
const argv = process.argv.slice(2);
const opt = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = (k) => argv.includes(`--${k}`);

const DEV_PORT = +(process.env.DEV_PORT ?? 5199);
const PREVIEW_PORT = +(process.env.PREVIEW_PORT ?? 5198);
const OUT = resolve(WEB, process.env.OUT ?? "ux-results");
const RETRY = !flag("no-retry");
const STUB_ENV = {
  VITE_SUPABASE_URL: "http://stub.supabase.local",
  VITE_SUPABASE_ANON_KEY: "stub",
  VITE_TEAM_EMAIL: "team@example.com",
};
const devUrl = `http://localhost:${DEV_PORT}/`;
const previewUrl = `http://localhost:${PREVIEW_PORT}/`;

// `sections` finds the section headings a script prints, and `rerun` gives
// the arguments that run just those sections again.
const CHECKS = [
  { name: "board", script: "functional-board.mjs", server: "dev", sections: /^== (.+)$/gm, rerun: (s) => [s] },
  { name: "tabs", script: "functional-tabs.mjs", server: "dev", sections: /^### (.+)$/gm, rerun: (s) => [s] },
  { name: "cards", script: "board-cards.mjs", server: "dev" },
  { name: "offline", script: "offline-pwa.mjs", server: "preview" },
  { name: "hover", script: "hoverdiff.mjs", server: "dev", args: ["--combos=classic", "--sizes=1440x900", "--screens=1"] },
];
const wanted = opt("only")?.split(",") ?? CHECKS.map((c) => c.name);
const unknown = wanted.filter((w) => !CHECKS.some((c) => c.name === w));
if (unknown.length) {
  console.error(`unknown check: ${unknown.join(", ")} (known: ${CHECKS.map((c) => c.name).join(", ")})`);
  process.exit(2);
}
const todo = CHECKS.filter((c) => wanted.includes(c.name));
mkdirSync(OUT, { recursive: true });

// ---- Processes ----------------------------------------------------------------
const children = new Set();
function start(args, logName) {
  const log = createWriteStream(resolve(OUT, logName));
  const child = spawn(process.execPath, [VITE, ...args], {
    cwd: WEB,
    env: { ...process.env, ...STUB_ENV },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // its own group, so the whole tree can be stopped
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
const stopAll = () => [...children].forEach(stop);
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

/** Refuses a port something else already answers on: the checks would
 *  otherwise run against whatever that is. */
async function ensureFree(url) {
  const taken = await fetch(url).then(() => true, () => false);
  if (taken) throw new Error(`${url} already answers: stop that server or pick another port (DEV_PORT / PREVIEW_PORT)`);
}

async function waitForServer(url, child, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`the server for ${url} exited (${child.exitCode}), see ${OUT}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no answer from ${url} after ${timeoutMs / 1000}s`);
}

/** Opens the app once, so Vite's first-visit dependency scan (and the reload
 *  it can trigger) happens before any check is timing anything. */
async function warmUp(url) {
  process.env.APP_URL = url;
  const { launch, openApp } = await import("./stub.mjs");
  const browser = await launch();
  try {
    const { page } = await openApp(browser, {});
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } finally {
    await browser.close();
  }
}

/** Runs one script, echoing its output and keeping it in a log file. */
function runScript(check, url, extraArgs, logName) {
  return new Promise((done) => {
    const log = createWriteStream(resolve(OUT, logName));
    let text = "";
    const child = spawn(process.execPath, [resolve(HERE, check.script), ...extraArgs], {
      cwd: WEB,
      env: { ...process.env, APP_URL: url, OUT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (stream, to) =>
      stream.on("data", (b) => {
        text += b;
        log.write(b);
        to.write(b);
      });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    const timer = setTimeout(() => {
      console.log(`\n!! ${check.name}: no end after 15 minutes, stopping it`);
      child.kill();
    }, 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      done({ code: code ?? 1, text });
    });
  });
}

/** The sections of a run that printed a FAIL (or "threw"). */
function failedSections(check, text) {
  if (!check.sections) return [];
  const heads = [...text.matchAll(check.sections)].map((m) => ({ name: m[1].trim(), at: m.index }));
  const failAt = [...text.matchAll(/^FAIL\b.*$/gm)].map((m) => m.index);
  const out = new Set();
  for (const at of failAt) {
    const head = heads.filter((h) => h.at < at).pop();
    if (!head) return []; // a failure outside any section: no partial rerun
    out.add(head.name);
  }
  return [...out];
}

// ---- Run ----------------------------------------------------------------------
const results = [];
const t0 = Date.now();
const secs = (ms) => `${Math.round(ms / 1000)}s`;

async function runCheck(check, url) {
  const started = Date.now();
  console.log(`\n================ ${check.name} (${check.script})`);
  const first = await runScript(check, url, check.args ?? [], `${check.name}.log`);
  let status = first.code === 0 ? "passed" : "FAILED";
  let note = "";
  if (first.code !== 0 && RETRY) {
    const again = failedSections(check, first.text);
    if (again.length) {
      const still = [];
      for (const s of again) {
        console.log(`\n---- ${check.name}: trying "${s}" again on its own`);
        const r = await runScript(check, url, check.rerun(s), `${check.name}-retry-${s.replace(/[^\w.-]+/g, "_")}.log`);
        if (r.code !== 0) still.push(s);
      }
      if (!still.length) {
        status = "passed";
        note = `flaky, passed on a second try: ${again.join(", ")}`;
      } else note = `failed twice: ${still.join(", ")}`;
    }
  }
  results.push({ name: check.name, status, note, time: Date.now() - started });
}

let exitCode = 0;
try {
  const onDev = todo.filter((c) => c.server === "dev");
  if (onDev.length) {
    console.log(`starting the dev server on ${devUrl}`);
    await ensureFree(devUrl);
    const dev = start(["--port", String(DEV_PORT), "--strictPort"], "dev-server.log");
    await waitForServer(devUrl, dev);
    await warmUp(devUrl);
    for (const c of onDev) await runCheck(c, devUrl);
    stop(dev);
  }
  const onPreview = todo.filter((c) => c.server === "preview");
  if (onPreview.length) {
    console.log("\nbuilding the app against the fake Supabase (dist-stub/)");
    const build = spawnSync(process.execPath, [VITE, "build", "--outDir", "dist-stub", "--emptyOutDir", "--logLevel", "warn"], {
      cwd: WEB,
      env: { ...process.env, ...STUB_ENV },
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("the stub build failed");
    console.log(`starting the preview server on ${previewUrl}`);
    await ensureFree(previewUrl);
    const preview = start(["preview", "--outDir", "dist-stub", "--port", String(PREVIEW_PORT), "--strictPort"], "preview-server.log");
    await waitForServer(previewUrl, preview);
    for (const c of onPreview) await runCheck(c, previewUrl);
    stop(preview);
  }
} catch (e) {
  console.error(`\n!! ${e?.stack ?? e}`);
  exitCode = 1;
}

console.log(`\n================ summary (${secs(Date.now() - t0)})`);
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name.padEnd(8)} ${secs(r.time).padStart(5)}${r.note ? "  " + r.note : ""}`);
console.log(`logs and screenshots: ${OUT}`);
if (results.some((r) => r.status !== "passed") || results.length < todo.length) exitCode = 1;
stopAll();
process.exit(exitCode);
