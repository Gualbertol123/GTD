import { useEffect, useId, useRef, useState } from "react";
import type { Op } from "../lib/types";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { isCaptureKey, newInboxTask } from "../lib/inbox";
import { isOffline } from "../lib/optimisticSend";
import { showUndo } from "./TaskDetails";

// -----------------------------------------------------------------------------
// Quick capture (desktop): press I anywhere outside a text field, or the
// Inbox strip's «Cattura» button, and a small box asks for a title. Enter
// writes an INBOX task (lib/inbox.ts `newInboxTask`) and keeps the box open
// for the next one; Escape closes it and gives the focus back. Each capture
// shows the app's one toast with Annulla.
// -----------------------------------------------------------------------------

const openers = new Set<() => void>();

/** Opens the capture box (the strip's button). */
export function openInboxCapture(): void {
  openers.forEach((fn) => fn());
}

export function InboxCaptureHost({ members, send }: { members: string[]; send: (op: Op) => void }) {
  const { t } = useT();
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Where the focus was when the box opened, to give it back on Escape.
  const returnTo = useRef<Element | null>(null);
  const id = useId();

  useEffect(() => {
    const show = () => {
      if (!box.current) returnTo.current = document.activeElement;
      setOpen(true);
      // Already open: back to its field.
      requestAnimationFrame(() => input.current?.focus());
    };
    openers.add(show);
    const onKey = (e: KeyboardEvent) => {
      if (!isCaptureKey(e)) return;
      // Not while a dialog of its own is up (the mail pop-up, a sheet).
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      show();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      openers.delete(show);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: PointerEvent) => {
      const n = e.target as Node;
      if (box.current?.contains(n) || document.querySelector("[data-undo-toast]")?.contains(n)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus();
    else document.getElementById("main")?.focus();
  };

  const save = () => {
    const v = title.trim();
    if (!v) return;
    const task = newInboxTask(v, me, members);
    send({ type: "addTask", task });
    // Offline it is refused (the app's toast says so): keep what was typed.
    if (isOffline()) return;
    setTitle("");
    showUndo(t("inbox.saved", { title: v }), () => send({ type: "deleteTask", id: task.id }));
  };

  if (!open) return null;
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-h`}
      data-inbox-capture=""
      className="color-pop fixed left-1/2 -translate-x-1/2 top-24 z-[70] w-[min(520px,calc(100vw-32px))] rounded-[14px] bg-white border border-[#E8E6E1] shadow-xl p-4 text-[#0A1931]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 id={`${id}-t`} className="font-trajan text-[12px] uppercase tracking-widest text-[#0A1931]">
          {t("inbox.captureBox")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label={t("inbox.captureClose")}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <input
        ref={input}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        placeholder={t("inbox.capturePh")}
        aria-label={t("inbox.capturePh")}
        enterKeyHint="send"
        className="w-full h-11 rounded-full bg-white border border-[#E8E6E1] px-5 text-[14px] field"
      />
      <p id={`${id}-h`} className="mt-2 px-2 text-[11px] text-ink-2">
        {t("inbox.captureHint")}
      </p>
    </div>
  );
}
