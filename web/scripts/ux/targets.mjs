// Phone: every visible control smaller than 44x44 CSS px (WCAG 2.5.8 asks
// 24, Apple's HIG 44). Usage: node scripts/ux/targets.mjs [combo]
import { launch, openApp, COMBOS } from "./stub.mjs";
const [combo = "glass-dark"] = process.argv.slice(2);
const PHONE = ["#/today", "#/board", "#/projects", "#/agenda", "#/more", "#/more/weekly", "#/more/settings", "#/more/reflection"];
const c = COMBOS.find((x) => x.name === combo);
const browser = await launch();
const { page } = await openApp(browser, { ...c, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const seen = new Map();
for (const p of PHONE) {
  await page.goto(page.url().split("#")[0] + p);
  await page.waitForTimeout(900);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], [role=checkbox], summary")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const s = getComputedStyle(e);
        if (s.visibility === "hidden" || s.display === "none") return false;
        return r.width < 44 || r.height < 44;
      })
      .map((e) => {
        const r = e.getBoundingClientRect();
        const name = (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || "").trim().slice(0, 30);
        return `${Math.round(r.width)}x${Math.round(r.height)} <${e.tagName.toLowerCase()} .${String(e.className).split(" ")[0]}> "${name}"`;
      })
  );
  for (const s of small) {
    const key = s.replace(/"[^"]*"$/, "");
    if (!seen.has(key)) seen.set(key, `${p}  ${s}`);
  }
}
for (const v of seen.values()) console.log(v);
await browser.close();
