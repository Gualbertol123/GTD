// Colour-intensity slider: open it, set values, screenshot; check the filter
// lands on <html> and that fixed/sticky chrome and glass blur still work.
import { launch, openApp } from "./stub.mjs";
const out = process.argv[2] ?? "/tmp/claude-0/color";
const browser = await launch();
for (const c of [{ name: "classic", skin: "classic", appearance: "light" }, { name: "glass-dark", skin: "glass", appearance: "dark" }]) {
  const { page, context } = await openApp(browser, { ...c, viewport: { width: 1440, height: 900 } });
  await page.waitForTimeout(700);
  await page.locator("button.color-btn").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-panel-${c.name}.png`, clip: { x: 700, y: 0, width: 740, height: 330 } });
  for (const v of [0, 50, 150]) {
    await page.locator(".color-range").fill(String(v));
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({
      filter: getComputedStyle(document.documentElement).filter,
      label: document.querySelector(".color-btn")?.textContent,
      stored: localStorage.getItem("gtd-color"),
    }));
    console.log(c.name, v, JSON.stringify(st));
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}-${v}-${c.name}.png` });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("button.color-btn").click();
  }
  // header still sticks at the top when scrolled with the filter on
  const top = await page.evaluate(() => { window.scrollTo(0, 300); return document.querySelector("header").getBoundingClientRect().top; });
  console.log(c.name, "header top while scrolled:", top);
  // survives a reload
  await page.reload();
  await page.waitForTimeout(700);
  console.log(c.name, "after reload:", await page.evaluate(() => getComputedStyle(document.documentElement).filter));
  await context.close();
}
await browser.close();
