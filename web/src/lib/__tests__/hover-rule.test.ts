// The hover rule (docs/interaction-rules.md): a resting pointer changes
// nothing but the cursor. This guard fails on any hover styling in the source,
// so a new one can't slip back in unnoticed. The pointer sweep
// (scripts/ux/hoverdiff.mjs) checks the running app; this checks the code.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..", "..");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...files(p, ext));
    } else if (ext.test(name)) out.push(p);
  }
  return out;
}

// Documented exceptions (docs/interaction-rules.md): "file :: text on the
// line" → reason. Only items inside an OPEN menu or suggestion list: the tint
// marks the item Enter / a click will choose, as keyboard focus does, in a
// surface the user has just opened.
const OPEN_LIST = "item inside an open menu / list: shows what a click will choose";
const ALLOW: Record<string, string> = {
  "styles/music.css :: .song-menu__item:hover": OPEN_LIST,
  "styles/music.css :: .mp-sugg__item:hover": OPEN_LIST,
  "styles/musicTab.css :: .mt-menu button:hover": OPEN_LIST,
  "styles/musicTab.css :: .mt-sugs button:hover": OPEN_LIST,
  "styles/musicTab.css :: .mt-menu--float button:hover": OPEN_LIST,
  "styles/glassReport.css :: .gr-picker-row:hover": OPEN_LIST,
};

const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");

describe("hover rule", () => {
  it("no Tailwind hover variants in components", () => {
    const hits: string[] = [];
    for (const f of files(SRC, /\.tsx?$/)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // hover:, group-hover:, peer-hover:, also inside arbitrary variants
          // like [&:hover]. "(hover:none)" in a media variant is fine.
          if (/(^|[\s"'`{&])((group|peer)-)?hover(\/[\w-]+)?:|&:hover/.test(line)) {
            const key = `${rel(f)} :: ${line.trim()}`;
            if (!Object.keys(ALLOW).some((k) => key.includes(k))) hits.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 120)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("no :hover selectors in stylesheets", () => {
    const hits: string[] = [];
    for (const f of files(SRC, /\.css$/)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\*|\*)/.test(line)) return; // comments
          if (/:hover\b/.test(line)) {
            const key = `${rel(f)} :: ${line.trim()}`;
            if (!Object.keys(ALLOW).some((k) => key.includes(k))) hits.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 120)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
