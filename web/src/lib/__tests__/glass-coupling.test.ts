// glass.css restyles Classic's literal Tailwind classes (.bg-white,
// .text-[#6B6B6B], .border-[#E8E6E1], …). If a component stops using one, or
// renames it, its Glass rule silently goes dead and the Glass look is lost
// without any error. This test lists every literal colour utility glass.css
// targets and fails if no component carries it any more.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");

function read(dir: string, ext: RegExp): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") out += read(p, ext);
    } else if (ext.test(name)) out += readFileSync(p, "utf8") + "\n";
  }
  return out;
}

describe("glass.css ↔ components", () => {
  it("every colour utility glass.css restyles is still used by a component", () => {
    const css = readFileSync(join(SRC, "styles", "glass.css"), "utf8");
    const code = read(SRC, /\.tsx?$/).toLowerCase();
    const sels = new Set(
      [...css.matchAll(/\.((?:bg|text|border)-\\\[\\#[0-9A-Fa-f]{6}\\\])/g)].map((m) => m[1].replace(/\\/g, ""))
    );
    expect(sels.size).toBeGreaterThan(20);
    const dead = [...sels].filter((cls) => !code.includes(cls.toLowerCase()));
    expect(dead).toEqual([]);
  });
});
