import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { COLOR_DEFAULT, COLOR_MAX, COLOR_MIN, readColor, writeColor } from "../lib/skin";

// Colour intensity for the whole app, per device: a compact round header
// button (a dot on it when it is not 100 %), opening a slider. 0 % is greyscale, 100 %
// the design as drawn, 150 % more vivid. The change is live while dragging.
export function ColorControl() {
  const { t } = useT();
  const [pct, setPct] = useState<number>(() => readColor());
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const sliderId = useId();

  const set = (n: number) => {
    setPct(n);
    writeColor(n);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`${t("color.title")} · ${pct}%`}
        className="color-btn relative h-9 w-9 rounded-full border border-white/30 bg-white/10 text-white flex items-center justify-center"
      >
        {/* half-filled circle: colour ↔ grey */}
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
        </svg>
        <span className="sr-only">
          {t("color.amount")}: {pct}%
        </span>
        {/* a small dot says "not the default" without spending header width */}
        {pct !== COLOR_DEFAULT && (
          <span aria-hidden="true" className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-[#C9A96E]" />
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={t("color.amount")}
          className="color-pop absolute right-0 top-full mt-2 z-50 w-[260px] rounded-[14px] bg-white border border-[#E8E6E1] shadow-xl p-4 text-[#0A1931]"
        >
          <div className="flex items-baseline justify-between mb-2">
            <label htmlFor={sliderId} className="text-[12px] font-semibold">
              {t("color.amount")}
            </label>
            <span className="text-[13px] font-semibold tabular-nums">{pct}%</span>
          </div>
          <input
            id={sliderId}
            type="range"
            min={COLOR_MIN}
            max={COLOR_MAX}
            step={5}
            value={pct}
            onChange={(e) => set(Number(e.target.value))}
            aria-valuetext={`${pct}%`}
            className="color-range w-full"
            autoFocus
          />
          <div className="relative h-4 text-[11px] text-[#6B6B6B] mt-1" aria-hidden="true">
            <span className="absolute left-0">{t("color.grey")}</span>
            <span
              className="absolute -translate-x-1/2"
              style={{ left: `${((COLOR_DEFAULT - COLOR_MIN) / (COLOR_MAX - COLOR_MIN)) * 100}%` }}
            >
              100%
            </span>
            <span className="absolute right-0">{t("color.vivid")}</span>
          </div>
          <button
            type="button"
            onClick={() => set(COLOR_DEFAULT)}
            disabled={pct === COLOR_DEFAULT}
            className="tab mt-3 h-8 px-3 text-[12px] font-semibold w-full"
          >
            {t("color.reset")}
          </button>
        </div>
      )}
    </div>
  );
}
