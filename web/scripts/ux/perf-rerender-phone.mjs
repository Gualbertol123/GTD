// How many phone task cards re-render for one change: the phone layout's
// counterpart of perf-rerender.mjs (same fake React DevTools hook, same
// counting: a fiber counts as rendered only when React actually called the
// component, not when it visited a memo and bailed out).
// Dev server only (the production build has no profiling timers).
//
// Phone layout (390×844, isMobile, hasTouch), N (default 300) extra tasks, on
// the Today screen and then on the Board screen:
//   realtime  one visible task's title changes on the server; a
//             postgres_changes event is pushed through the websocket
//   poll      the full re-read the 30 s safety-net poll does (visibilitychange)
//   status    tap the round check of one visible card (a local, optimistic
//             status change: Today drops the card, the Board moves it to Done)
//
// Usage: APP_URL=http://localhost:5199/ node scripts/ux/perf-rerender-phone.mjs [N]
import { launch, openApp } from "./perf-stub.mjs";

const N = +(process.argv[2] ?? 300);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const browser = await launch();
const { page, context, db, realtime } = await openApp(browser, { skin: "classic", appearance: "light", ...PHONE, path: "#/today" });

await context.addInitScript(() => {
  const commits = [];
  let lastT = 0;
  let id = 0;
  const nameOf = (f) => {
    const t = f.type;
    if (!t || typeof t === "string") return null;
    return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || null;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { this.renderers.set(++id, r); return id; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const counts = {};
      const visits = {};
      const self = {};
      let n = 0;
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        if (f.actualStartTime !== undefined && f.actualStartTime >= lastT) {
          const nm = nameOf(f);
          if (nm) visits[nm] = (visits[nm] ?? 0) + 1;
          if (nm && (f.flags & 1)) {
            counts[nm] = (counts[nm] ?? 0) + 1;
            self[nm] = (self[nm] ?? 0) + (f.selfBaseDuration ?? 0);
            n++;
          }
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      commits.push({ at: performance.now(), duration: root.current.actualDuration, components: n, counts, visits, self });
      lastT = performance.now();
    },
  };
  window.__commits = commits;
});

// N extra tasks, mostly mine (Today shows only mine), over every column, with
// due dates from three days ago to a week ahead, some in a project, some
// with subtasks, pinned or waiting, so every Today section has cards.
const ST = ["NEXT", "IN PROGRESS", "WAITING", "BACKLOG", "DONE", "MAYBE"];
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const now = Date.now();
for (let i = 0; i < N; i++) {
  const status = ST[i % 6];
  db.tasks.push({
    id: `perf${i}`, title: `Attività di prova ${i}`, description: i % 4 === 0 ? "Una descrizione" : "",
    owner: i % 4 === 3 ? "Chiara" : "Francesco", assignees: null, priority: ["P1", "P2", "P3", "P4"][i % 4], status, notes: "",
    subtasks: i % 5 === 0 ? [{ id: `s${i}a`, text: "uno", done: true }, { id: `s${i}b`, text: "due", done: false }] : [],
    due_date: i % 3 === 0 ? null : iso((i % 11) - 3), waiting_since: status === "WAITING" ? iso(-(i % 10)) : null, file_dir: null,
    done_at: status === "DONE" ? now - DAY : null, project_id: i % 7 === 0 ? "p1" : null, pinned: i % 50 === 0, recurrence: null,
    updated_at: now, created_at: now + 1000 + i,
  });
}
await page.reload();
await page.waitForSelector(".m-app main");
await page.waitForTimeout(2500);

const CARD_NAMES = ["TaskCard", "TaskCardView"];
const results = {};

async function measure(screen, label, act, settle = 1500) {
  const cards = await page.evaluate(() => document.querySelectorAll(".m-card").length);
  await page.evaluate(() => (window.__commits.length = 0));
  await act();
  await page.waitForTimeout(settle);
  const cs = await page.evaluate(() => window.__commits.splice(0));
  const sum = {};
  const visits = {};
  const self = {};
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.visits)) visits[k] = (visits[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.counts)) sum[k] = (sum[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.self)) self[k] = (self[k] ?? 0) + v;
  }
  const rendered = CARD_NAMES.reduce((a, k) => a + (sum[k] ?? 0), 0);
  const visited = CARD_NAMES.reduce((a, k) => a + (visits[k] ?? 0), 0);
  const top = Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v} (${self[k].toFixed(1)} ms self)`);
  console.log(`\n## ${screen}: ${label}`);
  console.log(`   commits: ${cs.length}; render durations (ms): ${cs.map((c) => c.duration.toFixed(1)).join(", ")}; components rendered: ${cs.map((c) => c.components).join(", ")}`);
  console.log(`   phone TaskCard renders: ${rendered} (of ${cards} cards on screen; ${visited} visited incl. memo bail-outs)`);
  console.log(`   top: ${top.join(" · ")}`);
  results[`${screen} ${label.split(":")[0]}`] = `${rendered} of ${cards}`;
}

const cardText = (re) =>
  page.evaluate((src) => [...document.querySelectorAll(".m-card")].some((c) => new RegExp(src).test(c.textContent)), re);

async function scenarios(screen) {
  // A task on screen, by its title.
  const titles = await page.evaluate(() => [...document.querySelectorAll(".m-card .m-card__title")].map((b) => b.textContent));
  const remote = db.tasks.find((r) => r.id.startsWith("perf") && r.status !== "DONE" && titles.includes(r.title));
  await measure(screen, "realtime: one task's title changed by another client", async () => {
    remote.title = `${remote.title} (modificata altrove)`;
    remote.updated_at = Date.now();
    if (!realtime.push("tasks", remote, "UPDATE")) console.log("   !! no subscribed channel to push to");
  });
  console.log(`   change visible on the card: ${await cardText("modificata altrove")}`);

  await measure(screen, "poll: full board re-read (no data changed)", async () => {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  });

  const local = db.tasks.find((r) => r.id.startsWith("perf") && r.status !== "DONE" && r !== remote && titles.includes(r.title));
  await measure(screen, "status: tap one card's check (local change)", async () => {
    await page.evaluate((title) => {
      const card = [...document.querySelectorAll(".m-card")].find((c) => c.querySelector(".m-card__title")?.textContent === title);
      card.querySelector(".m-hit--check").click();
    }, local.title);
  });
  const after = await page.evaluate(
    (title) => [...document.querySelectorAll(".m-card")].filter((c) => c.querySelector(".m-card__title")?.textContent === title).map((c) => c.classList.contains("m-card--done")),
    local.title
  );
  console.log(`   card after the tap: ${screen === "today" ? `gone from Today ${after.length === 0}` : `shown done ${after.length === 1 && after[0]}`}`);
  await page.waitForTimeout(5500); // let the Undo toast go
}

console.log(`board: ${db.tasks.length} tasks; phone layout ${PHONE.viewport.width}×${PHONE.viewport.height}`);
await scenarios("today");
await page.evaluate(() => (location.hash = "#/board"));
await page.waitForSelector(".m-pager");
await page.waitForTimeout(1500);
await scenarios("board");

console.log("\n## summary (phone TaskCard renders)");
for (const [k, v] of Object.entries(results)) console.log(`   ${k.padEnd(16)} ${v}`);
await browser.close();
