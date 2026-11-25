import { useEffect, useId, useRef, useState } from "react";
import { useT, type Lang } from "../lib/i18n";
import {
  COLOR_DEFAULT,
  COLOR_MAX,
  COLOR_MIN,
  readAppearanceChoice,
  readBlur,
  readColor,
  readSkin,
  writeAppearance,
  writeBlur,
  writeColor,
  writeSkin,
  type AppearanceChoice,
  type Skin,
} from "../lib/skin";

// The header's display settings in one place (owner's decision, 2026-11-25):
// language, Liquid Glass on/off, light / dark / automatic, glass blur and
// colour intensity used to be five pills that wrapped the header onto two
// rows at 1024 px. One "Aspetto ▾" button opens them as a small panel. All of
// them are per device; nothing here is shared with the team.
export function AppearanceMenu() {
  const { t, lang, setLang } = useT();
  const [open, setOpen] = useState(false);
  const [skin, setSkin] = useState<Skin>(() => readSkin());
  const [appearance, setAppearance] = useState<AppearanceChoice>(() => readAppearanceChoice());
  const [blur, setBlurState] = useState<boolean>(() => readBlur());
  const [pct, setPct] = useState<number>(() => readColor());
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const sliderId = useId();
  const glass = skin === "glass";

  // Opened from the keyboard: focus moves into the panel.
  const kbOpen = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (kbOpen.current) panel.current?.querySelector<HTMLElement>("button, input")?.focus();
    kbOpen.current = false;
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

  const pickLang = (l: Lang) => setLang(l);
  const toggleSkin = () => {
    const next: Skin = glass ? "classic" : "glass";
    writeSkin(next);
    setSkin(next);
  };
  const pickAppearance = (m: AppearanceChoice) => {
    writeAppearance(m);
    setAppearance(m);
  };
  const toggleBlur = () => {
    writeBlur(!blur);
    setBlurState(!blur);
  };
  const setColor = (n: number) => {
    setPct(n);
    writeColor(n);
  };

  const row = "flex items-center justify-between gap-4 min-h-[40px]";
  const label = "text-[12px] font-semibold text-[#0A1931]";

  return (
    <div ref={wrap} className="relative">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(e) => {
          kbOpen.current = e.detail === 0;
          setOpen((v) => !v);
        }}
        className="relative inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border border-white/30 bg-white/10 text-white text-[12px] font-semibold"
      >
        {t("skin.appearance")}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        {/* the colour is not the default: a small dot, as on the old ◐ button */}
        {pct !== COLOR_DEFAULT && (
          <span aria-hidden="true" className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-[#C9A96E]" />
        )}
      </button>
      {open && (
        <div
          id={panelId}
          ref={panel}
          role="group"
          aria-label={t("skin.appearance")}
          className="color-pop absolute right-0 top-full mt-2 z-50 w-[300px] rounded-[14px] bg-white border border-[#E8E6E1] shadow-xl p-4 text-[#0A1931] space-y-1"
        >
          <div className={row}>
            <span id={`${panelId}-lang`} className={label}>
              {t("m.language")}
            </span>
            <div role="group" aria-labelledby={`${panelId}-lang`} className="seg">
              {(["it", "en"] as Lang[]).map((l) => (
                <button key={l} lang={l} aria-pressed={lang === l} onClick={() => pickLang(l)} className="tab h-8 px-3 text-[12px] font-semibold">
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className={row}>
            <span id={`${panelId}-glass`} className={label}>
              {t("skin.label")}
            </span>
            <Switch on={glass} onToggle={toggleSkin} labelledBy={`${panelId}-glass`} title={t(glass ? "skin.onHint" : "skin.offHint")} />
          </div>

          {glass && (
            <div className={row}>
              <span id={`${panelId}-mode`} className={label}>
                {t("skin.mode")}
              </span>
              <div role="group" aria-labelledby={`${panelId}-mode`} className="seg">
                {(["light", "dark", "auto"] as AppearanceChoice[]).map((m) => (
                  <button
                    key={m}
                    aria-pressed={appearance === m}
                    aria-label={t(`skin.${m}`)}
                    title={t(`skin.${m}`)}
                    onClick={() => pickAppearance(m)}
                    className="tab h-8 w-9 text-[13px] leading-none"
                  >
                    {m === "light" ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                      </svg>
                    ) : m === "dark" ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                      </svg>
                    ) : (
                      "A"
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {glass && (
            <div className={row}>
              <span id={`${panelId}-blur`} className={label}>
                {t("skin.blur")}
              </span>
              <Switch on={blur} onToggle={toggleBlur} labelledBy={`${panelId}-blur`} title={t(blur ? "skin.blurOn" : "skin.blurOff")} />
            </div>
          )}

          <div className="pt-2">
            <div className="flex items-baseline justify-between mb-1.5">
              <label htmlFor={sliderId} className={label}>
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
              onChange={(e) => setColor(Number(e.target.value))}
              aria-valuetext={`${pct}%`}
              className="color-range w-full"
            />
            <div className="relative h-4 text-[11px] text-ink-2 mt-1" aria-hidden="true">
              <span className="absolute left-0">{t("color.grey")}</span>
              <span className="absolute -translate-x-1/2" style={{ left: `${((COLOR_DEFAULT - COLOR_MIN) / (COLOR_MAX - COLOR_MIN)) * 100}%` }}>
                100%
              </span>
              <span className="absolute right-0">{t("color.vivid")}</span>
            </div>
            <button
              type="button"
              onClick={() => setColor(COLOR_DEFAULT)}
              disabled={pct === COLOR_DEFAULT}
              className="tab mt-3 h-8 px-3 text-[12px] font-semibold w-full"
            >
              {t("color.reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** An iOS-style on/off switch (role="switch"), named by its row's label. */
function Switch({ on, onToggle, labelledBy, title }: { on: boolean; onToggle: () => void; labelledBy: string; title: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      title={title}
      onClick={onToggle}
      className="h-8 px-1 rounded-full inline-flex items-center"
    >
      {/* Off track #8A857E: 3.5:1 on the panel, so the switch itself is visible
          (WCAG 1.4.11). The knob is painted inline: glass.css turns every
          .bg-white into translucent material. */}
      <span className="relative w-10 h-6 rounded-full" style={{ background: on ? "#248A3D" : "#8A857E" }}>
        <span
          className={`absolute top-[3px] w-[18px] h-[18px] rounded-full shadow ${on ? "left-[19px]" : "left-[3px]"}`}
          style={{ background: "#ffffff" }}
        />
      </span>
    </button>
  );
}
