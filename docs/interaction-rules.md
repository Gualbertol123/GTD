# Interaction rules: hover, focus and motion

One rule for the whole app, in both skins (Classic, Glass) and both layouts
(desktop, phone). It exists because moving the mouse across a page used to
light up fields, draw rims around titles, grow shadows and reveal buttons:
dozens of small changes that made the interface feel restless. The rule is
checked by two tests; see *How it is enforced* at the end.

## The rule

1. **A resting pointer changes nothing but the cursor.** Moving the mouse over
   a page with no button pressed does not change colour, background, border,
   outline, shadow, opacity, size, position or visibility of anything.
2. **Text fields, selects, date inputs and textareas have no hover state.**
   They change only on focus (one focus ring, from the keyboard or a click),
   on error (`aria-invalid="true"`) and when disabled.
3. **Buttons that look like buttons** (filled, or a pill with a border) get no
   hover change either. The rule allows "at most a small background tint";
   this app uses none, everywhere, which is the calmer of the two and the only
   one that never repaints a blurred Glass surface (README §10, glass.css §11).
4. **Things that do not look clickable but are** (a task card, a collapsible
   section header, a row, a project card) get `cursor: pointer` and nothing
   else. Never a box around part of the target, such as its title.
5. **Nothing appears or disappears on hover.** A control that is needed is
   always shown (at a quieter weight if it is secondary: a delete ×, an
   unlink ×, a ⋯ menu), or shown while its item is open or has focus.
6. **Keyboard focus is always clearly visible.** Every focusable element keeps
   a `:focus-visible` ring (2 px, the accent: gold in Classic, systemBlue in
   Glass) with at least 3:1 contrast (WCAG 2.4.7, 2.4.11, 1.4.11). A calm hover
   never means an invisible focus.
7. **Motion only follows something the user did on purpose**: open / close,
   select, drag, press. No hover transitions at all; state transitions are
   short (≤ 150 ms, colour only, never layout), and everything respects
   `prefers-reduced-motion` (one global rule in `index.css`).

Pressing is not resting: a button may dim briefly while it is held down
(`:active`, Glass only), and drag-and-drop shows its drop targets while a
drag is in progress. Neither happens under a resting pointer.

## Where the states live

| State | Where | What |
| --- | --- | --- |
| Focus ring, every control | `index.css` (`:where(...)` default), `controls.css` (`.tab`) | 2 px outline in `--ctl-focus`, offset 2 px |
| Field focus / invalid / disabled | `index.css` `.field` | border + 2 px ring in `--field-*` tokens |
| Chosen (tabs, segments, toggles) | `controls.css` `.tab`, `.seg` | read from ARIA (`aria-pressed`, `aria-current`, `aria-selected`, `aria-expanded`) |
| Press | `glass.css` §7 | `:active` opacity 0.8 |
| Drop target while dragging | `index.css` `.drop-target`, `glass.css` | dashed outline + tint |
| Cursor | the element itself | `cursor: pointer` on clickable non-buttons |

## Exceptions

Each exception is listed here with its reason, and in the guard's allowlist.

| Where | What | Why |
| --- | --- | --- |
| Undo toasts (`components/TaskDetails.tsx`, `CalendarView.tsx`) | the toast's countdown pauses while the pointer is over it | WCAG 2.2.1 (timing adjustable). Nothing on screen changes. |
| ♪ button (`MusicPlayer.tsx`) | `onPointerEnter` warms the YouTube / Spotify player | A preload on intent; nothing on screen changes on a normal network. |

## How it is enforced

- **Static guard** (`npm test`, so also CI): `src/lib/__tests__/hover-rule.test.ts`
  fails on any Tailwind `hover:` / `group-hover:` / `peer-hover:` class in a
  component and on any `:hover` selector in a stylesheet, except the
  allowlist in that file (each entry has a reason).
- **Pointer sweep** (by hand, needs Playwright): `web/scripts/ux/hoverdiff.mjs`
  moves the real mouse over a 24 px grid on every desktop tab and phone
  screen, in Classic, Glass dark, Glass light and Glass without blur, at
  1440×900 and 1024×768 (phone 390×844), and diffs the computed style of every
  element and its `::before` / `::after` against rest. It exits 1 on any change
  the rule does not allow. See `UX_AUDIT.md` for how to run it.

When you add a control: give it `cursor: pointer` if it is clickable but
not a `<button>`, rely on the shared focus ring, and do not add a hover style.
