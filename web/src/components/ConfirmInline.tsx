import { useEffect, useId, useRef } from "react";
import { useT } from "../lib/i18n";

// Inline "Sure? Yes / No" for actions that cannot be undone, used instead of
// the browser's confirm() everywhere. Focus starts on No, so Enter straight
// away is the safe answer (it used to log out or remove the logo); Escape
// answers No too. Both buttons are described by the question, so a screen
// reader landing on No hears what it is about.
export function ConfirmInline({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  const { t } = useT();
  const noRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => noRef.current?.focus(), []);
  return (
    <span
      className="inline-flex items-center gap-2 flex-wrap text-[12px]"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onNo();
      }}
    >
      <span id={id} className="text-[#C81E1E]">
        {text}
      </span>
      <button
        type="button"
        onClick={onYes}
        aria-describedby={id}
        className="h-8 px-3 rounded-full font-semibold text-[#C81E1E] border border-[#FECACA]"
      >
        {t("task.yes")}
      </button>
      <button
        ref={noRef}
        type="button"
        onClick={onNo}
        aria-describedby={id}
        className="h-8 px-3 rounded-full font-semibold text-ink-2 border border-[#E8E6E1]"
      >
        {t("task.no")}
      </button>
    </span>
  );
}
