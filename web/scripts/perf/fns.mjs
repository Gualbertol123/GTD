#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Server function bench: netlify/functions/music-*.mts against REAL YouTube
// (YouTube.js) and Spotify, with a local mock of Supabase's is_team_member RPC.
//
//   node scripts/perf/fns.mjs --label baseline [--warm 5] [--rpc-delay 80-150] [--only search,radio]
//
// Each function is bundled with esbuild into scripts/perf/.build/fns/. Each
// case runs in a FRESH node process: the first call is COLD (module import +
// YouTube.js client creation + the call), then --warm more calls (median =
// WARM). A fetch hook in the child splits each call's time into the auth RPC
// (Supabase mock) and upstream (YouTube / Spotify) requests.
// YOUTUBE_API_KEY is removed from the environment: only the YouTube.js path is
// measured (the Data API fallback would answer 501 no-key).
// Results: scripts/perf/results/fns-<label>.json + a markdown table on stdout.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv0 = process.argv.slice(2);
const wi = argv0.indexOf("--web");
const WEB = wi >= 0 ? resolve(argv0[wi + 1]) : join(HERE, "..", ".."); // --web <dir>: bundle from another checkout
const BUILD = join(HERE, ".build", "fns");
const RESULTS = join(HERE, "results");
const FUNCTIONS = ["music-search", "music-browse", "music-playlist", "music-spotify"];

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

if (argv[0] === "--child") await child(JSON.parse(argv[1]));
else await parent();

// =============================================================================
// Child: one case, cold + warm.
// =============================================================================
async function child(c) {
  const supa = process.env.VITE_SUPABASE_URL;
  const realFetch = globalThis.fetch;
  let cur = null; // the current call's accounting
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const t = performance.now();
    try {
      return await realFetch(input, init);
    } finally {
      const ms = performance.now() - t;
      if (cur) {
        if (url.startsWith(supa)) cur.authMs += ms;
        else {
          cur.upstreamMs += ms;
          cur.upstreamCalls++;
          cur.hosts[new URL(url).hostname] = (cur.hosts[new URL(url).hostname] ?? 0) + 1;
        }
      }
    }
  };
  // The functions log YouTube.js failures with console.warn: keep them per call.
  console.warn = (...a) => cur && cur.warnings.push(a.map(String).join(" ").slice(0, 200));
  console.log = () => {};
  const t0 = performance.now();
  const mod = await import(pathToFileURL(join(BUILD, `${c.fn}.mjs`)).href);
  const importMs = performance.now() - t0;
  const handler = mod.default;
  const calls = [];
  for (let i = 0; i <= c.warm; i++) {
    if (i > 0 && c.gap) await new Promise((r) => setTimeout(r, c.gap));
    cur = { authMs: 0, upstreamMs: 0, upstreamCalls: 0, hosts: {}, warnings: [] };
    const req = new Request(`http://localhost/.netlify/functions/${c.fn}?${c.query ?? ""}`, {
      method: c.method ?? "GET",
      headers: { authorization: "Bearer perf-test-token", "content-type": "application/json" },
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
    const t = performance.now();
    let status = 0;
    let text = "";
    let error = null;
    try {
      const res = await handler(req, {});
      status = res.status;
      text = await res.text();
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    const ms = performance.now() - t;
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    calls.push({ ms, status, bytes: text.length, error: error ?? body?.error ?? null, ...cur, body: i === 0 ? body : undefined });
  }
  process.stdout.write("\n@@RESULT@@" + JSON.stringify({ importMs, calls }) + "\n");
  process.exit(0);
}

// =============================================================================
// Parent
// =============================================================================
async function parent() {
  const label = opt("--label", "run");
  const warm = Number(opt("--warm", 5));
  const gap = Number(opt("--gap", 500)); // ms between warm calls
  const [dMin, dMax] = opt("--rpc-delay", "80-150").split("-").map(Number);
  const only = opt("--only", null)?.split(",");

  // 1. Bundle.
  const require = createRequire(join(HERE, "..", "..", "package.json"));
  const esbuild = require("esbuild");
  mkdirSync(BUILD, { recursive: true });
  for (const fn of FUNCTIONS) {
    await esbuild.build({
      entryPoints: [join(WEB, "netlify", "functions", `${fn}.mts`)],
      outfile: join(BUILD, `${fn}.mjs`),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "error",
    });
  }

  // 2. Supabase mock: is_team_member → true after dMin–dMax ms.
  let rpcCalls = 0;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const server = createServer((req, res) => {
    if (req.url.startsWith("/rest/v1/rpc/is_team_member")) {
      rpcCalls++;
      req.resume();
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
      }, dMin + rnd() * (dMax - dMin));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const supaUrl = `http://127.0.0.1:${server.address().port}`;

  const env = { ...process.env, VITE_SUPABASE_URL: supaUrl, VITE_SUPABASE_ANON_KEY: "anon", NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" };
  delete env.YOUTUBE_API_KEY;

  const runCase = (c) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", JSON.stringify({ ...c, warm, gap })], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => p.kill("SIGKILL"), 180000);
      p.on("exit", () => {
        clearTimeout(timer);
        const m = out.split("@@RESULT@@")[1];
        if (!m) return resolve({ error: (err.trim().split("\n").filter((l) => !/ExperimentalWarning|EnvHttpProxyAgent|trace-warnings/.test(l)).slice(-2).join(" ") || "no result").slice(0, 300) });
        resolve(JSON.parse(m));
      });
    });

  // 3. Cases (later ones take ids from earlier answers).
  const found = { video: "dQw4w9WgXcQ", artist: null, list: null, spotifySongs: null };
  const cases = [
    { name: "search", fn: "music-search", query: "q=tiziano+ferro", after: (b) => b?.tracks?.[0]?.id && (found.video = b.tracks[0].id), count: (b) => b?.tracks?.length },
    { name: "suggest", fn: "music-browse", query: "suggest=tiz", count: (b) => b?.suggestions?.length },
    { name: "explore", fn: "music-browse", query: "explore=1", count: (b) => b?.sections?.reduce((a, s) => a + s.tracks.length, 0) },
    { name: "charts-IT", fn: "music-browse", query: "charts=IT", after: (b) => b?.artists?.[0]?.id && (found.artist = b.artists[0].id), count: (b) => (b?.lists?.length ?? 0) + (b?.artists?.length ?? 0) },
    { name: "radio", fn: "music-browse", query: () => `radio=${found.video}`, count: (b) => b?.tracks?.length },
    { name: "artist", fn: "music-browse", query: () => (found.artist ? `artist=${found.artist}` : null), count: (b) => b?.tracks?.length },
    { name: "artist-top (fav)", fn: "music-search", query: "channelId=UCvBz3n23YgAvAHfoZtdqZCA&order=viewCount", count: (b) => b?.tracks?.length },
    { name: "playlist-find", fn: "music-playlist", query: "q=tiziano+ferro", after: (b) => b?.lists?.[0]?.list && (found.list = b.lists[0].list), count: (b) => b?.lists?.length },
    { name: "playlist-import", fn: "music-playlist", query: () => (found.list ? `list=${found.list}` : null), count: (b) => b?.tracks?.length },
    {
      name: "spotify-read",
      fn: "music-spotify",
      query: "url=" + encodeURIComponent("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
      after: (b) => b?.songs?.length && (found.spotifySongs = b.songs.slice(0, 3)),
      count: (b) => b?.songs?.length,
    },
    {
      name: "spotify-match×3",
      fn: "music-spotify",
      method: "POST",
      body: () => ({
        songs: found.spotifySongs ?? [
          { title: "Perdono", artist: "Tiziano Ferro", ms: 220000 },
          { title: "Bailando", artist: "Enrique Iglesias", ms: 243000 },
          { title: "Livin' la Vida Loca", artist: "Ricky Martin", ms: 243000 },
        ],
      }),
      count: (b) => b?.matches?.filter(Boolean).length,
    },
  ];

  const rows = [];
  for (const c of cases) {
    if (only && !only.includes(c.name)) continue;
    const query = typeof c.query === "function" ? c.query() : c.query;
    if (query === null) {
      rows.push({ name: c.name, na: "no id from an earlier case" });
      console.error(`[fns] ${c.name}: n/a`);
      continue;
    }
    const t = Date.now();
    const r = await runCase({ fn: c.fn, query, method: c.method, body: typeof c.body === "function" ? c.body() : c.body });
    if (r.error) {
      rows.push({ name: c.name, fn: c.fn, query, na: r.error });
      console.error(`[fns] ${c.name}: n/a ${r.error}`);
      continue;
    }
    const [first, ...all] = r.calls;
    c.after?.(first.body);
    // A call "fell back" when YouTube.js threw (the function then tries the
    // Data API, which answers 501 no-key here) or the status is not 200.
    const okCall = (x) => x.status === 200 && !x.warnings.length && !x.error;
    const rest = all.filter(okCall);
    const failed = all.filter((x) => !okCall(x));
    const med = (a) => {
      const s = a.filter((x) => isFinite(x)).sort((x, y) => x - y);
      if (!s.length) return null;
      const m = s.length >> 1;
      return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    };
    const row = {
      name: c.name,
      fn: c.fn,
      query: query.length > 60 ? query.slice(0, 60) + "…" : query,
      status: [...new Set(r.calls.map((x) => x.status))].join("/"),
      coldOk: okCall(first),
      warmOk: `${rest.length}/${all.length}`,
      failedWarmMedianMs: med(failed.map((x) => x.ms)),
      ytjsErrors: [...new Set(r.calls.flatMap((x) => x.warnings))].slice(0, 2).join(" ‖ "),
      items: c.count?.(first.body) ?? null,
      error: first.error ?? all.find((x) => x.error)?.error ?? null,
      importMs: Math.round(r.importMs),
      coldMs: Math.round(r.importMs + first.ms),
      coldCallMs: Math.round(first.ms),
      coldAuthMs: Math.round(first.authMs),
      coldUpstreamCalls: first.upstreamCalls,
      warmMedianMs: med(rest.map((x) => x.ms)),
      warmMinMs: rest.length ? Math.round(Math.min(...rest.map((x) => x.ms))) : null,
      warmMaxMs: rest.length ? Math.round(Math.max(...rest.map((x) => x.ms))) : null,
      warmAuthMedianMs: med(rest.map((x) => x.authMs)),
      warmUpstreamCalls: med(rest.map((x) => x.upstreamCalls)),
      upstreamHosts: Object.keys(first.hosts).join(" "),
      bytes: first.bytes,
    };
    row.authSharePct = row.warmMedianMs ? Math.round((100 * (row.warmAuthMedianMs ?? 0)) / row.warmMedianMs) : null;
    rows.push(row);
    console.error(`[fns] ${c.name}: cold ${row.coldMs} ms, warm ${row.warmMedianMs} ms (auth ${row.warmAuthMedianMs}) status ${row.status} items ${row.items} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
  server.close();

  const result = { label, web: WEB, date: new Date().toISOString(), git: gitRev(), node: process.version, warm, rpcDelayMs: [dMin, dMax], rpcCalls, rows };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `fns-${label}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  const h = ["case", "fn", "status", "items", "cold ms (import+1st)", "import ms", "1st call ms", "1st auth ms", "cold ok", "warm ok", "warm median ms (ok calls)", "warm min–max", "warm auth ms", "auth %", "failed calls median ms", "upstream calls cold/warm", "error / YouTube.js failure"];
  const lines = [
    `### Music functions — ${label} (${result.date}, ${result.git}, node ${process.version}, warm=${warm}, RPC mock ${dMin}–${dMax} ms)`,
    "",
    `| ${h.join(" | ")} |`,
    `|${h.map(() => "---").join("|")}|`,
  ];
  for (const r of rows) {
    if (r.na) lines.push(`| ${r.name} | ${r.fn ?? ""} | n/a |${" |".repeat(13)} ${String(r.na).replace(/\|/g, "\\|")} |`);
    else
      lines.push(
        `| ${r.name} | ${r.fn} | ${r.status} | ${r.items ?? "—"} | ${r.coldMs} | ${r.importMs} | ${r.coldCallMs} | ${r.coldAuthMs} | ${r.coldOk ? "yes" : "NO"} | ${r.warmOk} | ${r.warmMedianMs ?? "—"} | ${r.warmMinMs ?? "—"}–${r.warmMaxMs ?? "—"} | ${r.warmAuthMedianMs ?? "—"} | ${r.authSharePct ?? "—"} | ${r.failedWarmMedianMs ?? "—"} | ${r.coldUpstreamCalls}/${r.warmUpstreamCalls ?? "—"} | ${[r.error, r.ytjsErrors].filter(Boolean).join(" · ").replace(/\|/g, "\\|")} |`
      );
  }
  console.log(lines.join("\n"));
  console.error(`[fns] wrote ${file}`);
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
