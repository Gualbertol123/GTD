// List visible text fields on each desktop tab that do not carry .field
// (directly or via a wrapper). Usage: node scripts/ux/nofield.mjs
import { launch, openApp } from "./stub.mjs";
const tabs = ["#/board", "#/projects", "#/projects/p1", "#/weekly", "#/report", "#/calendario", "#/reflection", "#/products", "#/settings"];
const browser = await launch();
const { page, context } = await openApp(browser, { skin: "classic" });
for (const tab of tabs) {
  await page.goto(page.url().split("#")[0] + tab);
  await page.waitForTimeout(700);
  if (tab === "#/board") {
    await page.click("text=Retail Q3 Ambition");
    await page.waitForTimeout(300);
  }
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea")]
      .filter((e) => !["checkbox", "radio", "range", "file", "color", "hidden"].includes(e.type))
      .filter((e) => e.offsetParent && !e.classList.contains("sr-only"))
      .filter((e) => !e.closest(".field") && !e.closest("[class*='report-print-root']"))
      .map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("aria-label") || e.placeholder || e.type}] ${String(e.className).slice(0, 110)}`)
  );
  console.log(`== ${tab}: ${rows.length}`);
  for (const r of rows) console.log("   " + r);
}
await context.close();
await browser.close();
