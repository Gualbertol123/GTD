import { useEffect, useMemo, useRef, useState } from "react";
import { useBackClose } from "../lib/history";
import { boardTasks } from "../lib/projects";
import { taskOwners } from "../lib/owners";
import type { Board } from "../lib/types";
import { ARCHIVE_DAYS, isArchived } from "../lib/constants";
import { useT } from "../lib/i18n";
import { shortDate } from "../lib/dates";

// Names for the mail line: everyone holding the task, or nothing when nobody does.
const mailOwners = (t: { owner: string; assignees?: string[] }) =>
  taskOwners(t).filter((n) => n !== "Unassigned").join(", ");

// Recipients are remembered on this device only (per viewer, not shared).
const TO_KEY = "gtd-mail-to";
const readTo = (): string => {
  try {
    return window.localStorage.getItem(TO_KEY) ?? "";
  } catch {
    return "";
  }
};
const writeTo = (v: string) => {
  try {
    if (v.trim()) window.localStorage.setItem(TO_KEY, v);
    else window.localStorage.removeItem(TO_KEY);
  } catch {
    /* storage blocked: just not remembered */
  }
};

// Past this many encoded characters some mail apps cut a mailto: body.
const MAILTO_SAFE = 1800;

const ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function MailModal({ board, onClose }: { board: Board; onClose: () => void }) {
  useBackClose(onClose); // the browser's Back closes it
  const { t, lang } = useT();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // The mail lists what was done in the last ARCHIVE_DAYS days (after that a
  // done task is archived), so say which days those are.
  const periodText = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getTime() - ARCHIVE_DAYS * 86400000);
    return t("ux.report.mailPeriod", {
      from: shortDate(from, lang, from.getFullYear() !== now.getFullYear(), true),
      to: shortDate(now, lang, true, true),
    });
  }, [t, lang]);

  const text = useMemo(() => {
    const done = board.tasks.filter((tk) => tk.status === "DONE" && !isArchived(tk));
    const focus = board.weekly.focus;
    const next = boardTasks(board).filter((tk) => tk.status === "NEXT");

    let e = `${periodText}\n\n${t("mail.completed")}\n`;
    if (done.length === 0) e += `- ${t("mail.none")}\n`;
    else done.forEach((w) => (e += `- ${w.title}${mailOwners(w) ? ` (${mailOwners(w)})` : ""}\n`));

    e += `\n${t("mail.nextSteps")}\n`;
    const nextLines: string[] = [
      ...focus.map((w) => w.text),
      ...next.map((w) => `${w.title}${mailOwners(w) ? ` (${mailOwners(w)})` : ""}`),
    ];
    if (nextLines.length === 0) e += `- ${t("mail.none")}\n`;
    else nextLines.forEach((l) => (e += `- ${l}\n`));
    return e;
  }, [board, t, periodText]);

  // The text can be edited before sending; "Regenerate" goes back to the board's.
  const [body, setBody] = useState(text);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setBody(text);
  }, [text, edited]);
  const [to, setTo] = useState(readTo);

  const subject = `${board.boardName} — ${t("mail.subject")}`;
  const encodedBody = encodeURIComponent(body);
  const toPart = to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join(",");
  const href = `mailto:${toPart}?subject=${encodeURIComponent(subject)}&body=${encodedBody}`;
  const tooLong = encodedBody.length > MAILTO_SAFE;

  // Focus moves into the dialog and comes back to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    copyRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape closes; Tab stays inside the dialog. Listened on the document, so
  // it works even when focus fell to the page (a button that just vanished).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      trapTab(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };

  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard access: select the text so Ctrl/Cmd+C does it.
      const area = areaRef.current;
      if (area) {
        area.focus();
        area.select();
      }
      setCopyFailed(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-modal-title"
        aria-describedby="mail-modal-period"
        className="bg-white rounded-[16px] w-full max-w-[480px] max-h-[calc(100dvh-32px)] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[#E8E6E1] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="mail-modal-title" className="font-trajan text-[14px] uppercase tracking-widest text-[#0A1931]">
              {t("mail.title")}
            </h3>
            <p id="mail-modal-period" className="mt-1 text-[11px] text-[#6B6B6B]">
              {periodText}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("ux.report.mailClose")}
            title={t("ux.report.mailClose")}
            className={`-mr-1.5 -mt-1 h-9 w-9 shrink-0 grid place-items-center rounded-full text-[#6B6B6B]`}
          >
            <svg {...ICON} width={16} height={16}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-[#6B6B6B] shrink-0">{t("ux.report.mailTo")}</span>
            <input
              type="email"
              multiple
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onBlur={() => writeTo(to)}
              placeholder={t("ux.report.mailToPh")}
              autoComplete="email"
              className="flex-1 min-w-0 h-9 rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[13px] text-[#0A1931] field"
            />
          </label>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span id="mail-body-label" className="text-[11px] uppercase tracking-wide text-[#6B6B6B]">
                {t("ux.report.mailBody")}
              </span>
              {edited && body !== text && (
                <button
                  type="button"
                  onClick={() => {
                    setBody(text);
                    setEdited(false);
                    areaRef.current?.focus();
                  }}
                  title={t("ux.report.mailRegenerateHint")}
                  className={`h-7 px-2 rounded-full text-[12px] font-semibold text-[#007AFF]`}
                >
                  {t("ux.report.mailRegenerate")}
                </button>
              )}
            </div>
            <textarea
              ref={areaRef}
              aria-labelledby="mail-body-label"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setEdited(true);
                setCopyFailed(false);
              }}
              rows={12}
              className="w-full rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] p-3 text-[13px] font-mono text-[#0A1931] resize-y field"
            />
          </div>
          <div role="status" aria-live="polite" className="text-[11px] empty:hidden">
            {copyFailed ? (
              <span className="text-[#92400E]">{t("ux.report.copyFailed")}</span>
            ) : tooLong ? (
              <span className="text-[#92400E]">{t("ux.report.mailLong")}</span>
            ) : null}
          </div>
        </div>
        <div className="p-4 border-t border-[#E8E6E1] flex justify-end gap-2 flex-wrap">
          <a
            href={href}
            className={`h-9 px-4 rounded-full text-[12px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1] flex items-center`}
          >
            {t("mail.openClient")}
          </a>
          <button
            ref={copyRef}
            type="button"
            onClick={copy}
            className={`h-9 px-5 rounded-full text-[12px] font-semibold bg-[#C9A96E] text-[#0A1931] inline-flex items-center gap-1.5`}
          >
            {copied ? (
              <>
                <svg {...ICON} width={13} height={13}>
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                {t("ux.report.copied")}
              </>
            ) : (
              t("mail.copy")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
