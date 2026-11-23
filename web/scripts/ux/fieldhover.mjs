// Before/after evidence for "fields highlight on hover": open a task editor,
// hover a field, crop the editor; then the new-task bar's assignee picker.
// Usage: node scripts/ux/fieldhover.mjs <outPrefix>
import { launch, openApp, COMBOS } from "./stub.mjs";
const [out] = process.argv.slice(2);
const browser = await launch();
for (const c of COMBOS) {
  const { page, context } = await openApp(browser, { ...c, scale: 2 });
  await page.click("text=Retail Q3 Ambition");
  await page.waitForTimeout(400);
  const desc = page.locator("textarea[placeholder^='Aggiungi una descrizione']").first();
  const card = page.locator("div.bg-white.rounded-\\[12px\\]", { has: desc }).last();
  await card.scrollIntoViewIfNeeded();
  const shot = (path) => card.screenshot({ path });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await shot(`${out}-editor-rest-${c.name}.png`);
  await desc.hover();
  await page.waitForTimeout(400);
  await shot(`${out}-editor-hover-${c.name}.png`);
  await desc.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await shot(`${out}-editor-focus-${c.name}.png`);
  // The new-task bar: hover the assignee picker (a button drawn as a field).
  await page.keyboard.press("Escape");
  const qa = page.locator(".qa-field").first();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const qb = await qa.boundingBox();
  const qclip = { x: Math.max(0, qb.x - 380), y: Math.max(0, qb.y - 10), width: 820, height: qb.height + 20 };
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-qa-rest-${c.name}.png`, clip: qclip });
  await qa.hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}-qa-hover-${c.name}.png`, clip: qclip });
  await context.close();
}
await browser.close();
