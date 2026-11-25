"""Contact sheet: rows = skin combos, columns = states.
Usage: python3 sheet.py <dir> <prefix> <name> [states...]"""
import sys
from PIL import Image, ImageDraw

d, prefix, name, *states = sys.argv[1:]
states = states or ["rest", "hover", "focus"]
combos = ["classic", "glass-dark", "glass-light", "glass-noblur"]
cells = []
for c in combos:
    row = []
    for s in states:
        try:
            row.append(Image.open(f"{d}/{prefix}-{name}-{s}-{c}.png").convert("RGB"))
        except FileNotFoundError:
            row.append(None)
    cells.append(row)
W = max((i.width for r in cells for i in r if i), default=10)
H = max((i.height for r in cells for i in r if i), default=10)
pad, lab = 12, 140
out = Image.new("RGB", (lab + len(states) * (W + pad), len(combos) * (H + pad) + 30), "#888")
dr = ImageDraw.Draw(out)
for j, s in enumerate(states):
    dr.text((lab + j * (W + pad), 8), s, fill="black")
for i, (c, r) in enumerate(zip(combos, cells)):
    y = 30 + i * (H + pad)
    dr.text((6, y + H // 2), c, fill="black")
    for j, im in enumerate(r):
        if im:
            out.paste(im, (lab + j * (W + pad), y))
out.save(f"{d}/{prefix}-{name}-sheet.png")
