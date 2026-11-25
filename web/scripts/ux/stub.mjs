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
// PostgREST reads/writes on a tiny in-memory table store, the RPCs the board
// uses (is_team_member, reflection_login, the migration-017 subtask_*), and
// the realtime websocket (it acknowledges the channel join, so the connection
// badge reads "online"). Writes are kept for the page's lifetime.
//
// Opt-in options (the defaults behave as before: one private store per page,
// no realtime events):
//
//   const store = createStore({ missing: ["023"] });     // one fake database
//   const a = await openApp(browser, { store });          // two browsers on it:
//   const b = await openApp(browser, { store, me: "Chiara" });
//     → a write from either is broadcast as a postgres_changes event to every
//       subscribed socket on the store (the writer too, as Supabase does).
//
//   openApp(browser, { reject: (method, table, body, url) => table === "tasks" && method === "PATCH" })
//     → that write answers 403 / 42501 (row-level security). Return
//       { status, body } for any other answer, or "silent" for what RLS does
//       to an UPDATE/DELETE it filters out (204, nothing changed).
//       `ctl.reject = fn` (the returned ctl) changes it later; store.reject
//       applies to every page on the store.
//
//   openApp(browser, { missing: ["009", "013", "015", "016", "017", "023"] })
//   createStore({ missing: [...] })
//     → PostgREST as before that migration: its columns are absent from rows,
//       selects/filters naming them fail with 42703, writes naming them with
//       PGRST204, its RPCs answer 404 PGRST202. (015 implies 016.)
//
//   openApp(browser, { delayMs: 300, jitterMs: 200 })  (or ctl.* / store.*)
//     → writes are answered after that delay, plus a random 0..jitter, so
//       parallel requests can land out of order (handy for races).
//
//   await goOffline(app, true) / goOffline(app, false)    (app = openApp's result)
//     → the browser goes offline (context.setOffline) AND the fake host stops
//       answering: REST calls fail as a network error and the realtime socket
//       is closed and refused, as a real dropped connection would be
//       (context.route and routeWebSocket otherwise answer even offline).
//
// The fake database also enforces tasks.project_id → projects(id) (23503) and
// "on delete set null", the board_mode check, a duplicate id on INSERT (23505)
// and Prefer: resolution=merge-duplicates / ignore-duplicates on upserts.
//
// openApp returns { context, page, db, store, ctl }; store.log lists every
// write ({ ctx, method, table, body, status }).
// -----------------------------------------------------------------------------

import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

export const STUB_HOST = "http://stub.supabase.local";
export const APP_URL = process.env.APP_URL ?? "http://localhost:5199/";

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

export function seed() {
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

// ---- Migrations the fake database can be "before" -----------------------------

export const MIGRATION_COLUMNS = {
  "009": { tasks: ["assignees"] },
  "013": { projects: ["report_hidden"] },
  "015": { projects: ["description", "notes", "owners", "priority", "start_date", "target_date", "color"], tasks: ["project_id"] },
  "016": { projects: ["board_mode", "task_order"] },
  "023": { tasks: ["pinned", "recurrence"] },
};
export const MIGRATION_RPCS = {
  "017": ["subtask_add", "subtask_update", "subtask_delete", "subtask_reorder"],
};
// Column defaults the database fills on insert (when the column exists).
const DEFAULTS = {
  tasks: { description: "", notes: "", subtasks: [], assignees: null, due_date: null, waiting_since: null, file_dir: null, done_at: null, project_id: null, pinned: false, recurrence: null },
  projects: { items: [], report_hidden: false, description: "", notes: "", owners: [], priority: "P2", start_date: null, target_date: null, color: "", board_mode: "all", task_order: [] },
};

function normMissing(list) {
  const set = new Set((list ?? []).map((m) => String(m).padStart(3, "0")));
  if (set.has("015")) set.add("016"); // 016 needs 015
  return set;
}

function missingColumns(missing) {
  const out = {};
  for (const m of missing)
    for (const [table, cols] of Object.entries(MIGRATION_COLUMNS[m] ?? {})) {
      out[table] ??= new Set();
      cols.forEach((c) => out[table].add(c));
    }
  return out;
}

/**
 * One fake database, shareable between several openApp() pages.
 * opts: { missing: ["023", ...], reject, delayMs, realtimeDelayMs, db }
 */
export function createStore(opts = {}) {
  const missing = normMissing(opts.missing);
  const gone = missingColumns(missing);
  const db = opts.db ?? seed();
  for (const [table, cols] of Object.entries(gone)) for (const r of db[table] ?? []) for (const c of cols) delete r[c];
  const missingRpc = new Set([...missing].flatMap((m) => MIGRATION_RPCS[m] ?? []));
  return {
    db,
    missing,
    gone,
    missingRpc,
    reject: opts.reject ?? null,
    delayMs: opts.delayMs ?? 0,
    jitterMs: opts.jitterMs ?? 0,
    realtimeDelayMs: opts.realtimeDelayMs ?? 30,
    subs: new Set(), // realtime subscribers: { send, topic, bindings: [{ id, table, event }], arr }
    log: [],
    /** Broadcast a change as Supabase realtime would (called by every write). */
    broadcast(table, type, record, oldRecord) {
      const msgs = [];
      for (const s of this.subs) {
        const ids = s.bindings
          .filter((b) => (b.table === table || b.table === "*" || !b.table) && (b.event === "*" || String(b.event).toUpperCase() === type))
          .map((b) => b.id);
        if (!ids.length) continue;
        const payload = {
          ids,
          data: { schema: "public", table, commit_timestamp: new Date().toISOString(), type, columns: [], record: type === "DELETE" ? null : clone(record), old_record: oldRecord ? clone(oldRecord) : null, errors: null },
        };
        msgs.push([s, payload]);
      }
      if (!msgs.length) return;
      setTimeout(() => {
        for (const [s, payload] of msgs) {
          if (!this.subs.has(s)) continue;
          try {
            s.send(s.arr ? [null, null, s.topic, "postgres_changes", payload] : { topic: s.topic, event: "postgres_changes", payload, ref: null });
          } catch {}
        }
      }, this.realtimeDelayMs);
    },
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---- Fake PostgREST -------------------------------------------------------------

class PgError extends Error {
  constructor(status, body) {
    super(body?.message);
    this.status = status;
    this.body = body;
  }
}
const pgErr = (status, code, message, extra = {}) => new PgError(status, { code, details: null, hint: null, message, ...extra });

function checkColumns(store, table, cols, kind) {
  const gone = store.gone[table];
  if (!gone) return;
  for (const c of cols) {
    if (!gone.has(c)) continue;
    if (kind === "write") throw pgErr(400, "PGRST204", `Could not find the '${c}' column of '${table}' in the schema cache`);
    throw pgErr(400, "42703", `column ${table}.${c} does not exist`);
  }
}

/** Split a PostgREST list on top-level commas: "a,b,in.(x,y)". */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function applyFilters(store, table, rows, url) {
  let out = rows;
  for (const [k, v] of url.searchParams) {
    if (RESERVED.has(k)) continue;
    checkColumns(store, table, [k], "read");
    const m = /^(not\.)?(eq|neq|in|is|gt|gte|lt|lte|like|ilike)\.(.*)$/s.exec(v);
    if (!m) continue;
    const [, not, op, raw] = m;
    const test = (r) => {
      const val = r[k];
      switch (op) {
        case "eq": return String(val) === raw;
        case "neq": return String(val) !== raw;
        case "in": return splitTop(raw.replace(/^\(|\)$/g, "")).map((x) => x.replace(/^"|"$/g, "")).includes(String(val));
        case "is": return raw === "null" ? val == null : String(val) === raw;
        case "gt": return val > (isNaN(+raw) ? raw : +raw);
        case "gte": return val >= (isNaN(+raw) ? raw : +raw);
        case "lt": return val < (isNaN(+raw) ? raw : +raw);
        case "lte": return val <= (isNaN(+raw) ? raw : +raw);
        case "like":
        case "ilike": {
          const re = new RegExp("^" + raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*") + "$", op === "ilike" ? "i" : "");
          return re.test(String(val ?? ""));
        }
      }
      return true;
    };
    out = out.filter((r) => (not ? !test(r) : test(r)));
  }
  return out;
}

function applyOrder(store, table, rows, url) {
  const o = url.searchParams.get("order");
  if (!o) return rows;
  const keys = splitTop(o).map((p) => {
    const [col, ...mods] = p.split(".");
    return { col, desc: mods.includes("desc") };
  });
  checkColumns(store, table, keys.map((k) => k.col), "read");
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const x = a[col], y = b[col];
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = x < y ? -1 : 1;
      return desc ? -c : c;
    }
    return 0;
  });
}

function project(store, table, rows, url) {
  const sel = url.searchParams.get("select");
  if (!sel || sel.trim() === "*") return rows.map(clone);
  const cols = splitTop(sel).map((c) => c.split(":").pop().split("::")[0]);
  if (cols.includes("*")) return rows.map(clone);
  checkColumns(store, table, cols, "read");
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, clone(r[c] ?? null)])));
}

function prefer(req) {
  const p = (req.headers()["prefer"] ?? "").toLowerCase();
  return {
    representation: p.includes("return=representation"),
    merge: p.includes("resolution=merge-duplicates"),
    ignore: p.includes("resolution=ignore-duplicates"),
  };
}

function withDefaults(store, table, row) {
  const d = DEFAULTS[table];
  if (!d) return { ...row };
  const gone = store.gone[table] ?? new Set();
  const out = {};
  for (const [k, v] of Object.entries(d)) if (!gone.has(k)) out[k] = clone(v);
  return { ...out, ...row };
}

function checkConstraints(table, row, store) {
  // tasks.project_id references projects(id) (migration 015)
  if (table === "tasks" && row.project_id != null && store && !store.gone.tasks?.has("project_id") && !(store.db.projects ?? []).some((p) => p.id === row.project_id))
    throw pgErr(409, "23503", 'insert or update on table "tasks" violates foreign key constraint "tasks_project_id_fkey"', { details: `Key (project_id)=(${row.project_id}) is not present in table "projects".` });
  if (table === "projects" && "board_mode" in row && !["all", "sequential", "none"].includes(row.board_mode))
    throw pgErr(400, "23514", 'new row for relation "projects" violates check constraint "projects_board_mode_check"');
  if (table === "tasks" && "pinned" in row && row.pinned === null)
    throw pgErr(400, "23502", 'null value in column "pinned" of relation "tasks" violates not-null constraint');
}

function rpc(store, fn, args) {
  if (store.missingRpc.has(fn))
    throw pgErr(404, "PGRST202", `Could not find the function public.${fn}(${Object.keys(args ?? {}).sort().join(", ")}) in the schema cache`, {
      hint: null,
      details: "Searched for the function public." + fn + " with parameters " + Object.keys(args ?? {}).sort().join(", "),
    });
  const tasks = store.db.tasks;
  const touch = (task, subtasks) => {
    const old = { id: task.id };
    task.subtasks = subtasks;
    task.updated_at = Date.now();
    store.broadcast("tasks", "UPDATE", task, old);
  };
  const find = () => tasks.find((t) => t.id === args.p_task);
  switch (fn) {
    case "is_team_member":
      return true;
    case "reflection_login":
      return "ok";
    case "subtask_add": {
      const t = find();
      if (!t) return null;
      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (subs.some((s) => s.id === args.p_subtask?.id)) return null;
      touch(t, [...subs, args.p_subtask]);
      return null;
    }
    case "subtask_update": {
      const t = find();
      if (!t) return null;
      const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
      touch(t, (t.subtasks ?? []).map((s) => (s.id === args.p_id ? strip({ ...s, ...args.p_patch }) : s)));
      return null;
    }
    case "subtask_delete": {
      const t = find();
      if (!t) return null;
      touch(t, (t.subtasks ?? []).filter((s) => s.id !== args.p_id));
      return null;
    }
    case "subtask_reorder": {
      const t = find();
      if (!t) return null;
      const pos = new Map((args.p_ids ?? []).map((id, i) => [id, i]));
      const subs = (t.subtasks ?? []).map((s, i) => [s, pos.has(s.id) ? pos.get(s.id) : 1e6 + i]);
      touch(t, subs.sort((a, b) => a[1] - b[1]).map((x) => x[0]));
      return null;
    }
  }
  return null;
}

/** Answer one PostgREST request against the store: { status, body, headers }. */
function handleRest(store, req, url, method) {
  const json = (status, body, headers = {}) => ({ status, body, headers });
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const fn = url.pathname.split("/").pop();
    const args = req.postDataJSON?.() ?? Object.fromEntries(url.searchParams);
    return json(200, rpc(store, fn, args));
  }
  const table = url.pathname.split("/").pop();
  const rows = (store.db[table] ??= []);
  const accept = req.headers()["accept"] ?? "";
  const single = accept.includes("vnd.pgrst.object");
  const pref = prefer(req);

  if (method === "GET" || method === "HEAD") {
    let out = applyFilters(store, table, rows, url);
    out = applyOrder(store, table, out, url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    out = out.slice(offset, limit ? offset + Number(limit) : undefined);
    out = project(store, table, out, url);
    if (single) return out.length === 1 ? json(200, out[0]) : json(406, { code: "PGRST116", details: `The result contains ${out.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
    return json(200, out, { "content-range": `${out.length ? offset : "*"}-${Math.max(offset + out.length - 1, 0)}/${out.length}` });
  }

  const body = req.postDataJSON?.() ?? null;
  if (method === "POST") {
    const list = (Array.isArray(body) ? body : [body]).filter(Boolean);
    const cols = new Set(list.flatMap((r) => Object.keys(r)));
    const colParam = url.searchParams.get("columns");
    if (colParam) splitTop(colParam.replace(/"/g, "")).forEach((c) => cols.add(c));
    checkColumns(store, table, [...cols], "write");
    const key = url.searchParams.get("on_conflict") ?? "id";
    // All or nothing, like one INSERT statement.
    const plan = list.map((r) => {
      const i = rows.findIndex((x) => String(x[key]) === String(r[key]));
      if (i >= 0 && !pref.merge && !pref.ignore)
        throw pgErr(409, "23505", `duplicate key value violates unique constraint "${table}_pkey"`, { details: `Key (${key})=(${r[key]}) already exists.` });
      const next = i >= 0 ? { ...rows[i], ...r } : withDefaults(store, table, r);
      checkConstraints(table, next, store);
      return { i, r, next };
    });
    const written = [];
    for (const { i, next } of plan) {
      if (i >= 0 && pref.ignore) continue;
      if (i >= 0) {
        rows[i] = next;
        store.broadcast(table, "UPDATE", next, { id: next.id });
      } else {
        rows.push(next);
        store.broadcast(table, "INSERT", next, null);
      }
      written.push(next);
    }
    return pref.representation ? json(201, project(store, table, written, url)) : json(201, undefined);
  }
  if (method === "PATCH") {
    checkColumns(store, table, Object.keys(body ?? {}), "write");
    const hit = applyFilters(store, table, rows, url);
    for (const r of hit) checkConstraints(table, { ...r, ...body }, store);
    for (const r of hit) {
      Object.assign(r, clone(body));
      store.broadcast(table, "UPDATE", r, { id: r.id });
    }
    return pref.representation ? json(200, project(store, table, hit, url)) : json(204, undefined);
  }
  if (method === "DELETE") {
    const hit = new Set(applyFilters(store, table, rows, url));
    store.db[table] = rows.filter((r) => !hit.has(r));
    for (const r of hit) store.broadcast(table, "DELETE", null, { id: r.id });
    // tasks.project_id references projects(id) on delete set null (migration 015)
    if (table === "projects" && !store.gone.tasks?.has("project_id"))
      for (const p of hit)
        for (const t of store.db.tasks ?? [])
          if (t.project_id === p.id) {
            t.project_id = null;
            store.broadcast("tasks", "UPDATE", t, { id: t.id });
          }
    return pref.representation ? json(200, [...hit].map(clone)) : json(204, undefined);
  }
  return json(405, { message: "stub: method " + method });
}

function fakeSession() {
  const user = { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "team@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 30;
  const access_token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, exp, role: "authenticated", aud: "authenticated" })}.sig`;
  return { access_token, refresh_token: "stub-refresh", token_type: "bearer", expires_in: 3600 * 24 * 30, expires_at: exp, user };
}

let ctxSeq = 0;

/**
 * Open the app on a fresh page with the given skin/appearance/blur.
 * opts: { skin: "glass"|"classic", appearance: "dark"|"light", blur: true|false,
 *         viewport: {width,height}, path: "#/board", lang: "it"|"en", me, reducedMotion, isMobile, hasTouch,
 *         store, realtime, missing, reject, delayMs, name, localStorage: {key: value} }
 * Without `store` (and without realtime: true) the page gets a private store and
 * no realtime events, as before.
 */
export async function openApp(browser, opts = {}) {
  const { skin = "glass", appearance = "dark", blur = true, viewport = { width: 1440, height: 900 }, path = "#/board", lang = "it", me = "Francesco" } = opts;
  const store = opts.store ?? createStore({ missing: opts.missing });
  const realtime = opts.realtime ?? !!opts.store;
  const ctl = { name: opts.name ?? `ctx${++ctxSeq}`, reject: opts.reject ?? null, delayMs: opts.delayMs ?? 0, jitterMs: opts.jitterMs ?? 0, offline: false, sockets: new Set() };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: opts.scale ?? 1,
    isMobile: !!opts.isMobile,
    hasTouch: !!opts.hasTouch,
    reducedMotion: opts.reducedMotion ?? "no-preference",
    colorScheme: appearance,
    ignoreHTTPSErrors: true,
  });
  const db = store.db;
  const session = fakeSession();
  await context.addInitScript(
    ([session, skin, appearance, blur, lang, me, extra]) => {
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
        for (const [k, v] of Object.entries(extra ?? {})) localStorage.setItem(k, v);
        document.cookie = `gtd-skin=${skin}; Path=/`;
        document.cookie = `gtd-appearance=${appearance}; Path=/`;
      } catch {}
    },
    [session, skin, appearance, blur, lang, me, opts.localStorage ?? {}]
  );

  await context.route(`${STUB_HOST}/**`, async (route) => {
    const req = route.request();
    if (ctl.offline) return route.abort("internetdisconnected");
    const url = new URL(req.url());
    const method = req.method();
    const reply = (status, body, headers = {}) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: body === undefined ? "" : JSON.stringify(body) });
    if (method === "OPTIONS")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });

    if (url.pathname.startsWith("/auth/v1/")) {
      if (url.pathname.endsWith("/user")) return reply(200, session.user);
      if (url.pathname.endsWith("/token")) return reply(200, session);
      if (url.pathname.endsWith("/logout")) return reply(204);
      return reply(200, {});
    }
    if (!url.pathname.startsWith("/rest/v1/")) return reply(404, { message: "stub: unknown " + url.pathname });

    const isRpc = url.pathname.startsWith("/rest/v1/rpc/");
    const isWrite = method !== "GET" && method !== "HEAD";
    const table = isRpc ? "rpc/" + url.pathname.split("/").pop() : url.pathname.split("/").pop();
    const body = isWrite ? (() => { try { return req.postDataJSON(); } catch { return null; } })() : null;
    const trivialRpc = table === "rpc/is_team_member" || table === "rpc/reflection_login";
    if (isWrite && !trivialRpc) {
      const jitter = ctl.jitterMs || store.jitterMs || 0;
      const delay = (ctl.delayMs || store.delayMs || 0) + Math.random() * jitter;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      for (const fn of [ctl.reject, store.reject]) {
        if (!fn) continue;
        const verdict = fn(method, table, body, url);
        if (!verdict) continue;
        store.log.push({ ctx: ctl.name, method, table, body, status: "rejected" });
        if (verdict === "silent") return reply(204);
        if (typeof verdict === "object") return reply(verdict.status ?? 400, verdict.body ?? { message: "rejected" });
        return reply(403, { code: "42501", details: null, hint: null, message: `new row violates row-level security policy for table "${table}"` });
      }
    }
    try {
      const res = handleRest(store, req, url, method);
      if (isWrite && !trivialRpc) store.log.push({ ctx: ctl.name, method, table, body, url: url.search, status: res.status });
      return reply(res.status, res.body, res.headers);
    } catch (e) {
      if (e instanceof PgError) {
        if (isWrite && !trivialRpc) store.log.push({ ctx: ctl.name, method, table, body, url: url.search, status: e.status, error: e.body });
        return reply(e.status, e.body);
      }
      console.error("[stub]", e);
      return reply(500, { code: "XX000", message: String(e?.message ?? e) });
    }
  });

  // Realtime: acknowledge joins (echoing the postgres_changes bindings with
  // ids, which supabase-js checks), answer heartbeats; with a shared store,
  // push every write to the subscribed sockets as postgres_changes.
  await context.routeWebSocket(/stub\.supabase\.local\/realtime/, (ws) => {
    if (ctl.offline) return void ws.close({ code: 4000, reason: "offline" });
    ctl.sockets.add(ws);
    const mine = new Map(); // topic -> subscriber
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
        const bindings = pc.map((b, i) => ({ ...b, id: i + 1 }));
        reply({ postgres_changes: bindings });
        if (realtime) {
          const old = mine.get(topic);
          if (old) store.subs.delete(old);
          const sub = { ctx: ctl.name, topic, arr, bindings, send: (m) => ws.send(JSON.stringify(m)) };
          mine.set(topic, sub);
          store.subs.add(sub);
        }
      } else if (event === "phx_leave") {
        const old = mine.get(topic);
        if (old) store.subs.delete(old);
        mine.delete(topic);
        reply({});
      } else reply({});
    });
    ws.onClose(() => {
      ctl.sockets.delete(ws);
      for (const s of mine.values()) store.subs.delete(s);
      mine.clear();
    });
  });

  // Anything third-party (YouTube, fonts CDN, Netlify functions) is not needed for a UX pass.
  await context.route((u) => !/^(localhost|127\.0\.0\.1|stub\.supabase\.local|fonts\.(googleapis|gstatic)\.com)$/.test(u.hostname) || u.pathname.startsWith("/.netlify/functions/"), (r) => r.abort());

  context.on("close", () => {
    for (const s of [...store.subs]) if (s.ctx === ctl.name) store.subs.delete(s);
  });

  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(APP_URL + path);
  await page.waitForSelector("main, [data-mobile-root], .m-app, nav", { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, db, store, ctl };
}

/** Take a page opened with openApp offline (true) or back online (false). */
export async function goOffline({ context, ctl }, offline) {
  ctl.offline = offline;
  await context.setOffline(offline);
  if (offline) for (const ws of [...ctl.sockets]) await ws.close({ code: 4000, reason: "offline" }).catch(() => {});
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
