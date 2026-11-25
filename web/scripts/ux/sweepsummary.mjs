// Turn pointer-sweep results (ux-audit/sweep-<label>-*.json, written by
// hoverdiff.mjs --label=…) into a markdown table: elements that changed
// under the pointer, per page, summed over the combos and viewports run.
//   node scripts/ux/sweepsummary.mjs before after [--fix=beforefix]
// --fix: a later run of some scenarios whose rows replace the first label's
// (used once, when the "before" run had a broken scenario).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../ux-audit");
const args = process.argv.slice(2);
const fix = args.find((a) => a.startsWith("--fix="))?.slice(6);
const labels = args.filter((a) => !a.startsWith("--"));

function load(label) {
  const pages = [];
  for (const f of readdirSync(DIR)) if (f.startsWith(`sweep-${label}-`) && f.endsWith(".json")) pages.push(...JSON.parse(readFileSync(resolve(DIR, f), "utf8")).pages);
  return pages;
}
const key = (p) => `${p.combo}|${p.size}|${p.scenario}`;
const sets = labels.map((l, i) => {
  let pages = load(l);
  if (i === 0 && fix) {
    const repl = new Map(load(fix).map((p) => [key(p), p]));
    pages = pages.map((p) => repl.get(key(p)) ?? p);
  }
  return pages;
});
const scenarios = [...new Set(sets.flat().map((p) => p.scenario))];
const combos = [...new Set(sets.flat().map((p) => p.combo))];
const sum = (pages, scen, f) => pages.filter((p) => p.scenario === scen).reduce((a, p) => a + f(p), 0);
const bad = (p) => p.violations + p.mutations;

console.log(`| Page | ${labels.map((l) => `${l}: changed / violations`).join(" | ")} |`);
console.log(`| --- | ${labels.map(() => "---").join(" | ")} |`);
for (const s of scenarios)
  console.log(`| ${s} | ${sets.map((ps) => `${sum(ps, s, (p) => p.changed)} / ${sum(ps, s, bad)}`).join(" | ")} |`);
console.log(`| **total** | ${sets.map((ps) => `**${ps.reduce((a, p) => a + p.changed, 0)} / ${ps.reduce((a, p) => a + bad(p), 0)}**`).join(" | ")} |`);
console.log(`\nPer combo (violations): `);
for (const c of combos) console.log(`- ${c}: ${sets.map((ps, i) => `${labels[i]} ${ps.filter((p) => p.combo === c).reduce((a, p) => a + bad(p), 0)}`).join(" → ")}`);
// Kinds of violation in the first set.
const kinds = {};
for (const p of sets[0]) for (const [k, v] of Object.entries(p.byVerdict)) kinds[k] = (kinds[k] ?? 0) + v;
console.log(`\nKinds in "${labels[0]}": ${JSON.stringify(kinds)}`);
