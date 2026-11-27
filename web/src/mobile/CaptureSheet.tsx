import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { newInboxTask } from "../lib/inbox";
import { isOffline } from "../lib/optimisticSend";
import { Sheet, useToast } from "./ui";
import type { Send } from "./actions";

/**
 * Capture to the Inbox (Oggi): a title and nothing else (lib/inbox.ts
 * `newInboxTask`). Enter or Salva saves and keeps the sheet open for the
 * next one; each save says so in the toast, with Undo.
 */
export function CaptureSheet({ members, send, onClose }: { members: string[]; send: Send; onClose: () => void }) {
  const { t } = useT();
  const { me } = useMe();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // After the sheet's rise, so the keyboard does not fight it.
    const id = setTimeout(() => input.current?.focus(), 280);
    return () => clearTimeout(id);
  }, []);

  const save = () => {
    const v = title.trim();
    if (!v) return;
    const task = newInboxTask(v, me, members);
    const fail = (m: string) => toast(`${t("m.notSaved")} ${m}`);
    send({ type: "addTask", task }, fail);
    if (isOffline()) return;
    setTitle("");
    toast(t("inbox.saved", { title: v }), () => send({ type: "deleteTask", id: task.id }, fail));
    input.current?.focus();
  };

  return (
    <Sheet
      title={t("m.inbox.capture")}
      onClose={onClose}
      headEnd={
        <button className="m-btn m-btn--primary m-btn--sm" disabled={!title.trim()} onClick={save}>
          {t("m.inbox.save")}
        </button>
      }
    >
      <div className="m-panel" style={{ padding: "14px 14px 12px" }}>
        <input
          ref={input}
          className="m-title-input"
          style={{ fontSize: 21 }}
          placeholder={t("inbox.capturePh")}
          aria-label={t("inbox.capturePh")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          enterKeyHint="send"
          data-capture-input=""
        />
      </div>
      <p style={{ margin: "10px 4px 0", color: "var(--m-text-2)", fontSize: 14 }}>{t("m.inbox.captureHint")}</p>
    </Sheet>
  );
}
