// Keyboard-only walk through the app's main flows. No mouse is used: every
// step is Tab / Shift+Tab / Enter / Space / Escape / arrows / typing.
// For every focus stop it logs: tag, role and accessible name (from Chromium's
// accessibility tree via CDP), and whether a focus indicator is visible — the
// element (and its .field wrapper) is screenshotted focused and unfocused and
// the changed pixels are compared (count, and how many change by >= 3:1).
//
// Usage: node scripts/ux/keyboard.mjs [desktop|phone|all] [combo] [--sweep]
//   --sweep  also focus every focusable element on the main screens and report
//            the ones whose focus indicator is invisible or below 3:1.
// Output: a readable log on stdout, and KB_JSON=<file> writes the raw stops.
import { launch, openApp, COMBOS } from "./stub.mjs";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args.find((a) => ["desktop", "phone", "all"].includes(a)) ?? "all";
const comboName = args.find((a) => COMBOS.some((c) => c.name === a)) ?? "classic";
const SWEEP = args.includes("--sweep");
// --fast: flows only, no focus-indicator screenshots (the sweep covers those).
const FAST = args.includes("--fast");
const combo = COMBOS.find((c) => c.name === comboName);
const all = [];
const problems = [];
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Focus probe
// ---------------------------------------------------------------------------
async function setup(page) {
  await page.addStyleTag({ content: "*{caret-color:transparent!important}" }).catch(() => {});
  await page.evaluate(() => {
    if (document.getElementById("__kb_neutral")) return;
    const n = document.createElement("div");
    n.id = "__kb_neutral";
    n.tabIndex = -1;
    n.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px";
    document.body.appendChild(n);
  });
}

async function axOf(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: "document.activeElement" });
  if (!result.objectId) return { role: "?", name: "" };
  try {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false });
    const n = nodes.find((x) => !x.ignored) ?? nodes[0];
    return { role: n?.role?.value ?? "?", name: (n?.name?.value ?? "").replace(/\s+/g, " ").trim() };
  } catch {
    return { role: "?", name: "" };
  }
}

// Pixel comparison of the focused vs unfocused element, in the page (canvas).
async function indicator(page) {
  if (FAST) return { verdict: "-" };
  // A date input is several Tab stops (dd/mm/yyyy) and focus() resets it to the
  // first one: check it once, then let Tab walk its segments untouched.
  const seg = await page.evaluate(() => {
    const el = document.activeElement;
    if (el?.type !== "date") return false;
    if (window.__kbDate === el) return true;
    window.__kbDate = el;
    return false;
  });
  if (seg) return { verdict: "segment" };
  const box = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el.id === "__kb_neutral") return null;
    const wrap = el.closest(".field, .task-card") && el.closest(".field") ? el.closest(".field") : el;
    const r1 = el.getBoundingClientRect();
    const r2 = wrap.getBoundingClientRect();
    const x = Math.min(r1.left, r2.left) - 6, y = Math.min(r1.top, r2.top) - 6;
    const w = Math.max(r1.right, r2.right) + 6 - x, h = Math.max(r1.bottom, r2.bottom) + 6 - y;
    // Obscured? The centre of the control should be the control itself.
    const cx = r1.left + r1.width / 2, cy = r1.top + r1.height / 2;
    const inView = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    const covered = inView && hit && !el.contains(hit) && !hit.contains(el) && !(el.labels && [...el.labels].some((l) => l.contains(hit)));
    return {
      x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, innerWidth), h: Math.min(h, innerHeight),
      ew: r1.width, eh: r1.height, inView,
      covered: covered ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0]}` : "",
    };
  });
  if (!box || box.w < 2 || box.h < 2 || !box.inView) return { verdict: box ? "offscreen" : "none", box };
  const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
  await page.waitForTimeout(220); // transitions (field 120 ms, glass rim 160 ms)
  const a = await page.screenshot({ clip });
  await page.evaluate(() => {
    window.__kbEl = document.activeElement;
    document.getElementById("__kb_neutral").focus({ preventScroll: true });
  });
  await page.waitForTimeout(220);
  const b = await page.screenshot({ clip });
  await page.evaluate(() => window.__kbEl?.isConnected && window.__kbEl.focus({ preventScroll: true }));
  const res = await page.evaluate(
    async ([a, b]) => {
      const load = (s) =>
        new Promise((ok) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.src = "data:image/png;base64," + s;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const A = px(ia), B = px(ib);
      const lum = (r, g, b) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      let changed = 0, ge3 = 0, max = 1;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d < 24) continue;
        changed++;
        const la = lum(A[i], A[i + 1], A[i + 2]), lb = lum(B[i], B[i + 1], B[i + 2]);
        const cr = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        if (cr >= 3) ge3++;
        if (cr > max) max = cr;
      }
      return { changed, ge3, max: +max.toFixed(2), w: ia.width, h: ia.height };
    },
    [a.toString("base64"), b.toString("base64")]
  );
  // WCAG 2.4.11 (2.2 draft) / 2.4.13: an area at least as large as a 1 CSS px
  // perimeter of the control, changing by >= 3:1.
  const perim = 2 * (box.ew + box.eh);
  const verdict = res.changed === 0 ? "INVISIBLE" : res.ge3 >= perim ? "ok" : res.ge3 >= perim * 0.5 ? "thin" : "WEAK";
  return { verdict, ...res, perim: Math.round(perim), covered: box.covered };
}

let ctxName = "";
async function stop(page, cdp, flow, note = "") {
  const ax = await axOf(cdp);
  const meta = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { tag: "-", inSheet: false };
    return {
      tag: el.tagName.toLowerCase() + (el.type && el.tagName === "INPUT" ? `[${el.type}]` : ""),
      cls: String(el.className).split(" ").slice(0, 2).join("."),
      inDialog: !!el.closest('[role="dialog"]'),
      body: el === document.body,
    };
  });
  const ind = meta.body ? { verdict: "BODY" } : await indicator(page);
  const row = { ctx: ctxName, flow, ...meta, role: ax.role, name: ax.name, ind: ind.verdict, px: ind.changed, ge3: ind.ge3, max: ind.max, perim: ind.perim, covered: ind.covered, note };
  all.push(row);
  // Body after the last control is the normal wrap; body after an action is lost focus.
  const flag = ["INVISIBLE", "WEAK"].includes(ind.verdict) || ind.covered || (meta.body && note) ? " <!>" : "";
  say(
    `   ${String(all.filter((r) => r.flow === flow && r.ctx === ctxName).length).padStart(3)}. ${meta.tag.padEnd(14)} ${String(ax.role).padEnd(12)} "${ax.name.slice(0, 60)}"` +
      `  [${ind.verdict}${ind.changed !== undefined ? ` ${ind.ge3}/${ind.changed}px≥3:1 max ${ind.max}` : ""}${ind.covered ? ` covered by ${ind.covered}` : ""}]${meta.inDialog ? " (dialog)" : ""}${note ? "  " + note : ""}${flag}`
  );
  if (flag) problems.push(`${ctxName} / ${flow}: ${meta.tag} "${ax.name.slice(0, 50)}" ${ind.verdict}${ind.covered ? " covered by " + ind.covered : ""}`);
  return row;
}

async function tab(page, cdp, flow, n = 1, shift = false) {
  let last;
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    last = await stop(page, cdp, flow);
  }
  return last;
}

/** Tab until the focused element's accessible name matches re (max steps). */
async function tabTo(page, cdp, flow, re, max = 80, { shift = false, quiet = false } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    if (quiet) {
      const ax = await axOf(cdp);
      if (re.test(ax.name)) return stop(page, cdp, flow, "(target)");
      continue;
    }
    const r = await stop(page, cdp, flow);
    if (re.test(r.name)) return r;
  }
  problems.push(`${ctxName} / ${flow}: could not reach ${re} by Tab in ${max} steps`);
  say(`   !! not reached: ${re}`);
  return null;
}

const focusedName = async (cdp) => (await axOf(cdp)).name;
const check = (ok, flow, msg) => {
  say(`   ${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) problems.push(`${ctxName} / ${flow}: FAIL ${msg}`);
};
async function fresh(page, path) {
  // A full reload puts the sequential-focus starting point back at the top.
  // The dev server hot-reloads while others edit: wait out an error overlay.
  for (let i = 0; i < 6; i++) {
    await page.goto(page.url().split("#")[0] + path);
    await page.reload();
    await page.waitForSelector("main, .m-app", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(900);
    if (!(await page.$("vite-error-overlay"))) break;
    say("   (vite error overlay: someone's edit is mid-way; retrying in 5 s)");
    await page.waitForTimeout(5000);
  }
  await setup(page);
}

// ---------------------------------------------------------------------------
// Desktop flows
// ---------------------------------------------------------------------------
async function desktop(browser) {
  ctxName = `desktop ${combo.name}`;
  const { page, context, db } = await openApp(browser, { ...combo, viewport: { width: 1440, height: 900 } });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  let f;

  f = "1 add task (new-task bar)";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  await tabTo(page, cdp, f, /^Nuova attività/i, 60);
  await page.keyboard.type("KB nuova attività");
  // walk the rest of the bar, logging it
  await tabTo(page, cdp, f, /^\+? ?aggiungi/i, 30);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check(db.tasks.some((r) => r.title === "KB nuova attività"), f, "task created from the keyboard");
  say(`   focus after add: "${await focusedName(cdp)}"`);

  f = "2 open card, edit, Ripeti, ★, Escape";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  await tabTo(page, cdp, f, /Completare check vs TBD/i, 120, { quiet: true });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const t0 = await tab(page, cdp, f, 1); // into the editor
  // title field: replace text, Enter saves
  if (/titolo/i.test(t0?.name ?? "") || t0?.tag === "textarea" || t0?.tag?.startsWith("input")) {
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Completare check KB");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const lost = await page.evaluate(() => document.activeElement === document.body);
    check(!lost, f, "focus stays in the editor after Enter saves the title");
    if (lost) {
      const nx = await page.evaluate(() => document.activeElement.tagName);
      await page.keyboard.press("Tab");
      await stop(page, cdp, f, "(first Tab after Enter in the title)");
      // get back to the open card without the mouse
      await tabTo(page, cdp, f, /Chiudi dettagli|Hide details|Collapse/i, 120, { quiet: true });
    }
  }
  const rip = await tabTo(page, cdp, f, /^Ripeti/i, 40);
  if (rip) {
    const before = db.tasks.find((r) => r.id === "5")?.recurrence;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    const after = db.tasks.find((r) => r.id === "5")?.recurrence;
    check(!before && !!after, f, `Ripeti set with ArrowDown on the closed select (recurrence=${JSON.stringify(after)})`);
  }
  await tab(page, cdp, f, 1, true); // back to the star
  const star = await focusedName(cdp);
  if (/evidenza/i.test(star)) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    check(db.tasks.find((r) => r.id === "5")?.pinned === true, f, `★ toggled with Space ("${star}")`);
  } else say(`   (star not right before Ripeti: "${star}")`);
  await tab(page, cdp, f, 6); // walk on (staying inside the editor): subtasks, description, …
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const a = document.activeElement;
    return { cls: String(a?.className ?? ""), exp: a?.getAttribute("aria-expanded"), text: a?.textContent?.trim().slice(0, 40) };
  });
  check(back.cls.includes("card-head") && back.exp === "false", f, `Escape closes and focus returns to the card title (now on "${back.text}")`);
  check(db.tasks.find((r) => r.id === "5")?.title === "Completare check KB", f, "title edited from the keyboard");

  f = "3 move with the section select";
  say(`\n## ${ctxName} — ${f}`);
  await page.keyboard.press("Enter"); // re-open the same card
  await page.waitForTimeout(300);
  const sel = await tabTo(page, cdp, f, /^(Stato|Sezione|Status)/i, 60);
  if (sel) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(600);
    const st = db.tasks.find((r) => r.id === "5")?.status;
    check(st !== "IN PROGRESS", f, `moved with ArrowDown on the section select (status now ${st})`);
    const after = await page.evaluate(() => ({ tag: document.activeElement?.tagName, body: document.activeElement === document.body, txt: document.activeElement?.textContent?.trim().slice(0, 40) }));
    check(!after.body, f, `focus kept after the move (on ${after.tag} "${after.txt}")`);
    await stop(page, cdp, f, "(after move)");
  }
  // ‹ › buttons
  const prev = await tabTo(page, cdp, f, /precedente|indietro|prev/i, 10, { shift: true });
  if (prev) say(`   ‹ button accessible name: "${prev.name}"`);

  f = "4 In evidenza band";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const band = await tabTo(page, cdp, f, /^(Comprimi|Espandi|In evidenza \d)/i, 80);
  if (band) {
    const ex0 = await page.evaluate(() => document.activeElement.getAttribute("aria-expanded"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const ex1 = await page.evaluate(() => document.activeElement.getAttribute("aria-expanded"));
    check(ex0 === "true" && ex1 === "false", f, `band collapses with Enter (aria-expanded ${ex0}→${ex1}); name now "${await focusedName(cdp)}"`);
    await page.keyboard.press("Enter");
    await tab(page, cdp, f, 6);
  }

  f = "5 Done / Archived bars";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const done = await tabTo(page, cdp, f, /^Completat|^Fatt|Done/i, 200, { quiet: true });
  if (done) {
    await page.keyboard.press("Enter");
    await tab(page, cdp, f, 3);
    const arch = await tabTo(page, cdp, f, /Archivi/i, 20);
    if (arch) {
      await page.keyboard.press("Enter");
      await tab(page, cdp, f, 3);
    }
  }

  f = "6 column editor";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const colBtn = await tabTo(page, cdp, f, /^Colonne/i, 40);
  if (colBtn) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await tab(page, cdp, f, 1);
    const n0 = await page.evaluate(() => document.querySelectorAll(".font-trajan.text-\\[12px\\]").length);
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    const pressed = await page.evaluate(() => document.activeElement.getAttribute("aria-pressed"));
    check(pressed === "false", f, `a column toggled off with Space (aria-pressed=${pressed})`);
    await page.keyboard.press("Space");
    await tab(page, cdp, f, 6);
  }

  f = "7 Projects → project → add task";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const pt = await tabTo(page, cdp, f, /^Progetti$/i, 30);
  if (pt) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    say(`   focus after tab switch: "${await focusedName(cdp)}" (${await page.evaluate(() => document.activeElement.id || document.activeElement.tagName)})`);
    const pj = await tabTo(page, cdp, f, /Pricing 2027/i, 40);
    if (pj) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      say(`   focus after opening project: "${await focusedName(cdp)}" (${await page.evaluate(() => document.activeElement.tagName)}) url ${page.url().split("#")[1]}`);
      const add = await tabTo(page, cdp, f, /nuova attività|aggiungi un'attività|aggiungi attività|attività del progetto|Nuova/i, 60);
      if (add && /input|textarea/.test(add.tag)) {
        const n0 = db.tasks.length;
        await page.keyboard.type("KB progetto task");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(600);
        const hit = db.tasks.find((r) => r.title === "KB progetto task");
        check(!!hit && hit.project_id === "p1", f, `task added in the project from the keyboard (rows ${n0}→${db.tasks.length}, project ${hit?.project_id})`);
      } else if (add) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        await tab(page, cdp, f, 1, false);
        await page.keyboard.type("KB progetto task");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(600);
        const hit = db.tasks.find((r) => r.title === "KB progetto task");
        check(!!hit, f, `task added in the project from the keyboard via "${add.name}"`);
      }
    }
  }

  f = "8 Weekly add / delete / Undo";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/weekly");
  const wadd = await tabTo(page, cdp, f, /: Aggiungi|Add to/i, 60);
  if (wadd) {
    await page.keyboard.type("KB weekly item");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    check(db.weekly.some((w) => w.body === "KB weekly item"), f, "weekly item added");
    const del = await tabTo(page, cdp, f, /Elimina|Delete/i, 10, { shift: true });
    if (del) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      const nm = await focusedName(cdp);
      await stop(page, cdp, f, "(after delete)");
      check(/Annulla|Undo/i.test(nm), f, `focus moves to Annulla after a keyboard delete ("${nm}")`);
      const left = db.weekly.length;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      check(db.weekly.length > left, f, `Undo restores the item (${left}→${db.weekly.length})`);
      say(`   focus after Undo: "${await focusedName(cdp)}" (${await page.evaluate(() => (document.activeElement === document.body ? "BODY" : document.activeElement.tagName))})`);
    }
  }

  f = "9 Calendar: due date without drag";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/calendario");
  const vub = await tabTo(page, cdp, f, /VUB/i, 60);
  if (vub) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await stop(page, cdp, f, "(after Enter on an undated task)");
    const due = await tabTo(page, cdp, f, /Scadenza|Due/i, 30);
    if (due) {
      await page.keyboard.type("15122026");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(500);
      const d = db.tasks.find((r) => r.title.startsWith("VUB"))?.due_date;
      check(!!d, f, `undated task got a due date from the keyboard via the details panel (${d})`);
    }
    // can a dated chip in the grid move day by keyboard?
    const keys = await page.evaluate(() => document.querySelector("[aria-keyshortcuts]")?.getAttribute("aria-keyshortcuts") ?? "");
    say(`   aria-keyshortcuts in calendar: "${keys}"`);
  }

  f = "10 mail pop-up";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const mail = await tabTo(page, cdp, f, /mail|posta|e-mail/i, 20);
  if (mail) {
    const opener = mail.name;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await stop(page, cdp, f, "(opened)");
    let out = 0;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const r = await stop(page, cdp, f);
      if (!r.inDialog) out++;
    }
    check(out === 0, f, `Tab stays inside the dialog (${out} stops outside in 25)`);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const nm = await focusedName(cdp);
    check(nm === opener, f, `Escape closes and focus returns to "${opener}" (now "${nm}")`);
  }

  await context.close();
}

// ---------------------------------------------------------------------------
// Phone flows (390x844, touch)
// ---------------------------------------------------------------------------
async function phone(browser) {
  ctxName = `phone ${combo.name}`;
  const { page, context, db } = await openApp(browser, { ...combo, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, path: "#/board" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  let f = "11 phone task sheet";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const card = await tabTo(page, cdp, f, /^Report settimanale/i, 60);
  if (card) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const s0 = await stop(page, cdp, f, "(sheet opened)");
    check(s0.inDialog || s0.role === "dialog", f, "focus moved into the sheet");
    let out = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const r = await stop(page, cdp, f);
      if (!r.inDialog && r.role !== "dialog") out++;
    }
    check(out === 0, f, `Tab trapped in the sheet (${out} of 40 stops outside)`);
    // Ripeti and In evidenza rows
    const rip = await tabTo(page, cdp, f, /Ripeti/i, 30);
    if (rip) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      const p = await stop(page, cdp, f, "(repeat picker)");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      check(/Ripeti/i.test(await focusedName(cdp)), f, `closing the Ripeti picker returns focus to its row ("${await focusedName(cdp)}")`);
    }
    const pin = await tabTo(page, cdp, f, /evidenza/i, 10);
    if (pin) {
      const role = await page.evaluate(() => [document.activeElement.getAttribute("role"), document.activeElement.getAttribute("aria-pressed"), document.activeElement.getAttribute("aria-checked")]);
      say(`   In evidenza row: role=${role[0]} aria-pressed=${role[1]} aria-checked=${role[2]} name="${pin.name}"`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      say(`   after Enter: name="${await focusedName(cdp)}" pinned=${db.tasks.find((r) => r.id === "3")?.pinned}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const nm = await focusedName(cdp);
    check(/Report settimanale/i.test(nm), f, `Escape closes and focus returns to the card ("${nm}")`);
  }

  f = "12 phone add sheet";
  say(`\n## ${ctxName} — ${f}`);
  await fresh(page, "#/board");
  const plus = await tabTo(page, cdp, f, /^(Nuova|Aggiungi|\+|Nuova attività)/i, 60);
  if (plus) {
    const opener = plus.name;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const s0 = await stop(page, cdp, f, "(sheet opened)");
    check(s0.inDialog || s0.role === "dialog", f, "focus moved into the add sheet");
    await page.keyboard.type("KB phone task");
    let out = 0;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const r = await stop(page, cdp, f);
      if (!r.inDialog && r.role !== "dialog") out++;
    }
    check(out === 0, f, `Tab trapped in the add sheet (${out} of 20 outside)`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const nm = await focusedName(cdp);
    check(nm === opener, f, `Escape closes and focus returns to "${opener}" (now "${nm}")`);
  }
  await context.close();
}

// ---------------------------------------------------------------------------
// Sweep: every focusable element, focus indicator check (programmatic focus
// after a Tab key press, so :focus-visible applies).
// ---------------------------------------------------------------------------
async function sweep(browser, phoneMode) {
  ctxName = `sweep ${phoneMode ? "phone" : "desktop"} ${combo.name}`;
  const { page, context } = await openApp(browser, {
    ...combo,
    viewport: phoneMode ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: phoneMode,
    hasTouch: phoneMode,
    path: phoneMode ? "#/today" : "#/board",
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const paths = phoneMode
    ? ["#/today", "#/board", "#/agenda", "#/projects", "#/more"]
    : ["#/board", "#/projects/p1", "#/weekly", "#/calendario", "#/report", "#/settings"];
  const seen = new Map();
  for (const p of paths) {
    await fresh(page, p);
    if (!phoneMode && p === "#/board") {
      // open one card so the editor's controls are swept too
      await page.evaluate(() => [...document.querySelectorAll(".card-head")].find((b) => /Report settimanale/.test(b.textContent))?.click());
      await page.waitForTimeout(400);
    }
    await page.keyboard.press("Tab");
    const n = await page.evaluate(() => {
      const sel = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && !e.closest("[inert]") && e.id !== "__kb_neutral");
      els.forEach((e, i) => e.setAttribute("data-kb", String(i)));
      return els.length;
    });
    for (let i = 0; i < n; i++) {
      const ok = await page.evaluate((i) => {
        const e = document.querySelector(`[data-kb="${i}"]`);
        if (!e || !e.isConnected) return false;
        e.scrollIntoView({ block: "center" });
        e.focus();
        return document.activeElement === e;
      }, i);
      if (!ok) continue;
      const ax = await axOf(cdp);
      const sig = await page.evaluate(() => {
        const e = document.activeElement;
        return `${e.tagName.toLowerCase()}.${String(e.className).replace(/\s+/g, ".").slice(0, 90)}`;
      });
      const ind = await indicator(page);
      const bad = ["INVISIBLE", "WEAK"].includes(ind.verdict) || ind.covered;
      if (!bad) continue;
      const key = `${ind.verdict} ${sig}`;
      if (seen.has(key)) {
        seen.get(key).n++;
        continue;
      }
      seen.set(key, { n: 1, line: `${p} ${ind.verdict} ${ind.ge3}/${ind.changed}px≥3:1 (need ${ind.perim}) max ${ind.max}${ind.covered ? " covered by " + ind.covered : ""} "${ax.name.slice(0, 40)}" <${sig}>` });
    }
  }
  say(`\n## ${ctxName}: focusables with an invisible/weak indicator (unique by class)`);
  for (const v of seen.values()) say(`   ${v.line}${v.n > 1 ? `  ×${v.n}` : ""}`);
  await context.close();
}

// The dev server may full-reload mid-run while others edit: retry that run.
async function retry(fn) {
  for (let i = 0; ; i++) {
    const mark = problems.length;
    try {
      return await fn();
    } catch (e) {
      if (i >= 3 || !/context was destroyed|navigation|Target .*closed/i.test(String(e))) throw e;
      problems.length = mark;
      say(`\n   (page reloaded under us: ${String(e).split("\n")[0]}; retrying in 5 s)\n`);
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}
const browser = await launch();
try {
  if (SWEEP) {
    if (mode !== "phone") await retry(() => sweep(browser, false));
    if (mode !== "desktop") await retry(() => sweep(browser, true));
  } else {
    if (mode !== "phone") await retry(() => desktop(browser));
    if (mode !== "desktop") await retry(() => phone(browser));
  }
} finally {
  await browser.close();
}
say(`\n## Problems (${problems.length})`);
for (const p of problems) say(" - " + p);
if (process.env.KB_JSON) writeFileSync(process.env.KB_JSON, JSON.stringify(all, null, 1));
