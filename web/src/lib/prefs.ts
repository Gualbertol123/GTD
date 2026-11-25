// Per-viewer UI preferences. Personal display settings for THIS browser only —
// not board data — so localStorage is the right home. Board content still lives
// only on the server and is never cached locally.

const KEYS = {
  lang: "gtd-lang",
  hidden: "gtd-hidden-cols",
  view: "gtd-view-mode",
  weights: "gtd-col-weights",
  auth: "gtd-auth",
  me: "gtd-me",
  reviewed: "gtd-reviewed",
  prio: "gtd-prio-collapsed",
  pinBand: "gtd-pin-band",
  menuBar: "gtd-menu-bar",
  reflauth: "gtd-refl-auth",
  reflpane: "gtd-reflection-pane",
  skin: "gtd-skin",
  appearance: "gtd-appearance",
  blur: "gtd-blur",
  color: "gtd-color",
  projView: "gtd-projects-view",
  projTasksView: "gtd-project-tasks-view",
  layout: "gtd-layout",
  music: "gtd-music-side",
  musicMode: "gtd-music-mode",
  musicVolume: "gtd-music-volume",
  musicPremium: "gtd-music-premium",
  musicSort: "gtd-music-sort",
  musicEngine: "gtd-music-engine",
  mTab: "gtd-m-tab",
  mBoardCol: "gtd-m-board-col",
  reportPeriod: "gtd-report-period",
} as const;

export function readPref(key: keyof typeof KEYS): string | null {
  try {
    return localStorage.getItem(KEYS[key]);
  } catch {
    return null;
  }
}

export function writePref(key: keyof typeof KEYS, value: string): void {
  try {
    localStorage.setItem(KEYS[key], value);
  } catch {
    /* private mode / disabled storage — ignore */
  }
}

export function removePref(key: keyof typeof KEYS): void {
  try {
    localStorage.removeItem(KEYS[key]);
  } catch {
    /* ignore */
  }
}

// Columns the viewer has chosen to hide.
export function readHidden(): string[] {
  return readJson<string[]>("hidden", []).filter((x) => typeof x === "string");
}
export function writeHidden(cols: string[]): void {
  writePref("hidden", JSON.stringify(cols));
}

// Board vs list view.
export type ViewMode = "board" | "list";
export function readViewMode(): ViewMode {
  return readPref("view") === "list" ? "list" : "board";
}
export function writeViewMode(v: ViewMode): void {
  writePref("view", v);
}

// Per-column flex-grow weights for the resizable board.
export function readWeights(): Record<string, number> {
  const w = readJson<Record<string, number>>("weights", {});
  return w && typeof w === "object" ? w : {};
}
export function writeWeights(w: Record<string, number>): void {
  writePref("weights", JSON.stringify(w));
}

// When this device's team login ends: { exp: epoch-ms }. The session itself
// is Supabase's (lib/supabaseClient.ts); AuthGate ends it at this time.
export function readAuthExp(): number | null {
  const a = readJson<{ exp?: number }>("auth", {});
  return typeof a?.exp === "number" ? a.exp : null;
}
export function writeAuth(exp: number): void {
  writePref("auth", JSON.stringify({ exp }));
}
// Leaving the team login also forgets every per-member Reflection login on
// this device, so the next person to log in here cannot open someone's diary.
export function clearLoginState(): void {
  removePref("auth");
  removePref("reflauth");
  // Report drafts hold board text: they go too, so a shared device keeps none.
  purgeReportDrafts(true);
  removePref("reportPeriod");
}

// Priority-distribution collapsed state (default collapsed to save space).
export function readPrioCollapsed(): boolean {
  const v = readPref("prio");
  return v === null ? true : v === "1";
}
export function writePrioCollapsed(v: boolean): void {
  writePref("prio", v ? "1" : "0");
}

// "In evidenza" band open (default) or collapsed, per device, like the other
// collapsible bars on the board.
// Owner's decision (2026-11-25): open by default on wide screens, collapsed
// below 1200 px, where the open band pushed the first card to the fold.
export function readPinBandOpen(): boolean {
  const v = readPref("pinBand");
  if (v !== null) return v !== "0";
  return typeof window === "undefined" || window.innerWidth >= 1200;
}
export function writePinBandOpen(v: boolean): void {
  writePref("pinBand", v ? "1" : "0");
}

// The "Menu mensa" bar under the board: collapsed by default (owner's
// decision, 2026-11-25; its header already shows today's dish), remembered
// per device once opened or closed.
export function readMenuBarOpen(): boolean {
  return readPref("menuBar") === "1";
}
export function writeMenuBarOpen(v: boolean): void {
  writePref("menuBar", v ? "1" : "0");
}

// Per-device reflection login cache: member -> expiry epoch ms, or "never"
// (indefinite). A member is authed while their value is "never" or in the future.
type ReflAuthMap = Record<string, number | "never">;

function reflAuthMap(): ReflAuthMap {
  const m = readJson<ReflAuthMap>("reflauth", {});
  return m && typeof m === "object" ? m : {};
}
export function isReflAuthed(member: string): boolean {
  const v = reflAuthMap()[member];
  return v === "never" || (typeof v === "number" && v > Date.now());
}
export function reflAuthValue(member: string): number | "never" | null {
  const v = reflAuthMap()[member];
  return v === "never" || typeof v === "number" ? v : null;
}
// days: a number of days, or "never" for indefinite.
export function setReflAuth(member: string, days: number | "never"): void {
  const m = reflAuthMap();
  m[member] = days === "never" ? "never" : Date.now() + days * 86400000;
  writePref("reflauth", JSON.stringify(m));
}
export function clearReflAuth(member: string): void {
  const m = reflAuthMap();
  delete m[member];
  writePref("reflauth", JSON.stringify(m));
}

// Which member "I" am (per device), for the Daily Reflection form.
export function readMe(): string {
  return readPref("me") ?? "";
}
export function writeMe(name: string): void {
  writePref("me", name);
}

// Learnings the viewer has marked reviewed today (per device, resets daily).
export function readReviewedToday(date: string): Set<string> {
  const v = readJson<{ date?: string; ids?: string[] }>("reviewed", {});
  if (v?.date === date && Array.isArray(v.ids)) return new Set(v.ids);
  return new Set();
}
export function writeReviewedToday(date: string, ids: string[]): void {
  writePref("reviewed", JSON.stringify({ date, ids }));
}

function readJson<T>(key: keyof typeof KEYS, fallback: T): T {
  try {
    const raw = readPref(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- Weekly report drafts -----------------------------------------------------
// The edits made to one week's report (texts, hidden cards, «Da sottolineare»),
// kept on this device so they survive leaving the REPORT tab or reloading.
// One draft per report period; a draft expires 7 days after its last change.

export interface ReportDraft {
  edits: Record<string, string>;
  hidden: string[];
  /** «Da sottolineare» as chosen; null until chosen (the list then follows the board's ★). */
  highlights: string[] | null;
  savedAt: number;
}

const DRAFT_PREFIX = "gtd-report-draft:";
const DRAFT_TTL_MS = 7 * 86400000;

function draftStorageKey(period: string): string {
  return DRAFT_PREFIX + period;
}

export function readReportDraft(period: string): ReportDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(period));
    if (!raw) return null;
    const d = JSON.parse(raw) as ReportDraft;
    if (!d || typeof d.savedAt !== "number" || Date.now() - d.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftStorageKey(period));
      return null;
    }
    return {
      edits: d.edits && typeof d.edits === "object" ? d.edits : {},
      hidden: Array.isArray(d.hidden) ? d.hidden : [],
      highlights: Array.isArray(d.highlights) ? d.highlights : null,
      savedAt: d.savedAt,
    };
  } catch {
    return null;
  }
}

export function writeReportDraft(period: string, draft: Omit<ReportDraft, "savedAt">): void {
  try {
    localStorage.setItem(draftStorageKey(period), JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    /* storage full or disabled — the report still works, just unsaved */
  }
}

export function clearReportDraft(period: string): void {
  try {
    localStorage.removeItem(draftStorageKey(period));
  } catch {
    /* ignore */
  }
}

// The report period last chosen on this device, so the REPORT tab reopens on
// it (a past week's draft included) rather than always on this week. The tab
// uses it only while that period still has a draft.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readReportPeriod(): { from: string; to: string } | null {
  const p = readJson<{ from?: unknown; to?: unknown } | null>("reportPeriod", null);
  if (!p || typeof p.from !== "string" || typeof p.to !== "string") return null;
  return ISO_DAY.test(p.from) && ISO_DAY.test(p.to) ? { from: p.from, to: p.to } : null;
}

export function writeReportPeriod(p: { from: string; to: string }): void {
  writePref("reportPeriod", JSON.stringify({ from: p.from, to: p.to }));
}

/** Remove expired drafts (or every draft, e.g. when logging out). */
export function purgeReportDrafts(all = false): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      if (all) localStorage.removeItem(k);
      else readReportDraft(k.slice(DRAFT_PREFIX.length)); // drops it if expired
    }
  } catch {
    /* ignore */
  }
}
