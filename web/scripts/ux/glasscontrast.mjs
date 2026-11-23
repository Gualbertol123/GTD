// Glass text contrast estimate. axe cannot compose translucent glass, so each
// text colour is checked against the opaque stand-ins the skin itself uses for
// "Reduce transparency" (panel and tray), plus the wallpaper's base. Only text
// whose own element or nearest ancestor has no solid fill is checked against
// those; text on a solid fill (a blue button) is checked against that fill.
// Usage: node scripts/ux/glasscontrast.mjs <glass-dark|glass-light> [paths...]
import { launch, openApp, COMBOS } from "./stub.mjs";
const [combo = "glass-light", ...rest] = process.argv.slice(2);
const paths = rest.length ? rest : ["#/board", "#/projects", "#/projects/p1", "#/weekly", "#/report", "#/calendario", "#/reflection", "#/products", "#/settings"];
const c = COMBOS.find((x) => x.name === combo);
const browser = await launch();
const { page } = await openApp(browser, { ...c });
const out = new Map();
for (const p of paths) {
  await page.goto(page.url().split("#")[0] + p);
  await page.waitForTimeout(800);
  const rows = await page.evaluate((light) => {
    const parse = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
        return [+r, +g, +b, +a];
      }
      const m2 = s.match(/color\(srgb ([^)]+)\)/);
      if (m2) {
        const [r, g, b, , a] = m2[1].split(/\s+/);
        return [r * 255, g * 255, b * 255, a === undefined ? 1 : +a];
      }
      return null;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cr = (a, b) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    // Worst-case surfaces: the opaque panel / tray / wallpaper base.
    const SURF = light ? [[255, 255, 255], [233, 237, 247], [228, 235, 250]] : [[35, 40, 66], [22, 27, 48], [19, 26, 51]];
    const res = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".report-print-root, .mt, svg")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !el.offsetParent) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || +cs.opacity === 0) continue;
      // nearest solid-ish fill
      let solid = null;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const bg = parse(getComputedStyle(a).backgroundColor);
        if (bg && bg[3] >= 0.85) { solid = bg; break; }
      }
      const bgs = solid ? [solid] : SURF;
      const worst = Math.min(...bgs.map((b) => cr(over(fg, b), b)));
      const size = parseFloat(cs.fontSize);
      const bold = +cs.fontWeight >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (worst < need) res.push(`${worst.toFixed(2)} ${cs.color} ${size}px "${el.textContent.trim().slice(0, 28)}" <${el.tagName.toLowerCase()} ${String(el.className).slice(0, 70)}>`);
    }
    return res;
  }, c.appearance === "light");
  for (const r of rows) {
    const key = r.replace(/"[^"]*"/, "");
    if (!out.has(key)) out.set(key, `${p} ${r}`);
  }
}
for (const v of out.values()) console.log(v);
await browser.close();
