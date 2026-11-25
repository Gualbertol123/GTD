// How much of the board re-renders for one remote change.
// Dev server only (the production build has no profiling timers).
//
// A fake React DevTools hook is installed before the app loads; with a hook
// present React puts the root in ProfileMode, so every fiber records
// actualStartTime / actualDuration / selfBaseDuration. On each commit we walk
// the tree and count the components whose actualStartTime is after the
// previous commit (they rendered in this one).
//
// Scenarios on a board of N (default 300) extra tasks:
//   realtime  one task's title changes on the server; a postgres_changes event
//             is pushed through the websocket (useBoard → fetchChange → applyRowChange)
//   poll      the full re-read the 30 s safety-net poll does (visibilitychange → reload)
//   dragstart start dragging one card (BoardView sets dragId)
//
// Usage: node scripts/ux/perf-rerender.mjs [N]
import { launch, openApp } from "./perf-stub.mjs";

const N = +(process.argv[2] ?? 300);
const browser = await launch();
const { page, context, db, realtime } = await openApp(browser, { skin: "classic", appearance: "light", viewport: { width: 1440, height: 900 } });

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
      const self = {};
      let n = 0;
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        if (f.actualStartTime !== undefined && f.actualStartTime >= lastT) {
          const nm = nameOf(f);
          if (nm) {
            counts[nm] = (counts[nm] ?? 0) + 1;
            self[nm] = (self[nm] ?? 0) + (f.selfBaseDuration ?? 0);
            n++;
          }
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      commits.push({ at: performance.now(), duration: root.current.actualDuration, components: n, counts, self });
      lastT = performance.now();
    },
  };
  window.__commits = commits;
});

// The board: N extra tasks over the six columns, some with subtasks/projects.
const ST = ["BACKLOG", "NEXT", "IN PROGRESS", "WAITING", "DONE", "MAYBE"];
const now = Date.now();
for (let i = 0; i < N; i++) {
  db.tasks.push({
    id: `perf${i}`, title: `Attività di prova ${i}`, description: "", owner: ["Francesco", "Chiara", "Gonzalo", "Gualberto"][i % 4],
    assignees: null, priority: ["P1", "P2", "P3", "P4"][i % 4], status: ST[i % 6], notes: "",
    subtasks: i % 5 === 0 ? [{ id: `s${i}a`, text: "uno", done: true }, { id: `s${i}b`, text: "due", done: false }] : [],
    due_date: null, waiting_since: null, file_dir: null, done_at: ST[i % 6] === "DONE" ? now - 86400000 : null,
    project_id: i % 7 === 0 ? "p1" : null, pinned: i % 50 === 0, recurrence: null, updated_at: now, created_at: now + 1000 + i,
  });
}
await page.reload();
await page.waitForSelector("main");
await page.waitForTimeout(3000);
const cards = await page.evaluate(() => document.querySelectorAll(".task-card").length);

async function measure(label, act, settle = 1500) {
  await page.evaluate(() => (window.__commits.length = 0));
  const t0 = await page.evaluate(() => performance.now());
  await act();
  await page.waitForTimeout(settle);
  const cs = await page.evaluate(() => window.__commits.splice(0));
  const sum = {};
  const self = {};
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.counts)) sum[k] = (sum[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.self)) self[k] = (self[k] ?? 0) + v;
  }
  const top = Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v} (${self[k].toFixed(1)} ms self)`);
  console.log(`\n## ${label}`);
  console.log(`   commits: ${cs.length}; render durations (ms): ${cs.map((c) => c.duration.toFixed(1)).join(", ")}; components rendered: ${cs.map((c) => c.components).join(", ")}`);
  console.log(`   TaskCard renders: ${sum.TaskCard ?? 0} (of ${cards} cards on screen)`);
  console.log(`   top: ${top.join(" · ")}`);
  return { cs, sum };
}

console.log(`board: ${db.tasks.length} tasks, ${cards} TaskCards mounted`);
await page.waitForTimeout(500);

// 1. One remote change through realtime
const row = db.tasks.find((r) => r.id === "perf7");
await measure("realtime: one task's title changed by another client", async () => {
  row.title = "Attività di prova 7 (modificata altrove)";
  row.updated_at = Date.now();
  const n = realtime.push("tasks", row, "UPDATE");
  if (!n) console.log("   !! no subscribed channel to push to");
});
const shown = await page.evaluate(() => [...document.querySelectorAll(".task-card")].some((c) => c.textContent.includes("modificata altrove")));
console.log(`   change visible on the board: ${shown}`);

// 2. The 30 s safety-net poll path (full re-read)
await measure("poll / tab refocus: full board re-read (no data changed)", async () => {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
});

// 3. Start dragging a card
await measure("drag start on one card (dragId state in BoardView)", async () => {
  const p = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.task-card[draggable="true"]')][3];
    c.scrollIntoView({ block: "center" });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 18 };
  });
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 10, { steps: 3 });
  await page.mouse.move(p.x + 260, p.y + 10, { steps: 6 }); // into the next column (overCol)
  await page.mouse.up();
});
await browser.close();
