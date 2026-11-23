// Tab-like controls in every skin: rest, hover (an inactive option), and
// keyboard focus, side by side. Usage: node scripts/ux/tabs.mjs <outPrefix>
import { launch, openApp, COMBOS } from "./stub.mjs";
const [out] = process.argv.slice(2);

const TARGETS = [
  { name: "nav", path: "#/board", group: "nav[aria-label] > div", hover: "nav[aria-label] button >> nth=2" },
  { name: "boardview", path: "#/board", group: "main .seg >> nth=0", hover: "main .seg >> nth=0 >> button >> nth=1" },
  { name: "projfilter", path: "#/projects", group: "button[aria-pressed] >> nth=0 >> xpath=..", hover: "button[aria-pressed] >> nth=1" },
  { name: "projview", path: "#/projects", group: "main .seg >> nth=0", hover: "main .seg >> nth=0 >> button >> nth=1" },
  { name: "projtasks", path: "#/projects/p1", group: "main .seg >> nth=0", hover: "main .seg >> nth=0 >> button >> nth=1" },
  { name: "reportview", path: "#/report", group: "main [role=tablist]", hover: "[role=tablist] [role=tab] >> nth=1" },
  { name: "weeklygroup", path: "#/weekly", group: "main .seg", hover: "main .seg button >> nth=1" },
  { name: "music", path: "#/music", group: ".mt-pills, .mt-chips >> nth=0", hover: ".mt-pill:not(.mt-pill--solid), .mt-chip >> nth=1" },
  { name: "header", path: "#/board", group: "header .seg >> nth=0 >> xpath=..", hover: "header .seg >> nth=1 >> button >> nth=2" },
  { name: "toolbar", path: "#/board", group: "main button[aria-expanded] >> nth=0 >> xpath=..", hover: "main button[aria-pressed] >> nth=-1" },
];

const browser = await launch();
for (const c of COMBOS) {
  const { page, context } = await openApp(browser, { ...c, scale: 2 });
  for (const tg of TARGETS) {
    try {
      await page.goto(page.url().split("#")[0] + tg.path);
      await page.waitForTimeout(800);
      const g = page.locator(tg.group).first();
      await g.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await g.boundingBox();
      const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 };
      await page.mouse.move(1, 1);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}-${tg.name}-rest-${c.name}.png`, clip });
      await page.locator(tg.hover).first().hover();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}-${tg.name}-hover-${c.name}.png`, clip });
      await page.mouse.move(1, 1);
      await page.locator(tg.hover).first().focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}-${tg.name}-focus-${c.name}.png`, clip });
    } catch (e) {
      console.log(`skip ${tg.name} ${c.name}: ${String(e.message).split("\n")[0]}`);
    }
  }
  await context.close();
}
await browser.close();
