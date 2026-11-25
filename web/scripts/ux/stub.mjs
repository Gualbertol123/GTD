// -----------------------------------------------------------------------------
// UX harness: drive the real app in Chromium against an IN-MEMORY fake
// Supabase, so a design review never touches production data.
//
//   1. Start the dev server pointed at the fake host:
//        VITE_SUPABASE_URL=http://stub.supabase.local VITE_SUPABASE_ANON_KEY=stub \
//        VITE_TEAM_EMAIL=team@example.com npx vite --port 5199
//   2. import { openApp } from "./scripts/ux/stub.mjs" in a Playwright script.
//
// Every request to the fake host is answered here: auth (a stored session),
// PostgREST reads/writes on a tiny in-memory table store, the is_team_member
// RPC, and the realtime websocket (it acknowledges the channel join, so the
// connection badge reads "online"). Writes are kept for the page's lifetime.
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

export const STUB_HOST = "http://stub.supabase.local";
export const APP_URL = process.env.APP_URL ?? "http://localhost:5199/";

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function seed() {
  const now = Date.now();
  const members = ["Francesco", "Chiara", "Gonzalo", "Gualberto"];
  let n = 0;
  const task = (o) => ({
    id: String(++n),
    title: "",
    description: "",
    owner: "Francesco",
    assignees: null,
    priority: "P2",
    status: "NEXT",
    notes: "",
    subtasks: [],
    due_date: null,
    waiting_since: null,
    file_dir: null,
    done_at: null,
    project_id: null,
    pinned: false,
    recurrence: null,
    updated_at: now,
    created_at: now + n,
    ...o,
  });
  const tasks = [
    task({ title: "BU Pivot loans", description: "Aggiornamento pricing, Market Share, Check risultanze", priority: "P1", due_date: iso(-2), project_id: "p1",
      subtasks: [{ id: "s1", text: "Aggiornamento pricing", done: true }, { id: "s2", text: "Market share", done: false }] }),
    task({ title: "Retail Q3 Ambition", owner: "Chiara", assignees: ["Chiara", "Gonzalo"], priority: "P1", due_date: iso(0), pinned: true }),
    task({ title: "Report settimanale al management", owner: "Gualberto", due_date: iso(2), pinned: true,
      recurrence: { freq: "weekly", every: 1, days: [4] } }),
    task({ title: "Backup cartella condivisa", owner: "Gonzalo", priority: "P3", due_date: iso(5),
      recurrence: { freq: "monthly", every: 1 } }),
    task({ title: "Completare check vs TBD per chief dashboard", status: "IN PROGRESS", due_date: iso(3), project_id: "p1" }),
    task({ title: "Efficientare l'update dei cambi", owner: "Chiara", due_date: iso(6) }),
    task({ title: "Cambiare corporate con legal entities", priority: "P3", due_date: iso(9) }),
    task({ title: "VUB - spostare SB", owner: "Gualberto", status: "BACKLOG" }),
    task({ title: "BU_LOANS_DEPO_PIVOT_luglio_v9", priority: "P3", status: "BACKLOG" }),
    task({ title: "Integrazione DB esterno per PJT", owner: "Unassigned", priority: "P1", status: "WAITING", waiting_since: iso(-12), due_date: iso(-1) }),
    task({ title: "Chief dashboard ppt", owner: "Chiara", priority: "P4", status: "MAYBE" }),
    task({ title: "Mind Map macroambiti", priority: "P4", status: "MAYBE" }),
    task({ title: "Allineamento pricing Q4", owner: "Gonzalo", priority: "P1", status: "IN PROGRESS", due_date: iso(1), project_id: "p2" }),
    task({ title: "Chiusura mensile novembre", owner: "Gualberto", status: "DONE", done_at: now - 2 * DAY, project_id: "p2" }),
    task({ title: "Review KPI trimestrali", owner: "Chiara", status: "DONE", done_at: now - 1 * DAY }),
    task({ title: "Presentazione board ottobre", owner: "Francesco", status: "DONE", done_at: now - 20 * DAY }),
  ];
  const projects = [
    { id: "p1", name: "Pricing 2027", items: [], created_at: now - 40 * DAY, updated_at: now, report_hidden: false,
      description: "Nuovo modello di pricing per il 2027", notes: "", owners: ["Francesco"], priority: "P1",
      start_date: iso(-30), target_date: iso(20), color: "#007AFF", board_mode: "all", task_order: [] },
    { id: "p2", name: "Chiusure contabili", items: [], created_at: now - 20 * DAY, updated_at: now, report_hidden: false,
      description: "", notes: "", owners: ["Gualberto", "Gonzalo"], priority: "P2",
      start_date: iso(-15), target_date: iso(-1), color: "#FF9500", board_mode: "sequential", task_order: [] },
  ];
  const weekly = [
    { id: "w1", bucket: "well", body: "Consegna dashboard in anticipo", created_at: now },
    { id: "w2", bucket: "blockers", body: "Attesa dati dal fornitore esterno", created_at: now + 1 },
    { id: "w3", bucket: "focus", body: "Chiudere pricing Q4", created_at: now + 2 },
  ];
  return {
    board_meta: [{ id: "main", board_name: "TEAM GTD FINALE", members, subtitle_it: "Bacheca del team", subtitle_en: "Team board", login_days: 30 }],
    tasks,
    weekly,
    projects,
    reflections: [],
    personal_notes: [],
    music_playlists: [],
  };
}

/** PostgREST filter subset: eq / neq on one column. */
function applyFilters(rows, url) {
  let out = rows;
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    const m = /^(eq|neq)\.(.*)$/.exec(v);
    if (!m) continue;
    out = out.filter((r) => (m[1] === "eq" ? String(r[k]) === m[2] : String(r[k]) !== m[2]));
  }
  return out;
}

function fakeSession() {
  const user = { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "team@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 30;
  const access_token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, exp, role: "authenticated", aud: "authenticated" })}.sig`;
  return { access_token, refresh_token: "stub-refresh", token_type: "bearer", expires_in: 3600 * 24 * 30, expires_at: exp, user };
}

/**
 * Open the app on a fresh page with the given skin/appearance/blur.
 * opts: { skin: "glass"|"classic", appearance: "dark"|"light", blur: true|false,
 *         viewport: {width,height}, path: "#/board", lang: "it"|"en", me, reducedMotion, isMobile, hasTouch }
 */
export async function openApp(browser, opts = {}) {
  const { skin = "glass", appearance = "dark", blur = true, viewport = { width: 1440, height: 900 }, path = "#/board", lang = "it", me = "Francesco" } = opts;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: opts.scale ?? 1,
    isMobile: !!opts.isMobile,
    hasTouch: !!opts.hasTouch,
    reducedMotion: opts.reducedMotion ?? "no-preference",
    colorScheme: appearance,
    ignoreHTTPSErrors: true,
  });
  const db = seed();
  const session = fakeSession();
  await context.addInitScript(
    ([session, skin, appearance, blur, lang, me]) => {
      try {
        if (sessionStorage.getItem("__stub_init")) return; // keep state across reloads within a test
        sessionStorage.setItem("__stub_init", "1");
        localStorage.setItem("gtd-session", JSON.stringify(session));
        localStorage.setItem("gtd-auth", JSON.stringify({ exp: Date.now() + 30 * 86400000 }));
        localStorage.setItem("gtd-skin", skin);
        localStorage.setItem("gtd-appearance", appearance);
        localStorage.setItem("gtd-blur", blur ? "on" : "off");
        localStorage.setItem("gtd-lang", lang);
        localStorage.setItem("gtd-me", me);
        document.cookie = `gtd-skin=${skin}; Path=/`;
        document.cookie = `gtd-appearance=${appearance}; Path=/`;
      } catch {}
    },
    [session, skin, appearance, blur, lang, me]
  );

  await context.route(`${STUB_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const json = (status, body, headers = {}) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: body === undefined ? "" : JSON.stringify(body) });
    if (method === "OPTIONS")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });

    if (url.pathname.startsWith("/auth/v1/")) {
      if (url.pathname.endsWith("/user")) return json(200, session.user);
      if (url.pathname.endsWith("/token")) return json(200, session);
      if (url.pathname.endsWith("/logout")) return json(204);
      return json(200, {});
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop();
      if (fn === "is_team_member") return json(200, true);
      if (fn === "reflection_login") return json(200, "ok");
      return json(200, null);
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.split("/").pop();
      const rows = (db[table] ??= []);
      const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
      if (method === "GET" || method === "HEAD") {
        let out = applyFilters(rows, url);
        const limit = url.searchParams.get("limit");
        if (limit) out = out.slice(0, Number(limit));
        if (single) return out.length ? json(200, out[0]) : json(406, { code: "PGRST116", message: "no rows" });
        return json(200, out, { "content-range": `0-${Math.max(out.length - 1, 0)}/${out.length}` });
      }
      const body = req.postDataJSON?.() ?? null;
      if (method === "POST") {
        const list = Array.isArray(body) ? body : [body];
        for (const r of list) {
          const i = rows.findIndex((x) => x.id === r.id);
          if (i >= 0) rows[i] = { ...rows[i], ...r };
          else rows.push(r);
        }
        return json(201, list);
      }
      if (method === "PATCH") {
        const hit = applyFilters(rows, url);
        for (const r of hit) Object.assign(r, body);
        return json(200, hit);
      }
      if (method === "DELETE") {
        const hit = new Set(applyFilters(rows, url));
        db[table] = rows.filter((r) => !hit.has(r));
        return json(200, [...hit]);
      }
    }
    return json(404, { message: "stub: unknown " + url.pathname });
  });

  // Realtime: acknowledge joins (echoing the postgres_changes bindings with
  // ids, which supabase-js checks), answer heartbeats.
  await context.routeWebSocket(/stub\.supabase\.local\/realtime/, (ws) => {
    ws.onMessage((raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Protocol 2.0.0 sends [join_ref, ref, topic, event, payload]; 1.0.0 an object.
      const arr = Array.isArray(msg);
      const [joinRef, ref, topic, event, payload] = arr ? msg : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
      const reply = (response) =>
        ws.send(JSON.stringify(arr
          ? [joinRef, ref, topic, "phx_reply", { status: "ok", response }]
          : { topic, event: "phx_reply", payload: { status: "ok", response }, ref, join_ref: joinRef }));
      if (event === "phx_join") {
        const pc = payload?.config?.postgres_changes ?? [];
        reply({ postgres_changes: pc.map((b, i) => ({ ...b, id: i + 1 })) });
      } else reply({});
    });
  });

  // Anything third-party (YouTube, fonts CDN, Netlify functions) is not needed for a UX pass.
  await context.route((u) => !/^(localhost|127\.0\.0\.1|stub\.supabase\.local|fonts\.(googleapis|gstatic)\.com)$/.test(u.hostname) || u.pathname.startsWith("/.netlify/functions/"), (r) => r.abort());

  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(APP_URL + path);
  await page.waitForSelector("main, [data-mobile-root], .m-app, nav", { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, db };
}

export const COMBOS = [
  { name: "classic", skin: "classic", appearance: "light", blur: true },
  { name: "glass-dark", skin: "glass", appearance: "dark", blur: true },
  { name: "glass-light", skin: "glass", appearance: "light", blur: true },
  { name: "glass-noblur", skin: "glass", appearance: "dark", blur: false },
];

export async function launch() {
  // In a sandbox with an HTTPS proxy (fonts.googleapis.com for Cinzel/Inter),
  // send Chromium through it too; the fake Supabase host is answered by route().
  const server = process.env.https_proxy || process.env.HTTPS_PROXY;
  return chromium.launch(server ? { proxy: { server, bypass: "localhost,127.0.0.1" } } : {});
}
