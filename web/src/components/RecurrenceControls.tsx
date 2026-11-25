import type { Op, Recurrence, Task } from "../lib/types";
import { useT, localeCode } from "../lib/i18n";
import { cleanRule, nextDue, weekdayShort } from "../lib/recurrence";
import { toISODate } from "../lib/dates";

type Freq = Recurrence["freq"];
const FREQS: Freq[] = ["daily", "weekly", "monthly", "yearly"];

/** The ★ star: outline when off, filled gold when on. */
export function StarIcon({ on, size = 14 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The ↻ repeat mark. */
export function RepeatIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </svg>
  );
}

interface Props {
  task: Task;
  send: (op: Op) => void;
  /** Migration 023 is in. */
  available: boolean;
}

// "In evidenza" toggle + the repeat rule, inside the task editor.
export function RecurrenceControls({ task, send, available }: Props) {
  const { t, lang } = useT();
  const patch = (p: Partial<Task>) => send({ type: "updateTask", id: task.id, patch: p });
  const rule = task.recurrence ? cleanRule(task.recurrence) : undefined;

  if (!available) {
    return <p className="text-[11px] text-ink-3">{t("rec.migration")}</p>;
  }

  // The series id is kept when the rule changes, so takes-back still match.
  const setRule = (r: Recurrence | undefined) =>
    patch({ recurrence: r ? cleanRule({ ...r, series: task.recurrence?.series }) : undefined });

  const setFreq = (f: Freq | "") => {
    if (!f) return setRule(undefined);
    setRule({ freq: f, every: rule?.every ?? 1, days: f === "weekly" ? rule?.days : undefined });
  };
  const toggleDay = (d: number) => {
    if (!rule) return;
    const cur = rule.days ?? [];
    setRule({ ...rule, days: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] });
  };
  const weekdaysOnly = rule?.days?.length === 5 && rule.days.every((d, i) => d === i);

  const today = toISODate(new Date());
  const next = rule ? nextDue(rule, task.dueDate, today) : "";
  const nextFmt = next
    ? new Date(`${next}T00:00:00`).toLocaleDateString(localeCode(lang), { weekday: "short", day: "numeric", month: "short" })
    : "";

  const pill = "inline-flex items-center gap-1.5 rounded-full h-8 border text-[12px] field";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={!!task.pinned}
          onClick={() => patch({ pinned: !task.pinned })}
          title={t(task.pinned ? "pin.remove" : "pin.add")}
          className={`${pill} px-3 font-semibold transition-colors ${
            task.pinned
              ? "bg-[#FBF3E2] text-[#7A5F30] border-[#C9A96E]"
              : "bg-[#F5F3EF] text-[#6B6B6B] border-[#E8E6E1] hover:border-[#C9A96E]"
          }`}
        >
          <span className={task.pinned ? "text-[#C9A96E]" : ""}>
            <StarIcon on={!!task.pinned} />
          </span>
          {t(task.pinned ? "pin.on" : "pin.add")}
        </button>

        <label className={`${pill} pl-3 pr-1 bg-[#F5F3EF] border-[#E8E6E1] text-[#6B6B6B]`}>
          <RepeatIcon />
          {t("rec.repeat")}
          <select
            value={rule?.freq ?? ""}
            onChange={(e) => setFreq(e.target.value as Freq | "")}
            className="bg-transparent outline-none text-[12px] text-[#0A1931] cursor-pointer"
          >
            <option value="">{t("rec.never")}</option>
            {FREQS.map((f) => (
              <option key={f} value={f}>
                {t(`rec.${f}`)}
              </option>
            ))}
          </select>
        </label>

        {rule && (
          <label className={`${pill} px-3 bg-[#F5F3EF] border-[#E8E6E1] text-[#6B6B6B]`}>
            {t("rec.every")}
            <input
              type="number"
              min={1}
              max={365}
              value={rule.every}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1) setRule({ ...rule, every: n });
              }}
              className="w-12 bg-transparent outline-none text-[12px] text-[#0A1931] tabular-nums"
            />
            {t(`rec.unit.${rule.freq}`)}
          </label>
        )}
      </div>

      {rule?.freq === "weekly" && (
        <div role="group" aria-label={t("rec.days")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[#6B6B6B] mr-0.5">{t("rec.days")}</span>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={!!rule.days?.includes(d)}
              onClick={() => toggleDay(d)}
              className="tab h-7 px-2.5 text-[11px]"
            >
              {weekdayShort(lang, d)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={weekdaysOnly}
            onClick={() => setRule({ ...rule, days: weekdaysOnly ? [] : [0, 1, 2, 3, 4] })}
            className="tab h-7 px-2.5 text-[11px]"
          >
            {t("rec.weekdays")}
          </button>
        </div>
      )}

      {rule && (
        <p className="text-[11px] text-[#6B6B6B]">
          <span className="font-semibold text-[#0A1931]">{t("rec.next", { date: nextFmt })}</span>
          {" · "}
          {t(task.dueDate ? "rec.hint" : "rec.hintNoDue")}
        </p>
      )}
    </div>
  );
}
