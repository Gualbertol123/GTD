#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Spotify → YouTube match rate: netlify/lib/ytjs.mts matchSong against REAL
// YouTube (YouTube.js), over a fixed sample of Spotify songs.
//
//   node scripts/perf/match-rate.mjs --label after [--sample scripts/perf/match-sample.json]
//        [--src path/to/other/ytjs.mts] [--batch 20] [--only 30] [--out DIR] [--retries 3]
//
// The sample (match-sample.json) is ~170 songs as Spotify writes them (title,
// "A, B" artists, length in ms), read from Spotify's public embed pages of
// editorial playlists (Top 50 Italy / Global / Japan / Korea / India, Rock
// Classics, All Out 50s–2010s, Viva Latino, Afternoon Acoustic, Coffee Table
// Jazz…) plus Italian classics typed by hand (`approxMs`: length from memory).
//
// Songs are matched as the function does it: `--batch` (20) at once, each
// within 8 s (BUDGET_MS - 500). A song whose matchSong threw (YouTube 403,
// network) or timed out is tried again after 2 s, 4 s, 8 s; if it still fails
// it counts as "error" / "timeout", never as "miss".
//
// Each chosen video is then looked up on its own (getBasicInfo: title,
// channel, length) and judged, independently of matchSong's own scoring:
//   exact      the title's words, an artist and the version (live or not) agree,
//              and the length is within ±10 s (±25 s for `approxMs` songs);
//   other-cut  the same song, but a cut 10–60 s longer/shorter (a music video
//              with an intro, a radio edit…);
//   wrong      anything else (another song, a cover, live instead of studio, a
//              length 60 s+ off: another recording).
// A song's okIds / badIds in the sample (checked by hand) override the judge.
//   miss       matchSong returned null.
// "right" = exact + other-cut. The judge is a heuristic: look at the "wrong"
// and "miss" lists it prints.
//
// Results: <out>/match-<label>.json (per song) + a markdown summary on stdout.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const label = opt("--label", "run");
const sampleFile = resolve(opt("--sample", join(HERE, "match-sample.json")));
const src = opt("--src", null);
const BATCH = Number(opt("--batch", 20));
const ONLY = Number(opt("--only", 0));
const OUT = resolve(opt("--out", join(HERE, "results")));
const RETRIES = Number(opt("--retries", 3));
const PER_SONG_MS = 8000;
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// ---- 1. Bundle matchSong (+ the classifier, for the judge) ---------------------
const require = createRequire(join(WEB, "package.json"));
const esbuild = require("esbuild");
const BUILD = join(HERE, ".build", "match");
mkdirSync(BUILD, { recursive: true });
const lib = join(WEB, "netlify", "lib");
// Another version of ytjs.mts (e.g. the original, for a baseline): copied next
// to the real one so its relative imports resolve, removed after the bundle.
const entryFile = src ? join(lib, `.ytjs-${label}.tmp.mts`) : join(lib, "ytjs.mts");
if (src) copyFileSync(resolve(src), entryFile);
try {
  await esbuild.build({
    stdin: {
      contents: `export { matchSong } from ${JSON.stringify(entryFile)};\nexport { normText, classify } from ${JSON.stringify(join(WEB, "src", "lib", "musicSort.ts"))};\n`,
      resolveDir: lib,
      loader: "ts",
    },
    outfile: join(BUILD, `match-${label}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    logLevel: "error",
  });
} finally {
  if (src) rmSync(entryFile, { force: true });
}
const { matchSong, normText, classify } = await import(pathToFileURL(join(BUILD, `match-${label}.mjs`)).href);

// A separate client for the judge's lookups (not timed, not shared with matchSong's cache).
const { Innertube, Log } = await import(pathToFileURL(require.resolve("youtubei.js")).href);
try {
  Log.setLevel(Log.Level.ERROR);
} catch {}
const judgeYt = await Innertube.create({ lang: "it", location: "IT", retrieve_player: false });

// ---- 2. Match -------------------------------------------------------------------
let sample = JSON.parse(readFileSync(sampleFile, "utf8"));
if (ONLY) sample = sample.slice(0, ONLY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms)))]).finally(() => clearTimeout(t));
};
const kindOf = (e) => (e?.name === "TimeoutError" || /timeout/i.test(String(e?.message)) ? "timeout" : "error");

const rows = sample.map((s, i) => ({ i, ...s, status: "pending", tries: 0, times: [] }));
const t0 = Date.now();
for (let b = 0; b < rows.length; b += BATCH) {
  const batch = rows.slice(b, b + BATCH);
  const bt = Date.now();
  await Promise.all(
    batch.map(async (r) => {
      const t = Date.now();
      try {
        const m = await within(matchSong(r.title, r.artist, r.ms), PER_SONG_MS);
        r.times.push(Date.now() - t);
        r.tries++;
        r.status = m ? "found" : "miss";
        r.match = m ?? null;
      } catch (e) {
        r.times.push(Date.now() - t);
        r.tries++;
        r.status = kindOf(e);
        r.err = r.firstErr = String(e?.message ?? e).slice(0, 200);
      }
    })
  );
  // Failures: again, one at a time, with backoff.
  for (const r of batch.filter((x) => x.status === "error" || x.status === "timeout")) {
    for (let k = 0; k < RETRIES && (r.status === "error" || r.status === "timeout"); k++) {
      await sleep(2000 * 2 ** k);
      const t = Date.now();
      try {
        const m = await within(matchSong(r.title, r.artist, r.ms), PER_SONG_MS);
        r.status = m ? "found" : "miss";
        r.match = m ?? null;
        delete r.err;
      } catch (e) {
        r.status = kindOf(e);
        r.err = String(e?.message ?? e).slice(0, 200);
      }
      r.times.push(Date.now() - t);
      r.tries++;
    }
  }
  log(`batch ${b / BATCH + 1}: ${batch.length} songs, ${Date.now() - bt} ms; ` + ["found", "miss", "error", "timeout"].map((k) => `${k} ${batch.filter((x) => x.status === k).length}`).join(", "));
}
const wall = Date.now() - t0;

// ---- 3. Judge ---------------------------------------------------------------------
const squash = (s) => normText(s).replace(/ /g, "");
const VERSION = /\s[-–]\s.*$/; // Spotify's " - 2011 Remaster", " - Live", " - From …"
const FEAT_PAREN = /[([]\s*(feat\.?|ft\.?|with|con|featuring)\b[^)\]]*[)\]]/gi;
const LIVE = /\blive\b|ao vivo|en vivo|dal vivo|unplugged|in concert|recorded at/i;
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

function judge(song, video) {
  const main = song.title.replace(FEAT_PAREN, " ").replace(VERSION, "").replace(/[([].*?([)\]]|$)/g, " ").trim() || song.title;
  const hayText = `${video.title} ${video.channel}`;
  const hay = ` ${normText(hayText)} `;
  const haySq = squash(hayText);
  const tokens = normText(main).split(" ").filter((w) => w.length > 1 || CJK.test(w));
  const hits = tokens.filter((w) => hay.includes(` ${w} `) || (w.length >= 4 && haySq.includes(w))).length;
  const titleOk = tokens.length ? hits / tokens.length >= 0.7 || (squash(main).length >= 2 && haySq.includes(squash(main))) : true;
  const artists = song.artist.split(/,\s*/).map(squash).filter((a) => a.length >= 2);
  const artistOk = artists.some((a) => haySq.includes(a));
  const wantLive = LIVE.test(song.title);
  const c = classify({ title: video.title, channel: video.channel });
  const gotLive = c.kind === "live" || LIVE.test(video.title);
  const wantRemix = /remix|edit|mix\b/i.test(song.title);
  // A cover or karaoke is another recording; a slowed / sped-up edit too, unless a remix or edit was asked for.
  const versionOk = (wantLive ? gotLive : !gotLive) && c.tag !== "cover" && (wantRemix || c.tag !== "edit");
  const tol = song.approxMs ? 25000 : 10000;
  const delta = video.ms && song.ms ? Math.abs(video.ms - song.ms) : null;
  const durOk = delta == null || delta <= tol;
  // Another recording: a concert, a full-length upload, a TV performance.
  const sameRecording = delta == null || delta <= 60000;
  let verdict = "wrong";
  if (titleOk && artistOk && versionOk && sameRecording) verdict = durOk ? "exact" : "other-cut";
  // Checked by hand (match-sample.json okIds / badIds): the heuristic misreads these.
  if (song.okIds?.includes(video.id)) verdict = durOk ? "exact" : "other-cut";
  if (song.badIds?.includes(video.id)) verdict = "wrong";
  return { verdict, titleOk, artistOk, versionOk, durOk, deltaS: delta == null ? null : Math.round(delta / 1000), kind: c.kind, tag: c.tag };
}

for (const r of rows.filter((x) => x.status === "found")) {
  let info = null;
  for (let k = 0; k < 3 && !info; k++) {
    info = await judgeYt.getBasicInfo(r.match.id).catch(async () => (await sleep(1500 * (k + 1)), null));
  }
  const b = info?.basic_info ?? {};
  r.video = { id: r.match.id, title: b.title ?? r.match.title, channel: b.author ?? r.match.channel, ms: b.duration ? b.duration * 1000 : r.match.ms ?? 0 };
  Object.assign(r, judge(r, r.video));
}

// ---- 4. Report --------------------------------------------------------------------
const n = rows.length;
const count = (f) => rows.filter(f).length;
const pct = (k) => `${((100 * k) / n).toFixed(1)}%`;
const first = rows.map((r) => r.times[0]).sort((a, b) => a - b);
const avg = Math.round(first.reduce((a, b) => a + b, 0) / n);
const p90 = first[Math.floor(n * 0.9)];
const s = {
  label,
  songs: n,
  found: count((r) => r.status === "found"),
  exact: count((r) => r.verdict === "exact"),
  otherCut: count((r) => r.verdict === "other-cut"),
  wrong: count((r) => r.verdict === "wrong"),
  miss: count((r) => r.status === "miss"),
  error: count((r) => r.status === "error"),
  timeout: count((r) => r.status === "timeout"),
  avgMs: avg,
  p90Ms: p90,
  wallMs: wall,
  retried: count((r) => r.tries > 1),
};
s.right = s.exact + s.otherCut;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `match-${label}.json`), JSON.stringify({ summary: s, rows }, null, 1));

const out = [];
out.push(`## Match rate: ${label} (${n} songs, ${new Date().toISOString().slice(0, 16)})`, "");
out.push("| found | right (exact + other cut) | exact | wrong | miss | error | timeout | avg / song | p90 | wall |", "|---|---|---|---|---|---|---|---|---|---|");
out.push(`| ${pct(s.found)} (${s.found}) | ${pct(s.right)} (${s.right}) | ${pct(s.exact)} (${s.exact}) | ${pct(s.wrong)} (${s.wrong}) | ${pct(s.miss)} (${s.miss}) | ${s.error} | ${s.timeout} | ${s.avgMs} ms | ${s.p90Ms} ms | ${(wall / 1000).toFixed(1)} s |`, "");
const groups = [...new Set(rows.map((r) => r.group))];
out.push("| group | songs | right | wrong | miss | err |", "|---|---|---|---|---|---|");
for (const g of groups) {
  const gr = rows.filter((r) => r.group === g);
  const c = (f) => gr.filter(f).length;
  out.push(`| ${g} | ${gr.length} | ${c((r) => r.verdict === "exact" || r.verdict === "other-cut")} | ${c((r) => r.verdict === "wrong")} | ${c((r) => r.status === "miss")} | ${c((r) => r.status === "error" || r.status === "timeout")} |`);
}
out.push("", "### Wrong", "");
for (const r of rows.filter((x) => x.verdict === "wrong"))
  out.push(`- ${r.artist} — ${r.title} (${Math.round(r.ms / 1000)} s) → ${r.video.id} "${r.video.title}" / ${r.video.channel} (${Math.round(r.video.ms / 1000)} s) [title ${r.titleOk ? "ok" : "no"}, artist ${r.artistOk ? "ok" : "no"}, version ${r.versionOk ? "ok" : "no"}, Δ ${r.deltaS} s]`);
out.push("", "### Other cut", "");
for (const r of rows.filter((x) => x.verdict === "other-cut")) out.push(`- ${r.artist} — ${r.title} → "${r.video.title}" / ${r.video.channel} (Δ ${r.deltaS} s)`);
out.push("", "### Retried (YouTube failed or was slow at first)", "");
for (const r of rows.filter((x) => x.tries > 1)) out.push(`- ${r.artist} — ${r.title}: ${r.tries} tries (${r.times.join(", ")} ms), first: ${r.firstErr}; now ${r.status}`);
out.push("", "### Miss / error", "");
for (const r of rows.filter((x) => x.status !== "found")) out.push(`- [${r.status}] ${r.artist} — ${r.title}${r.err ? ` (${r.err})` : ""}`);
console.log(out.join("\n"));
process.exit(0);
