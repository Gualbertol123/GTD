// Network mocks for the UI harness: Supabase (REST, RPC, Auth, Realtime
// websocket), the Netlify music functions, YouTube (fake IFrame API, blank
// embed frame, thumbnails). Everything is deterministic: answers and
// latencies follow from the request URL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SHARED_SRC = readFileSync(join(here, "shared.js"), "utf8");
export const FAKE_YT_SRC = SHARED_SRC + "\n" + readFileSync(join(here, "fakeYT.js"), "utf8");
export const INPAGE_SRC = readFileSync(join(here, "inpage.js"), "utf8");

// The same catalogue functions the browser uses.
export const cat = new Function(
  SHARED_SRC + "\nreturn { fnv1a, vid, titleFor, artistFor, durationFor, bufferFor, isBad, SONG_TITLE_RE };"
)();
const { fnv1a, vid, titleFor, artistFor, isBad } = cat;

export const SUPABASE = "http://supabase.mock";

// ---- Catalogue ------------------------------------------------------------------

export function track(id) {
  return { id, title: titleFor(id), channel: artistFor(id), thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
}
/** n ids from a seed prefix. */
function ids(prefix, n) {
  return Array.from({ length: n }, (_, k) => vid(`${prefix}:${k}`));
}
/** The k-th playable / unplayable id for a prefix. */
function pick(prefix, bad, skip = 0) {
  for (let k = 0, found = 0; k < 10000; k++) {
    const id = vid(`${prefix}:pick:${k}`);
    if (isBad(id) === bad && found++ === skip) return id;
  }
  throw new Error("pick failed");
}

/** Trends: 30 songs; 0–4 and 6 play, 5 does NOT (onError 150) — S9 relies on it. */
export const TRENDS = (() => {
  const out = [];
  for (let i = 0; i < 5; i++) out.push(pick("trend", false, i));
  out.push(pick("trend", true, 0));
  out.push(pick("trend", false, 5));
  for (const id of ids("trend-rest", 40)) if (out.length < 30 && !out.includes(id)) out.push(id);
  return out.map(track);
})();
export const NEW_VIDEOS = ids("newvideos", 20).map(track);

/** Team playlists (music_playlists rows). "Errori" = [bad, bad, good…, bad(last)]. */
export const PLAYLISTS = (() => {
  const now = Date.now();
  const p = (id, name, owner, list, age) => ({ id, name, owner, tracks: list.map(track), created_at: now - age, updated_at: now - age });
  const errori = [pick("err", true, 0), pick("err", true, 1), ...Array.from({ length: 27 }, (_, i) => pick("err", false, i)), pick("err", true, 2)];
  // Songs 0–3 of the first two playlists play (stable starts for S5/S8).
  const good = (prefix) => [...Array.from({ length: 4 }, (_, i) => pick(prefix, false, i)), ...ids(prefix, 26)];
  return [
    p("plviaggio", "Viaggio in auto", "Marco", good("viaggio"), 1000),
    p("plufficio", "Ufficio chill", "Giulia", good("ufficio"), 2000),
    p("plerrori", "Errori", "Luca", errori, 3000),
  ];
})();

export function searchTracks(q) {
  // Results 0–3 play (S10 long-presses one), the rest as the hash says.
  const k = q.toLowerCase().trim();
  return [...Array.from({ length: 4 }, (_, i) => pick(`search:${k}`, false, i)), ...ids(`search:${k}`, 36)].map(track);
}
function chartsOf(country) {
  return {
    lists: Array.from({ length: 6 }, (_, i) => ({
      list: "PL" + vid(`chart:${country}:${i}`) + vid(`chart2:${country}:${i}`).slice(0, 11) + "Ab",
      title: ["Top 100 brani", "Top 100 video musicali", "Tendenze", "Top 20 settimana", "Hit del momento", "Nuove uscite"][i] + ` · ${country}`,
      thumb: `https://i.ytimg.com/vi/${vid(`chartthumb:${country}:${i}`)}/hqdefault.jpg`,
    })),
    artists: Array.from({ length: 12 }, (_, i) => {
      const id = "UC" + (vid(`artist:${country}:${i}`) + vid(`artistb:${country}:${i}`)).slice(0, 22);
      return { id, name: cat.artistFor(id) + (i > 9 ? " " + i : ""), thumb: `https://i.ytimg.com/vi/${vid(`at:${id}`)}/hqdefault.jpg` };
    }),
  };
}
function suggestions(q) {
  const s = q.toLowerCase().trim();
  return [s, `${s} ferro`, `${s} live`, `${s} 2024`, `${s} testo`, `${s} remix`, `${s} acustico`, `${s} karaoke`];
}
function playlistOf(list) {
  const tr = ids(`list:${list}`, 30).map(track);
  return { list, title: `Playlist ${list.slice(0, 6)}`, channel: "YouTube Music", thumb: `https://i.ytimg.com/vi/${tr[0].id}/hqdefault.jpg`, total: 30, tracks: tr, via: "ytjs" };
}

// ---- Board seed (Supabase tables read at boot) -------------------------------------------

const MEMBERS = ["Marco", "Giulia", "Luca"];
const STATUSES = ["BACKLOG", "NEXT", "IN PROGRESS", "WAITING", "DONE", "MAYBE"];
function seedTasks() {
  const now = Date.now();
  return Array.from({ length: 18 }, (_, i) => ({
    id: `task${i}`,
    title: `Attività di prova ${i + 1}`,
    description: "",
    owner: MEMBERS[i % 3],
    assignees: [MEMBERS[i % 3]],
    priority: ["P1", "P2", "P3", "P4"][i % 4],
    status: STATUSES[i % STATUSES.length],
    notes: "",
    subtasks: [],
    due_date: null,
    waiting_since: null,
    file_dir: null,
    done_at: null,
    updated_at: now - i * 1000,
    created_at: now - i * 60000,
    project_id: null,
  }));
}
const TABLES = {
  board_meta: [{ id: "main", board_name: "Team GTD", members: MEMBERS, login_days: 30 }],
  tasks: seedTasks(),
  weekly: [],
  projects: [],
  reflections: [],
  personal_notes: [],
  music_playlists: PLAYLISTS,
};

// ---- Auth seed ------------------------------------------------------------------

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function fakeSession() {
  const now = Math.floor(Date.now() / 1000);
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "team@example.com",
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2025-01-01T00:00:00Z",
  };
  const access_token = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: user.id, role: "authenticated", aud: "authenticated", email: user.email, exp: now + 7200, iat: now })}.c2ln`;
  return { access_token, token_type: "bearer", expires_in: 7200, expires_at: now + 7200, refresh_token: "refresh-perf", user };
}

/** localStorage seed for the app origin: logged in, Italian, "me" chosen. */
export function initSeedScript(origin, extra = {}) {
  const items = {
    "gtd-session": JSON.stringify(fakeSession()),
    "gtd-auth": JSON.stringify({ exp: Date.now() + 30 * 86400000 }),
    "gtd-me": "Marco",
    "gtd-lang": "it",
    ...extra,
  };
  return `(() => { if (location.origin !== ${JSON.stringify(origin)}) return;
    const items = ${JSON.stringify(items)};
    try { if (!sessionStorage.getItem("__perfSeeded")) { for (const k in items) localStorage.setItem(k, items[k]); sessionStorage.setItem("__perfSeeded", "1"); } } catch (e) {}
  })();`;
}

// ---- Request accounting -------------------------------------------------------------

export function category(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  if (u.hostname === "supabase.mock") {
    const m = u.pathname.match(/^\/rest\/v1\/rpc\/([^/?]+)/);
    if (m) return `sb:rpc:${m[1]}`;
    const t = u.pathname.match(/^\/rest\/v1\/([^/?]+)/);
    if (t) return `sb:rest:${t[1]}`;
    if (u.pathname.startsWith("/auth/")) return `sb:auth:${u.pathname.replace(/^\/auth\/v1\//, "")}`;
    if (u.pathname.startsWith("/realtime/")) return "sb:realtime";
    return "sb:other";
  }
  const fn = u.pathname.match(/^\/\.netlify\/functions\/([\w-]+)/);
  if (fn) {
    if (fn[1] === "music-browse") {
      const kind = ["explore", "charts", "artist", "suggest", "radio"].find((k) => u.searchParams.has(k)) ?? "?";
      return `fn:browse:${kind}`;
    }
    if (fn[1] === "music-playlist") return u.searchParams.has("list") ? "fn:playlist:list" : "fn:playlist:find";
    return `fn:${fn[1].replace(/^music-/, "")}`;
  }
  if (u.hostname === "i.ytimg.com") return "img:ytimg";
  if (/youtube(-nocookie)?\.com$/.test(u.hostname)) return u.pathname.includes("iframe_api") ? "yt:iframe_api" : u.pathname.startsWith("/embed") ? "yt:embed" : "yt:other";
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.pathname.startsWith("/assets/") ? "app:asset" : "app:doc";
  return `ext:${u.hostname}`;
}

export class RequestLog {
  constructor() {
    this.all = [];
  }
  add(url, method) {
    this.all.push({ t: Date.now(), url, method, cat: category(url) });
  }
  mark() {
    return this.all.length;
  }
  since(mark) {
    const counts = {};
    for (const r of this.all.slice(mark)) counts[r.cat] = (counts[r.cat] ?? 0) + 1;
    return counts;
  }
  urlsSince(mark, re) {
    return this.all.slice(mark).filter((r) => re.test(r.url)).map((r) => r.url);
  }
}

// ---- Routes --------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64");
const json = (body, status = 200, headers = {}) => ({ status, contentType: "application/json; charset=utf-8", headers, body: JSON.stringify(body) });

/** Function latency: 300–900 ms, fixed per URL. */
function fnLatency(url) {
  return 300 + (fnv1a("lat:" + url) % 601);
}

function answerFunction(url, method, postBody) {
  const u = new URL(url);
  const p = u.searchParams;
  const name = u.pathname.split("/").pop();
  if (name === "music-browse") {
    if (p.has("explore"))
      return json({ sections: [{ title: "Tendenze", tracks: TRENDS }, { title: "Nuovi video musicali", tracks: NEW_VIDEOS }] });
    if (p.has("charts")) return json(chartsOf(p.get("charts")));
    if (p.has("artist")) {
      const id = p.get("artist");
      return json({ name: artistFor(id), thumb: `https://i.ytimg.com/vi/${vid("ah:" + id)}/hqdefault.jpg`, tracks: ids(`martist:${id}`, 30).map(track) });
    }
    if (p.has("suggest")) return json({ suggestions: suggestions(p.get("suggest")) });
    if (p.has("radio")) {
      const id = p.get("radio");
      return json({ tracks: [track(id), ...ids(`radio:${id}`, 49).map(track)] });
    }
    return json({ error: "Empty request" }, 400);
  }
  if (name === "music-search") return json({ tracks: searchTracks(p.get("q") ?? p.get("channelId") ?? ""), via: "ytjs" });
  if (name === "music-playlist") {
    if (p.has("list")) return json(playlistOf(p.get("list")));
    const q = p.get("q") ?? "";
    return json({
      lists: Array.from({ length: 12 }, (_, i) => {
        const list = "PL" + (vid(`find:${q}:${i}`) + vid(`findb:${q}:${i}`) + "xyz").slice(0, 32);
        return { list, title: `${q} playlist ${i + 1}`, channel: artistFor(list), thumb: `https://i.ytimg.com/vi/${vid(list)}/hqdefault.jpg` };
      }),
      via: "ytjs",
    });
  }
  if (name === "music-spotify") {
    if (method === "POST") {
      let songs = [];
      try {
        songs = JSON.parse(postBody || "{}").songs ?? [];
      } catch {}
      return json({ matches: songs.map((s, i) => (i % 7 === 6 ? null : track(vid(`sp:${s.title}`)))) });
    }
    return json({
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
      name: "Fake Spotify list",
      owner: "Spotify",
      cover: "",
      songs: Array.from({ length: 25 }, (_, i) => ({ title: titleFor(vid(`spt:${i}`)), artist: artistFor(vid(`spt:${i}`)), ms: 200000 })),
    });
  }
  return json({ error: "unknown function" }, 404);
}

function answerSupabase(url, method, headers) {
  const u = new URL(url);
  const path = u.pathname;
  if (path.startsWith("/auth/v1/")) {
    const s = fakeSession();
    if (path.endsWith("/user")) return json(s.user);
    if (path.endsWith("/token")) return json(s);
    if (path.endsWith("/logout")) return { status: 204, body: "" };
    return json({});
  }
  const rpc = path.match(/^\/rest\/v1\/rpc\/(\w+)/);
  if (rpc) {
    if (rpc[1] === "is_team_member") return json(true);
    return json(null);
  }
  const t = path.match(/^\/rest\/v1\/(\w+)/);
  if (t) {
    if (method === "HEAD") return { status: 200, body: "" };
    if (method !== "GET") return { status: method === "POST" ? 201 : 204, contentType: "application/json", body: method === "POST" ? "[]" : "" };
    let rows = TABLES[t[1]] ?? [];
    for (const [k, v] of u.searchParams) {
      const m = /^eq\.(.*)$/.exec(v);
      if (m && !["select", "order", "limit"].includes(k)) rows = rows.filter((r) => String(r[k]) === m[1]);
    }
    if (u.searchParams.get("limit")) rows = rows.slice(0, Number(u.searchParams.get("limit")));
    const accept = headers["accept"] ?? "";
    if (accept.includes("vnd.pgrst.object")) return rows[0] ? json(rows[0]) : json({ code: "PGRST116", message: "0 rows" }, 406);
    return json(rows, 200, { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
  }
  return json({});
}

/**
 * Installs every route on a browser context. Returns the RequestLog.
 * opts.ytApiDelay: ms before iframe_api answers (default 150).
 */
export async function installMocks(context, { origin, ytApiDelay = 150 } = {}) {
  const log = new RequestLog();
  context.on("request", (r) => log.add(r.url(), r.method()));
  await context.addInitScript({ content: INPAGE_SRC });
  await context.addInitScript({ content: initSeedScript(origin) });

  await context.route(`${SUPABASE}/**`, async (route) => {
    const req = route.request();
    await sleep(60 + (fnv1a("sb:" + req.url()) % 91));
    await route.fulfill(answerSupabase(req.url(), req.method(), req.headers())).catch(() => {});
  });
  await context.route("**/.netlify/functions/**", async (route) => {
    const req = route.request();
    await sleep(fnLatency(req.url() + req.method() + (req.postData() ?? "")));
    await route.fulfill(answerFunction(req.url(), req.method(), req.postData())).catch(() => {});
  });
  await context.route("https://www.youtube.com/iframe_api*", async (route) => {
    await sleep(ytApiDelay);
    await route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_YT_SRC }).catch(() => {});
  });
  await context.route(/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body style='margin:0;background:#000'></body></html>" }).catch(() => {})
  );
  await context.route("https://i.ytimg.com/**", async (route) => {
    await sleep(30);
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }).catch(() => {});
  });
  // Anything else outside the app (fonts, other YouTube, Spotify covers…): refused, but counted.
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|supabase\.mock)/, (route) => {
    const url = route.request().url();
    if (url.startsWith("https://www.youtube.com/iframe_api") || url.startsWith("https://i.ytimg.com/") || /youtube(-nocookie)?\.com\/embed\//.test(url)) return route.fallback();
    return route.abort("blockedbyclient").catch(() => {});
  });

  // Realtime: a minimal Phoenix server — joins succeed, heartbeats answered,
  // no events. (The app must work either way; a mock keeps S5 free of
  // reconnect noise.)
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/realtime\/v1\/websocket/, (ws) => {
      log.add(ws.url(), "WS");
      ws.onMessage((msg) => {
        let m;
        try {
          m = JSON.parse(String(msg));
        } catch {
          return;
        }
        const arr = Array.isArray(m);
        const [joinRef, ref, topic, event, payload] = arr ? m : [m.join_ref, m.ref, m.topic, m.event, m.payload];
        let response = {};
        if (event === "phx_join") {
          const pc = payload?.config?.postgres_changes ?? [];
          response = { postgres_changes: pc.map((c, i) => ({ ...c, id: 1000 + i })) };
        }
        const p = { status: "ok", response };
        ws.send(JSON.stringify(arr ? [joinRef, ref, topic, "phx_reply", p] : { join_ref: joinRef, ref, topic, event: "phx_reply", payload: p }));
      });
    });
  }
  return log;
}
