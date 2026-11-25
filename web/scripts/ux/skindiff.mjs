// -----------------------------------------------------------------------------
// Skin diff: do Classic and Glass differ in anything but paint?
//
//   node scripts/ux/skindiff.mjs [--sizes=1440x900,1024x768] [--only=board,weekly]
//                                [--against=glass-dark] [--out=<file.json>] [--verbose]
//
// README §10 promises the Glass skin "is only paint". This opens every desktop
// route in Classic and in a Glass combo (stub.mjs COMBOS), walks both DOM trees
// and matches elements by DOM path (children aligned by tag+class signature,
// so a node present in only one skin doesn't shift its siblings' match). Then:
//   - box:   own size, or own offset inside the parent, differs by > 1 px
//            (descendants that merely ride along with a moved ancestor are not
//            reported again; the absolute shift is kept for reference);
//   - style: computed position, display, overflow-x/y, z-index,
//            pointer-events or cursor differs;
//   - only:  an element exists in one skin only.
// Repeats are collapsed by (signature, kind, delta). For box diffs the
// padding / border / font / gap values of both sides are printed, which is
// usually enough to point at the rule in styles/glass.css.
// -----------------------------------------------------------------------------
import { writeFileSync } from "node:fs";
import { launch, openApp, COMBOS } from "./stub.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const VERBOSE = argv.includes("--verbose");
const sizes = opt("sizes", "1440x900,1024x768").split(",").map((s) => s.split("x").map(Number));
const against = COMBOS.find((c) => c.name === opt("against", "glass-dark"));
const classic = COMBOS.find((c) => c.name === "classic");
const ROUTES = [
  ["board", "#/board"],
  ["projects", "#/projects"],
  ["project-page", "#/projects/p1"],
  ["weekly", "#/weekly"],
  ["report", "#/report"],
  ["products", "#/products"],
  ["calendar", "#/calendario"],
  ["reflection", "#/reflection"],
  ["settings", "#/settings"],
  ["music", "#/music"],
].filter(([n]) => !opt("only") || opt("only").split(",").includes(n));

const STYLE_KEYS = ["position", "display", "overflowX", "overflowY", "zIndex", "pointerEvents", "cursor"];
const EXPLAIN_KEYS = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderLeftWidth", "marginTop", "marginLeft",
  "fontSize", "lineHeight", "fontWeight", "letterSpacing", "fontFamily",
  "gap", "height", "minHeight", "width", "boxSizing", "top",
];

/** Runs in the page: a tree of {sig, cls, txt, r, s, e, kids}. */
function collect([STYLE_KEYS, EXPLAIN_KEYS]) {
  const round = (v) => Math.round(v * 10) / 10;
  const walk = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "";
    const node = {
      tag: el.tagName.toLowerCase(),
      cls,
      sig: el.tagName.toLowerCase() + "." + cls.trim().split(/\s+/).slice(0, 3).join("."),
      txt: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
      r: [round(b.x), round(b.y + scrollY), round(b.width), round(b.height)],
      s: Object.fromEntries(STYLE_KEYS.map((k) => [k, cs[k]])),
      e: Object.fromEntries(EXPLAIN_KEYS.map((k) => [k, cs[k]])),
      kids: [],
    };
    if (!["svg", "script", "style", "iframe", "noscript"].includes(node.tag))
      for (const c of el.children) node.kids.push(walk(c));
    return node;
  };
  return walk(document.body);
}

/** LCS alignment of two child lists on signature (falls back to tag). */
function align(a, b) {
  const key = (n) => n.sig;
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [], onlyA = [], onlyB = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) pairs.push([a[i++], b[j++]]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(a[i++]);
    else onlyB.push(b[j++]);
  }
  while (i < n) onlyA.push(a[i++]);
  while (j < m) onlyB.push(b[j++]);
  // Same tag, different class (glass never changes className, but React state may): pair them up in order.
  const restA = [], restB = [...onlyB];
  for (const x of onlyA) {
    const k = restB.findIndex((y) => y.tag === x.tag);
    if (k >= 0) pairs.push([x, restB.splice(k, 1)[0]]);
    else restA.push(x);
  }
  return { pairs, onlyA: restA, onlyB: restB };
}

function diffTrees(A, B, out, path = "body", pa = null, pb = null) {
  const vis = (n) => n.r[2] > 0 && n.r[3] > 0;
  if (vis(A) || vis(B)) {
    const relA = pa ? [A.r[0] - pa.r[0], A.r[1] - pa.r[1]] : [A.r[0], A.r[1]];
    const relB = pb ? [B.r[0] - pb.r[0], B.r[1] - pb.r[1]] : [B.r[0], B.r[1]];
    const d = [relB[0] - relA[0], relB[1] - relA[1], B.r[2] - A.r[2], B.r[3] - A.r[3]].map((v) => Math.round(v));
    if (d.some((v) => Math.abs(v) > 1)) {
      const changed = Object.fromEntries(EXPLAIN_KEYS.filter((k) => A.e[k] !== B.e[k]).map((k) => [k, [A.e[k], B.e[k]]]));
      out.push({ kind: "box", path, sig: A.sig, txt: A.txt, d, a: A.r, b: B.r, changed });
    }
  }
  for (const k of STYLE_KEYS)
    if (A.s[k] !== B.s[k]) out.push({ kind: "style", prop: k, path, sig: A.sig, txt: A.txt, v: [A.s[k], B.s[k]] });
  const { pairs, onlyA, onlyB } = align(A.kids, B.kids);
  for (const x of onlyA) if (x.r[2] || x.r[3]) out.push({ kind: "only-classic", path: path + ">" + x.sig, sig: x.sig, txt: x.txt });
  for (const y of onlyB) if (y.r[2] || y.r[3]) out.push({ kind: "only-glass", path: path + ">" + y.sig, sig: y.sig, txt: y.txt });
  pairs.forEach(([a, b], i) => diffTrees(a, b, out, `${path}>${a.tag}:${i}`, A, B));
}

const groupKey = (x) =>
  x.kind === "box" ? `box|${x.sig}|${x.d.join(",")}` : x.kind === "style" ? `style|${x.sig}|${x.prop}|${x.v.join("→")}` : `${x.kind}|${x.sig}`;

const browser = await launch();
const report = [];
for (const [W, H] of sizes) {
  for (const [name, path] of ROUTES) {
    const trees = [];
    for (const c of [classic, against]) {
      const { page, context } = await openApp(browser, { ...c, path, viewport: { width: W, height: H } });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      await page.mouse.move(W - 2, H - 2); // park the pointer; hover is out of scope
      await page.waitForTimeout(700);
      trees.push(await page.evaluate(collect, [STYLE_KEYS, EXPLAIN_KEYS]));
      await context.close();
    }
    const raw = [];
    diffTrees(trees[0], trees[1], raw);
    const groups = new Map();
    for (const x of raw) {
      const k = groupKey(x);
      if (!groups.has(k)) groups.set(k, { ...x, n: 0 });
      groups.get(k).n++;
    }
    const list = [...groups.values()];
    report.push({ size: `${W}x${H}`, route: name, diffs: list });
    console.log(`\n== ${name} @ ${W}x${H}: ${raw.length} raw, ${list.length} groups`);
    for (const g of list.slice(0, VERBOSE ? 1e9 : 40)) {
      const tag = `${g.n > 1 ? `×${g.n} ` : ""}${g.sig.slice(0, 70)} "${g.txt}"`;
      if (g.kind === "box") console.log(`  box  d(x,y,w,h)=${g.d.join(",")}  ${tag}\n       ${JSON.stringify(g.changed)}`);
      else if (g.kind === "style") console.log(`  ${g.prop}: ${g.v[0]} → ${g.v[1]}  ${tag}`);
      else console.log(`  ${g.kind}  ${tag}`);
    }
  }
}
await browser.close();
const outFile = opt("out", "");
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 1));
