// Screenshot one path in every skin/appearance combo. Usage:
//   node scripts/ux/shoot.mjs <outPrefix> <path> [width] [height] [--action=<js>]
import { launch, openApp, COMBOS } from "./stub.mjs";
const [out, path = "#/board", w = "1440", h = "900", ...rest] = process.argv.slice(2);
const action = rest.find((a) => a.startsWith("--action="))?.slice(9);
const only = rest.find((a) => a.startsWith("--only="))?.slice(7);
const full = rest.includes("--full");
const browser = await launch();
for (const c of COMBOS.filter((c) => !only || only.split(",").includes(c.name))) {
  const W = +w, H = +h;
  const mobile = W <= 900 && H <= 900 && (W < 768 || H < 768);
  const { page, context } = await openApp(browser, { ...c, path, viewport: { width: W, height: H }, isMobile: mobile, hasTouch: mobile, scale: +(process.env.SCALE ?? 2) });
  await page.waitForTimeout(600);
  if (action) { await eval(`(async()=>{${action}})()`); await page.waitForTimeout(400); }
  await page.screenshot({ path: `${out}-${c.name}.png`, fullPage: full });
  await context.close();
}
await browser.close();
