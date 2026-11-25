// -----------------------------------------------------------------------------
// Pointer sweep: does moving the mouse across a page change anything it
// shouldn't? The regression check for the hover rule (docs/interaction-rules.md).
//
//   node scripts/ux/hoverdiff.mjs [options]
//
//   --mode=desktop|phone     which screens (default desktop)
//   --combos=classic,…       skin combos (default all four, stub.mjs COMBOS)
//   --sizes=1440x900,…       viewports (default 1440x900,1024x768; phone 390x844)
//   --only=board,weekly      scenario names (default all for the mode)
//   --step=24                grid step in px
//   --screens=3              how many screens to scroll through per page
//   --label=after            writes ../ux-audit/sweep-<label>.json
//   --verbose                print every violation, not just a summary per page
//   --fields <path>          the old check: hover each field on one page
//
// How it works, per page state:
//   1. collect every element in the viewport (and hidden children of visible
//      ones, which is where hover reveals live) and record its computed style,
//      and its ::before / ::after, at rest; also its original transitions;
//   2. turn transitions and animations off, hit-test a grid of points with
//      elementFromPoint and group them by the element hit (one element = one
//      :hover chain), then move the real mouse to one point per group;
//   3. diff every collected element against rest, and watch the DOM for nodes
//      or attributes that change while hovering.
// Each change is classified against the rule. Allowed: a background-colour
// change on the hovered element or one of its ancestors, when that element is
// clickable (cursor: pointer or a control) and not a field, with a transition
// of at most 100 ms. Everything else is a violation, unless it matches
// scripts/ux/hover-allow.json (a documented exception). Exit code 1 if any.
// -----------------------------------------------------------------------------
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, openApp, COMBOS } from "./stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k) => argv.includes(`--${k}`);

if (flag("fields")) {
  await fieldsMode(argv[argv.indexOf("--fields") + 1] ?? "#/board");
  process.exit(0);
}

const MODE = opt("mode", "desktop");
const PHONE = MODE === "phone";
const STEP = +opt("step", "24");
const SCREENS = +opt("screens", PHONE ? "2" : "3");
const LABEL = opt("label", "");
const VERBOSE = flag("verbose");
const combos = COMBOS.filter((c) => !opt("combos") || opt("combos").split(",").includes(c.name));
const sizes = opt("sizes", PHONE ? "390x844" : "1440x900,1024x768")
  .split(",")
  .map((s) => s.split("x").map(Number));

// Page states. `act` runs in Node with `page` in scope after the route opens.
const DESKTOP = [
  { name: "board", path: "#/board" },
  {
    name: "board-card-open",
    path: "#/board",
    act: async (page) => {
      await page.locator(".task-card button").filter({ hasText: "Completare check" }).first().click();
      await page.waitForTimeout(300);
    },
  },
  { name: "board-list", path: "#/board", act: async (page) => { await page.getByRole("button", { name: /^(Lista|List)$/ }).click(); } },
  { name: "projects", path: "#/projects" },
  { name: "project-page", path: "#/projects/p1" },
  { name: "weekly", path: "#/weekly" },
  { name: "report", path: "#/report" },
  { name: "products", path: "#/products" },
  { name: "calendar", path: "#/calendario" },
  { name: "reflection", path: "#/reflection" },
  { name: "music", path: "#/music" },
  { name: "settings", path: "#/settings" },
];
const PHONES = [
  { name: "m-today", path: "#/today" },
  { name: "m-board", path: "#/board" },
  { name: "m-projects", path: "#/projects" },
  { name: "m-agenda", path: "#/agenda" },
  { name: "m-more", path: "#/more" },
  { name: "m-weekly", path: "#/more/weekly" },
];
const only = opt("only");
const scenarios = (PHONE ? PHONES : DESKTOP).filter((s) => !only || only.split(",").includes(s.name));

const allowPath = resolve(HERE, "hover-allow.json");
const ALLOW = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : [];

// ---------------------------------------------------------------------------
// In-page instrumentation (installed once per page; survives hash routing).
// ---------------------------------------------------------------------------
function install() {
  const PROPS = [
    "color",
    "background-color",
    "background-image",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "outline-style",
    "outline-width",
    "box-shadow",
    "opacity",
    "transform",
    "scale",
    "visibility",
    "display",
    "filter",
    "text-decoration-line",
  ];
  const PARTS = ["", "::before", "::after"];
  const S = (window.__sweep = { els: [], rest: [], trans: [], muts: [], obs: null });

  const read = (e) =>
    PARTS.map((p) => {
      const cs = getComputedStyle(e, p || null);
      if (p && (cs.content === "none" || cs.content === "normal")) return null;
      return PROPS.map((k) => cs.getPropertyValue(k));
    });

  const describe = (e) => {
    const tag = e.tagName.toLowerCase();
    const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).slice(0, 5).join(".") : "";
    const label =
      e.getAttribute("aria-label") ||
      e.getAttribute("placeholder") ||
      e.getAttribute("title") ||
      (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `${tag}${cls ? "." + cls : ""}${label ? ` "${label}"` : ""}`;
  };

  S.collect = () => {
    const vw = innerWidth, vh = innerHeight;
    const inView = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const els = [];
    for (const e of document.body.querySelectorAll("*")) {
      if (e.closest("svg") && e.tagName.toLowerCase() !== "svg") continue; // svg parts inherit colour
      if (e.tagName === "SCRIPT" || e.tagName === "STYLE" || e.tagName === "IFRAME") continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        // Hidden (display: none or empty): keep it if its parent is on screen,
        // which is where a hover reveal would show it.
        const p = e.parentElement?.getBoundingClientRect();
        if (!p || !inView(p)) continue;
      } else if (!inView(r)) continue;
      els.push(e);
    }
    S.els = els;
    S.trans = els.map((e) =>
      PARTS.map((p) => {
        const cs = getComputedStyle(e, p || null);
        return { prop: cs.transitionProperty, dur: cs.transitionDuration };
      })
    );
  };
  S.freeze = (on) => {
    let st = document.getElementById("__sweep_freeze");
    if (on && !st) {
      st = document.createElement("style");
      st.id = "__sweep_freeze";
      st.textContent =
        "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
      document.head.appendChild(st);
    } else if (!on && st) st.remove();
  };
  S.snapRest = () => {
    S.rest = S.els.map(read);
  };
  // Elements whose style changes with no pointer at all (clocks, the music
  // progress, a pulsing badge): never counted.
  S.noise = new Set();
  S.markNoise = () => {
    S.els.forEach((e, i) => {
      if (JSON.stringify(read(e)) !== JSON.stringify(S.rest[i])) S.noise.add(i);
    });
  };
  S.targets = (step) => {
    const vw = innerWidth, vh = innerHeight;
    const seen = new Map();
    for (let y = Math.floor(step / 2); y < vh; y += step)
      for (let x = Math.floor(step / 2); x < vw; x += step) {
        const t = document.elementFromPoint(x, y);
        if (!t || seen.has(t)) continue;
        seen.set(t, [x, y]);
      }
    S.targetEls = [...seen.keys()];
    return [...seen.values()];
  };
  S.startWatch = () => {
    S.muts = [];
    S.obs?.disconnect();
    S.obs = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.target.closest?.("[data-sweep-ignore]")) continue;
        if (r.type === "childList") {
          for (const n of [...r.addedNodes, ...r.removedNodes])
            if (n.nodeType === 1) S.muts.push(`${r.addedNodes.length ? "added" : "removed"} ${describe(n)}`);
        } else if (r.type === "attributes") {
          if (r.attributeName === "style" && r.target.closest?.("svg")) continue;
          S.muts.push(`attr ${r.attributeName} on ${describe(r.target)}`);
        }
      }
    });
    S.obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-expanded"] });
  };
  const FIELD = "input, select, textarea, .field, [contenteditable='true'], [contenteditable='']";
  const CONTROL =
    "button, a[href], summary, label, [role=button], [role=tab], [role=link], [role=option], [role=menuitem], [role=checkbox], [draggable=true], [tabindex]:not([tabindex='-1'])";
  const durMs = (s) => Math.max(...s.split(",").map((d) => (d.trim().endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000)));
  // Hovering the element at index `ti` of S.targetEls: what changed?
  S.diff = async (x, y) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const target = document.elementFromPoint(x, y);
    const out = [];
    S.els.forEach((e, i) => {
      if (S.noise.has(i) || !e.isConnected) return;
      const now = read(e);
      const was = S.rest[i];
      PARTS.forEach((part, pi) => {
        const a = was[pi], b = now[pi];
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        const changes = [];
        if (!a || !b) changes.push({ prop: "content", from: a ? "on" : "none", to: b ? "on" : "none" });
        else PROPS.forEach((k, ki) => a[ki] !== b[ki] && changes.push({ prop: k, from: a[ki], to: b[ki] }));
        const inChain = !!target && (e === target || e.contains(target));
        const field = e.matches(FIELD);
        const clickable = e.matches(CONTROL) || getComputedStyle(e).cursor === "pointer";
        const onlyBg = !part && changes.every((c) => c.prop === "background-color");
        // Transition that was on this change before the freeze.
        const tr = S.trans[i][pi];
        const slow = changes.some((c) => {
          const props = tr.prop.split(",").map((s) => s.trim());
          const durs = tr.dur.split(",").map((s) => s.trim());
          const j = props.findIndex((p) => p === "all" || p === c.prop || c.prop.startsWith(p + "-"));
          return j >= 0 && durMs(durs[j % durs.length]) > 100;
        });
        let verdict;
        if (field) verdict = "field";
        else if (!inChain) verdict = changes.some((c) => ["display", "visibility", "opacity", "content"].includes(c.prop)) ? "appears" : "elsewhere";
        else if (onlyBg && clickable) verdict = slow ? "slow-tint" : "ok-tint";
        else if (changes.some((c) => ["display", "visibility", "opacity", "content"].includes(c.prop))) verdict = "appears";
        else if (changes.some((c) => /outline|box-shadow|border/.test(c.prop))) verdict = "rim";
        else if (changes.some((c) => c.prop === "transform" || c.prop === "scale")) verdict = "moves";
        else if (changes.some((c) => c.prop === "color" || c.prop === "text-decoration-line")) verdict = "text";
        else verdict = onlyBg ? "tint-not-clickable" : "other";
        out.push({ i, el: describe(e) + part, verdict, changes, inChain });
      });
    });
    return { target: target ? describe(target) : "(none)", changes: out, muts: S.muts.slice() };
  };
}

// ---------------------------------------------------------------------------
async function sweepPage(page, scen) {
  const found = new Map(); // element description + part → record
  const muts = new Map();
  let screens = 0;
  for (let s = 0; s < SCREENS; s++) {
    const canScroll = await page.evaluate((s) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const y = Math.round(s * innerHeight * 0.85);
      if (s > 0 && y > max + 8) return false;
      window.scrollTo(0, Math.min(y, max));
      return true;
    }, s);
    if (!canScroll) break;
    screens++;
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.__sweep.freeze(false));
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__sweep.collect());
    await page.evaluate(() => window.__sweep.freeze(true));
    // Rest: the pointer parked on the page's top-left pixel (the header's
    // edge), then read twice to find what changes by itself.
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__sweep.snapRest());
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__sweep.markNoise());
    const pts = await page.evaluate((st) => window.__sweep.targets(st), STEP);
    await page.evaluate(() => window.__sweep.startWatch());
    for (const [x, y] of pts) {
      await page.mouse.move(x, y);
      const r = await page.evaluate(([x, y]) => window.__sweep.diff(x, y), [x, y]);
      for (const c of r.changes) {
        const key = `${c.el}`;
        const rec = found.get(key) ?? { el: c.el, verdict: c.verdict, changes: new Map(), at: r.target, n: 0 };
        // The worst verdict wins (ok-tint < anything else).
        if (rec.verdict.startsWith("ok") && !c.verdict.startsWith("ok")) {
          rec.verdict = c.verdict;
          rec.at = r.target;
        }
        rec.n++;
        for (const ch of c.changes) rec.changes.set(ch.prop, `${ch.from} → ${ch.to}`);
        found.set(key, rec);
      }
      for (const m of r.muts) if (!muts.has(m)) muts.set(m, r.target);
      await page.evaluate(() => (window.__sweep.muts = []));
    }
    await page.evaluate(() => window.__sweep.obs?.disconnect());
  }
  await page.evaluate(() => window.__sweep.freeze(false));
  const recs = [...found.values()].map((r) => ({ ...r, changes: Object.fromEntries(r.changes) }));
  for (const r of recs) {
    const a = ALLOW.find((a) => (!a.scenario || new RegExp(a.scenario).test(scen)) && new RegExp(a.el).test(r.el) && (!a.verdict || a.verdict === r.verdict));
    if (a && !r.verdict.startsWith("ok")) r.allowed = a.reason;
  }
  const mutList = [...muts.entries()].map(([m, at]) => ({ m, at }));
  return { recs, mutList, screens };
}

const browser = await launch();
const report = { date: new Date().toISOString(), mode: MODE, step: STEP, pages: [] };
let violations = 0;
for (const c of combos) {
  for (const [W, H] of sizes) {
    const { page, context } = await openApp(browser, {
      ...c,
      path: scenarios[0].path,
      viewport: { width: W, height: H },
      isMobile: PHONE,
      hasTouch: PHONE,
    });
    await page.evaluate(install);
    for (const scen of scenarios) {
      await page.goto(page.url().split("#")[0] + scen.path);
      await page.waitForTimeout(700);
      if (!(await page.evaluate(() => !!window.__sweep))) await page.evaluate(install);
      try {
        if (scen.act) await scen.act(page);
      } catch (e) {
        console.log(`   ! ${scen.name}: action failed (${e.message.split("\n")[0]})`);
      }
      await page.waitForTimeout(300);
      const t0 = Date.now();
      const { recs, mutList, screens } = await sweepPage(page, scen.name);
      const bad = recs.filter((r) => !r.verdict.startsWith("ok") && !r.allowed);
      const ok = recs.filter((r) => r.verdict.startsWith("ok"));
      const allowed = recs.filter((r) => r.allowed);
      violations += bad.length + mutList.length;
      const byVerdict = {};
      for (const r of bad) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
      report.pages.push({ combo: c.name, size: `${W}x${H}`, scenario: scen.name, screens, changed: recs.length, ok: ok.length, allowed: allowed.length, violations: bad.length, mutations: mutList.length, byVerdict, recs, mutList });
      console.log(
        `${c.name.padEnd(12)} ${`${W}x${H}`.padEnd(9)} ${scen.name.padEnd(16)} changed ${String(recs.length).padStart(3)} · ok ${String(ok.length).padStart(3)} · allowed ${String(allowed.length).padStart(2)} · VIOLATIONS ${String(bad.length).padStart(3)}${mutList.length ? ` + ${mutList.length} DOM` : ""}  ${JSON.stringify(byVerdict)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`
      );
      if (VERBOSE)
        for (const r of bad)
          console.log(`      [${r.verdict}] ${r.el}  (at ${r.at})\n         ${Object.entries(r.changes).map(([k, v]) => `${k}: ${v}`).join("\n         ")}`);
      if (VERBOSE) for (const m of mutList) console.log(`      [dom] ${m.m}  (at ${m.at})`);
    }
    await context.close();
  }
}
await browser.close();

// Summary per scenario (sum over combos and sizes).
const sum = {};
for (const p of report.pages) {
  const s = (sum[p.scenario] ??= { changed: 0, ok: 0, violations: 0, mutations: 0 });
  s.changed += p.changed;
  s.ok += p.ok;
  s.violations += p.violations;
  s.mutations += p.mutations;
}
report.summary = sum;
console.log("\nscenario          changed    ok  violations  dom");
for (const [k, s] of Object.entries(sum))
  console.log(`${k.padEnd(16)} ${String(s.changed).padStart(8)} ${String(s.ok).padStart(5)} ${String(s.violations).padStart(11)} ${String(s.mutations).padStart(4)}`);
console.log(`\nTOTAL violations: ${violations}`);
if (LABEL) {
  const dir = resolve(HERE, "../../../ux-audit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `sweep-${LABEL}-${MODE}${opt("combos") ? "-" + opt("combos") : ""}.json`), JSON.stringify(report, null, 1));
}
process.exit(violations ? 1 : 0);

// ---------------------------------------------------------------------------
// The original per-field check: hover each field on one page, every combo.
async function fieldsMode(path) {
  const props = ["border-top-color", "background-color", "box-shadow", "outline-color", "outline-style", "outline-width", "color"];
  const browser = await launch();
  for (const c of COMBOS) {
    const { page, context } = await openApp(browser, { ...c, path });
    const sel = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), select, textarea, .qa-field, .field, [aria-haspopup]";
    const out = [];
    let n = 0;
    for (const el of await page.$$(sel)) {
      if (!(await el.isVisible())) continue;
      n++;
      const read = () => el.evaluate((e, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(e).getPropertyValue(p)])), props);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      const a = await read();
      await el.hover({ force: true });
      await page.waitForTimeout(350);
      const b = await read();
      const diff = Object.keys(a).filter((p) => a[p] !== b[p]).map((p) => `${p}: ${a[p]} -> ${b[p]}`);
      if (diff.length) out.push(`  ${await el.evaluate((e) => e.outerHTML.slice(0, 90))}\n     ${diff.join("\n     ")}`);
    }
    console.log(`== ${c.name}: ${out.length}/${n} fields change on hover`);
    if (out.length) console.log(out.join("\n"));
    await context.close();
  }
  await browser.close();
}
