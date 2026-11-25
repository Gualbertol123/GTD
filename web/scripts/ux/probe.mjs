// Evaluate a JS expression on a page in one skin combo and print the result.
// Usage: node scripts/ux/probe.mjs <combo> <path> "<expression>" [width] [height]
import { launch, openApp, COMBOS } from "./stub.mjs";
const [combo = "classic", path = "#/board", expr = "document.title", w = "1440", h = "900"] = process.argv.slice(2);
const c = COMBOS.find((x) => x.name === combo);
const browser = await launch();
const phone = +w < 768;
const { page } = await openApp(browser, { ...c, path, viewport: { width: +w, height: +h }, isMobile: phone, hasTouch: phone });
await page.waitForTimeout(700);
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
