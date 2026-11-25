// -----------------------------------------------------------------------------
// Functional checks for the BOARD, recurring tasks, "In evidenza", projects
// and the phone layout, driven in Chromium against the in-memory fake
// Supabase (stub.mjs). Prints PASS / FAIL per check; exit code 1 on a FAIL.
//
//   (dev server on :5199 pointed at http://stub.supabase.local, see stub.mjs)
//   NODE_PATH=<dir with playwright>/node_modules node scripts/ux/functional-board.mjs [filter]
//
// `filter` runs only the sections whose name contains it (e.g. "recurring").
// -----------------------------------------------------------------------------

import { launch, openApp, createStore, seed } from "./stub.mjs";

const only = process.argv[2] ?? "";
const results = [];
const DAY = 86400000;

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : detail && process.env.VERBOSE ? `  (${detail})` : ""}`);
}
async function waitFor(fn, timeout = 4000, step = 100) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, step));
  }
  try { return await fn(); } catch { return v; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Dates (local, like the app) ----------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const rel = (n) => isoOf(addD(today, n));
const weekday = (d) => (d.getDay() + 6) % 7; // 0 = Monday
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

// ---- Data -----------------------------------------------------------------------
let tid = 100;
function row(o) {
  const now = Date.now();
  return {
    id: String(++tid), title: "", description: "", owner: "Francesco", assignees: null, priority: "P2", status: "NEXT",
    notes: "", subtasks: [], due_date: null, waiting_since: null, file_dir: null, done_at: null, project_id: null,
    pinned: false, recurrence: null, updated_at: now - 5000, created_at: now - 100000 + tid, ...o,
  };
}
/** The seed's meta and projects with only these tasks. */
function dbWith(tasks, { projects } = {}) {
  const db = seed();
  db.tasks = tasks;
  if (projects) db.projects = projects;
  return db;
}

// ---- Page helpers ---------------------------------------------------------------
const boardCard = (page, title) =>
  page.locator(".task-card").filter({ hasText: title }).filter({ hasNot: page.locator("xx") });

/** Column (status label) each card with this title sits in, outside the band / bars. */
async function columnsOf(page, title) {
  return page.evaluate((title) => {
    const out = [];
    for (const c of document.querySelectorAll(".task-card")) {
      if (c.closest("section.pin-band, #board-done-panel, #board-archive-panel")) continue;
      if (!(c.textContent ?? "").includes(title)) continue;
      const col = c.closest('div[style*="min-height"]');
      out.push(col?.querySelector(".font-trajan")?.textContent?.trim() ?? "?");
    }
    return out;
  }, title);
}
async function bandTitles(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("section.pin-band .task-card .card-head")].map((e) => e.textContent?.trim() ?? "")
  );
}
const toastUndo = (page) => page.locator("[role=status] button", { hasText: /^(Annulla|Undo)$/ });
async function toastText(page) {
  return page.evaluate(() => [...document.querySelectorAll("[role=status]")].map((e) => e.textContent).join(" | "));
}
/** The round check of the card in the board columns. */
async function clickCheck(page, title) {
  const c = page.locator(".task-card").filter({ hasText: title }).first();
  await c.locator("button").first().click();
}
async function openCard(page, title) {
  const c = page.locator(".task-card").filter({ has: page.locator(".card-head", { hasText: title }) }).first();
  await c.locator(".card-head").click();
  return page.locator(".task-card.is-open").first();
}

const sv = (db, id) => db.tasks.find((t) => t.id === id);

/** HTML5 drag of a board card onto a target, one event per step (React state settles between). */
async function synthDrag(page, title, targetSel, { inBand = false } = {}) {
  await page.evaluate(([title, inBand]) => {
    window.__dt = new DataTransfer();
    window.__card = [...document.querySelectorAll(".task-card")].find((c) => (c.textContent ?? "").includes(title) && !!c.closest("section.pin-band") === inBand);
    window.__card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dt }));
  }, [title, inBand]);
  await sleep(80);
  await page.evaluate((sel) => {
    const t = sel.startsWith("col:")
      ? [...document.querySelectorAll('div[style*="min-height"]')].find((c) => c.querySelector(".font-trajan")?.textContent?.trim() === sel.slice(4))
      : document.querySelector(sel);
    window.__target = t;
    t.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    t.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
  }, targetSel);
  await sleep(80);
  await page.evaluate(() => {
    window.__target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    window.__card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: window.__dt }));
  });
  await sleep(150);
}

// =================================================================================
const sections = [];
const section = (name, fn) => sections.push({ name, fn });

// ---- Recurring: next occurrence -------------------------------------------------
section("recurring.next", async (browser) => {
  const subs = [{ id: "a", text: "uno", done: true, doneAt: Date.now() }, { id: "b", text: "due", done: false }];
  const early = row({ title: "Rec early weekly", due_date: rel(2), recurrence: { freq: "weekly", every: 1 }, subtasks: subs, pinned: true });
  const late = row({ title: "Rec late daily", due_date: rel(-5), recurrence: { freq: "daily", every: 1 } });
  const nodue = row({ title: "Rec nodue monthly", recurrence: { freq: "monthly", every: 1 } });
  // Feriali, due on the next Friday
  const fri = addD(today, ((4 - weekday(today)) + 7) % 7 || 7);
  const feriali = row({ title: "Rec feriali", due_date: isoOf(fri), recurrence: { freq: "weekly", every: 1, days: [0, 1, 2, 3, 4] } });
  // Weekly on Mon + Thu, due a Monday in the future
  const mon = addD(today, ((0 - weekday(today)) + 7) % 7 || 7);
  const monthu = row({ title: "Rec lun gio", due_date: isoOf(mon), recurrence: { freq: "weekly", every: 1, days: [0, 3] } });
  const y = today.getFullYear() + 1;
  const m31 = row({ title: "Rec mese 31", due_date: `${y}-01-31`, recurrence: { freq: "monthly", every: 1 } });
  const store = createStore({ db: dbWith([early, late, nodue, feriali, monthu, m31]) });
  const { page, context } = await openApp(browser, { store, name: "rec" });

  // ↻ chip
  const chip = await page.locator(".task-card", { hasText: "Rec feriali" }).first().textContent();
  check("recurring: ↻ chip says the rule (Feriali)", /feriali/i.test(chip ?? ""), chip);
  const chip2 = await page.locator(".task-card", { hasText: "Rec lun gio" }).first().textContent();
  check("recurring: ↻ chip lists weekdays (lun, gio)", /lun, gio/.test(chip2 ?? ""), chip2);

  // early
  await clickCheck(page, "Rec early weekly");
  const nextEarly = `${early.id}@${isoOf(addD(parse(early.due_date), 7))}`;
  await waitFor(() => sv(store.db, nextEarly));
  const n1 = sv(store.db, nextEarly);
  check("recurring: done early → next due the date after its due date", !!n1, `expected id ${nextEarly}; tasks: ${store.db.tasks.map((t) => t.id).join(",")}`);
  check("recurring: completed occurrence stays in DONE", sv(store.db, early.id)?.status === "DONE");
  if (n1) {
    check("recurring: next occurrence is in Next", n1.status === "NEXT", n1.status);
    check("recurring: next occurrence has subtasks unticked", n1.subtasks.every((s) => s.done === false && !("doneAt" in s)), JSON.stringify(n1.subtasks));
    check("recurring: next occurrence keeps ★ and the series", n1.pinned === true && n1.recurrence?.series === early.id, JSON.stringify(n1.recurrence));
  }
  const tt = await toastText(page);
  check("recurring: toast says when the next one is due", /prossima il/.test(tt), tt);
  await sleep(300);
  check("recurring: next occurrence card appears in Next", (await columnsOf(page, "Rec early weekly")).includes("Next"));

  // late
  await clickCheck(page, "Rec late daily");
  const nextLate = `${late.id}@${rel(1)}`;
  check("recurring: done late → first date after today", !!(await waitFor(() => sv(store.db, nextLate))), `expected ${nextLate}; got ${store.db.tasks.filter((t) => t.id.startsWith(late.id + "@")).map((t) => t.id)}`);

  // no due
  await clickCheck(page, "Rec nodue monthly");
  const nm = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate()));
  const nextNo = `${nodue.id}@${isoOf(nm)}`;
  check("recurring: no due date → counted from today", !!(await waitFor(() => sv(store.db, nextNo))), `expected ${nextNo}; got ${store.db.tasks.filter((t) => t.id.startsWith(nodue.id + "@")).map((t) => t.id)}`);

  // feriali: Friday → Monday
  await clickCheck(page, "Rec feriali");
  const nextFer = `${feriali.id}@${isoOf(addD(fri, 3))}`;
  check("recurring: Feriali, done on Friday's occurrence → next Monday", !!(await waitFor(() => sv(store.db, nextFer))), `expected ${nextFer}; got ${store.db.tasks.filter((t) => t.id.startsWith(feriali.id + "@")).map((t) => t.id)}`);

  // Mon+Thu: Monday → Thursday
  await clickCheck(page, "Rec lun gio");
  const nextMT = `${monthu.id}@${isoOf(addD(mon, 3))}`;
  check("recurring: weekly lun+gio, Monday → Thursday", !!(await waitFor(() => sv(store.db, nextMT))), `expected ${nextMT}`);

  // monthly on the 31st: Jan 31 → Feb 28/29 → Mar 31
  await clickCheck(page, "Rec mese 31");
  const feb = `${y}-02-${new Date(y, 2, 0).getDate()}`;
  const id2 = `${m31.id}@${feb}`;
  check("recurring: monthly on the 31st → last day of February", !!(await waitFor(() => sv(store.db, id2))), `expected ${id2}; got ${store.db.tasks.filter((t) => t.id.startsWith(m31.id)).map((t) => t.id)}`);
  await sleep(400);
  // complete the February occurrence (the one still in Next)
  await page.evaluate(() => 0);
  const febCard = page.locator(".task-card").filter({ hasText: "Rec mese 31" }).filter({ has: page.locator('button[aria-label="Segna come fatta"]') }).first();
  await febCard.locator('button[aria-label="Segna come fatta"]').click();
  await sleep(600);
  const marchIds = store.db.tasks.filter((t) => t.id.startsWith(`${m31.id}@${y}-03`)).map((t) => t.id);
  check("recurring: monthly on the 31st keeps its day (Feb → Mar 31)", marchIds.includes(`${m31.id}@${y}-03-31`), `got ${marchIds.join(",")}`);
  await context.close();
});

// ---- Recurring: Undo / Reopen ---------------------------------------------------
section("recurring.undo", async (browser) => {
  const a = row({ title: "Rec undo A", due_date: rel(1), recurrence: { freq: "weekly", every: 1 } });
  const b = row({ title: "Rec reopen B", due_date: rel(1), recurrence: { freq: "daily", every: 1 } });
  const c = row({ title: "Rec touched C", due_date: rel(1), recurrence: { freq: "daily", every: 1 } });
  const store = createStore({ db: dbWith([a, b, c]) });
  const { page, context } = await openApp(browser, { store, name: "undo" });

  await clickCheck(page, "Rec undo A");
  const nA = `${a.id}@${rel(8)}`;
  await waitFor(() => sv(store.db, nA));
  await toastUndo(page).click();
  await sleep(600);
  check("recurring Undo: original back in Next", sv(store.db, a.id)?.status === "NEXT", sv(store.db, a.id)?.status);
  check("recurring Undo: next occurrence taken back (server)", !sv(store.db, nA), store.db.tasks.map((t) => t.id).join(","));
  check("recurring Undo: only one card left on the board", (await columnsOf(page, "Rec undo A")).length === 1, JSON.stringify(await columnsOf(page, "Rec undo A")));

  // Reopen later from the Done column
  await clickCheck(page, "Rec reopen B");
  const nB = `${b.id}@${rel(2)}`;
  await waitFor(() => sv(store.db, nB));
  await sleep(300);
  await page.locator(".task-card").filter({ hasText: "Rec reopen B" }).locator('button[aria-label="Riapri"]').first().click();
  await sleep(600);
  check("recurring Reopen: untouched next occurrence taken back", !sv(store.db, nB));

  // Somebody changed the next one → Reopen keeps it
  await clickCheck(page, "Rec touched C");
  const nC = `${c.id}@${rel(2)}`;
  await waitFor(() => sv(store.db, nC));
  await sleep(300);
  // a teammate edits the next occurrence (priority) in a second browser
  const other = await openApp(browser, { store, name: "undo-2", me: "Chiara" });
  await openCard(other.page, "Rec touched C").catch(() => {});
  const open2 = other.page.locator(".task-card.is-open").first();
  await open2.locator("button", { hasText: /^P1$/ }).click();
  await waitFor(() => sv(store.db, nC)?.priority === "P1");
  await sleep(500);
  await page.locator(".task-card").filter({ hasText: "Rec touched C" }).locator('button[aria-label="Riapri"]').first().click();
  await sleep(600);
  check("recurring Reopen: next occurrence someone changed is kept", !!sv(store.db, nC) && sv(store.db, c.id)?.status === "NEXT");
  await other.context.close();
  await context.close();
});

// ---- Recurring: two people complete at once -------------------------------------
section("recurring.race", async (browser) => {
  const r = row({ title: "Rec race", due_date: rel(0), recurrence: { freq: "weekly", every: 1 }, subtasks: [{ id: "x", text: "x", done: true }] });
  const store = createStore({ db: dbWith([r]), delayMs: 250 });
  const A = await openApp(browser, { store, name: "raceA" });
  const B = await openApp(browser, { store, name: "raceB", me: "Chiara" });
  await Promise.all([clickCheck(A.page, "Rec race"), clickCheck(B.page, "Rec race")]);
  await sleep(1500);
  const next = store.db.tasks.filter((t) => t.id.startsWith(`${r.id}@`));
  check("recurring race: exactly one next row on the server", next.length === 1, next.map((t) => t.id).join(","));
  const errs = store.log.filter((l) => l.table === "tasks" && l.status >= 400);
  check("recurring race: no write refused", errs.length === 0, JSON.stringify(errs.map((e) => e.error)));
  const ca = await columnsOf(A.page, "Rec race");
  const cb = await columnsOf(B.page, "Rec race");
  check("recurring race: each browser shows one next + one done", ca.filter((x) => x === "Next").length === 1 && cb.filter((x) => x === "Next").length === 1, `A ${ca} | B ${cb}`);
  await A.context.close();
  await B.context.close();
});

// ---- Recurring: editor controls -------------------------------------------------
section("recurring.editor", async (browser) => {
  const t1 = row({ title: "Plain task", due_date: rel(3) });
  const store = createStore({ db: dbWith([t1]) });
  const { page, context } = await openApp(browser, { store, name: "ed" });
  const card = await openCard(page, "Plain task");
  await card.locator("select").filter({ has: page.locator("option", { hasText: "Ogni settimana" }) }).selectOption("weekly");
  await waitFor(() => sv(store.db, t1.id)?.recurrence?.freq === "weekly");
  check("editor Ripeti: weekly saved", sv(store.db, t1.id)?.recurrence?.freq === "weekly", JSON.stringify(sv(store.db, t1.id)?.recurrence));
  await card.locator("button", { hasText: "Feriali" }).click();
  await waitFor(() => sv(store.db, t1.id)?.recurrence?.days?.length === 5);
  check("editor Feriali: Mon–Fri saved", JSON.stringify(sv(store.db, t1.id)?.recurrence?.days) === "[0,1,2,3,4]", JSON.stringify(sv(store.db, t1.id)?.recurrence));
  const txt = await card.textContent();
  check("editor shows the next date", /Prossima:/.test(txt ?? ""));
  // every N
  const every = card.locator('input[type="number"]');
  await every.fill("2");
  await waitFor(() => sv(store.db, t1.id)?.recurrence?.every === 2);
  check("editor Ogni N: every 2 saved", sv(store.db, t1.id)?.recurrence?.every === 2, JSON.stringify(sv(store.db, t1.id)?.recurrence));
  // ★
  await card.locator("button", { hasText: "Metti in evidenza" }).click();
  await waitFor(() => sv(store.db, t1.id)?.pinned === true);
  check("editor ★: pinned saved", sv(store.db, t1.id)?.pinned === true);
  await sleep(300);
  check("editor ★: task appears in the In evidenza band", (await bandTitles(page)).some((x) => x.includes("Plain task")) || (await page.locator("section.pin-band").textContent()).includes("Plain task"));
  // Never
  await card.locator("select").filter({ has: page.locator("option", { hasText: "Ogni settimana" }) }).selectOption("");
  await waitFor(() => sv(store.db, t1.id)?.recurrence === null);
  check("editor Ripeti → Mai clears the rule", sv(store.db, t1.id)?.recurrence === null, JSON.stringify(sv(store.db, t1.id)?.recurrence));
  await context.close();
});

// ---- Refused writes (desktop) ---------------------------------------------------
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const RLS = /row-level security|non salvat|not saved|42501|errore/i;

section("refused.desktop", async (browser) => {
  // 1. Completing a task when the UPDATE is refused
  {
    const store = createStore();
    const { page, context, ctl } = await openApp(browser, { store, name: "rej1" });
    ctl.reject = (m, t) => m === "PATCH" && t === "tasks";
    await clickCheck(page, "Efficientare l'update dei cambi");
    await sleep(1500);
    check("refused done: server unchanged", sv(store.db, "6").status === "NEXT");
    check("refused done: card rolled back to Next", (await columnsOf(page, "Efficientare l'update dei cambi"))[0] === "Next", JSON.stringify(await columnsOf(page, "Efficientare")));
    const txt = await bodyText(page);
    check("refused done: the page says the change was not saved", RLS.test(txt), "no error text anywhere on the page after a 403");
    await context.close();
  }
  // 2. Recurring: the next occurrence's INSERT is refused, the completion is not
  {
    const store = createStore();
    const { page, context, ctl } = await openApp(browser, { store, name: "rej2" });
    ctl.reject = (m, t) => m === "POST" && t === "tasks";
    await clickCheck(page, "Backup cartella condivisa");
    const tt = await toastText(page);
    await sleep(1500);
    const nexts = store.db.tasks.filter((t) => t.id.startsWith("4@"));
    check("refused next-occurrence insert: completion is not left half-done", !(sv(store.db, "4").status === "DONE" && nexts.length === 0),
      `server: task 4 ${sv(store.db, "4").status}, next rows ${nexts.length}; toast said “${tt.trim()}”`);
    await context.close();
  }
  // 3. Recurring: the completion is refused but the next occurrence goes in
  {
    const store = createStore();
    const { page, context, ctl } = await openApp(browser, { store, name: "rej3" });
    ctl.reject = (m, t) => m === "PATCH" && t === "tasks";
    await clickCheck(page, "Backup cartella condivisa");
    await sleep(1500);
    const nexts = store.db.tasks.filter((t) => t.id.startsWith("4@"));
    const cols = await columnsOf(page, "Backup cartella condivisa");
    check("refused completion: no orphan next occurrence on the server", nexts.length === 0,
      `server: task 4 ${sv(store.db, "4").status} + ${nexts.map((t) => t.id)}; board shows ${cols.length} cards (${cols})`);
    await context.close();
  }
  // 4. Subtask tick refused (RPC 500)
  {
    const store = createStore();
    const { page, context, ctl } = await openApp(browser, { store, name: "rej4" });
    ctl.reject = (m, t) => (t.startsWith("rpc/subtask") ? { status: 500, body: { code: "XX000", message: "boom" } } : false);
    const card = await openCard(page, "BU Pivot loans");
    const box = card.locator('input[type="checkbox"]').nth(1);
    await box.click();
    await sleep(1500);
    check("refused subtask tick: server unchanged", sv(store.db, "1").subtasks[1].done === false);
    const checked = await page.locator(".task-card.is-open input[type=checkbox]").nth(1).isChecked().catch(() => null);
    check("refused subtask tick: checkbox rolled back", checked === false, `checked=${checked}`);
    await context.close();
  }
  // 5. Delete refused
  {
    const store = createStore();
    const { page, context, ctl } = await openApp(browser, { store, name: "rej5" });
    ctl.reject = (m, t) => m === "DELETE" && t === "tasks";
    const card = await openCard(page, "Mind Map macroambiti");
    await card.locator("button", { hasText: /^Elimina$/ }).click();
    await card.locator("button", { hasText: /^Sì$/ }).click();
    await sleep(1500);
    check("refused delete: task still on the server", !!sv(store.db, "12"));
    check("refused delete: card comes back", (await columnsOf(page, "Mind Map macroambiti")).length === 1);
    await context.close();
  }
});

// ---- In evidenza band -----------------------------------------------------------
section("band", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "band" });
  const band = page.locator("section.pin-band");
  let titles = await bandTitles(page);
  check("band: shows the seeded highlighted tasks (2)", titles.length === 2, titles.join(" / "));
  const bt = await band.textContent();
  check("band: recurring ones grouped apart", /Ricorrenti · 1/.test(bt) && /Attività · 1/.test(bt), bt.slice(0, 200));
  check("band: highlighted cards also stay in their column", (await columnsOf(page, "Retail Q3 Ambition")).length === 1);

  // Filters apply
  await page.getByLabel("Cerca attività…").fill("Retail");
  await sleep(200);
  titles = await bandTitles(page);
  check("band: search filter applies to the band", titles.length === 1 && titles[0].includes("Retail"), titles.join(" / "));
  await page.getByLabel("Cerca attività…").fill("zzzz-nothing");
  await sleep(200);
  const emptyTxt = await band.textContent();
  check("band: with filters hiding all highlighted tasks the band does not claim it is empty", !/Trascina qui/.test(emptyTxt), emptyTxt);
  const nm = await page.locator("[role=status]", { hasText: "Nessuna attività corrisponde" }).count();
  check("board: “no match” notice with a reset button", nm === 1);
  await page.locator("button", { hasText: "Azzera filtri" }).first().click();
  await sleep(200);
  check("board: reset filters brings the band back", (await bandTitles(page)).length === 2);
  await page.getByLabel("Membro", { exact: false }).first().selectOption("Gualberto").catch(async () => {
    await page.locator("select").filter({ has: page.locator("option", { hasText: "Tutti i membri" }) }).first().selectOption("Gualberto");
  });
  await sleep(200);
  titles = await bandTitles(page);
  check("band: owner filter applies to the band", titles.length === 1 && titles[0].includes("Report settimanale"), titles.join(" / "));
  await page.locator("button", { hasText: "Azzera filtri" }).first().click();

  // Drag a card onto the band (synthetic HTML5 DnD: the band is off-screen from the card)
  await synthDrag(page, "Efficientare l'update dei cambi", "section.pin-band");
  await waitFor(() => sv(store.db, "6").pinned === true, 2500);
  check("band: dragging a card onto the band highlights it", sv(store.db, "6").pinned === true);
  await sleep(200);
  check("band: dragged card now in the band", (await bandTitles(page)).some((x) => x.includes("Efficientare")));

  // DONE leaves the band
  await page.locator("section.pin-band .task-card").filter({ hasText: "Retail Q3 Ambition" }).locator("button").first().click();
  await sleep(400);
  check("band: a highlighted task marked DONE leaves the band", !(await bandTitles(page)).some((x) => x.includes("Retail")));

  // New-task bar ★ and Ripeti
  await page.getByLabel("Nuova attività…").fill("QA new pinned weekly");
  await page.locator('button[aria-label="Metti in evidenza"]').first().click();
  await page.getByLabel("Ripeti").first().selectOption("weekly");
  await page.getByLabel("Nuova attività…").press("Enter");
  const created = await waitFor(() => store.db.tasks.find((t) => t.title === "QA new pinned weekly"));
  check("new-task bar: ★ saved", created?.pinned === true, JSON.stringify(created && { pinned: created.pinned }));
  check("new-task bar: Ripeti saved", created?.recurrence?.freq === "weekly", JSON.stringify(created?.recurrence));
  await sleep(200);
  check("new-task bar: the new ★ task shows in the band", (await bandTitles(page)).some((x) => x.includes("QA new pinned weekly")));

  // collapse
  await band.locator("button[aria-expanded]").first().click();
  await sleep(150);
  check("band: collapses", (await bandTitles(page)).length === 0);
  await context.close();

  // Empty state
  const s2 = createStore();
  s2.db.tasks.forEach((t) => (t.pinned = false));
  const e = await openApp(browser, { store: s2, name: "band-empty" });
  const et = await e.page.locator("section.pin-band").textContent();
  check("band: empty state explains how to highlight", /Trascina qui/.test(et), et);
  await e.context.close();
});

// ---- Before each migration -----------------------------------------------------
const writeErrors = (store) => store.log.filter((l) => typeof l.status === "number" && l.status >= 400 && !(l.status === 404 && l.table.startsWith("rpc/subtask")));

section("migrations", async (browser) => {
  // 023: no pinned / recurrence
  {
    const store = createStore({ missing: ["023"] });
    const { page, context } = await openApp(browser, { store, name: "m023" });
    check("before 023: board loads", (await page.locator(".task-card").count()) > 5);
    check("before 023: no In evidenza band", (await page.locator("section.pin-band").count()) === 0);
    check("before 023: new-task bar hides ★ / Ripeti", (await page.locator('button[aria-label="Metti in evidenza"]').count()) === 0);
    const card = await openCard(page, "Efficientare l'update dei cambi");
    const txt = await card.textContent();
    check("before 023: task editor says to run migration 023", /migrazione 023/.test(txt));
    await card.locator("button", { hasText: /^P1$/ }).click();
    await page.getByLabel("Nuova attività…").fill("QA pre-023 task");
    await page.getByLabel("Nuova attività…").press("Enter");
    await sleep(600);
    check("before 023: edits and new tasks save (no PGRST204)", writeErrors(store).length === 0 && sv(store.db, "6").priority === "P1" && store.db.tasks.some((t) => t.title === "QA pre-023 task"), JSON.stringify(writeErrors(store).map((e) => e.error?.message)));
    await clickCheck(page, "Cambiare corporate con legal entities");
    await sleep(500);
    check("before 023: completing a task works", sv(store.db, "7").status === "DONE");
    const c2 = await openCard(page, "Mind Map macroambiti");
    await c2.locator("button", { hasText: /^Elimina$/ }).click();
    await c2.locator("button", { hasText: /^Sì$/ }).click();
    await sleep(300);
    await toastUndo(page).click();
    await sleep(600);
    check("before 023: delete + Undo restores the row", !!sv(store.db, "12") && writeErrors(store).length === 0, JSON.stringify(writeErrors(store).map((e) => e.error?.message)));
    await context.close();
    // phone
    const ph = await openApp(browser, { store: createStore({ missing: ["023"] }), name: "m023p", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, path: "#/board" });
    await ph.page.locator(".m-card", { hasText: "Efficientare" }).first().click();
    await sleep(500);
    const sheet = await ph.page.evaluate(() => document.body.innerText);
    check("before 023: phone task sheet has no Ripeti / In evidenza rows", !/Ripeti/.test(sheet) && !/In evidenza/.test(sheet));
    check("before 023: phone says what to run (README: “the controls say what to run”)", /023/.test(sheet), "the phone hides the rows and says nothing");
    await ph.context.close();
  }
  // 017: no subtask functions → whole-array fallback
  {
    const store = createStore({ missing: ["017"] });
    const { page, context } = await openApp(browser, { store, name: "m017" });
    const card = await openCard(page, "BU Pivot loans");
    await card.getByPlaceholder(/Aggiungi sotto-?attività…/).fill("QA sub");
    await card.getByPlaceholder(/Aggiungi sotto-?attività…/).press("Enter");
    await waitFor(() => sv(store.db, "1").subtasks.length === 3);
    check("before 017: add subtask falls back to the array write", sv(store.db, "1").subtasks.some((s) => s.text === "QA sub"), JSON.stringify(sv(store.db, "1").subtasks));
    await card.getByLabel("Market share").click();
    await waitFor(() => sv(store.db, "1").subtasks.find((s) => s.id === "s2")?.done === true);
    check("before 017: tick subtask falls back", sv(store.db, "1").subtasks.find((s) => s.id === "s2")?.done === true);
    check("before 017: only the first RPC is tried", store.log.filter((l) => l.table.startsWith("rpc/")).length === 1, store.log.map((l) => l.table).join(","));
    await context.close();
  }
  // 009: single assignee
  {
    const store = createStore({ missing: ["009"] });
    const { page, context } = await openApp(browser, { store, name: "m009" });
    const card = await openCard(page, "Efficientare l'update dei cambi");
    await card.locator('[id^="task-details-"] button[aria-expanded]').first().click();
    const txt = await card.textContent();
    check("before 009: assignee picker says it needs migration 009", /migration-009/.test(txt));
    await card.locator("button[aria-pressed]", { hasText: /^Gonzalo$/ }).click();
    await sleep(500);
    check("before 009: picking a person replaces the holder", sv(store.db, "6").owner === "Gonzalo" && writeErrors(store).length === 0, JSON.stringify({ owner: sv(store.db, "6").owner, errs: writeErrors(store).map((e) => e.error?.message) }));
    await page.getByLabel("Nuova attività…").fill("QA pre-009");
    await page.getByLabel("Nuova attività…").press("Enter");
    await sleep(500);
    check("before 009: new task saves", store.db.tasks.some((t) => t.title === "QA pre-009") && writeErrors(store).length === 0);
    await context.close();
  }
  // 015 (and so 016): projects have a name only
  {
    const store = createStore({ missing: ["015"] });
    const { page, context } = await openApp(browser, { store, name: "m015", path: "#/projects" });
    await sleep(500);
    const txt = await bodyText(page);
    check("before 015: Projects tab says what to run", /migration-015/.test(txt));
    await page.goto(page.url().replace(/#.*$/, "#/board"));
    await sleep(800);
    check("before 015: board shows every task (no project filtering)", (await columnsOf(page, "Allineamento pricing Q4")).length === 1);
    const card = await openCard(page, "Efficientare l'update dei cambi");
    await card.locator("button", { hasText: /^P3$/ }).click();
    await sleep(400);
    check("before 015: task edits save", sv(store.db, "6").priority === "P3" && writeErrors(store).length === 0, JSON.stringify(writeErrors(store).map((e) => e.error?.message)));
    await context.close();
  }
  // 016: board mode
  {
    const store = createStore({ missing: ["016"] });
    const { page, context } = await openApp(browser, { store, name: "m016", path: "#/projects/p2" });
    await sleep(700);
    const txt = await bodyText(page);
    check("before 016: project page says to run 016", /migration-016/.test(txt));
    const disabled = await page.locator('[role=group][aria-label="Nel BOARD"] button').evaluateAll((bs) => bs.length > 0 && bs.every((b) => b.disabled));
    check("before 016: board-mode buttons disabled", disabled);
    await page.goto(page.url().replace(/#.*$/, "#/board"));
    await sleep(800);
    check("before 016: all project tasks on the BOARD", (await columnsOf(page, "Allineamento pricing Q4")).length === 1);
    await context.close();
  }
  // 013
  {
    const store = createStore({ missing: ["013"] });
    const { page, context } = await openApp(browser, { store, name: "m013", path: "#/projects" });
    await sleep(500);
    check("before 013: projects still load", /Pricing 2027/.test(await bodyText(page)));
    await context.close();
  }
});

// ---- BOARD ----------------------------------------------------------------------
const lsGet = (page, k) => page.evaluate((k) => localStorage.getItem(k), k);

section("board.layout", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "layout" });
  const heads = await page.evaluate(() => [...document.querySelectorAll('div[style*="min-height"] > div .font-trajan')].map((e) => e.textContent.trim()));
  check("board: six columns in order", heads.join(",") === "Backlog,Next,In Progress,Waiting,Done,Maybe", heads.join(","));

  // list view, remembered
  await page.locator('[role=group] button', { hasText: /^Elenco$/ }).click();
  await sleep(300);
  check("list view: stored", (await lsGet(page, "gtd-view-mode")) === "list");
  await page.reload();
  await page.waitForSelector("main");
  await sleep(600);
  const pressed = await page.locator('[role=group] button', { hasText: /^Elenco$/ }).getAttribute("aria-pressed");
  check("list view: remembered after reload", pressed === "true");
  await page.locator('[role=group] button', { hasText: /^Bacheca$/ }).click();
  await sleep(300);

  // drag between columns
  await synthDrag(page, "Cambiare corporate con legal entities", "col:Waiting");
  await waitFor(() => sv(store.db, "7").status === "WAITING");
  check("drag to Waiting: saved with waiting_since", sv(store.db, "7").status === "WAITING" && !!sv(store.db, "7").waiting_since, JSON.stringify({ s: sv(store.db, "7").status, w: sv(store.db, "7").waiting_since }));
  check("drag to Waiting: card shown in Waiting", (await columnsOf(page, "Cambiare corporate con legal entities"))[0] === "Waiting");

  // column visibility
  await page.locator("button", { hasText: /Colonne/ }).first().click();
  await page.locator("#board-columns-panel button", { hasText: "Maybe" }).click();
  await sleep(200);
  const heads2 = await page.evaluate(() => [...document.querySelectorAll('div[style*="min-height"] > div .font-trajan')].map((e) => e.textContent.trim()));
  check("columns editor: hides Maybe", !heads2.includes("Maybe") && heads2.length === 5, heads2.join(","));
  check("columns editor: stored", (await lsGet(page, "gtd-hidden-cols") ?? "").includes("MAYBE"));
  const badge = await page.locator("button", { hasText: /Colonne/ }).first().textContent();
  check("columns editor: button shows 5/6", /5\/6/.test(badge), badge);
  // a new task into the hidden column says so and offers to show it
  await page.getByLabel("Nuova attività…").fill("QA into hidden Maybe");
  await page.getByLabel("Nuova attività…").locator("xpath=..").locator("select").filter({ has: page.locator("option[value=MAYBE]") }).first().selectOption("MAYBE");
  await page.getByLabel("Nuova attività…").press("Enter");
  await sleep(300);
  const st = await toastText(page);
  check("new-task bar: says the task went to a hidden column", /nascost|Mostra/i.test(st), st);
  await page.locator("button", { hasText: /^Mostra$/ }).first().click().catch(() => {});
  await sleep(200);
  check("new-task bar: “Mostra” reveals the column", (await columnsOf(page, "QA into hidden Maybe"))[0] === "Maybe");

  // edit layout: resize
  await page.locator("button", { hasText: /^Modifica layout$/ }).click();
  const handle = page.locator('div[title="Modifica layout"].cursor-col-resize').first();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 120, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const w = JSON.parse((await lsGet(page, "gtd-col-weights")) ?? "{}");
  check("edit layout: dragging a handle widens the left column and is stored", (w.BACKLOG ?? 1) > 1.05 && (w.NEXT ?? 1) < 0.95, JSON.stringify(w));

  // Names toggle
  await page.locator("button", { hasText: /Nomi$/ }).click();
  await sleep(200);
  const names = await page.locator(".task-card").filter({ hasText: "Retail Q3 Ambition" }).first().textContent();
  check("Names toggle: hides owner names on cards", !/Chiara/.test(names), names);
  await page.locator("button", { hasText: /Nomi nascosti/ }).click();

  // Done bar & Archived bar
  await page.locator("button[aria-controls], button[aria-expanded]", { hasText: /^▶?\s*Fatte/ }).first().click();
  await sleep(200);
  const doneCards = await page.locator("#board-done-panel .task-card").count();
  const doneCol = (await page.evaluate(() => [...document.querySelectorAll('div[style*="min-height"]')].find((c) => c.querySelector(".font-trajan")?.textContent.trim() === "Done")?.querySelectorAll(".task-card").length));
  check("Done bar: mirrors the DONE column", doneCards === doneCol && doneCards >= 2, `bar ${doneCards}, column ${doneCol}`);
  await page.getByLabel("Cerca tra le fatte").fill("KPI").catch(async () => page.locator("#board-done-panel input").fill("KPI"));
  await sleep(200);
  check("Done bar: search", (await page.locator("#board-done-panel .task-card").count()) === 1);
  await page.locator("button", { hasText: /Archiviate/ }).first().click();
  await sleep(200);
  check("Archived bar: shows tasks done > 7 days ago", (await page.locator("#board-archive-panel .task-card").count()) === 1);
  await page.locator("#board-archive-panel input").fill("zzz");
  await sleep(150);
  check("Archived bar: search with no hit says so", /Niente|Nessun/i.test(await page.locator("#board-archive-panel").textContent()));
  check("Archived task is not in the DONE column", !(await columnsOf(page, "Presentazione board ottobre")).length);

  // Menu mensa
  check("Menu mensa bar is there", /Menu/i.test(await bodyText(page)));
  await context.close();
});

section("board.quickadd", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "qa" });
  await page.getByLabel("Nuova attività…").fill("QA full new task");
  await page.locator('button[aria-expanded][title="Assegnatario"]').click();
  await page.locator("button[aria-pressed]", { hasText: /^Chiara$/ }).first().click();
  const qrow = page.getByLabel("Nuova attività…").locator("xpath=..");
  await qrow.locator("select").filter({ has: page.locator("option[value=P1]") }).first().selectOption("P1");
  await qrow.locator("select").filter({ has: page.locator("option[value=WAITING]") }).first().selectOption("WAITING");
  await page.locator('input[type="date"]').first().fill(rel(4));
  await page.locator("button", { hasText: /^\+ Aggiungi$/ }).first().click();
  const t = await waitFor(() => store.db.tasks.find((x) => x.title === "QA full new task"));
  check("new-task bar: saved", !!t);
  if (t) {
    check("new-task bar: two assignees (me + Chiara)", JSON.stringify(t.assignees) === '["Francesco","Chiara"]' && t.owner === "Francesco", JSON.stringify({ o: t.owner, a: t.assignees }));
    check("new-task bar: priority, status, due", t.priority === "P1" && t.status === "WAITING" && t.due_date === rel(4), JSON.stringify({ p: t.priority, s: t.status, d: t.due_date }));
    check("new-task bar: Waiting starts counting today (local date)", t.waiting_since === rel(0), `waiting_since ${t.waiting_since} vs local today ${rel(0)}`);
  }
  // empty title
  await page.locator("button", { hasText: /^\+ Aggiungi$/ }).first().click();
  check("new-task bar: empty title says why", /titolo/i.test(await toastText(page)), await toastText(page));
  await context.close();
});

section("board.editor", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "edit" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:5199" });
  let card = await openCard(page, "Efficientare l'update dei cambi");
  // assignees multi-select
  await card.locator('button[title="Cambia chi se ne occupa"]').click();
  await card.locator("button[aria-pressed]", { hasText: /^Gonzalo$/ }).click();
  await waitFor(() => sv(store.db, "6").assignees?.length === 2);
  check("editor: add a second assignee", JSON.stringify(sv(store.db, "6").assignees) === '["Chiara","Gonzalo"]', JSON.stringify(sv(store.db, "6").assignees));
  await card.locator("button[aria-pressed]", { hasText: /^Chiara$/ }).click();
  await waitFor(() => sv(store.db, "6").owner === "Gonzalo");
  check("editor: removing the first assignee hands owner to the next", sv(store.db, "6").owner === "Gonzalo", JSON.stringify({ o: sv(store.db, "6").owner, a: sv(store.db, "6").assignees }));
  // priority
  await card.locator("button", { hasText: /^P3$/ }).click();
  await waitFor(() => sv(store.db, "6").priority === "P3");
  check("editor: priority", sv(store.db, "6").priority === "P3");
  // due
  await card.locator('input[type="date"]').fill(rel(10));
  await waitFor(() => sv(store.db, "6").due_date === rel(10));
  check("editor: due date", sv(store.db, "6").due_date === rel(10), sv(store.db, "6").due_date);
  // description / notes / file dir
  await card.getByPlaceholder(/descrizione|Descrizione|Aggiungi una descrizione/).first().fill("QA desc").catch(() => {});
  const areas = card.locator("textarea");
  const n = await areas.count();
  // title, (subtasks...), desc, notes → desc and notes are the last two textareas
  await areas.nth(n - 2).fill("QA desc");
  await areas.nth(n - 1).fill("QA notes");
  await card.locator("input.font-mono").fill("\\\\srv\\share\\qa");
  await card.locator("input.font-mono").blur();
  await sleep(400);
  check("editor: description saved on blur", sv(store.db, "6").description === "QA desc", sv(store.db, "6").description);
  check("editor: notes saved on blur", sv(store.db, "6").notes === "QA notes", sv(store.db, "6").notes);
  check("editor: file dir saved", sv(store.db, "6").file_dir === "\\\\srv\\share\\qa", sv(store.db, "6").file_dir);
  await card.locator("button", { hasText: /^Copia$/ }).click();
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  check("editor: file dir Copy puts the path on the clipboard", clip === "\\\\srv\\share\\qa", String(clip));
  // move-to-section select and arrows
  await card.locator('select[title="Stato"]').selectOption("IN PROGRESS").catch(async () => card.locator("select").filter({ has: page.locator("option[value=MAYBE]") }).last().selectOption("IN PROGRESS"));
  await waitFor(() => sv(store.db, "6").status === "IN PROGRESS");
  check("editor: move to section", sv(store.db, "6").status === "IN PROGRESS");
  await sleep(200);
  check("editor: card stays open after moving column (select)", (await page.locator(".task-card.is-open").count()) === 1, "the open editor closes when its task changes column");
  // The moved card reopens itself on mount: wait for it, or clicking its title
  // below would close it again.
  await page.locator(".task-card.is-open").first().waitFor({ timeout: 1500 }).catch(() => {});
  card = (await page.locator(".task-card.is-open").count()) ? page.locator(".task-card.is-open").first() : await openCard(page, "Efficientare l'update dei cambi");
  {
    await card.locator('button[title="Stato successivo"]').click();
    await waitFor(() => sv(store.db, "6").status === "WAITING");
    check("editor: › arrow moves to the next status", sv(store.db, "6").status === "WAITING");
  }
  // subtasks
  // The moved card reopens itself on mount: wait for it, or clicking its title
  // below would close it again.
  await page.locator(".task-card.is-open").first().waitFor({ timeout: 1500 }).catch(() => {});
  card = (await page.locator(".task-card.is-open").count()) ? page.locator(".task-card.is-open").first() : await openCard(page, "Efficientare l'update dei cambi");
  const add = card.getByPlaceholder(/Aggiungi sotto-?attività…/);
  for (const s of ["uno", "due", "tre"]) {
    await add.fill(s);
    await add.press("Enter");
  }
  await waitFor(() => sv(store.db, "6").subtasks.length === 3);
  check("subtasks: add three (RPC)", sv(store.db, "6").subtasks.map((s) => s.text).join(",") === "uno,due,tre", JSON.stringify(sv(store.db, "6").subtasks));
  await card.getByLabel("due", { exact: true }).click();
  await waitFor(() => sv(store.db, "6").subtasks[1]?.done === true);
  check("subtasks: tick", sv(store.db, "6").subtasks[1]?.done === true && !!sv(store.db, "6").subtasks[1]?.doneAt);
  await card.getByLabel("due", { exact: true }).click();
  await waitFor(() => sv(store.db, "6").subtasks[1]?.done === false);
  check("subtasks: untick removes doneAt", sv(store.db, "6").subtasks[1]?.done === false && !("doneAt" in sv(store.db, "6").subtasks[1]), JSON.stringify(sv(store.db, "6").subtasks[1]));
  const grip = card.locator('button[aria-label^="Sposta"]').first();
  await grip.focus();
  await page.keyboard.press("ArrowDown");
  await waitFor(() => sv(store.db, "6").subtasks[0]?.text === "due");
  check("subtasks: reorder (keyboard)", sv(store.db, "6").subtasks.map((s) => s.text).join(",") === "due,uno,tre", sv(store.db, "6").subtasks.map((s) => s.text).join(","));
  await card.locator('button[aria-label="Elimina sottoattività"]').nth(1).click().catch(async () => card.locator('button[aria-label*="limina"]').nth(1).click());
  await waitFor(() => sv(store.db, "6").subtasks.length === 2);
  check("subtasks: delete", sv(store.db, "6").subtasks.map((s) => s.text).join(",") === "due,tre", sv(store.db, "6").subtasks.map((s) => s.text).join(","));
  await toastUndo(page).click();
  await waitFor(() => sv(store.db, "6").subtasks.length === 3);
  await sleep(300);
  check("subtasks: delete Undo puts it back in place", sv(store.db, "6").subtasks.map((s) => s.text).join(",") === "due,uno,tre", sv(store.db, "6").subtasks.map((s) => s.text).join(","));

  // empty title is refused
  card = page.locator(".task-card.is-open").first();
  const title = card.locator("textarea").first();
  await title.fill("");
  await title.press("Enter");
  await sleep(300);
  check("editor: empty title not saved", sv(store.db, "6").title === "Efficientare l'update dei cambi");

  // delete with Undo
  const snapshot = JSON.stringify(sv(store.db, "6"));
  await card.locator("button", { hasText: /^Elimina$/ }).click();
  await card.locator("button", { hasText: /^Sì$/ }).click();
  await waitFor(() => !sv(store.db, "6"));
  check("delete: row gone", !sv(store.db, "6"));
  await toastUndo(page).click();
  await waitFor(() => sv(store.db, "6"));
  const back = sv(store.db, "6");
  const same = back && ["title", "description", "notes", "file_dir", "owner", "priority", "status", "due_date", "waiting_since"].every((k) => JSON.stringify(back[k]) === JSON.stringify(JSON.parse(snapshot)[k]))
    && back.subtasks.length === 3 && JSON.stringify(back.assignees) === JSON.stringify(JSON.parse(snapshot).assignees);
  check("delete Undo: the task comes back whole", same, back ? JSON.stringify({ ...back, updated_at: 0, created_at: 0 }) : "missing");
  check("delete Undo: keeps its place (created_at)", back?.created_at === JSON.parse(snapshot).created_at, `${back?.created_at} vs ${JSON.parse(snapshot).created_at}`);
  await context.close();
});

section("board.realtime", async (browser) => {
  const store = createStore();
  const A = await openApp(browser, { store, name: "rtA" });
  const B = await openApp(browser, { store, name: "rtB", me: "Chiara" });
  // A edits title, B sees it
  const card = await openCard(A.page, "Chief dashboard ppt");
  const title = card.locator("textarea").first();
  await title.fill("Chief dashboard ppt v2");
  await title.press("Enter");
  check("realtime: title edit reaches the other browser", !!(await waitFor(async () => (await B.page.locator(".task-card", { hasText: "Chief dashboard ppt v2" }).count()) === 1)));
  // subtask concurrency: both add a subtask at the same time
  const ca = await openCard(A.page, "BU Pivot loans");
  const cb = await openCard(B.page, "BU Pivot loans");
  await Promise.all([
    (async () => { await ca.getByPlaceholder(/Aggiungi sotto-?attività…/).fill("from A"); await ca.getByPlaceholder(/Aggiungi sotto-?attività…/).press("Enter"); })(),
    (async () => { await cb.getByPlaceholder(/Aggiungi sotto-?attività…/).fill("from B"); await cb.getByPlaceholder(/Aggiungi sotto-?attività…/).press("Enter"); })(),
  ]);
  await sleep(800);
  const subs = sv(store.db, "1").subtasks.map((s) => s.text);
  check("realtime: two people adding subtasks at once keep both", subs.includes("from A") && subs.includes("from B"), subs.join(","));
  const seenA = await A.page.locator(".task-card.is-open").first().textContent();
  check("realtime: each browser shows the other's subtask", /from B/.test(seenA) && /from A/.test(await B.page.locator(".task-card.is-open").first().textContent()));
  // delete in B reaches A
  await B.page.keyboard.press("Escape");
  const cB = await openCard(B.page, "Mind Map macroambiti");
  await cB.locator("button", { hasText: /^Elimina$/ }).click();
  await cB.locator("button", { hasText: /^Sì$/ }).click();
  check("realtime: delete reaches the other browser", !!(await waitFor(async () => (await columnsOf(A.page, "Mind Map macroambiti")).length === 0)));
  // B's Undo brings it back for A too
  await toastUndo(B.page).click();
  check("realtime: Undo of a delete reaches the other browser", !!(await waitFor(async () => (await columnsOf(A.page, "Mind Map macroambiti")).length === 1)));
  // highlight from A appears in B's band
  const cA2 = await openCard(A.page, "VUB - spostare SB");
  await cA2.locator("button", { hasText: "Metti in evidenza" }).click();
  check("realtime: ★ from one browser shows in the other's band", !!(await waitFor(async () => (await bandTitles(B.page)).some((x) => x.includes("VUB")))));
  await A.context.close();
  await B.context.close();
});

// ---- PROJECTS -------------------------------------------------------------------
const goto = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await sleep(500);
};
const onBoard = async (page, title) => (await columnsOf(page, title)).length > 0;

section("projects.overview", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "proj", path: "#/projects" });
  let txt = await bodyText(page);
  check("projects: Ongoing lists both projects", /Pricing 2027/.test(txt) && /Chiusure contabili/.test(txt));
  await page.locator("button", { hasText: /^Timeline$/ }).first().click();
  await sleep(300);
  check("projects: Timeline view stored", (await lsGet(page, "gtd-projects-view")) === "timeline");
  await page.reload();
  await page.waitForSelector("main");
  await sleep(600);
  check("projects: Timeline remembered", (await page.locator("button", { hasText: /^Timeline$/ }).first().getAttribute("aria-pressed")) === "true");
  await page.locator("button", { hasText: /^Schede$/ }).first().click();
  await page.locator("button", { hasText: /^Completati/ }).first().click();
  await sleep(300);
  txt = await bodyText(page);
  check("projects: Completed is empty at first", !/Pricing 2027/.test(txt.split("Completati").slice(1).join("")));
  await page.locator("button", { hasText: /^In corso/ }).first().click();

  // project page: complete every task of p1 → completed
  await goto(page, "#/projects/p1");
  for (const title of ["BU Pivot loans", "Completare check vs TBD per chief dashboard"]) {
    // The done toggle is a checkbox named after its task (it was "Done").
    const rowBtn = page.getByRole("checkbox", { name: title, exact: true }).first();
    await rowBtn.click();
    await sleep(300);
  }
  await waitFor(() => sv(store.db, "1").status === "DONE" && sv(store.db, "5").status === "DONE");
  check("project list: tick marks tasks done", sv(store.db, "1").status === "DONE" && sv(store.db, "5").status === "DONE", `${sv(store.db, "1").status} ${sv(store.db, "5").status}`);
  await goto(page, "#/projects");
  await page.locator("button", { hasText: /^Completati/ }).first().click();
  await sleep(300);
  check("projects: a project whose tasks are all DONE moves to Completed", /Pricing 2027/.test(await bodyText(page)));
  await context.close();
});

section("projects.tasks", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "ptasks", path: "#/projects/p1" });
  await sleep(400);
  // new task from the project
  await page.getByLabel("Nuova attività…").last().fill("QA project task");
  await page.getByLabel("Nuova attività…").last().press("Enter");
  const t = await waitFor(() => store.db.tasks.find((x) => x.title === "QA project task"));
  check("project: new task created linked", t?.project_id === "p1", JSON.stringify(t && { p: t.project_id }));
  // link existing
  await page.getByLabel("+ Collega un'attività del board…").selectOption({ label: "Efficientare l'update dei cambi" });
  await waitFor(() => sv(store.db, "6").project_id === "p1");
  check("project: link an existing board task", sv(store.db, "6").project_id === "p1");
  // unlink + undo
  const unl = page.locator('button[aria-label^="Scollega dal progetto"]');
  const row = page.locator("div").filter({ hasText: "Efficientare l'update dei cambi" }).filter({ has: unl }).last().locator(unl).first();
  await row.click();
  await waitFor(() => sv(store.db, "6").project_id === null);
  check("project: unlink", sv(store.db, "6").project_id === null);
  const u = toastUndo(page);
  if (await u.count()) {
    await u.click();
    await waitFor(() => sv(store.db, "6").project_id === "p1");
    check("project: unlink Undo", sv(store.db, "6").project_id === "p1");
  } else check("project: unlink offers Undo", false, "no toast");
  // board view of the project's tasks, remembered
  await page.locator('[role=group] button', { hasText: /^Board$/ }).first().click();
  await sleep(300);
  check("project tasks: Board view stored", (await lsGet(page, "gtd-project-tasks-view")) === "board");
  // on the main board with the project chip
  await goto(page, "#/board");
  const chip = await page.locator(".task-card", { hasText: "QA project task" }).first().textContent();
  check("board: project task shows the project chip", /Pricing 2027/.test(chip ?? ""), chip);
  // project picker in the board editor
  const card = await openCard(page, "Cambiare corporate con legal entities");
  await card.locator('select[title="Progetto"]').selectOption("p2").catch(async () => card.locator("select").filter({ has: page.locator("option[value=p2]") }).first().selectOption("p2"));
  await waitFor(() => sv(store.db, "7").project_id === "p2");
  check("board editor: project picker links the task", sv(store.db, "7").project_id === "p2");
  await sleep(300);
  check("board editor: linking an existing task to a sequential project makes it a later step (off the BOARD)", !(await onBoard(page, "Cambiare corporate con legal entities")), "it became step 1 (older created_at) and is on the BOARD");
  check("board editor: linking keeps the in-progress current step on the BOARD", await onBoard(page, "Allineamento pricing Q4"), "“Allineamento pricing Q4” (IN PROGRESS, the current step) vanished from the BOARD");
  await context.close();
});

section("projects.modes", async (browser) => {
  const store = createStore();
  const B = await openApp(browser, { store, name: "modesB", me: "Gonzalo" });
  const { page, context } = await openApp(browser, { store, name: "modes", path: "#/board" });
  // sequential p2: current step is "Allineamento pricing Q4" (13), 14 is DONE
  const chip = await page.locator(".task-card", { hasText: "Allineamento pricing Q4" }).first().textContent();
  check("sequential: current step on the BOARD with Passo n/N", /Passo 1\/2/.test(chip ?? ""), chip);
  await goto(page, "#/projects/p2");
  await page.getByLabel("Nuova attività…").last().fill("QA step 3");
  await page.getByLabel("Nuova attività…").last().press("Enter");
  const s3 = await waitFor(() => store.db.tasks.find((x) => x.title === "QA step 3"));
  await goto(page, "#/board");
  check("sequential: a new later step is not on the BOARD", !(await onBoard(page, "QA step 3")));
  check("sequential (realtime): other browser does not show the later step", !(await onBoard(B.page, "QA step 3")) && (await onBoard(B.page, "Allineamento pricing Q4")));
  // complete the current step from the BOARD → next appears
  await clickCheck(page, "Allineamento pricing Q4");
  await sleep(500);
  check("sequential: after the current step is DONE the next appears", await onBoard(page, "QA step 3"));
  check("sequential (realtime): next step appears for the other browser", !!(await waitFor(() => onBoard(B.page, "QA step 3"))));
  // Undo → back
  await toastUndo(page).click();
  await sleep(500);
  check("sequential: Undo takes the next step off again", !(await onBoard(page, "QA step 3")));
  // ▲ ▼ reorder
  await goto(page, "#/projects/p2");
  await page.locator('[role=group] button', { hasText: /^Elenco$/ }).first().click().catch(() => {});
  const ups = page.locator('button[aria-label="Sposta prima"]');
  // QA step 3 is the last row: move it up twice → first
  await ups.last().click();
  await sleep(300);
  await ups.nth(1).click().catch(() => {});
  await sleep(400);
  const order = (store.db.projects.find((p) => p.id === "p2").task_order ?? []).join(",");
  check("sequential: ▲ reorders the steps (task_order saved)", order.startsWith(s3?.id ?? "?"), order);
  await goto(page, "#/board");
  check("sequential: the step moved first is now the one on the BOARD", (await onBoard(page, "QA step 3")) && !(await onBoard(page, "Allineamento pricing Q4")));
  // mode none on p1
  await goto(page, "#/projects/p1");
  await page.locator('[role=group][aria-label="Nel BOARD"] button', { hasText: "Solo progetto" }).click();
  await waitFor(() => store.db.projects.find((p) => p.id === "p1").board_mode === "none");
  await goto(page, "#/board");
  check("project only: its tasks leave the BOARD", !(await onBoard(page, "BU Pivot loans")) && !(await onBoard(page, "Completare check vs TBD")));
  check("project only (realtime): also for the other browser", !!(await waitFor(async () => !(await onBoard(B.page, "BU Pivot loans")))));
  // refused mode change
  const { ctl } = { ctl: null };
  store.reject = (m, t) => m === "PATCH" && t === "projects";
  await goto(page, "#/projects/p1");
  await page.locator('[role=group][aria-label="Nel BOARD"] button', { hasText: "Tutte" }).click();
  await sleep(1200);
  const pressed = await page.locator('[role=group][aria-label="Nel BOARD"] button', { hasText: "Tutte" }).getAttribute("aria-pressed");
  check("refused mode change: rolled back in the UI", pressed === "false" && store.db.projects.find((p) => p.id === "p1").board_mode === "none");
  {
    const bt = await bodyText(page);
    const m = bt.match(RLS);
    check("refused mode change: the page says it was not saved", !!m, "silent");
    if (m) console.log("   matched:", bt.slice(Math.max(0, m.index - 80), m.index + 80).replace(/\n/g, " "));
  }
  store.reject = null;
  await B.context.close();
  await context.close();
});

// ---- PHONE ----------------------------------------------------------------------
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const mCard = (page, title) => page.locator(".m-card").filter({ hasText: title }).first();
async function swipe(page, title, dx) {
  const c = mCard(page, title);
  await c.scrollIntoViewIfNeeded();
  const b = await c.boundingBox();
  const y = b.y + b.height / 2;
  const x = dx > 0 ? b.x + 40 : b.x + b.width - 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + 1);
  await page.mouse.up();
  await sleep(350);
}
const mToast = (page) => page.locator(".m-toast");
const mUndo = (page) => page.locator(".m-toast button", { hasText: /^Annulla$/ });
const sheetOpen = (page) => page.locator(".m-sheet, [role=dialog]").count();

section("phone.today", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "ph-today", ...PHONE, path: "#/today" });
  const txt = await bodyText(page);
  const evid = txt.split(/In evidenza/i)[1] ?? "";
  check("phone Oggi: shows the team's highlighted tasks (not only mine)", /Retail Q3 Ambition/.test(evid) && /Report settimanale/.test(evid), evid.slice(0, 200));
  check("phone Oggi: my overdue task listed", /BU Pivot loans/.test(txt));

  // swipe right = done, with Undo
  await swipe(page, "BU Pivot loans", 160);
  await waitFor(() => sv(store.db, "1").status === "DONE");
  check("phone swipe right: marks done", sv(store.db, "1").status === "DONE", sv(store.db, "1").status);
  check("phone swipe right: toast “Fatta” with Annulla", /Fatta/.test(await mToast(page).textContent().catch(() => "")) && (await mUndo(page).count()) === 1);
  await mUndo(page).click();
  await waitFor(() => sv(store.db, "1").status === "NEXT");
  check("phone Undo: restores the status", sv(store.db, "1").status === "NEXT", sv(store.db, "1").status);

  // swipe left = move
  await swipe(page, "BU Pivot loans", -160);
  await sleep(300);
  const opened = await page.locator("text=Waiting").count();
  check("phone swipe left: opens Move to…", opened > 0);
  await page.locator("[role=listbox] >> text=Waiting").first().click().catch(async () => page.getByText("Waiting", { exact: true }).last().click());
  await waitFor(() => sv(store.db, "1").status === "WAITING");
  check("phone Move to: saves the status", sv(store.db, "1").status === "WAITING", sv(store.db, "1").status);
  check("phone Move to: toast “Spostata in …”", /Spostata/.test(await mToast(page).textContent().catch(() => "")));

  // tap opens the task sheet; Back closes it
  const before = page.url();
  await mCard(page, "Report settimanale").locator(".m-card__open").click();
  await sleep(500);
  check("phone: tapping a card opens the task sheet", /Stato/.test(await bodyText(page)));
  // Ripeti row → Feriali
  await page.locator("button, [role=button]", { hasText: /^Ripeti/ }).first().click();
  await sleep(300);
  await page.locator("[role=listbox] >> text=Feriali").first().click();
  await waitFor(() => (sv(store.db, "3").recurrence?.days ?? []).length === 5);
  check("phone task sheet Ripeti → Feriali saved", JSON.stringify(sv(store.db, "3").recurrence?.days) === "[0,1,2,3,4]" && sv(store.db, "3").recurrence?.every === 1, JSON.stringify(sv(store.db, "3").recurrence));
  await sleep(300);
  // In evidenza row toggles
  await page.locator("button, [role=button]", { hasText: /^In evidenza/ }).first().click();
  await waitFor(() => sv(store.db, "3").pinned === false);
  check("phone task sheet In evidenza row toggles ★", sv(store.db, "3").pinned === false);
  await page.goBack();
  await sleep(500);
  check("phone Back: closes the task sheet and stays on Oggi", page.url().endsWith("#/today") && !/Ripeti/.test(await bodyText(page)), page.url());
  await context.close();
});

section("phone.refused", async (browser) => {
  const store = createStore();
  const { page, context, ctl } = await openApp(browser, { store, name: "ph-rej", ...PHONE, path: "#/today" });
  ctl.reject = (m, t) => m === "PATCH" && t === "tasks";
  await swipe(page, "BU Pivot loans", 160);
  await sleep(1500);
  const tt = await page.locator(".m-toast").allTextContents();
  check("phone refused: toast says not saved", tt.some((x) => /Non salvato/.test(x)), tt.join(" | "));
  check("phone refused: card back to not-done", (await mCard(page, "BU Pivot loans").getAttribute("class")).includes("m-card--done") === false);
  await context.close();
});

section("phone.board", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "ph-board", ...PHONE, path: "#/board" });
  const pager = page.locator(".m-pager");
  const w = await pager.evaluate((el) => el.clientWidth);
  await pager.evaluate((el, w) => el.scrollTo({ left: w * 2 }), w);
  await sleep(700);
  check("phone Board: swiping the pager changes column (remembered)", (await lsGet(page, "gtd-m-board-col")) === "IN PROGRESS", await lsGet(page, "gtd-m-board-col"));
  // Add here in In Progress
  const sec = page.locator('section.m-pager__page[aria-label="In corso"], section.m-pager__page').nth(2);
  await sec.locator("button", { hasText: "Aggiungi qui" }).click();
  await sleep(400);
  await page.getByPlaceholder("Cosa c'è da fare?").fill("QA phone add here");
  await page.locator("button", { hasText: /^Aggiungi$/ }).first().click();
  const t = await waitFor(() => store.db.tasks.find((x) => x.title === "QA phone add here"));
  check("phone Add here: task created in that column", t?.status === "IN PROGRESS", JSON.stringify(t && t.status));
  await sleep(400);
  // Colonne
  await page.locator('button[aria-label="Colonne"]').click();
  await sleep(300);
  await page.locator("[role=dialog], .m-sheet").last().getByText("Maybe", { exact: false }).first().click();
  await sleep(200);
  check("phone Colonne: hides a column (shared pref)", (await lsGet(page, "gtd-hidden-cols") ?? "").includes("MAYBE"));
  await page.goBack();
  await sleep(400);
  check("phone Back: closes the Colonne sheet, stays on Board", page.url().endsWith("#/board"), page.url());
  // Solo mie
  await page.locator("button", { hasText: "Solo mie" }).click();
  await sleep(300);
  const titles = await page.locator(".m-card").allTextContents();
  check("phone Solo mie: only my tasks", titles.length > 0 && !titles.some((x) => /Retail Q3 Ambition/.test(x)), `${titles.length} cards`);
  // + add sheet
  await page.locator('button[aria-label="Nuova attività"]').click();
  await sleep(400);
  await page.getByPlaceholder("Cosa c'è da fare?").fill("QA phone plus");
  await page.getByPlaceholder("Cosa c'è da fare?").press("Enter");
  const t2 = await waitFor(() => store.db.tasks.find((x) => x.title === "QA phone plus"));
  check("phone +: adds a task", !!t2);
  await page.goBack();
  await sleep(400);
  check("phone Back: closes the add sheet", !(await page.getByPlaceholder("Cosa c'è da fare?").count()));
  await context.close();
});

section("phone.agenda+projects", async (browser) => {
  const store = createStore();
  const { page, context } = await openApp(browser, { store, name: "ph-ag", ...PHONE, path: "#/agenda" });
  const target = rel(3);
  const d = parse(target);
  // choose the day in the strip (it may be next week)
  const label = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  let day = page.locator(`button[aria-label^="${label}"]`);
  if (!(await day.count())) {
    await page.locator('button[aria-label="Settimana successiva"]').click().catch(() => {});
    day = page.locator(`button[aria-label^="${label}"]`);
  }
  await day.first().click();
  await sleep(300);
  await page.locator("h2 button.m-link", { hasText: "Aggiungi" }).first().click();
  await sleep(300);
  await page.getByPlaceholder("Cosa c'è da fare?").fill("QA agenda day");
  await page.locator("button", { hasText: /^Aggiungi$/ }).first().click();
  const t = await waitFor(() => store.db.tasks.find((x) => x.title === "QA agenda day"));
  check("phone Agenda: add on a day sets that due date", t?.due_date === target, JSON.stringify(t && t.due_date));
  // Progetti sheet
  await page.evaluate(() => (location.hash = "#/projects"));
  await sleep(500);
  await page.locator(".m-project", { hasText: "Pricing 2027" }).click();
  await sleep(400);
  check("phone Progetti: project opens as a sheet", /Pricing 2027/.test(await bodyText(page)) && /BU Pivot loans/.test(await bodyText(page)));
  await page.locator("button.m-link", { hasText: "Aggiungi" }).first().click();
  await sleep(300);
  await page.getByPlaceholder("Cosa c'è da fare?").fill("QA phone project task");
  await page.locator("button", { hasText: /^Aggiungi$/ }).first().click();
  const t2 = await waitFor(() => store.db.tasks.find((x) => x.title === "QA phone project task"));
  check("phone Progetti: add a task to the project", t2?.project_id === "p1", JSON.stringify(t2 && t2.project_id));
  await sleep(400);
  check("phone add sheet closes after Aggiungi", !(await page.getByPlaceholder("Cosa c'è da fare?").count()));
  await page.goBack();
  await sleep(400);
  check("phone Back: closes the project sheet and stays on Progetti", page.url().endsWith("#/projects") && !(await page.locator(".m-project").filter({ hasText: "Pricing 2027" }).count() === 0), page.url());
  await context.close();
});

// ---- Write ordering (parallel requests that may land out of order) ---------------
section("races", async (browser) => {
  // Project delete → Undo: the project INSERT and the task re-links go out together
  {
    let lost = 0;
    const tries = 4;
    for (let i = 0; i < tries; i++) {
      const store = createStore({ jitterMs: 400 });
      const { page, context } = await openApp(browser, { store, name: `pdel${i}`, path: "#/projects/p1" });
      await page.locator("button", { hasText: /^Elimina progetto$/ }).click();
      await page.locator("button", { hasText: /^Sì$/ }).click();
      await sleep(800);
      await toastUndo(page).click();
      await sleep(2000);
      if (store.db.tasks.filter((t) => t.project_id === "p1").length !== 2) lost++;
      await context.close();
    }
    check("project delete Undo re-links every task (requests out of order)", lost === 0, `${lost}/${tries} runs lost task links (UPDATE before INSERT → 23503, nothing shown)`);
  }
  // Subtask delete → Undo: addSubtask and reorderSubtasks go out together
  {
    let wrong = 0;
    const tries = 5;
    for (let i = 0; i < tries; i++) {
      const db = seed();
      db.tasks[0].subtasks = [{ id: "a", text: "uno", done: false }, { id: "b", text: "due", done: false }, { id: "c", text: "tre", done: false }];
      const store = createStore({ db, jitterMs: 400 });
      const { page, context } = await openApp(browser, { store, name: `sdel${i}` });
      const card = await openCard(page, "BU Pivot loans");
      await card.locator('button[aria-label="Elimina sottoattività"]').first().click();
      await sleep(900);
      await toastUndo(page).click();
      await sleep(2200);
      if (sv(store.db, "1").subtasks.map((s) => s.text).join(",") !== "uno,due,tre") wrong++;
      await context.close();
    }
    check("subtask delete Undo restores the position (requests out of order)", wrong === 0, `${wrong}/${tries} runs put it last`);
  }
  // Realtime echo of an earlier write briefly undoes a later optimistic one
  {
    const db = seed();
    db.tasks[0].subtasks = [{ id: "a", text: "uno", done: false }, { id: "b", text: "due", done: false }];
    const store = createStore({ db, delayMs: 300, realtimeDelayMs: 10 });
    const { page, context } = await openApp(browser, { store, name: "echo" });
    const card = await openCard(page, "BU Pivot loans");
    await card.getByLabel("uno", { exact: true }).click();
    await sleep(150);
    await card.getByLabel("due", { exact: true }).click();
    const samples = [];
    for (let i = 0; i < 30; i++) {
      samples.push((await card.getByLabel("due", { exact: true }).isChecked()) ? 1 : 0);
      await sleep(50);
    }
    const s = samples.join("");
    check("two quick subtask ticks: the second never flips back while saving", !/10+1/.test(s), `“due” checkbox sampled every 50 ms: ${s}`);
    await context.close();
  }
});

// =================================================================================
const browser = await launch();
for (const s of sections) {
  if (only && !s.name.includes(only)) continue;
  console.log(`\n== ${s.name}`);
  try {
    await s.fn(browser);
  } catch (e) {
    check(`${s.name}: ran to the end`, false, String(e?.message ?? e).split("\n")[0]);
  }
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
