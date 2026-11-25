// The installed app offline, against a PRODUCTION build (the service worker
// is registered in production only), with the fake Supabase in stub.mjs:
//
//   VITE_SUPABASE_URL=http://stub.supabase.local VITE_SUPABASE_ANON_KEY=stub \
//   VITE_TEAM_EMAIL=team@example.com npm run build
//   (same env) npx vite preview --port 5222
//   APP_URL=http://localhost:5222/ node scripts/ux/offline-pwa.mjs [desktop,phone]
//
// Checks: one online visit caches every built file (and nothing from
// Supabase); offline + reload opens the app and says it is offline; it loads
// the board by itself once back online; an edit made offline is refused with
// the message, nothing sent or stored; back online the badge is Live again.
import { goOffline, launch, openApp } from "./stub.mjs";
const OUT = process.env.OUT ?? ".";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);

const browser = await launch();

async function cacheReport(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => r.url);
    return out;
  });
}

async function scenario({ mobile }) {
  const tag = mobile ? "phone" : "desktop";
  const opts = mobile
    ? { skin: "glass", appearance: "dark", path: "#/board", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { skin: "classic", appearance: "light", path: "#/board" };
  const app = await openApp(browser, opts);
  const { context, page, db, store } = app;
  // 1. The first online visit: the service worker installs and precaches.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  const caches1 = await cacheReport(page);
  const all = Object.values(caches1).flat();
  const assets = all.filter((u) => u.includes("/assets/"));
  info(`${tag}: caches after one visit`, Object.entries(caches1).map(([k, v]) => `${k}=${v.length}`).join(", "));
  const listed = await page.evaluate(async () => {
    const src = await (await fetch("/sw.js")).text();
    return (src.match(/"\/assets\/[^"]+"/g) ?? []).length;
  });
  ok(`${tag}: every built file is cached on the first visit`, assets.length === listed && listed > 0, `${assets.length}/${listed}`);
  ok(`${tag}: nothing cross-origin (Supabase) in any cache`, all.every((u) => u.startsWith(new URL(page.url()).origin)), all.filter((u) => !u.startsWith(new URL(page.url()).origin)).join(" "));
  const ls1 = await page.evaluate(() => Object.keys(localStorage).sort());

  // 2. Offline + reload: the app opens and says it is offline.
  await goOffline(app, true);
  await page.reload({ waitUntil: "domcontentloaded" }).catch((e) => info(`${tag}: reload`, e.message));
  const t0 = Date.now();
  await page.waitForFunction(() => /offline/i.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500); // and it stays so
  const text = await page.evaluate(() => document.body.innerText);
  const fromSW = await page.evaluate(() => !!navigator.serviceWorker.controller);
  info(`${tag}: offline start shows (after ${Date.now() - t0 - 1500} ms, controlled by SW=${fromSW}, onLine=${await page.evaluate(() => navigator.onLine)})`, text.replace(/\s+/g, " ").slice(0, 200));
  ok(`${tag}: offline reload opens the app shell`, /TEAM GTD/i.test(text));
  ok(`${tag}: it says it is offline`, /offline/i.test(text));
  ok(`${tag}: no raw fetch error`, !/failed to fetch|typeerror|networkerror/i.test(text));
  await page.screenshot({ path: `${OUT}/offline-start-${tag}.png` });

  // 3. Back online: it reconnects by itself (no reload).
  await goOffline(app, false);
  const back = await page
    .waitForFunction(() => /BU Pivot loans/.test(document.body.innerText), null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  ok(`${tag}: back online, the board loads by itself`, back);

  // 4. An edit while offline is refused up front, the board unchanged.
  await page.waitForTimeout(800);
  await goOffline(app, true);
  await page.waitForTimeout(800);
  const writes0 = store.log.length;
  const before = JSON.stringify(db.tasks);
  let shownAfter;
  if (mobile) {
    // Tick a task done on the phone board.
    const card = page.locator(".m-card", { hasText: "Completare check" }).first();
    const tick = card.locator("button").first();
    await tick.click().catch((e) => info("phone tick", e.message));
  } else {
    const input = page.getByPlaceholder("Nuova attività…");
    await input.fill("Scritta offline");
    await input.press("Enter");
  }
  await page.waitForTimeout(700);
  const toastText = await page.evaluate(() =>
    [...document.querySelectorAll("[data-undo-toast], .m-toast")].map((e) => e.textContent.trim()).join(" | ")
  );
  info(`${tag}: toast`, toastText);
  ok(`${tag}: offline edit refused with the message`, /offline/i.test(toastText) && /non fatta|non è stata fatta|not made/i.test(toastText), toastText);
  await page.screenshot({ path: `${OUT}/offline-edit-${tag}.png` });
  if (mobile) {
    const cls = await page.locator(".m-card", { hasText: "Completare check" }).first().getAttribute("class");
    ok(`${tag}: the card was not ticked`, !/m-card--done/.test(cls ?? ""), cls);
  } else {
    shownAfter = await page.evaluate(() => /Scritta offline/.test(document.querySelector("main")?.innerText ?? ""));
    const kept = await page.getByPlaceholder("Nuova attività…").inputValue();
    ok(`${tag}: no new card on the board`, !shownAfter);
    ok(`${tag}: the typed title is kept to try again`, kept === "Scritta offline", kept);
  }
  ok(`${tag}: nothing was sent, server unchanged`, store.log.length === writes0 && JSON.stringify(db.tasks) === before);
  const ls2 = await page.evaluate(() => Object.keys(localStorage).sort());
  const idb = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
  ok(`${tag}: nothing new in localStorage, no IndexedDB`, JSON.stringify(ls1) === JSON.stringify(ls2) && idb.length === 0, `${ls2.join(",")} idb=${idb.join(",")}`);
  const caches2 = Object.values(await cacheReport(page)).flat();
  ok(`${tag}: caches still hold code only`, caches2.every((u) => /\/(assets|icons)\/|\/manifest\.webmanifest$|\/sw\.js$|\/$/.test(u)), caches2.filter((u) => !/\/(assets|icons)\//.test(u)).join(" "));
  const badge = await page.locator(mobile ? ".m-header__title p" : "header [role=status]").first().innerText();
  ok(`${tag}: the badge says Offline`, /Offline/.test(badge), badge);

  // 5. Online again: reconnects, the badge says live.
  await goOffline(app, false);
  const badgeSel = mobile ? ".m-header__title p" : "header [role=status]";
  const live = await page
    .waitForFunction((sel) => /\bLive\b/.test(document.querySelector(sel)?.textContent ?? ""), badgeSel, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  ok(`${tag}: back online, the badge says live`, live, await page.locator(badgeSel).first().innerText());
  // And an edit then goes through.
  if (!mobile) {
    const input = page.getByPlaceholder("Nuova attività…");
    await input.press("Enter");
    await page.waitForTimeout(1200);
    ok(`${tag}: online again, the same edit saves`, db.tasks.some((t) => t.title === "Scritta offline"));
  }
  await context.close();
}

const which = process.argv[2] ?? "desktop,phone";
if (which.includes("desktop")) await scenario({ mobile: false });
if (which.includes("phone")) await scenario({ mobile: true });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
