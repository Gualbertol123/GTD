import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board, Op } from "../lib/types";
import { useT } from "../lib/i18n";
import { collectReport, weekPeriod, type Period } from "../lib/reportData";
import { GlassReport, type GlassReportActions } from "./GlassReport";
import type { ReportDoc } from "../lib/reportDoc";
import { supabase } from "../lib/supabaseClient";
import { shortDate } from "../lib/dates";
import { projectStats } from "../lib/projects";
import { isOffline } from "../lib/optimisticSend";
import { clearReportDraft, purgeReportDrafts, readReportDraft } from "../lib/prefs";
import "@fontsource-variable/inter";
import "../styles/glassReport.css";

interface Props {
  board: Board;
  send: (op: Op, onError?: (message: string) => void) => void;
}

const WEEKS_BACK = 12;
const TOAST_MS = 6000;

type Stage = "setup" | "editing";

/** An error line: a readable message, plus the raw server text when useful. */
interface ErrLine {
  text: string;
  details?: string;
}

// Small decorative icons (the controls carry their own text).
const ICON = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};
function IconDoc() {
  return (
    <svg {...ICON}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}
function IconUndo() {
  return (
    <svg {...ICON}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg {...ICON}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg {...ICON}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg {...ICON}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ErrorLine({ err }: { err: ErrLine }) {
  const { t } = useT();
  return (
    <div role="alert" className="text-[11px] text-[#C81E1E]">
      {err.text}
      {err.details && (
        <details className="mt-1 text-[#6B6B6B]">
          <summary className="cursor-pointer select-none">{t("ux.report.errorDetails")}</summary>
          <code className="block mt-1 whitespace-pre-wrap break-all">{err.details}</code>
        </details>
      )}
    </div>
  );
}

// The REPORT tab.
//
// Flow: pick a period → Generate. The report is laid out right here as A4
// pages in Liquid Glass (GlassReport); every text on it can be edited in
// place, cards can be hidden, and "Download PDF" sends the report — texts
// as they now read on the pages — to the server, which makes the PDF
// (netlify/functions/report-pdf.mts), so it is the same on every device.
// The old Word template is still available as a direct download.
export function ReportView({ board, send }: Props) {
  const { t, lang } = useT();
  const [period, setPeriod] = useState<Period>(() => weekPeriod(0));
  const [custom, setCustom] = useState(false);
  const draftKey = `${period.from}_${period.to}`;
  // Coming back to the tab with a saved draft for this week reopens it.
  const [stage, setStage] = useState<Stage>(() => {
    purgeReportDrafts();
    const p = weekPeriod(0);
    return readReportDraft(`${p.from}_${p.to}`) ? "editing" : "setup";
  });
  const [hasDraft, setHasDraft] = useState(false);
  const [resetN, setResetN] = useState(0);
  useEffect(() => setHasDraft(!!readReportDraft(draftKey)), [draftKey]);
  const onDraftChange = useCallback((v: boolean) => setHasDraft(v), []);

  // "Report" or the list of projects left out of the report.
  const [view, setView] = useState<"report" | "excluded">("report");
  const excluded = board.projects.filter((p) => p.reportHidden);
  const setProjectInReport = useCallback(
    (id: string, hidden: boolean) =>
      send({ type: "projectReportHidden", id, hidden }, (message) =>
        // Offline is not a missing migration: say just that.
        setErr({ text: isOffline() ? t("save.offline") : `${t("report.excludeFailed")} (${message})` })
      ),
    [send, t]
  );

  // A short notice at the foot of the screen, with an Undo when it has one.
  // It sits outside the pages, so it is never measured or exported.
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => void } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((text: string, undo?: () => void) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, undo });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), TOAST_MS);
    return () => window.clearTimeout(h);
  }, [toast]);

  // × on a project card: leaves it out of every report, so offer to undo.
  const excludeProject = useCallback(
    (id: string) => {
      setProjectInReport(id, true);
      showToast(t("ux.report.excluded"), () => setProjectInReport(id, false));
    },
    [setProjectInReport, showToast, t]
  );
  const onCardHidden = useCallback(
    (undo: () => void) => showToast(t("ux.report.cardHidden"), undo),
    [showToast, t]
  );
  const [hiddenCount, setHiddenCount] = useState(0);
  const actionsRef = useRef<GlassReportActions | null>(null);
  // "Put back in the report" on the excluded list: say it worked.
  const [included, setIncluded] = useState<string | null>(null);
  useEffect(() => {
    if (!included) return;
    const h = window.setTimeout(() => setIncluded(null), TOAST_MS);
    return () => window.clearTimeout(h);
  }, [included]);

  // Throw away this week's changes and start again from the board.
  const resetReport = () => {
    if (!window.confirm(t("report.resetConfirm"))) return;
    clearReportDraft(draftKey);
    setHasDraft(false);
    setResetN((n) => n + 1);
  };
  const [busy, setBusy] = useState<null | "docx" | "pdf">(null);
  const [err, setErr] = useState<ErrLine | null>(null);
  // Changing the period starts afresh: an old error no longer applies.
  useEffect(() => setErr(null), [draftKey]);
  const badRange = custom && period.from > period.to;

  const docRef = useRef<(() => ReportDoc) | null>(null);

  const weeks = useMemo(
    () => Array.from({ length: WEEKS_BACK }, (_, i) => ({ offset: i, ...weekPeriod(i) })),
    []
  );
  const data = useMemo(() => collectReport(board, period), [board, period]);

  const fmt = (iso: string, withYear = false) => {
    const [y, m, d] = iso.split("-").map(Number);
    return shortDate(new Date(y, m - 1, d), lang, withYear, true);
  };

  const weekLabel = (w: { offset: number; from: string; to: string }) => {
    const range = `${fmt(w.from)} – ${fmt(w.to)}`;
    if (w.offset === 0) return `${range} · ${t("report.thisWeek")}`;
    if (w.offset === 1) return `${range} · ${t("report.lastWeek")}`;
    return range;
  };
  const selected = weeks.find((w) => w.from === period.from && w.to === period.to);
  const periodText = `${fmt(period.from)} – ${fmt(period.to, true)}`;

  // The old Word template, straight to a download.
  const downloadWord = async () => {
    setErr(null);
    setBusy("docx");
    try {
      const { downloadReportDocx } = await import("../lib/reportDocx");
      await downloadReportDocx(data);
    } catch (e) {
      setErr({ text: `${t("report.error")} — ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const downloadPdf = async () => {
    const build = docRef.current;
    if (!build || badRange) return;
    setErr(null);
    setBusy("pdf");
    try {
      // Finish an edit still in progress so it is part of the document.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      await new Promise((r) => setTimeout(r, 0));
      const doc = build();
      const fail = (text: string, details?: string) =>
        setErr({ text: `${t("ux.report.downloadFailed")} — ${text}`, details });
      const { data: auth } = await supabase.auth.getSession();
      const token = auth.session?.access_token;
      if (!token) return fail(t("report.pdfLogin"));
      let res: Response;
      try {
        res = await fetch("/.netlify/functions/report-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(doc),
        });
      } catch (e) {
        return fail(t("ux.report.pdfFailed"), e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return fail(t("report.pdfLogin"));
        if (res.status === 413) return fail(t("ux.report.tooBig"));
        const raw = await res.text().catch(() => "");
        let detail = raw;
        try {
          const j = JSON.parse(raw) as { error?: unknown };
          if (typeof j?.error === "string") detail = j.error;
        } catch {
          /* not JSON: keep the text */
        }
        return fail(t("ux.report.pdfFailed"), `${res.status}${detail ? ` · ${detail}` : ""}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr({ text: `${t("ux.report.downloadFailed")} — ${t("ux.report.pdfFailed")}`, details: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  // One visible keyboard focus for every control, in both skins and themes.
  const control = "h-9 rounded-full bg-white border border-[#E8E6E1] text-[13px] field px-3";
  const primaryBtn = `h-9 px-5 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold disabled:opacity-40`;
  const ghostBtn = `h-9 px-4 rounded-full bg-white text-[#0A1931] border border-[#E8E6E1] text-[12px] font-semibold disabled:opacity-40`;
  const views = ["report", "excluded"] as const;

  return (
    <div className="space-y-4">
      {/* Report | projects left out: a small switch inside the tab, not a
          second tab bar (plain border, no panel fill: no glass in glass). */}
      <div
        role="tablist"
        aria-label={t("ux.report.views")}
        className="seg h-8"
      >
        {views.map((v, i) => (
          <button
            key={v}
            type="button"
            role="tab"
            id={`report-view-${v}`}
            aria-selected={view === v}
            tabIndex={view === v ? 0 : -1}
            onClick={() => setView(v)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = views[(i + (e.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
              setView(next);
              document.getElementById(`report-view-${next}`)?.focus();
            }}
            className="tab h-full px-3 text-[11px] font-semibold"
          >
            {v === "report" ? t("report.viewReport") : t("report.viewExcluded")}
            {v === "excluded" && excluded.length > 0 && (
              <span className="tab__count">{excluded.length}</span>
            )}
          </button>
        ))}
      </div>

      {view === "excluded" && (
        <div className="rounded-[14px] border border-[#E8E6E1] bg-white p-4 space-y-3">
          <p className="text-[12px] text-[#6B6B6B]">{t("report.excludedHint")}</p>
          {err && <ErrorLine err={err} />}
          <div role="status" aria-live="polite" className="text-[11px] text-[#065F46] empty:hidden">
            {included && (
              <span className="inline-flex items-center gap-1.5">
                <IconCheck />
                {t("ux.report.included", { name: included })}
              </span>
            )}
          </div>
          {excluded.length === 0 ? (
            <p className="text-[12px] text-[#6B6B6B]">{t("report.excludedEmpty")}</p>
          ) : (
            <ul className="divide-y divide-[#F0EEE9]">
              {excluded.map((p) => {
                const st = projectStats(p, board.tasks);
                return (
                  <li key={p.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-[#0A1931] truncate">{p.name || "—"}</div>
                      <div className="text-[11px] text-[#6B6B6B] tabular-nums">
                        {st.total
                          ? t("ux.report.projectTasks", { d: st.done, n: st.total })
                          : t("ux.report.projectNoTasks")}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectInReport(p.id, false);
                        setIncluded(p.name || "—");
                      }}
                      className={`h-8 px-4 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold shrink-0 inline-flex items-center gap-1.5`}
                    >
                      <IconPlus />
                      {t("report.includeAgain")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {view === "report" && (<>
      {/* Controls */}
      <div className="rounded-[14px] border border-[#C9A96E]/40 bg-[#FBF6EC] p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-trajan text-[11px] uppercase tracking-widest text-[#7A5F30] inline-flex items-center gap-1.5">
            <IconDoc />
            {t("report.title")}
          </span>
          <span className="text-[11px] text-[#6B6B6B]">{t("report.hint")}</span>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-[#6B6B6B]">
              {t("report.period")}
            </span>
            <select
              value={custom ? "custom" : selected ? String(selected.offset) : "custom"}
              onChange={(e) => {
                if (e.target.value === "custom") return setCustom(true);
                setCustom(false);
                setPeriod(weekPeriod(Number(e.target.value)));
              }}
              className={`${control} min-w-[230px] max-w-full`}
            >
              {weeks.map((w) => (
                <option key={w.offset} value={w.offset}>
                  {weekLabel(w)}
                </option>
              ))}
              <option value="custom">{t("report.custom")}</option>
            </select>
          </label>

          {custom && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-[#6B6B6B]">
                  {t("report.from")}
                </span>
                <input
                  type="date"
                  value={period.from}
                  max={period.to}
                  aria-invalid={badRange || undefined}
                  aria-describedby={badRange ? "report-bad-range" : undefined}
                  onChange={(e) =>
                    e.target.value && setPeriod((p) => ({ ...p, from: e.target.value }))
                  }
                  className={control}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-[#6B6B6B]">
                  {t("report.to")}
                </span>
                <input
                  type="date"
                  value={period.to}
                  min={period.from}
                  aria-invalid={badRange || undefined}
                  aria-describedby={badRange ? "report-bad-range" : undefined}
                  onChange={(e) =>
                    e.target.value && setPeriod((p) => ({ ...p, to: e.target.value }))
                  }
                  className={control}
                />
              </label>
            </>
          )}

          {stage !== "editing" ? (
            <>
              <button type="button" onClick={() => setStage("editing")} disabled={badRange} className={primaryBtn}>
                {t("report.generate")}
              </button>
              <button type="button" onClick={downloadWord} disabled={busy !== null || badRange} className={ghostBtn}>
                {busy === "docx" ? t("report.generating") : t("report.downloadWordClassic")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={downloadPdf} disabled={busy !== null || badRange} className={primaryBtn}>
                {busy === "pdf" ? t("report.pdfMaking") : t("report.downloadPdf")}
              </button>
              <button type="button" onClick={() => setStage("setup")} disabled={busy !== null} className={ghostBtn}>
                {t("report.close")}
              </button>
            </>
          )}
          {(stage === "editing" || hasDraft) && (
            <button
              type="button"
              onClick={resetReport}
              disabled={busy !== null || !hasDraft}
              className={`${ghostBtn} text-[#C81E1E] border-[#FECACA] inline-flex items-center gap-1.5`}
              title={t("report.resetHint")}
            >
              <IconUndo />
              {t("report.reset")}
            </button>
          )}
          {stage === "editing" && hiddenCount > 0 && !badRange && (
            <button
              type="button"
              onClick={() => actionsRef.current?.showHidden()}
              className={`h-9 px-2 rounded-full text-[12px] font-semibold text-[#007AFF]`}
            >
              {t("ux.report.showHidden", { n: hiddenCount })}
            </button>
          )}
        </div>

        {badRange && (
          <div id="report-bad-range" role="alert" className="text-[11px] text-[#C81E1E]">
            {t("ux.report.badRange")}
          </div>
        )}

        {hasDraft && (
          <div className="text-[11px] text-[#065F46] inline-flex items-center gap-1.5">
            <IconCheck />
            {t("report.draftSaved")}
          </div>
        )}

        <div className="text-[12px] text-[#6B6B6B]">
          {data.totalTasks === 0 && data.totalSubtasks === 0
            ? t("report.empty")
            : t("report.preview", { t: data.totalTasks, s: data.totalSubtasks })}
        </div>

        {err && <ErrorLine err={err} />}
      </div>

      {stage === "editing" && !badRange && (
        <div className="space-y-2">
          <div className="text-[11px] text-[#6B6B6B] text-center">{t("report.editHint")}</div>
          <GlassReport
            key={`${draftKey}#${resetN}`}
            board={board}
            data={data}
            periodText={periodText}
            docRef={docRef}
            draftKey={draftKey}
            onDraftChange={onDraftChange}
            onExcludeProject={excludeProject}
            onCardHidden={onCardHidden}
            onHiddenCount={setHiddenCount}
            actionsRef={actionsRef}
          />
          {/* The same actions again at the end of the pages, so nobody has to
              scroll back to the top after editing the last page. */}
          <div
            role="group"
            aria-label={t("ux.report.endActions")}
            className="flex flex-col items-center gap-2 pt-1 pb-16"
          >
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <button type="button" onClick={downloadPdf} disabled={busy !== null} className={primaryBtn}>
                {busy === "pdf" ? t("report.pdfMaking") : t("report.downloadPdf")}
              </button>
              <button type="button" onClick={() => setStage("setup")} disabled={busy !== null} className={ghostBtn}>
                {t("report.close")}
              </button>
            </div>
            {err && <ErrorLine err={err} />}
          </div>
        </div>
      )}
      </>)}

      <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 -translate-x-1/2 bottom-24 md:bottom-6 z-[60] pointer-events-none max-w-[calc(100vw-32px)]"
      >
        {toast && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-[#1C1C1E] text-white shadow-xl pl-4 pr-1.5 py-1.5 text-[13px]">
            <span className="min-w-0 truncate">{toast.text}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
                className="shrink-0 h-8 px-3 rounded-full text-[12px] font-semibold text-[#E9C989] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#E9C989]"
              >
                {t("ux.report.undo")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label={t("ux.report.dismiss")}
              className="shrink-0 h-8 w-8 rounded-full inline-flex items-center justify-center text-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#E9C989]"
            >
              <IconClose />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
