// Board cards are memoised (TaskCard is React.memo, see components/TaskCard.tsx).
// These check what a stale card would get wrong and functional-board.mjs does
// not cover: the sequential step label, the column widening for an open card,
// a card moved with the editor's ‹ reopening with focus, a card filtered away
// while open, remote task / project changes, and a language switch.
//
// Usage (dev server on the fake Supabase, see perf-stub.mjs):
//   APP_URL=http://localhost:5199/ node scripts/ux/board-cards.mjs
import { launch, openApp } from "./perf-stub.mjs";

let fails = 0;
const check = (name, ok, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !info ? "" : " :: " + info}`);
};

const browser = await launch();
const { page, db, realtime } = await openApp(browser, { skin: "classic", appearance: "light" });
await page.waitForTimeout(800);

// Board columns carry an inline min-width (148px, 340px with an open card).
const COL = "div[style*='min-height: 140px']";
const colCard = (title) =>
  page.evaluate(
    ([title, COL]) => {
      const c = [...document.querySelectorAll(".task-card")].find(
        (x) => (x.textContent ?? "").includes(title) && !x.closest("section.pin-band, #board-done-panel, #board-archive-panel")
      );
      if (!c) return null;
      const col = c.parentElement.closest(COL);
      return {
        col: col?.querySelector(".font-trajan")?.textContent?.trim(),
        minWidth: col?.style.minWidth,
        open: c.querySelector(".card-head")?.getAttribute("aria-expanded"),
        focused: document.activeElement === c.querySelector(".card-head"),
        text: c.textContent,
      };
    },
    [title, COL]
  );
const colWidths = () =>
  page.evaluate(
    (COL) =>
      Object.fromEntries(
        [...document.querySelectorAll(COL)].map((col) => [col.querySelector(".font-trajan")?.textContent?.trim(), col.style.minWidth])
      ),
    COL
  );

// Sequential step label (p2 is sequential: Allineamento = step 1, Chiusura = step 2)
let c = await colCard("Allineamento pricing Q4");
check("step label on a sequential project's card", /Passo 1\/2/.test(c?.text ?? ""), c?.text);
c = await colCard("Chiusura mensile novembre");
check("step label on its second step", /Passo 2\/2/.test(c?.text ?? ""), c?.text);
c = await colCard("BU Pivot loans");
check("no step label on an 'all' project's card", c && !/Passo/.test(c.text) && /Pricing 2027/.test(c.text), c?.text);

// Open a card: its column widens
const title = "Efficientare l'update dei cambi";
await page.locator(".task-card").filter({ hasText: title }).locator(".card-head").first().click();
await page.waitForTimeout(200);
c = await colCard(title);
check("open card: column widens to 340px", c?.open === "true" && c?.minWidth === "340px", JSON.stringify(c));

// Move it back one column with the editor's ‹: it reopens there with focus
await page.locator(".task-card.is-open").first().locator("button", { hasText: "‹" }).click();
await page.waitForTimeout(400);
c = await colCard(title);
let w = await colWidths();
check("moved with ‹: card is in the previous column", c?.col === "Backlog", JSON.stringify(c));
check("moved with ‹: card reopens and has focus", c?.open === "true" && c?.focused, JSON.stringify(c));
check("moved with ‹: new column wide, old column back to 148px", c?.minWidth === "340px" && Object.values(w).filter((x) => x === "340px").length === 1, JSON.stringify(w));

// Escape from inside the editor closes it: every column back to normal
await page.locator(".task-card.is-open textarea, .task-card.is-open input").first().focus();
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
w = await colWidths();
c = await colCard(title);
check("Escape closes the card and the column narrows", c?.open === "false" && Object.values(w).every((x) => x === "148px"), JSON.stringify(w));

// Open a card, then filter it away (unmount while open): the column narrows
await page.locator(".task-card").filter({ hasText: "VUB - spostare SB" }).locator(".card-head").first().click();
await page.waitForTimeout(200);
w = await colWidths();
check("second open: Backlog wide again", w.Backlog === "340px", JSON.stringify(w));
const search = page.locator('input[aria-label="Cerca attività…"]').first();
await search.fill("zzzz-nothing");
await page.waitForTimeout(300);
await search.fill("");
await page.waitForTimeout(300);
w = await colWidths();
check("card filtered away while open counts as closed", Object.values(w).every((x) => x === "148px"), JSON.stringify(w));

// A remote change to one task shows on its card
const row = db.tasks.find((r) => r.title === "Cambiare corporate con legal entities");
row.title = "Cambiare corporate (remoto)";
row.updated_at = Date.now();
realtime.push("tasks", row, "UPDATE");
await page.waitForTimeout(800);
check("remote title change shows", !!(await colCard("Cambiare corporate (remoto)")));

// A remote project rename reaches its cards
const p1 = db.projects.find((p) => p.id === "p1");
p1.name = "Pricing 2028";
p1.updated_at = Date.now();
realtime.push("projects", p1, "UPDATE");
await page.waitForTimeout(800);
c = await colCard("BU Pivot loans");
check("remote project rename shows on its cards", /Pricing 2028/.test(c?.text ?? ""), c?.text);

// A remote reorder of a sequential project's steps reaches the step labels
const p2 = db.projects.find((p) => p.id === "p2");
const ids = db.tasks.filter((t) => t.project_id === "p2").map((t) => t.id);
p2.task_order = [ids[1], ids[0]];
p2.updated_at = Date.now();
realtime.push("projects", p2, "UPDATE");
await page.waitForTimeout(800);
c = await colCard("Chiusura mensile novembre");
check("remote step reorder updates the step label", /Passo 1\/2/.test(c?.text ?? ""), c?.text);

// A language switch reaches the (memoised) cards
await page.locator('[role="group"] button', { hasText: /^EN$/ }).first().click();
await page.waitForTimeout(300);
c = await colCard("Chiusura mensile novembre");
check("language switch reaches the cards", /Step 1\/2/.test(c?.text ?? ""), c?.text);

await browser.close();
console.log(fails ? `${fails} FAIL` : "all PASS");
process.exitCode = fails ? 1 : 0;
