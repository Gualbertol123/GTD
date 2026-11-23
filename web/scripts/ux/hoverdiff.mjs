// For every visible field (input/select/textarea + field-like buttons), hover it
// and report which computed styles change. Usage:
//   node scripts/ux/hoverdiff.mjs <path> [actionJs] [width] [height]
import { launch, openApp, COMBOS } from "./stub.mjs";
const [path = "#/board", action, w = "1440", h = "900"] = process.argv.slice(2);
const props = ["border-top-color", "background-color", "box-shadow", "outline-color", "outline-style", "outline-width", "color"];
const browser = await launch();
for (const c of COMBOS) {
  const { page, context } = await openApp(browser, { ...c, path, viewport: { width: +w, height: +h } });
  if (action) {
    await eval(`(async()=>{${action}})()`);
    await page.waitForTimeout(400);
  }
  const sel =
    process.env.SEL ||
    "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), select, textarea, .qa-field, .field, [aria-haspopup]";
  const els = await page.$$(sel);
  const out = [];
  let n = 0;
  for (const el of els) {
    if (!(await el.isVisible())) continue;
    n++;
    const read = () =>
      el.evaluate((e, props) => {
        const s = getComputedStyle(e);
        const o = Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
        const af = getComputedStyle(e, "::after");
        o["::after opacity"] = af.content === "none" ? "-" : af.opacity;
        let a = e.parentElement;
        for (let i = 1; a && i <= 5; i++, a = a.parentElement) {
          const ps = getComputedStyle(a);
          const pa = getComputedStyle(a, "::after");
          o[`ancestor${i} <${a.tagName.toLowerCase()} ${String(a.className).slice(0, 60)}>`] =
            [ps.borderTopColor, ps.backgroundColor, ps.boxShadow, ps.outlineColor, pa.content === "none" ? "" : pa.opacity].join(" | ");
        }
        return o;
      }, props);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    const a = await read();
    await el.hover({ force: true });
    await page.waitForTimeout(350);
    const b = await read();
    const diff = Object.keys(a).filter((p) => a[p] !== b[p]).map((p) => `${p}: ${a[p]} -> ${b[p]}`);
    const id = await el.evaluate(
      (e) =>
        `${e.tagName.toLowerCase()}${e.className ? "." + String(e.className).split(" ").slice(0, 3).join(".") : ""}[${
          e.getAttribute("placeholder") || e.getAttribute("aria-label") || ""
        }]`
    );
    if (diff.length) out.push(`  ${id}\n     ${diff.join("\n     ")}`);
  }
  console.log(`== ${c.name}: ${out.length}/${n} fields change on hover`);
  if (out.length) console.log(out.join("\n"));
  await context.close();
}
await browser.close();
