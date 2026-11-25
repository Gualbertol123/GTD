// Functional QA pass over the secondary tabs (Weekly, Report, Calendar,
// Reflection, Products, Music, Settings), login/logout, addresses/Back,
// IT/EN, refused writes and missing migrations, against the in-memory fake
// Supabase in stub.mjs. Prints PASS / FAIL / INFO per check.
//
//   node scripts/ux/functional-tabs.mjs [group,group,…]
//   groups: weekly report calendar reflection products music settings auth
//           routes lang offline board
//
// Needs the dev server on :5199 pointed at the fake host (see stub.mjs).
import { goOffline, launch, openApp, STUB_HOST } from "./stub.mjs";

const only = process.argv[2]?.split(",");
const OUT = process.env.OUT ?? ".";
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);
const wait = (p, ms) => p.waitForTimeout(ms);
const go = async (page, hash) => {
  await page.goto(page.url().split("#")[0] + hash);
  await wait(page, 900);
};
const mainText = (page) => page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Make writes to a table fail. `match(req)` narrows which requests. */
async function refuse(context, table, { status = 403, body, methods = ["POST", "PATCH", "DELETE"], match } = {}) {
  const hits = [];
  await context.route(`${STUB_HOST}/rest/v1/${table}*`, async (route) => {
    const req = route.request();
    if (!methods.includes(req.method()) || (match && !match(req))) return route.fallback();
    hits.push(req.method() + " " + (req.postData() ?? "").slice(0, 120));
    return route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body ?? { code: "42501", message: `permission denied for table ${table}`, details: null, hint: null }),
    });
  });
  return hits;
}

/** Any visible text that reads like an error / not-saved message. */
async function errorsOnScreen(page) {
  return page.evaluate(() => {
    const re = /non salvat|not saved|errore|error|non riuscit|failed|impossibile|permission|negat|refused|denied|riprova|try again/i;
    return [...document.querySelectorAll("[role=alert], [role=status], body *")]
      .filter((e) => e.children.length === 0 && re.test(e.textContent ?? "") && e.getBoundingClientRect().height > 0)
      .map((e) => e.textContent.trim().slice(0, 140))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 6);
  });
}

const browser = await launch();
const groups = {};

// ---------------------------------------------------------------- WEEKLY
groups.weekly = async () => {
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/weekly" });
    const t = await mainText(page);
    ok("weekly: recap lists this week's DONE tasks", /Review KPI trimestrali/.test(t) && /Chiusura mensile novembre/.test(t));
    ok("weekly: recap leaves out the 20-day-old task", !/RECAP[\s\S]*Presentazione board ottobre[\s\S]*ARCHIVIATE/.test(t));
    // Archived section
    const arch = page.locator("main button", { hasText: /ARCHIVIATE|Archiviate/ }).first();
    const exp0 = await arch.getAttribute("aria-expanded");
    await arch.click();
    await wait(page, 300);
    const t2 = await mainText(page);
    ok("weekly: Archived opens and shows the old task", /Presentazione board ottobre/.test(t2), `aria-expanded before=${exp0}`);
    // Add in each column
    const cols = ["Vittorie", "Cosa abbiamo imparato", "Da migliorare", "Blocchi", "Focus prossima settimana"];
    for (const c of cols) {
      const inp = page.locator(`input[aria-label="${c}: Aggiungi…"]`);
      await inp.fill(`QA ${c}`);
      await inp.press("Enter");
    }
    await wait(page, 600);
    const added = cols.filter((c) => db.weekly.some((r) => r.body === `QA ${c}`));
    ok("weekly: add in all 5 columns reaches the DB", added.length === 5, `${added.length}/5`);
    // Edit
    const ta = page.locator('textarea[aria-label="Vittorie: voce"]').first();
    await ta.fill("Consegna dashboard MODIFICATA");
    await ta.press("Enter");
    await wait(page, 500);
    ok("weekly: edit in place saves (Enter)", db.weekly.some((r) => r.body === "Consegna dashboard MODIFICATA"));
    // Esc cancels
    await ta.fill("non deve salvarsi");
    await ta.press("Escape");
    await wait(page, 400);
    ok("weekly: Esc cancels an edit", !db.weekly.some((r) => r.body === "non deve salvarsi") && (await ta.inputValue()) !== "non deve salvarsi");
    // Delete + undo
    const n0 = db.weekly.length;
    await page.locator('button[aria-label="Elimina voce"]').first().click({ force: true });
    await wait(page, 500);
    const n1 = db.weekly.length;
    const toast = await page.locator("[role=status]", { hasText: "Annulla" }).count();
    ok("weekly: delete removes the row and shows Undo", n1 === n0 - 1 && toast > 0, `rows ${n0}->${n1}, toast=${toast}`);
    await page.locator("[role=status] button", { hasText: "Annulla" }).first().click();
    await wait(page, 600);
    ok("weekly: Undo restores the row", db.weekly.length === n0, `rows=${db.weekly.length}`);
    // Empty an item = delete
    const ta2 = page.locator('textarea[aria-label="Blocchi: voce"]').first();
    const nB = db.weekly.length;
    await ta2.fill("");
    await ta2.press("Enter");
    await wait(page, 500);
    ok("weekly: emptying an item deletes it", db.weekly.length === nB - 1, `${nB}->${db.weekly.length}`);
    // Clear all
    const nC = db.weekly.length;
    let dialog = null;
    page.once("dialog", (d) => { dialog = d.message(); d.dismiss(); });
    await page.locator("main button", { hasText: "Svuota weekly" }).click();
    await wait(page, 600);
    info("weekly: 'Svuota weekly'", `dialog=${dialog ?? "none"}, rows ${nC}->${db.weekly.length}, toast=${await page.locator("[role=status]", { hasText: "Annulla" }).count()}`);
    if (db.weekly.length === 0) {
      await page.locator("[role=status] button", { hasText: "Annulla" }).first().click().catch(() => {});
      await wait(page, 600);
      ok("weekly: Undo after Svuota restores every row", db.weekly.length === nC, `${db.weekly.length}/${nC}`);
    }
    // Week navigation
    await page.locator('button[aria-label="Settimana precedente"]').click();
    await wait(page, 300);
    const t3 = await mainText(page);
    ok("weekly: previous week shows its own recap", !/Review KPI trimestrali/.test(t3.split(/ARCHIVIATE|Archiviate/)[0]));
    await page.screenshot({ path: `${OUT}/weekly-prevweek.png` });
    await context.close();
  }
  // Empty state
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/board" });
    db.weekly.length = 0;
    db.tasks = db.tasks.filter((x) => x.status !== "DONE");
    await go(page, "#/weekly");
    await page.reload();
    await wait(page, 1200);
    const t = await mainText(page);
    info("weekly empty state text", t.replace(/\n+/g, " | ").slice(0, 400));
    await page.screenshot({ path: `${OUT}/weekly-empty.png` });
    await context.close();
  }
  // Refused writes
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/weekly" });
    const hits = await refuse(context, "weekly");
    const inp = page.locator('input[aria-label="Vittorie: Aggiungi…"]');
    await inp.fill("QA rifiutato");
    await inp.press("Enter");
    await wait(page, 300);
    const shownBefore = (await mainText(page)).includes("QA rifiutato") || (await page.evaluate(() => [...document.querySelectorAll("textarea")].some((e) => e.value === "QA rifiutato")));
    await wait(page, 1800);
    const shownAfter = await page.evaluate(() => [...document.querySelectorAll("textarea")].some((e) => e.value === "QA rifiutato"));
    const errs = await errorsOnScreen(page);
    ok("weekly refused add: rolled back", !shownAfter, `optimistic=${shownBefore}, after=${shownAfter}, hits=${hits.length}`);
    ok("weekly refused add: UI says it was not saved", errs.length > 0, errs.join(" / ") || "no message on screen");
    await page.screenshot({ path: `${OUT}/weekly-refused.png` });
    // refused delete
    const n0 = db.weekly.length;
    await page.locator('button[aria-label="Elimina voce"]').first().click({ force: true });
    await wait(page, 2000);
    const back = await page.locator('textarea[aria-label="Vittorie: voce"]').count();
    ok("weekly refused delete: item comes back", back > 0 && db.weekly.length === n0);
    const errs2 = await errorsOnScreen(page);
    ok("weekly refused delete: UI says so", errs2.length > 0, errs2.join(" / ") || "no message (Undo toast still says deleted?) toast=" + (await page.locator("[role=status]", { hasText: "Annulla" }).count()));
    await context.close();
  }
};

// ---------------------------------------------------------------- REPORT
groups.report = async () => {
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/report" });
    await page.locator("main button", { hasText: "Genera report" }).click();
    await wait(page, 2500);
    const pages = await page.locator(".gr-page, [class*=gr-page]").count();
    ok("report: Generate lays out pages", pages > 0, `${pages} page nodes`);
    await page.screenshot({ path: `${OUT}/report-generated.png` });
    // Edit text in place
    const ed = page.locator("[data-ed-id][contenteditable=true]").first();
    const edId = await ed.getAttribute("data-ed-id");
    await ed.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" QAEDIT");
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await wait(page, 800);
    const draftRaw = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("gtd-report-draft:")).map((k) => k + "=" + localStorage.getItem(k)));
    ok("report: in-place edit saved as a draft in localStorage", draftRaw.some((d) => d.includes("QAEDIT")), `${edId}; ${draftRaw.map((d) => d.slice(0, 80)).join(" | ")}`);
    const draftNote = await page.locator("main", { hasText: /Bozza|bozza|salvat/ }).count();
    // Hide a card ×
    const hides = page.locator("button.gr-hide");
    const nh = await hides.count();
    const cardsBefore = await page.locator("[data-block-id], .gr-card").count();
    if (nh) {
      await hides.first().click({ force: true });
      await wait(page, 1200);
    }
    const toastHide = (await page.locator("[role=status]").allInnerTexts()).join(" ");
    const showHidden = await page.locator("main button", { hasText: /nascost|hidden/i }).count();
    ok("report: × hides a card and offers Undo/show hidden", nh > 0 && /Annulla/.test(toastHide), `hide buttons=${nh}, toast="${toastHide.replace(/\n/g, " ")}", showHidden btn=${showHidden}`);
    // Highlights picker
    const pick = page.locator("main button", { hasText: /Scegli attivit/ });
    const pc = await pick.count();
    if (pc) {
      await pick.first().click();
      await wait(page, 500);
      const opts = await page.locator(".gr-picker input[type=checkbox], .gr-picker [role=checkbox], .gr-picker button").count();
      info("report: highlights picker", `opened with ${opts} options`);
      const first = page.locator(".gr-picker input[type=checkbox], .gr-picker [role=checkbox]").first();
      if (await first.count()) { await first.click(); await wait(page, 400); }
      await page.keyboard.press("Escape");
      await wait(page, 600);
      const d2 = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("gtd-report-draft:")).map((k) => localStorage.getItem(k)).join(""));
      ok("report: highlight choice kept in the draft", /"highlights":\[/.test(d2), d2.match(/"highlights":[^\]]*\]?/)?.[0] ?? "");
    } else ok("report: 'Scegli attività' button found", false);
    await page.screenshot({ path: `${OUT}/report-edited.png` });
    // Leave the tab and come back: draft reopens
    await go(page, "#/board");
    await go(page, "#/report");
    await wait(page, 2000);
    const reopened = await page.evaluate(() => document.body.innerText.includes("QAEDIT") || [...document.querySelectorAll("[data-ed-id]")].some((e) => e.textContent.includes("QAEDIT")));
    ok("report: leaving the tab and coming back reopens the draft", reopened);
    await page.reload();
    await wait(page, 2500);
    ok("report: reload reopens the draft", await page.evaluate(() => [...document.querySelectorAll("[data-ed-id]")].some((e) => e.textContent.includes("QAEDIT"))));
    // Past-week draft: pick last week, edit, leave, return
    const sel = page.locator("main select").first();
    await sel.selectOption("1");
    await wait(page, 1500);
    const ed1 = page.locator("[data-ed-id][contenteditable=true]").first();
    if (await ed1.count()) {
      await ed1.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" LASTWEEK");
      await page.locator("main").click({ position: { x: 5, y: 5 } });
      await wait(page, 800);
    }
    const lastStage = await page.locator("main button", { hasText: "Scarica PDF" }).count();
    await go(page, "#/board");
    await go(page, "#/report");
    await wait(page, 1500);
    const selVal = await page.locator("main select").first().inputValue();
    const hasLW = await page.evaluate(() => document.body.innerText.includes("LASTWEEK"));
    info("report: past-week draft after leaving the tab", `stage after select=${lastStage ? "editing" : "setup"}; on return period=${selVal} (0=this week), LASTWEEK visible=${hasLW}`);
    await sel.selectOption("1").catch(() => {});
    await wait(page, 1500);
    const lwStage = await page.locator("main button", { hasText: "Scarica PDF" }).count();
    const hasLW2 = await page.evaluate(() => [...document.querySelectorAll("[data-ed-id]")].some((e) => e.textContent.includes("LASTWEEK")));
    info("report: re-selecting last week", `stage=${lwStage ? "editing" : "setup"}, LASTWEEK on page=${hasLW2}`);
    await sel.selectOption("0");
    await wait(page, 1500);
    // Download PDF (functions are aborted in the harness)
    const pdfBtn = page.locator("main button", { hasText: "Scarica PDF" }).first();
    if (await pdfBtn.count()) {
      const reqP = page.waitForRequest((r) => r.url().includes("/.netlify/functions/report-pdf"), { timeout: 8000 }).catch(() => null);
      await pdfBtn.click();
      const req = await reqP;
      await wait(page, 1500);
      const alert = await page.locator("main [role=alert]").allInnerTexts();
      ok("report: Download PDF POSTs to the function with a bearer token", !!req && req.method() === "POST" && /^Bearer /.test(req.headers()["authorization"] ?? ""));
      ok("report: PDF failure is reported in the UI", alert.length > 0, alert.join(" / ").replace(/\n/g, " ").slice(0, 200));
      const busy = await pdfBtn.isDisabled();
      ok("report: PDF button re-enabled after failure", !busy);
    } else ok("report: Scarica PDF button present when editing", false);
    // Reset (Ripristina)
    let dlg = null;
    page.once("dialog", (d) => { dlg = d.message(); d.accept(); });
    await page.locator("main button", { hasText: "Ripristina" }).first().click();
    await wait(page, 1500);
    const still = await page.evaluate(() => [...document.querySelectorAll("[data-ed-id]")].some((e) => e.textContent.includes("QAEDIT")));
    const dk = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("gtd-report-draft:")));
    ok("report: Ripristina throws the week's draft away", !still, `confirm()="${dlg}", drafts left=${dk.join(",")}`);
    // Close and Word download
    await page.locator("main button", { hasText: "Chiudi report" }).first().click().catch(() => {});
    await wait(page, 500);
    const dlP = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await page.locator("main button", { hasText: "Word (modello classico)" }).click();
    const dl = await dlP;
    await wait(page, 800);
    const werr = await page.locator("main [role=alert]").allInnerTexts();
    ok("report: Word (classic) downloads a .docx or says why", !!dl || werr.length > 0, dl ? dl.suggestedFilename() : werr.join(" / "));
    // Bad custom range
    await page.locator("main select").first().selectOption("custom");
    await wait(page, 300);
    const dates = page.locator("main input[type=date]");
    await dates.nth(0).fill("2026-11-30");
    await dates.nth(1).fill("2026-11-01").catch(() => {});
    await wait(page, 300);
    const bad = await page.locator("#report-bad-range").count();
    const genDisabled = await page.locator("main button", { hasText: "Genera report" }).isDisabled().catch(() => null);
    info("report: custom period from > to", `bad-range alert=${bad}, Generate disabled=${genDisabled}`);
    await context.close();
  }
  // Progetti esclusi: exclude a project via ×, view list, put back
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/report" });
    await page.locator("main button", { hasText: "Genera report" }).click();
    await wait(page, 2500);
    const px = page.locator(`button[aria-label="${"Escludi"}"], button.gr-hide[aria-label*="progett"], button.gr-hide[aria-label*="report"]`);
    const labels = await page.locator("button.gr-hide").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("aria-label")))]);
    info("report: × labels on cards", labels.join(" | "));
    const projX = page.locator('button.gr-hide[aria-label*="rogett"]');
    if (await projX.count()) {
      await projX.first().click({ force: true });
      await wait(page, 900);
      ok("report: project × writes report_hidden=true", db.projects.some((p) => p.report_hidden === true));
      const tab = await page.locator("[role=tab]", { hasText: "Progetti esclusi" }).innerText();
      ok("report: 'Progetti esclusi' shows a count", /\d/.test(tab), tab.replace(/\n/g, " "));
      await page.locator("[role=tab]", { hasText: "Progetti esclusi" }).click();
      await wait(page, 400);
      await page.locator("main button", { hasText: /Rimetti|report/i }).last().click();
      await wait(page, 800);
      ok("report: put back from Progetti esclusi clears report_hidden", db.projects.every((p) => !p.report_hidden));
    } else ok("report: project card has its own ×", false, "not found");
    // Empty excluded list
    const t = await mainText(page);
    info("report: excluded empty state", t.replace(/\n+/g, " | ").slice(0, 200));
    await context.close();
  }
  // Before migration 013: writes naming report_hidden fail with PGRST204
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/report" });
    for (const p of db.projects) delete p.report_hidden;
    await refuse(context, "projects", {
      status: 400,
      body: { code: "PGRST204", message: "Could not find the 'report_hidden' column of 'projects' in the schema cache", details: null, hint: null },
      match: (r) => (r.postData() ?? "").includes("report_hidden"),
    });
    await page.reload();
    await wait(page, 1200);
    await page.locator("main button", { hasText: /Genera report|Scarica PDF/ }).first().click();
    await wait(page, 2500);
    const projX = page.locator('button.gr-hide[aria-label*="rogett"]');
    if (await projX.count()) {
      await projX.first().click({ force: true });
      await wait(page, 2000);
      const alerts = await page.locator("main [role=alert]").allInnerTexts();
      const toast = await page.locator("[role=status]").allInnerTexts();
      ok("report pre-013: excluding a project says the migration is missing", alerts.some((a) => /013|migrazion/i.test(a)), `alerts=${alerts.join(" / ").replace(/\n/g, " ")}; toast=${toast.join(" / ").replace(/\n/g, " ")}`);
      await page.screenshot({ path: `${OUT}/report-pre013.png` });
    }
    // Excluded view before migration
    await page.locator("[role=tab]", { hasText: "Progetti esclusi" }).click();
    await wait(page, 400);
    info("report pre-013: Progetti esclusi view", (await mainText(page)).replace(/\n+/g, " | ").slice(0, 250));
    await context.close();
  }
  // Empty board
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/board" });
    db.tasks.length = 0;
    db.projects.length = 0;
    await go(page, "#/report");
    await page.reload();
    await wait(page, 1200);
    info("report: empty board", (await mainText(page)).replace(/\n+/g, " | ").slice(0, 300));
    await page.locator("main button", { hasText: "Genera report" }).click();
    await wait(page, 2500);
    await page.screenshot({ path: `${OUT}/report-empty.png`, fullPage: true });
    info("report: empty generated pages", `${await page.locator(".gr-page, [class*=gr-page]").count()} nodes`);
    await context.close();
  }
};

// ---------------------------------------------------------------- CALENDAR
groups.calendar = async () => {
  const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/calendario" });
  const t = await mainText(page);
  ok("calendar: month grid renders with dated tasks", /Retail Q3 Ambition/.test(t));
  const src = page.locator('button[aria-label^="VUB - spostare SB"]').first();
  const todayIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  await src.dragTo(page.locator("main [aria-current=date]").first());
  await wait(page, 700);
  const row = db.tasks.find((x) => x.title === "VUB - spostare SB");
  ok("calendar: drag onto a day sets due_date", row?.due_date === todayIso, `due_date=${row?.due_date}`);
  const toast = (await page.locator("[role=status]").allInnerTexts()).join(" ").replace(/\n/g, " ");
  ok("calendar: move toast with Undo", /Annulla/.test(toast), toast.slice(0, 120));
  await page.locator("[role=status] button", { hasText: "Annulla" }).first().click().catch(() => {});
  await wait(page, 600);
  ok("calendar: Undo clears the date again", !db.tasks.find((x) => x.title === "VUB - spostare SB")?.due_date);
  await page.locator('main button[aria-label^="Retail Q3 Ambition"]').first().click();
  await wait(page, 600);
  ok("calendar: click opens the details panel", (await page.locator('main button[aria-label*="hiudi"]').count()) > 0);
  await page.screenshot({ path: `${OUT}/calendar-details.png` });
  const oggi = page.locator("main button", { hasText: /^Oggi$/ });
  ok("calendar: Oggi disabled on the current month", await oggi.isDisabled());
  await page.locator('button[aria-label="Mese successivo"]').click();
  await wait(page, 300);
  ok("calendar: Oggi enabled on another month", !(await oggi.isDisabled()));
  await oggi.click();
  await wait(page, 300);
  ok("calendar: Oggi returns to this month", (await page.locator("main [aria-current=date]").count()) === 1);
  await refuse(context, "tasks");
  await page.locator('button[aria-label^="Mind Map macroambiti"]').first().dragTo(page.locator("main [aria-current=date]").first());
  await wait(page, 2000);
  const back = db.tasks.find((x) => x.title === "Mind Map macroambiti")?.due_date;
  const inCell = await page.locator('main [aria-current=date] button[aria-label^="Mind Map"]').count();
  const toast2 = (await page.locator("[role=status]").allInnerTexts()).join(" ").replace(/\n/g, " ");
  const errs = await errorsOnScreen(page);
  ok("calendar refused move: rolled back", !back && inCell === 0, `db=${back}, inCell=${inCell}`);
  ok("calendar refused move: UI says not saved", errs.length > 0, `toast says: "${toast2.slice(0, 100)}"; errors=${errs.join(" / ") || "none"}`);
  db.tasks.length = 0;
  await page.reload();
  await wait(page, 1200);
  info("calendar empty", (await mainText(page)).replace(/\n+/g, " | ").slice(0, 300));
  await context.close();
};

// ---------------------------------------------------------------- REFLECTION
groups.reflection = async () => {
  {
    const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/reflection" });
    let rpc = "wrong";
    const calls = [];
    await context.route(`${STUB_HOST}/rest/v1/rpc/reflection_*`, async (route) => {
      const fn = new URL(route.request().url()).pathname.split("/").pop();
      calls.push(fn + " " + route.request().postData());
      const body = fn === "reflection_change_password" ? (JSON.parse(route.request().postData()).p_current === "password" ? "ok" : "wrong") : rpc;
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    });
    const pwd = page.locator("main input[type=password]");
    const enter = page.locator("main button[type=submit]", { hasText: "Entra" });
    info("reflection: Entra with an empty password", `disabled=${await enter.isDisabled()}`);
    await pwd.fill("sbagliata");
    await enter.click();
    await wait(page, 600);
    const a1 = (await page.locator("main [role=alert]").allInnerTexts()).join(" ");
    ok("reflection: wrong password message", /errata/i.test(a1), a1);
    rpc = "locked";
    await pwd.fill("ancora");
    await enter.click();
    await wait(page, 600);
    const a2 = (await page.locator("main [role=alert]").allInnerTexts()).join(" ");
    ok("reflection: lockout message (RPC returns 'locked')", /5 minuti/.test(a2), a2);
    info("reflection: password field after a failed try", `value kept="${await pwd.inputValue()}"`);
    rpc = "unknown";
    await pwd.fill("x");
    await enter.click();
    await wait(page, 500);
    info("reflection: RPC 'unknown'", (await page.locator("main [role=alert]").allInnerTexts()).join(" "));
    rpc = "ok";
    await pwd.fill("password");
    await enter.click();
    await wait(page, 1000);
    const inside = await mainText(page);
    ok("reflection: correct password opens the diary", (await page.locator("main textarea").count()) >= 4, inside.replace(/\n+/g, " | ").slice(0, 200));
    await page.screenshot({ path: `${OUT}/reflection-in.png`, fullPage: true });
    const tas = page.locator("main textarea");
    for (let i = 0; i < 4; i++) await tas.nth(i).fill(`QA campo ${i}`);
    await page.locator("main button", { hasText: /^Salva/ }).first().click();
    await wait(page, 800);
    ok("reflection: entry saves to reflections", db.reflections.some((r) => r.done === "QA campo 0" && r.member === "Francesco"), JSON.stringify(db.reflections[0] ?? {}).slice(0, 120));
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    db.reflections.push(
      { id: "r1", member: "Francesco", date: d(1), done: "Ieri QA", well: "", improve: "", learning: "", created_at: 1, updated_at: 1 },
      { id: "r3", member: "Francesco", date: d(3), done: "Tre giorni QA", well: "", improve: "", learning: "", created_at: 1, updated_at: 1 },
      { id: "rx", member: "Chiara", date: d(1), done: "SEGRETO di Chiara", well: "", improve: "", learning: "", created_at: 1, updated_at: 1 }
    );
    await page.reload();
    await wait(page, 1500);
    const t3 = await mainText(page);
    ok("reflection: remembered login survives reload", !/Scegli il tuo nome/.test(t3));
    ok("reflection: spaced review shows the 1- and 3-day entries", /Ieri QA/.test(t3) && /Tre giorni QA/.test(t3));
    ok("reflection: another member's entry is not shown", !/SEGRETO di Chiara/.test(t3));
    const notesTab = page.locator("main button, main [role=tab]", { hasText: /^Note/ }).first();
    if (await notesTab.count()) {
      await notesTab.click();
      await wait(page, 500);
      const ta = page.locator("main textarea").first();
      await ta.fill("Nota QA");
      await page.locator("main button", { hasText: /Aggiungi/ }).first().click();
      await wait(page, 600);
      ok("notes: add saves to personal_notes", db.personal_notes.some((n) => n.body === "Nota QA"));
      await page.locator("main button", { hasText: /^Modifica/ }).first().click();
      await wait(page, 300);
      await page.locator("main textarea").nth(1).fill("Nota QA modificata");
      await page.locator("main button", { hasText: /^Salva/ }).first().click();
      await wait(page, 600);
      ok("notes: edit saves", db.personal_notes.some((n) => n.body === "Nota QA modificata"));
      // Since 2026-11-25: deleted at once, with Annulla (no confirm).
      const delNote = () => page.locator("main button", { hasText: /^Elimina$/ }).last().click();
      await delNote();
      await wait(page, 600);
      ok("notes: delete removes the note at once", db.personal_notes.length === 0);
      await page.locator("[role=status] button", { hasText: "Annulla" }).click();
      await wait(page, 700);
      ok("notes: Annulla brings the note back", db.personal_notes.some((n) => n.body === "Nota QA modificata"));
      await delNote();
      await wait(page, 600);
      await refuse(context, "personal_notes");
      await page.locator("main textarea").first().fill("Nota rifiutata");
      await page.locator("main button", { hasText: /Aggiungi/ }).first().click();
      await wait(page, 1500);
      const e = await errorsOnScreen(page);
      ok("notes refused add: UI says so", e.length > 0, e.join(" / "));
      info("notes refused add: typed text kept for retry", String(await page.evaluate(() => [...document.querySelectorAll("textarea")].some((x) => x.value === "Nota rifiutata"))));
      await page.reload();
      await wait(page, 1200);
      ok("reflection: reopens on the Notes pane used last", (await page.locator("main textarea").count()) < 4);
    } else ok("reflection: Diary/Notes switch present", false);
    const diary = page.locator("main button, main [role=tab]", { hasText: /^Diario/ }).first();
    if (await diary.count()) { await diary.click(); await wait(page, 400); }
    const cur = page.locator("#refl-pwd-cur");
    if (await cur.count()) {
      await cur.fill("sbagliata");
      await page.locator("#refl-pwd-new").fill("nuova123");
      await page.locator("#refl-pwd-new").press("Enter");
      await wait(page, 800);
      const m1 = (await page.locator("main [role=alert], main [role=status]").allInnerTexts()).join(" ");
      ok("reflection: change password with a wrong current one is refused", /attuale non è corretta/.test(m1), m1.replace(/\n/g, " ").slice(0, 120));
      await cur.fill("password");
      await page.locator("#refl-pwd-new").fill("abc");
      await page.locator("#refl-pwd-new").press("Enter");
      await wait(page, 800);
      const m2 = (await page.locator("main [role=alert], main [role=status]").allInnerTexts()).join(" ");
      info("reflection: new password 'abc' (hint says 6–72)", m2.replace(/\n/g, " ").slice(0, 160) + " | change rpc calls=" + calls.filter((c) => c.startsWith("reflection_change")).length);
    } else ok("reflection: change-password form found", false);
    await context.close();
  }
  {
    const { context, page } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/reflection" });
    await context.route(`${STUB_HOST}/rest/v1/rpc/reflection_login`, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code: "PGRST202", message: "Could not find the function public.reflection_login" }) }));
    await page.locator("main input[type=password]").fill("x");
    await page.locator("main button[type=submit]").click();
    await wait(page, 700);
    info("reflection pre-011", (await page.locator("main [role=alert]").allInnerTexts()).join(" "));
    await context.setOffline(true);
    await page.locator("main input[type=password]").fill("y");
    await page.locator("main button[type=submit]").click();
    await wait(page, 1500);
    info("reflection offline login", (await page.locator("main [role=alert]").allInnerTexts()).join(" "));
    await context.close();
  }
};

// ---------------------------------------------------------------- PRODUCTS
groups.products = async () => {
  const { context, page } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/products" });
  const s = page.locator("main input[type=search]");
  await s.fill("leasing");
  await wait(page, 600);
  ok("products: search finds 'leasing'", /leasing/i.test(await mainText(page)));
  await s.fill("zzzqqq");
  await wait(page, 600);
  info("products: no-match state", (await mainText(page)).replace(/\n+/g, " | ").slice(0, 700));
  await s.fill("carta");
  await wait(page, 600);
  info("products: Italian query 'carta'", (await mainText(page)).replace(/\n+/g, " | ").slice(0, 700));
  await s.fill("");
  await page.locator("main button", { hasText: "Chiudi tutto" }).click();
  await wait(page, 300);
  const nOpen = await page.locator("main button[aria-expanded=true]").count();
  await page.locator("main button", { hasText: "Espandi tutto" }).click();
  await wait(page, 300);
  const nOpen2 = await page.locator("main button[aria-expanded=true]").count();
  ok("products: Espandi/Chiudi tutto", nOpen2 > nOpen, `${nOpen} -> ${nOpen2} expanded`);
  await page.locator("main button", { hasText: /^NPL/ }).click();
  await wait(page, 300);
  info("products: NPL tag filter", (await page.locator("main button[aria-pressed=true]").allInnerTexts()).join(",").replace(/\n/g, " ") + " pressed");
  await page.locator("main button", { hasText: /SCHEMA DI REPORTING/i }).first().click({ timeout: 5000 }).catch(() => info("products: section switch", "button not found after a tag filter"));
  await wait(page, 400);
  await page.screenshot({ path: `${OUT}/products-schema.png` });
  info("products: after section switch", page.url());
  await context.close();
};

// ---------------------------------------------------------------- MUSIC
groups.music = async () => {
  const { context, page } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/music" });
  await wait(page, 1500);
  const t = await mainText(page);
  info("music: visible messages", (t.match(/[^|\n]*(offline|riprova|non disponibil|errore|connession)[^|\n]*/gi) ?? []).slice(0, 4).join(" / "));
  const online = await page.evaluate(() => navigator.onLine);
  ok("music: does not claim 'offline' while the browser is online", !(online && /Sei offline/.test(t)), `navigator.onLine=${online}`);
  await page.screenshot({ path: `${OUT}/music-home.png` });
  await context.close();
};

// ---------------------------------------------------------------- SETTINGS
groups.settings = async () => {
  const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/settings" });
  const fileInputs = page.locator("main input[type=file]");
  await fileInputs.nth(0).setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await wait(page, 600);
  const e1 = (await mainText(page)).match(/[^\n]*(immagine|image|valid|support|formato)[^\n]*/gi)?.join(" / ");
  ok("settings: non-image logo refused with a message", !db.board_meta[0].logo_url, e1);
  await fileInputs.nth(0).setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 10, 1) });
  await wait(page, 800);
  const e2 = (await mainText(page)).match(/[^\n]*(troppo grand|too big|too large|MB)[^\n]*/gi)?.join(" / ");
  ok("settings: >5 MB logo refused with 'too big'", /troppo/i.test(e2 ?? ""), e2);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await fileInputs.nth(0).setInputFiles({ name: "ok.png", mimeType: "image/png", buffer: png });
  await wait(page, 1200);
  ok("settings: valid logo is saved and the error clears", !!db.board_meta[0].logo_url && !/troppo grand/i.test(await mainText(page)), (db.board_meta[0].logo_url ?? "").slice(0, 30));
  await page.locator("#team-pwd-cur").fill("vecchia");
  await page.locator("#team-pwd-new").fill("corta");
  await page.locator("#team-pwd-new2").fill("corta");
  await page.locator("#team-pwd-new2").press("Enter");
  await wait(page, 300);
  const m1 = (await page.locator("main [role=alert]").allInnerTexts()).join(" ");
  ok("settings: team password under 12 chars refused", /12/.test(m1), m1);
  await page.locator("#team-pwd-new").fill("abcdefghijkl1");
  await page.locator("#team-pwd-new2").fill("abcdefghijkl2");
  await page.locator("#team-pwd-new2").press("Enter");
  await wait(page, 300);
  const m2 = (await page.locator("main [role=alert]").allInnerTexts()).join(" ");
  ok("settings: mismatched confirmation refused", m2.length > 0, m2);
  await context.route(`${STUB_HOST}/auth/v1/token*`, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials", message: "Invalid login credentials" }) }));
  await page.locator("#team-pwd-new2").fill("abcdefghijkl1");
  await page.locator("#team-pwd-new2").press("Enter");
  await wait(page, 1500);
  const m3 = (await page.locator("main [role=alert]").allInnerTexts()).join(" ");
  ok("settings: wrong current team password refused", m3.length > 0, m3);
  await wait(page, 1500);
  ok("settings: a wrong current password does not log this device out", !/Accesso team/i.test(await bodyText(page)));
  await context.unroute(`${STUB_HOST}/auth/v1/token*`);
  const days = page.locator("main input[type=number]");
  for (const v of ["0", "500", "-3", "7"]) {
    await days.fill(v).catch(() => {});
    const btn = page.locator("main input[type=number] ~ button, main input[type=number] + button").first();
    const dis = await btn.isDisabled().catch(() => null);
    if (!dis) { await btn.click().catch(() => {}); await wait(page, 500); }
    info(`settings: login days '${v}'`, `Save disabled=${dis}, saved login_days=${db.board_meta[0].login_days}, field now="${await days.inputValue()}"`);
  }
  await refuse(context, "board_meta");
  await page.locator("#settings-sub-it").fill("Sottotitolo QA");
  await page.locator("#settings-sub-it").press("Enter");
  await wait(page, 1800);
  const m4 = (await mainText(page)).match(/[^\n]*(Non salvat|Salvat)[^\n]*/g);
  ok("settings refused subtitle: says 'not saved'", !!m4?.some((x) => /Non salvat/.test(x)), (m4 ?? []).join(" / "));
  await context.unroute(`${STUB_HOST}/rest/v1/board_meta*`);
  await page.locator("main button", { hasText: "Esci da questo dispositivo" }).click();
  await wait(page, 300);
  info("settings: logout confirm focus", `focused="${await page.evaluate(() => document.activeElement?.textContent?.trim())}"`);
  await page.locator("main button", { hasText: /^Sì$/ }).click();
  await wait(page, 1500);
  const ls = await page.evaluate(() => Object.keys(localStorage).join(","));
  ok("settings: log out returns to the login screen", /Accesso team/i.test(await bodyText(page)), `localStorage keys: ${ls}`);
  ok("settings: log out removes session and report drafts", !/gtd-session|gtd-report-draft/.test(ls));
  await context.close();
};

// ---------------------------------------------------------------- AUTH
groups.auth = async () => {
  const { context, page } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/weekly" });
  await page.evaluate(() => { localStorage.removeItem("gtd-session"); localStorage.removeItem("gtd-auth"); });
  await context.route(`${STUB_HOST}/auth/v1/token*`, (route) => {
    const pw = JSON.parse(route.request().postData() ?? "{}").password;
    if (pw === "giusta-password") return route.fallback();
    return route.fulfill({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }) });
  });
  await page.reload();
  await wait(page, 1500);
  ok("auth: without a session the login screen shows", /Accesso team/i.test(await bodyText(page)));
  const pw = page.locator("input[type=password]");
  ok("auth: password field focused on load", await pw.evaluate((e) => e === document.activeElement));
  info("auth: language switch on the login screen", (await page.locator("button", { hasText: /^EN$|^IT$/ }).count()) ? "present" : "absent");
  await pw.fill("sbagliata");
  await pw.press("Enter");
  await wait(page, 1000);
  const a = (await page.locator("[role=alert]").allInnerTexts()).join(" ");
  ok("auth: wrong password message", /Password errata/.test(a), a);
  ok("auth: field marked invalid", (await pw.getAttribute("aria-invalid")) === "true");
  await page.screenshot({ path: `${OUT}/auth-wrong.png` });
  await pw.fill("giusta-password");
  await pw.press("Enter");
  await wait(page, 2500);
  ok("auth: right password opens the app on the address asked for", (await page.locator("nav[aria-label]").count()) > 0 && /#\/weekly/.test(page.url()), page.url());
  await context.close();
};

// ---------------------------------------------------------------- ROUTES
groups.routes = async () => {
  {
    const { context, page } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/board" });
    // Six places since 2026-11-25: SETTIMANA holds Weekly | Report | Mail.
    const tab = (name) => page.locator("nav[aria-label] button", { hasText: name }).first().click();
    const week = (name) => page.locator('[role=group][aria-label="SETTIMANA"] button', { hasText: name }).click();
    await tab("SETTIMANA"); await wait(page, 400);
    await week("Report"); await wait(page, 400);
    await tab("CALENDARIO"); await wait(page, 400);
    ok("routes: tab clicks write the address", page.url().endsWith("#/calendario"), page.url());
    const at = () => page.url().split("#")[1];
    await page.goBack(); await wait(page, 400);
    const cur1 = at();
    await page.goBack(); await wait(page, 400);
    const cur2 = at();
    await page.goForward(); await wait(page, 400);
    const cur3 = at();
    const navNow = await page.locator("nav[aria-label] button[aria-current=page]").innerText();
    ok("routes: Back/Back/Forward = report, weekly, report (nav: SETTIMANA)", cur1 === "/report" && cur2 === "/weekly" && cur3 === "/report" && navNow === "SETTIMANA", `${cur1},${cur2},${cur3} ${navNow}`);
    ok("routes: document.title names the section", /Report/i.test(await page.title()), await page.title());
    await go(page, "#/projects/p1");
    const projName = () => page.evaluate(() => [...document.querySelectorAll("main textarea")].some((e) => e.value === "Pricing 2027"));
    ok("routes: #/projects/p1 opens the project page", await projName());
    await page.reload(); await wait(page, 1200);
    ok("routes: reload keeps the open project", /#\/projects\/p1$/.test(page.url()) && (await projName()));
    await go(page, "#/nonesiste");
    ok("routes: unknown address falls back to the board", /#\/board$/.test(page.url()), page.url());
    await go(page, "#/projects/zzz");
    info("routes: unknown project id", `${page.url()} — ${(await mainText(page)).replace(/\n+/g, " | ").slice(0, 120)}`);
    // Mail: on the desktop a page (SETTIMANA › Mail) since 2026-11-25; the
    // header button opens it, Back returns to where you were.
    await go(page, "#/weekly");
    const mailBtn = page.locator("header button", { hasText: /Mail|mail/ }).first();
    if (await mailBtn.count()) {
      await mailBtn.click(); await wait(page, 500);
      const open1 = /#\/mail$/.test(page.url()) && (await page.locator("main textarea").count()) > 0;
      await page.goBack(); await wait(page, 500);
      ok("routes: the header's mail button opens SETTIMANA › Mail, Back returns", open1 && /#\/weekly$/.test(page.url()), page.url());
    } else info("routes: mail button", "not found in header");
    // Switch layout: desktop -> phone
    for (const [from, want] of [["#/weekly", "#/more/weekly"], ["#/calendario", "#/agenda"], ["#/projects/p1", "#/projects/p1"], ["#/reflection", "#/more/reflection"], ["#/music", "#/more"]]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await go(page, from);
      await page.setViewportSize({ width: 390, height: 844 });
      await wait(page, 1500);
      const sheet = await page.locator(".m-sheet, [role=dialog]").count();
      const got = page.url().replace(/^.*#/, "#");
      ok(`routes: desktop ${from} -> phone keeps the place`, got === want || (from === "#/projects/p1" && sheet > 0), `${got}${sheet ? " (sheet open)" : ""}`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await wait(page, 1200);
      info(`routes: … and back to desktop`, page.url().replace(/^.*#/, "#"));
    }
    await context.close();
  }
  // Phone
  {
    const { context, page } = await openApp(browser, { skin: "glass", appearance: "dark", path: "#/today", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const dock = page.locator("nav.m-dock");
    await dock.locator("button", { hasText: /Board/ }).click(); await wait(page, 400);
    await dock.locator("button", { hasText: /Agenda/ }).click(); await wait(page, 400);
    const u1 = page.url();
    await page.goBack(); await wait(page, 400);
    ok("routes phone: Back from Agenda goes to Board", /#\/board$/.test(page.url()), `${u1} -> ${page.url()}`);
    // open a task sheet
    await page.locator(".m-card button, [class*=m-card] button").filter({ hasText: /\w{4,}/ }).first().click().catch(() => {});
    await wait(page, 700);
    const sheets = await page.locator("[role=dialog]").count();
    await page.goBack(); await wait(page, 700);
    ok("routes phone: Back closes the task sheet first", sheets > 0 && (await page.locator("[role=dialog]").count()) === 0 && /#\/board$/.test(page.url()), `sheets=${sheets}, url=${page.url()}`);
    await page.locator('button[aria-label="Altro"], button[aria-label="More"]').first().click(); await wait(page, 500);
    await page.locator("main button, .m-row, button", { hasText: /^Weekly/ }).first().click().catch(() => {});
    await wait(page, 600);
    ok("routes phone: Altro -> Weekly is #/more/weekly", /#\/more\/weekly$/.test(page.url()), page.url());
    await page.goBack(); await wait(page, 500);
    ok("routes phone: Back returns to #/more", /#\/more$/.test(page.url()), page.url());
    await page.setViewportSize({ width: 1440, height: 900 });
    await go(page, "#/more/weekly");
    await wait(page, 800);
    info("routes phone: #/more/weekly at desktop width", page.url());
    await go(page, "#/today");
    info("routes phone: #/today at desktop width", page.url());
    await context.close();
  }
};

// ---------------------------------------------------------------- LANGUAGE
const IT_WORDS = /\b(attivit[àa]|settimana|progett\w*|salva|annulla|aggiungi|nessun\w*|cerca|chiudi|oggi|domani|ieri|scadenz\w*|priorit[àa]|completat\w*|riprova|elimina|modifica|questa|della|delle|degli|sono|anche|per sempre|giorn\w+|mese|password del team|esci)\b/gi;
const EN_WORDS = /\b(the|and|with|save|cancel|undo|search|week|project\w*|task\w*|today|tomorrow|delete|edit|close|nothing|empty|loading|error|settings|highlights?|recap|wins|focus|learnings?)\b/gi;
groups.lang = async () => {
  const TABS = ["#/board", "#/projects", "#/projects/p1", "#/weekly", "#/report", "#/products", "#/calendario", "#/reflection", "#/music", "#/settings"];
  for (const lang of ["en", "it"]) {
    const { context, page } = await openApp(browser, { skin: "glass", appearance: "light", path: "#/board", lang });
    for (const p of TABS) {
      await go(page, p);
      if (p === "#/report") { await page.locator("main button").filter({ hasText: /Generate report|Genera report/ }).click().catch(() => {}); await wait(page, 2000); }
      const txt = await page.evaluate(() => {
        const out = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
          const n = walk.currentNode; const el = n.parentElement;
          if (!el || !n.textContent.trim()) continue;
          if (el.closest("script,style,[data-ed-id] .x,.mt-title,.gr-task-title")) continue;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          out.push(n.textContent.trim());
        }
        for (const e of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
          const r = e.getBoundingClientRect(); if (!r.width) continue;
          for (const a of ["aria-label", "title", "placeholder"]) if (e.getAttribute(a)) out.push("@" + a + ":" + e.getAttribute(a));
        }
        return [...new Set(out)];
      });
      const seed = /Pivot|Retail|Report settimanale|Backup|Completare|Efficientare|Cambiare|VUB|BU_|Integrazione|Chief|Mind Map|Allineamento|Chiusura|Review KPI|Presentazione|Pricing|Chiusure|Nuovo modello|Consegna|Attesa dati|Chiudere pricing|Francesco|Chiara|Gonzalo|Gualberto|TEAM GTD|Bacheca del team|Team board|^[A-Z0-9 &,.()–\-\/·]+$/;
      const re = lang === "en" ? IT_WORDS : EN_WORDS;
      const hits = txt.filter((s) => !seed.test(s) && s.match(re) && !(lang === "it" && /^(Backlog|Next|In Progress|Waiting|Done|Maybe|Focus P1|Report|Weekly|Live|Recap)$/i.test(s)));
      if (hits.length) info(`lang ${lang.toUpperCase()} ${p}`, hits.slice(0, 12).map((h) => h.slice(0, 70)).join(" ‖ "));
    }
    await context.close();
  }
};

// ---------------------------------------------------------------- OFFLINE
// Offline, an edit is refused up front (it used to look saved, then vanish):
// the board is unchanged, nothing is sent, and the toast says so. The badge
// reads Offline, and Live again once the connection is back. (Opening the
// installed app offline needs the service worker: scripts/ux/offline-pwa.mjs
// against a production build.)
groups.offline = async () => {
  const app = await openApp(browser, { skin: "classic", appearance: "light", path: "#/weekly" });
  const { page, db, store } = app;
  const badge = () => page.locator("header [role=status]").first().innerText().catch(() => "?");
  const badge0 = await badge();
  await goOffline(app, true);
  await wait(page, 1500);
  const badge1 = await badge();
  ok("offline: the badge says Offline", /Offline/.test(badge1), `online="${badge0.trim()}" -> offline="${badge1.trim()}"`);
  const writes0 = store.log.length;
  const inp = page.locator('input[aria-label="Vittorie: Aggiungi…"]');
  await inp.fill("Scritto offline");
  await inp.press("Enter");
  await wait(page, 800);
  const shown = await page.evaluate(() => [...document.querySelectorAll("textarea")].some((e) => e.value === "Scritto offline"));
  const toast = await page.locator("[data-undo-toast]").innerText().catch(() => "");
  ok("offline: a weekly item added offline is not shown as added", !shown);
  ok("offline: the toast says the change was not made, offline", /non fatta: sei offline/i.test(toast), toast);
  ok("offline: nothing was sent", store.log.length === writes0);
  await page.screenshot({ path: `${OUT}/offline-weekly.png` });
  await goOffline(app, false);
  const live = await page
    .waitForFunction(() => /Live/.test(document.querySelector("header [role=status]")?.textContent ?? ""), null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  ok("offline: back online, the badge says Live by itself", live, (await badge()).trim());
  ok("offline: the refused item never reached the server", !db.weekly.some((r) => r.body === "Scritto offline"));
  await app.context.close();
  // phone offline
  const ph = await openApp(browser, { skin: "glass", appearance: "dark", path: "#/today", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await goOffline(ph, true);
  await wait(ph.page, 1500);
  const head = (await ph.page.locator(".m-header__title p").first().innerText().catch(() => "")).trim();
  ok("offline phone: the header says Offline", /Offline/.test(head), head);
  await ph.page.screenshot({ path: `${OUT}/offline-phone.png` });
  await goOffline(ph, false);
  const phLive = await ph.page
    .waitForFunction(() => /Live/.test(document.querySelector(".m-header__title p")?.textContent ?? ""), null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  ok("offline phone: back online, Live by itself", phLive);
  await ph.context.close();
};

// ---------------------------------------------------------------- BOARD (refused writes)
groups.board = async () => {
  const { context, page, db } = await openApp(browser, { skin: "classic", appearance: "light", path: "#/board" });
  await refuse(context, "tasks");
  const qa = page.locator('main input[placeholder="Nuova attività…"]').first();
  const ph = await qa.getAttribute("placeholder");
  await qa.fill("Task rifiutato QA");
  await qa.press("Enter");
  await wait(page, 300);
  const opt = (await mainText(page)).includes("Task rifiutato QA");
  await wait(page, 2000);
  const after = (await mainText(page)).includes("Task rifiutato QA");
  const errs = await errorsOnScreen(page);
  ok("board refused add: rolled back", !after, `field="${ph}", optimistic=${opt}`);
  ok("board refused add: UI says it was not saved", errs.length > 0, errs.join(" / ") || "nothing on screen");
  await page.screenshot({ path: `${OUT}/board-refused.png` });
  await context.close();
};

// ---------------------------------------------------------------- BOARD TOP AREA (measurements)
groups.boardtop = async () => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    for (const c of [{ name: "classic", skin: "classic", appearance: "light" }, { name: "glass", skin: "glass", appearance: "dark" }]) {
      const { page, context } = await openApp(browser, { ...c, viewport: vp, path: "#/board" });
      await wait(page, 1000);
      const card = () => page.evaluate(() => {
        const leaf = [...document.querySelectorAll("main *")].find((e) => e.children.length === 0 && e.textContent.trim() === "VUB - spostare SB");
        let el = leaf; while (el && el.getBoundingClientRect().height < 50) el = el.parentElement;
        let col = el?.parentElement; while (col && !/backlog/i.test(col.firstElementChild?.textContent ?? "")) col = col.parentElement;
        const blocks = [...document.querySelector("main").firstElementChild.children].map((e) => {
          const b = e.getBoundingClientRect();
          return `y=${Math.round(b.top)} h=${Math.round(b.height)} ${(e.innerText || "").replace(/\s+/g, " ").slice(0, 28)}`;
        });
        const cb = col?.getBoundingClientRect();
        return { card: Math.round(el.getBoundingClientRect().top), col: cb && Math.round(cb.top), colVis: cb && Math.max(0, Math.round(Math.min(cb.bottom, innerHeight) - cb.top)), colH: cb && Math.round(cb.height), blocks };
      });
      const r = await card();
      info(`boardtop ${vp.width}x${vp.height} ${c.name}`, `first column y=${r.col} (visible ${r.colVis}/${r.colH}px), first card y=${r.card}, fold=${vp.height}`);
      for (const b of r.blocks.slice(0, 5)) console.log("        " + b);
      await page.locator("main section button[aria-expanded=true]").first().click().catch(() => {});
      await wait(page, 400);
      info(`boardtop ${vp.width}x${vp.height} ${c.name}`, `with In evidenza collapsed: first card y=${(await card()).card}`);
      await context.close();
    }
  }
};

for (const [name, fn] of Object.entries(groups)) {
  if (only && !only.includes(name)) continue;
  console.log(`\n### ${name}`);
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}: threw — ${String(e.message).split("\n")[0]}`);
  }
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
