import { useMemo, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { readPref, writePref } from "../lib/prefs";
import type { Track } from "../lib/music";
import { hasViews, parseSortPrefs, primaryOfficial, sortTracks, type SortMode, type SortPrefs } from "../lib/musicSort";

// -----------------------------------------------------------------------------
// Sorting the music search results (MUSICA tab Search, the ♪ panel / phone):
// "Ufficiali prima" (default) | "Pertinenza" (YouTube's order) | "Più visti",
// and "Nascondi cover e versioni non ufficiali". The rules are in
// lib/musicSort; this is the control, the badges and the remembered choice
// (one per browser, shared live by both views).
// -----------------------------------------------------------------------------

let prefs: SortPrefs = parseSortPrefs(readPref("musicSort"));
const subs = new Set<() => void>();

function setPrefs(next: Partial<SortPrefs>): void {
  prefs = { ...prefs, ...next };
  writePref("musicSort", JSON.stringify(prefs));
  subs.forEach((f) => f());
}

function useSortPrefs(): SortPrefs {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => prefs
  );
}

export interface SortedResults {
  /** The results in the order shown: play and the queue follow it. */
  shown: Track[];
  /** How many "hide covers" left out. */
  hidden: number;
  /** The result with the "Ufficiale" badge. */
  primary: string | null;
  prefs: SortPrefs;
  /** "Più visti" is offered only when YouTube gave view counts. */
  views: boolean;
}

/** The results as the viewer chose to see them: sorted at once, no new request. */
export function useSortedResults(tracks: Track[] | null | undefined, q: string): SortedResults {
  const p = useSortPrefs();
  return useMemo(() => {
    const list = tracks ?? [];
    const views = hasViews(list);
    const mode: SortMode = p.mode === "views" && !views ? "official" : p.mode;
    const shown = sortTracks(list, mode, q, p.hide);
    return { shown, hidden: list.length - shown.length, primary: primaryOfficial(shown, q), prefs: { ...p, mode }, views };
  }, [tracks, q, p]);
}

/** A check in a circle: the official version. */
export function IconOfficial({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mi">
      <circle cx="12" cy="12" r="9.5" />
      <path d="m7.8 12.3 2.8 2.8 5.6-5.8" />
    </svg>
  );
}

/**
 * What a result is, small, before its channel: "Ufficiale" (strong on the
 * first official result, subtle on the others), "Audio ufficiale", and muted
 * "Live", "Cover", "Remix/Edit", "Testo", "Non ufficiale". Nothing for the rest.
 */
export function KindBadge({ tr, primary }: { tr: Track; primary: boolean }) {
  const { t } = useT();
  const k = tr.kind;
  if (k === "official" || k === "audio") {
    const label = t(k === "audio" ? "ms.badgeAudio" : "ms.badgeOfficial");
    return (
      <span className={`msort-badge${primary ? " msort-badge--primary" : " msort-badge--soft"}`} title={primary ? t("ms.primaryTip") : label}>
        <IconOfficial size={primary ? 13 : 12} />
        {label}
      </span>
    );
  }
  if (k === "live" || k === "cover") {
    const key = k === "live" ? "ms.live" : tr.tag === "edit" ? "ms.edit" : tr.tag === "lyrics" ? "ms.lyrics" : tr.tag === "unofficial" ? "ms.unofficial" : "ms.cover";
    return <span className="msort-badge msort-badge--muted">{t(key)}</span>;
  }
  return null;
}

/**
 * The sort control (a segmented choice: native radios, so arrow keys work)
 * and the "hide covers" switch. `id` keeps the radio groups of the two views apart.
 */
export function SortBar({ id, res, compact }: { id: string; res: SortedResults; compact?: boolean }) {
  const { t } = useT();
  const modes: SortMode[] = res.views ? ["official", "relevance", "views"] : ["official", "relevance"];
  const label: Record<SortMode, string> = { official: t("ms.official"), relevance: t("ms.relevance"), views: t("ms.views") };
  return (
    <div className={`msort${compact ? " msort--compact" : ""}`}>
      <fieldset className="msort-seg">
        <legend className="msort-sr">{t("ms.sort")}</legend>
        {modes.map((m) => (
          <label key={m} className={`msort-seg__opt${res.prefs.mode === m ? " is-on" : ""}`}>
            <input type="radio" className="msort-sr" name={`msort-${id}`} value={m} checked={res.prefs.mode === m} onChange={() => setPrefs({ mode: m })} />
            {label[m]}
          </label>
        ))}
      </fieldset>
      <label className="msort-hide">
        <input type="checkbox" role="switch" className="msort-sr" checked={res.prefs.hide} onChange={(e) => setPrefs({ hide: e.target.checked })} />
        <span className="msort-switch" aria-hidden="true" />
        <span>{t("ms.hide")}</span>
      </label>
    </div>
  );
}

/** "N hidden" under the list, with "Show all" (when hiding left anything out). */
export function HiddenNote({ res, className }: { res: SortedResults; className?: string }) {
  const { t } = useT();
  if (!res.hidden || !res.prefs.hide) return null;
  return (
    <p className={`msort-note${className ? " " + className : ""}`}>
      {t("ms.hidden", { n: res.hidden })}{" "}
      <button type="button" className="msort-link" onClick={() => setPrefs({ hide: false })}>
        {t("ms.showAll")}
      </button>
    </p>
  );
}

/** Whether a list can be sorted at all (results from an older server have no kind). */
export const sortable = (tracks: Track[] | null | undefined) => !!tracks?.some((x) => x.kind);
