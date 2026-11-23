// Does hovering / selecting a board card change pixels in the header?
// Glass, blur on. Prints the rows of the header strip that changed.
import { launch, openApp } from "./stub.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PNG } = (() => { try { return require("pngjs"); } catch { return {}; } })();
const appearance = process.argv[2] ?? "dark";
const browser = await launch();
const { page } = await openApp(browser, { skin: "glass", appearance, viewport: { width: 1706, height: 900 } });
await page.waitForTimeout(1000);
const H = 140;
const shot = () => page.screenshot({ clip: { x: 0, y: 0, width: 1706, height: H } });
await page.mouse.move(1700, 890);
await page.waitForTimeout(400);
const a = await shot();
const card = page.getByText("VUB - spostare SB").first();
await card.hover();
await page.waitForTimeout(500);
const b = await shot();
await card.click();
await page.waitForTimeout(600);
const c = await shot();
const fs = await import("node:fs");
fs.writeFileSync("/tmp/claude-0/seam-a.png", a);
fs.writeFileSync("/tmp/claude-0/seam-b.png", b);
fs.writeFileSync("/tmp/claude-0/seam-c.png", c);
await browser.close();
