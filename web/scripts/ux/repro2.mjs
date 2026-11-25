// Repro for two reports: (1) a light band under the sticky header after
// scrolling, (2) a box drawn around a card title on hover. Glass dark.
import { launch, openApp } from "./stub.mjs";
const out = process.argv[2] ?? "/tmp/claude-0/repro2";
const combo = process.argv[3] ?? "dark";
const browser = await launch();
const { page } = await openApp(browser, { skin: "glass", appearance: combo, viewport: { width: 1726, height: 900 } });
await page.waitForTimeout(800);
// (2) hover a collapsed card's title
const title = page.getByText("VUB - spostare SB").first();
await title.hover();
await page.waitForTimeout(400);
const card = page.locator("div.bg-white.rounded-\\[12px\\]", { has: title }).last();
await card.screenshot({ path: `${out}-cardhover.png` });
const info = await title.evaluate((e) => {
  const b = e.closest("button");
  const s = getComputedStyle(b);
  return { cls: b.className, outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, radius: s.borderRadius };
});
console.log("title button:", JSON.stringify(info));
// (1) scroll and look at the header's bottom edge
for (const y of [0, 60, 140, 400]) {
  await page.mouse.move(5, 600);
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-header-${y}.png`, clip: { x: 0, y: 0, width: 1726, height: 130 } });
}
await browser.close();
