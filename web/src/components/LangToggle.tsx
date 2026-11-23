import { useT, type Lang } from "../lib/i18n";

export function LangToggle() {
  const { lang, setLang, t } = useT();
  const opt = (l: Lang, label: string) => (
    <button
      onClick={() => setLang(l)}
      aria-pressed={lang === l}
      lang={l}
      className="tab px-2.5 h-7 text-[11px] font-semibold"
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("m.language")} className="seg seg--chrome">
      {opt("it", "IT")}
      {opt("en", "EN")}
    </div>
  );
}
