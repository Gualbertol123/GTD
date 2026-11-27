// axe-core over every desktop tab and phone screen, in every skin combo.
// Usage: node scripts/ux/axe.mjs [desktop|phone] [comboNames] [paths]
//   paths: comma-separated hashes to check instead of every page (e.g. "#/review").
// Prints violations grouped by rule, with the first few targets.
import { launch, openApp, COMBOS } from "./stub.mjs";
const [mode = "desktop", only, onlyPaths] = process.argv.slice(2);
import { createRequire } from "node:module";
// axe-core is not a project dependency: install it anywhere
// (npm i axe-core@4.10.2) and set AXE_PATH to its axe.min.js, or install it
// next to this repo so require.resolve finds it.
const AXE =
  process.env.AXE_PATH ||
  (() => {
    try {
      return createRequire(import.meta.url).resolve("axe-core/axe.min.js");
    } catch {
      throw new Error("axe-core not found: npm i axe-core@4.10.2 and set AXE_PATH to its axe.min.js");
    }
  })();
const DESK = ["#/board", "#/projects", "#/projects/p1", "#/weekly", "#/review", "#/report", "#/mail", "#/calendario", "#/reflection", "#/products", "#/settings"];
const PHONE = ["#/today", "#/board", "#/projects", "#/agenda", "#/more", "#/more/weekly"];
const phone = mode === "phone";
const paths = onlyPaths ? onlyPaths.split(",") : phone ? PHONE : DESK;
const browser = await launch();
const summary = {};
for (const c of COMBOS.filter((c) => !only || only.split(",").includes(c.name))) {
  const { page, context } = await openApp(browser, {
    ...c,
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: phone,
    hasTouch: phone,
  });
  for (const p of paths) {
    await page.goto(page.url().split("#")[0] + p);
    await page.waitForTimeout(900);
    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        exclude: [[".report-print-root"], [".gr-page"]],
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        n: v.nodes.length,
        nodes: v.nodes.slice(0, 200).map((n) => `${n.target.join(" ")} :: ${(n.any[0]?.message || n.all[0]?.message || "").slice(0, 120)}`),
      }));
    });
    for (const v of res) {
      const k = `${v.id}`;
      summary[k] ??= { impact: v.impact, hits: [] };
      summary[k].hits.push(`${c.name} ${p} (${v.n})\n        ${v.nodes.join("\n        ")}`);
    }
  }
  await context.close();
}
for (const [k, v] of Object.entries(summary)) {
  console.log(`\n### ${k} [${v.impact}]`);
  for (const h of v.hits) console.log("   " + h);
}
await browser.close();
