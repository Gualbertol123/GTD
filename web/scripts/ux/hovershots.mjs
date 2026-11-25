// Before/after evidence for the hover rule: the same control at rest and under
// the pointer, side by side, in every skin combo, at deviceScaleFactor 2.
//   node scripts/ux/hovershots.mjs <before|after> [comboNames]
// Writes ux-audit/shots/hover-<label>-<case>-<combo>.png (rest | hover).
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, openApp, COMBOS } from "./stub.mjs";

const [label = "before", only] = process.argv.slice(2);
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../ux-audit/shots");
mkdirSync(OUT, { recursive: true });

// Each case: where to hover, and the region to clip (around the control).
const CASES = [
  { name: "newtask", path: "#/board", hover: (p) => p.getByPlaceholder(/Nuova attività|New task/).first(), pad: 14 },
  { name: "band", path: "#/board", hover: (p) => p.getByRole("button", { name: /In evidenza|Highlighted/ }).first(), clip: (p) => p.locator(".pin-band").first(), pad: 6 },
  { name: "tabs", path: "#/board", hover: (p) => p.getByRole("button", { name: "PROGETTI" }).first(), clip: (p) => p.locator("nav").first(), pad: 6 },
  { name: "toolbar", path: "#/board", hover: (p) => p.getByRole("button", { name: /^Colonne/ }).first(), pad: 120 },
  { name: "card", path: "#/board", hover: (p) => p.locator(".task-card").filter({ hasText: "Completare check" }).first(), pad: 10 },
  { name: "filters", path: "#/board", hover: (p) => p.getByPlaceholder(/Cerca attività|Search tasks/).first(), pad: 14 },
];

const browser = await launch();
for (const c of COMBOS.filter((c) => !only || only.split(",").includes(c.name))) {
  const { page, context } = await openApp(browser, { ...c, scale: 2 });
  for (const k of CASES) {
    await page.goto(page.url().split("#")[0] + k.path);
    await page.waitForTimeout(700);
    const target = k.hover(page);
    await target.scrollIntoViewIfNeeded();
    const box = await (k.clip ? k.clip(page) : target).boundingBox();
    if (!box) continue;
    const pad = k.pad ?? 8;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(box.width + pad * 2, 1440 - Math.max(0, box.x - pad)),
      height: box.height + pad * 2,
    };
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const rest = await page.screenshot({ clip });
    await target.hover({ force: true });
    await page.waitForTimeout(500);
    const hover = await page.screenshot({ clip });
    // Stack rest above hover in one image (no image library: let the page do it).
    const p2 = await context.newPage();
    await p2.setViewportSize({ width: Math.ceil(clip.width), height: Math.ceil(clip.height * 2 + 30) });
    await p2.setContent(
      `<body style="margin:0;background:#888;font:11px system-ui;color:#fff">
        <div style="position:relative"><img style="display:block;width:${clip.width}px" src="data:image/png;base64,${rest.toString("base64")}"><span style="position:absolute;top:2px;right:4px;background:#000a;padding:1px 4px">rest</span></div>
        <div style="height:30px;line-height:30px;padding-left:6px">${label} · ${c.name} · ${k.name}</div>
        <div style="position:relative"><img style="display:block;width:${clip.width}px" src="data:image/png;base64,${hover.toString("base64")}"><span style="position:absolute;top:2px;right:4px;background:#000a;padding:1px 4px">hover</span></div>
      </body>`
    );
    await p2.screenshot({ path: resolve(OUT, `hover-${label}-${k.name}-${c.name}.png`), fullPage: true });
    await p2.close();
  }
  await context.close();
}
await browser.close();
