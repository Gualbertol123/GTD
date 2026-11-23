# Prompt: usability and design audit + fixes for TEAM GTD FINALE

Copy everything below the line into an AI coding agent that has this repository
checked out (Claude Code or similar), with permission to run the app and edit files.

---

You are a senior product designer and front-end engineer. Your job has two
parts, and **both are required**: audit the usability, interaction design and
visual design of this app, **and fix what you find in the code**. A report on its
own is not a finished job. Work from the code and from the running app, not
from guesses.

## How to work

Work in a loop, one problem at a time:

1. **Reproduce** the problem in the running app and take a "before" screenshot.
2. **Find the cause** in the code (`file:line`), at the source, not just where it shows.
3. **Fix it** with the smallest change that solves it properly.
4. **Verify** it in the browser in every skin/appearance it affects (see below),
   on desktop and phone, and take an "after" screenshot. Check you broke nothing
   next to it.
5. Run `npm run typecheck` and `npm test` in `web/`.
6. **Commit** that fix on its own, then log it in `UX_AUDIT.md` and move on.

Fix every blocker, major and minor you find. Fix polish items when they are
cheap and safe. Only leave something unfixed when fixing it would break a
constraint below or needs a decision from the team; then write down why and
what the options are. Don't stop after the audit to ask whether to start fixing:
start fixing.

## The app

- **What it is:** TEAM GTD FINALE, a real-time team GTD + Kanban board for a
  small Italian team. Bilingual Italian / English (Italian is the main language).
- **Stack:** React 18 + Vite + TypeScript + Tailwind 3, Supabase (Postgres +
  realtime), Netlify. All front-end code is in `web/`. There's no custom backend.
- **Read first:** `README.md` (feature tour by tab, desktop and phone),
  `web/tailwind.config.js`, `web/src/index.css`, `web/src/App.tsx`, and every file
  in `web/src/styles/` plus `web/src/mobile/mobile.css`.
- **Desktop tabs** (`App.tsx` → `components/`): Board (`BoardView`, `ListView`,
  `TaskCard`, `TaskDetails`, `QuickAdd`, `Filters`, `MembersBar`, `MenuBar`,
  `PriorityDistribution`), Projects (`ProjectsView`, `components/projects/*`),
  Weekly (`WeeklyView`), Report (`ReportView`, `GlassReport`), Calendar
  (`CalendarView`), Reflection (`DailyReflection`, `PersonalNotes`), Products
  (`ProductTreeView`), Music (`MusicTab`, `MusicPlayer`, `SpotifyLibrary`,
  `SongMenu`, `AudioOutput`), Settings (`SettingsView`). Header: `TopBar`.
- **Phone layout** (767 px wide or less): `web/src/mobile/*`. It's a separate UI
  with its own bottom bar and screens. The README section "1b. On a phone"
  describes it.

### How the styling works (read this before changing any CSS)

There are **two skins** and **two appearances**:

1. **Classic:** the original look. Navy `#0A1931`, gold `#C9A96E`, cream
   backgrounds, Cinzel headings and Inter body text. Components write these
   colours directly as Tailwind arbitrary values, such as `bg-[#0A1931]`,
   `border-[#E8E6E1]` and `hover:border-[#C9A96E]`.
2. **Liquid Glass** (`html[data-skin="glass"]`, in `web/src/styles/glass.css`):
   an iOS-style restyle that **re-maps those exact Tailwind class names** to
   tokens (`--label`, `--fill-3`, `--separator`, `--rim`, `--ios-blue`…), in a
   **dark** and a **light** appearance (`data-appearance`). Glass also has a blur
   on/off switch (`data-blur="off"`).

So any hard-coded colour class that `glass.css` doesn't re-map shows up in Glass
as a Classic colour on glass. That's usually where "weird colours" come from.
Every fix has to look right in **all four combinations** (Classic,
Glass-dark, Glass-light, Glass with blur off). Desktop and phone have to be
checked separately.

## Known bugs to fix first

### 1. Text boxes highlight on hover

Inputs, textareas and selects change look when the mouse is over them, even
when they aren't focused. On hover a field should at most show a very subtle
change in its border. A clear highlight belongs to `:focus-visible` only.
Find every source:

- `hover:` utilities on inputs, textareas, selects and `AutoTextarea`, or on the
  wrappers around them. Search for `hover:border-[#C9A96E]` (about 33 uses),
  `hover:bg-[...]` and `hover:border-[...]` across `components/` and `mobile/`.
- Glass rules that target controls. In `glass.css`, see section 6 (inset
  controls: `input.bg-white`, `input:focus`), section 7 (button hover
  `outline`, which hits anything rendered as a `<button>` that looks like a field,
  such as `.qa-field`, the assignee picker and date or priority pickers) and
  section 11 (`will-change: opacity` on `input, select, textarea` inside
  glass surfaces, which can cause repaint or flicker on hover).
- Inline-editable text that's really a `<button>` or a `div` with a hover
  style (the subtitle in `TopBar`, click-to-edit text in the Report, editable
  cards in Weekly and Projects).

Give hover, focus, disabled, read-only and invalid states **one shared
definition** for every field, in both skins, and remove the scattered one-off
hover classes.

### 2. Weird colours in the tabs

Check the main tab bar in `App.tsx` (`<nav aria-label=…tabsNav>`, around lines
165–194). The active tab uses `bg-[#0A1931] text-[#C9A96E]`. The inactive tab
uses `bg-white border-[#E8E6E1] hover:border-[#C9A96E]`. In Glass these are
re-mapped by several rules that compete (`glass.css` around lines 208–330 for
navy, gold and `header` overrides, and section 11 for `button.bg-white` hover
rims). Also check every other tab-like control:

- view toggles (Board/List, Cards/Timeline, Ongoing/Completed, List/Board in a
  project, Diary/Notes in Reflection, the Weekly column pills `.weekly-pill--*`)
- the Music tab's own pills (`.mt-pill`, `.mt-pill--solid` in `musicTab.css`,
  which hard-codes `#fff` and won't follow the light appearance)
- the phone's bottom bar and column pills (`mobile/`, `mobile.css`)

For each one, take screenshots of its default, hover, active, focus-visible and
disabled states in all four skin and appearance combinations. List every colour
that's off-palette, low-contrast, mismatched between neighbours (for example blue
active and gold hover, or a navy active tab on light glass), or different from the
other tab sets. Then make a **single tab/segmented-control style**, defined
once, and use it everywhere.

## Then audit and fix everything else

Go through every tab, desktop and phone, and judge it against the points below.
Fix each problem as you find it, using the loop in "How to work".
Use Playwright (Chromium is pre-installed: `require('playwright')`, no install
needed). Run the dev server (`cd web && npm run dev`). Take screenshots at
1440×900, 1024×768, 390×844 (phone) and 844×390 (phone landscape). If Supabase
isn't configured locally, use whatever offline or seed mode the app has
(`web/src/lib/seed.ts`), or stub the data. Don't point the app at production data.

1. **Visual consistency:** colours that aren't tokens, one-off hex values,
   font sizes (lots of `text-[10px]`, `[11px]`, `[12px]`, `[13px]`), radii, spacing,
   shadows, icon sizes. Propose a small scale for each and apply it.
2. **States:** hover, focus-visible, active, disabled, loading, empty, error and
   offline (`ConnBadge`) for every interactive element. Hover never moves layout
   (in Glass, moving a blurred element leaves visible seams; read the
   comments in `glass.css` §7, §10, §11 before you touch hover effects).
3. **Accessibility:** WCAG 2.2 AA contrast for small text in all four
   combinations, keyboard reach and visible focus, logical tab order,
   labels on every field and icon button, `aria-*` on toggles, tabs and
   collapsible bars, touch targets of at least 44 px on the phone, and
   `prefers-reduced-motion` / `prefers-reduced-transparency`.
4. **Information density and hierarchy:** the Board has many collapsible bars
   (Done, Archived, Menu mensa, Team, priority distribution, filters, new-task
   bar). Decide what's primary, what can be collapsed, and whether the
   order and defaults make sense for daily use.
5. **Interaction flows:** creating a task, editing it inline, moving it between
   columns (drag and the "move to" dropdown), multiple assignees, linking to a
   project, weekly review, generating the PDF report, Reflection login. Count
   clicks, find dead ends, unclear labels, missing confirmations or undo
   (there's a shared Undo toast; check it's used consistently), and anything
   that saves silently with no feedback.
6. **Copy and i18n:** every visible string goes through `t()` (files
   `web/src/lib/i18n*.ts`). Italian and English are both complete and natural.
   Labels are short and consistent (the same action has the same word
   everywhere). Text doesn't overflow or truncate badly in Italian, which runs longer.
7. **Phone:** the bottom bar steps aside while typing, sheets stay above the
   keyboard, swipe doesn't conflict with scrolling, and there's nothing on the
   phone that only works with hover.
8. **Performance you can see:** jank on hover or scroll in Glass with blur on,
   layout shift when data arrives from realtime, and slow first paint.

## Constraints

- **Don't change behaviour or data.** No schema changes, no Supabase migrations,
  no changes to sync logic (`lib/rowSync.ts`, `lib/optimisticSend.ts`,
  `useSyncedField`, `useAutosave`). This is a UX and design pass.
- Keep the brand: navy, gold and cream in Classic, the Apple palette in Glass.
  Refine it; don't replace it.
- Prefer fixing things at the source (shared classes or tokens) over adding more
  overrides to `glass.css`. If you add tokens, define them for both appearances.
- Keep the existing comment style in `glass.css`: each rule says *why* it exists.
- `npm run typecheck` and `npm test` (in `web/`) must pass. Don't touch the PDF
  report output (`GlassReport`, `glassReport.css`, `.report-print-root`) except
  for on-screen chrome around it.
- Make small, reviewable commits, one concern each, with clear messages.

## Deliverables

1. `UX_AUDIT.md` at the repo root containing:
   - a findings table: ID, area/tab, skin/appearance, severity (blocker / major /
     minor / polish), what's wrong, evidence (a screenshot path or `file:line`),
     and the fix
   - the design tokens and scales you settled on (colour, type, spacing, radius,
     field states, tab/segmented-control states)
   - before and after screenshots for the two known bugs and every major finding
   - anything you chose **not** to fix and why
2. **The code fixes themselves**, committed one concern per commit: first the two
   known bugs, then blockers, then majors, then minors, then cheap polish. Each
   row in the findings table says whether it is fixed (with the commit) or not
   (with the reason).
3. A short summary: what you fixed, what is still open and why, what to check
   by hand, and any questions for the team.

You're done when the two known bugs are fixed and verified in all four
skin/appearance combinations, every blocker, major and minor is fixed or
explained, typecheck and tests pass, and the commits are pushed to the working
branch.
