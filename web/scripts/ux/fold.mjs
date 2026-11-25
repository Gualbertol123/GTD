// Where does the work start? y of the first kanban column and its first card
// on the Board, per combo and viewport (the "above the fold" check).
//   node scripts/ux/fold.mjs
import { launch, openApp, COMBOS } from "./stub.mjs";
const browser = await launch();
for (const [W, H] of [[1440, 900], [1024, 768]])
  for (const c of COMBOS) {
    const { page, context } = await openApp(browser, { ...c, viewport: { width: W, height: H } });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const head = [...document.querySelectorAll("h2,h3,div,span")].find((e) => /^BACKLOG$/i.test(e.textContent.trim()) && e.children.length === 0);
      const col = head?.closest("[class*='bg-[#EFECE6]']") ?? head;
      const card = col?.querySelector(".task-card");
      const vis = col ? Math.max(0, Math.min(innerHeight, col.getBoundingClientRect().bottom) - col.getBoundingClientRect().top) : 0;
      return { col: Math.round(col?.getBoundingClientRect().top ?? -1), card: Math.round(card?.getBoundingClientRect().top ?? -1), visible: Math.round(vis) };
    });
    console.log(`${W}x${H} ${c.name.padEnd(12)} first column y=${r.col}  first card y=${r.card}  column px visible=${r.visible}`);
    await context.close();
  }
await browser.close();
