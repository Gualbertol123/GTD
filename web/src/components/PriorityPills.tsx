import { priorityLabel, useT } from "../lib/i18n";
import type { Priority } from "../lib/types";

const PRIOS: Priority[] = ["P1", "P2", "P3", "P4"];

// The chosen fill per priority: the colours of the priority dots.
const ON: Record<Priority, string> = {
  P1: "bg-[#DC2626] text-white border-[#DC2626]",
  P2: "bg-[#C9A96E] text-[#0A1931] border-[#C9A96E]",
  P3: "bg-[#C9C5BE] text-[#0A1931] border-[#C9C5BE]",
  P4: "bg-[#0A1931] text-white border-[#0A1931]",
};
const OFF = "bg-white text-ink-2 border-[#E8E6E1]";

interface Props<V extends string> {
  value: V;
  onChange: (v: V) => void;
  /** The group's name for screen readers. */
  label: string;
  /** Text of a first pill for "any priority", whose value is "all" (filters). */
  all?: string;
  /** Pill size, to sit in the row around it (the editor's is the default). */
  size?: string;
  className?: string;
}

// P1–P4 as pills, one chosen (aria-pressed), the same in the task editor,
// the new-task bar, the board filters and a project's new task. The filters
// add a first pill for "any priority", whose value is "all".
export function PriorityPills<V extends string>({
  value,
  onChange,
  label,
  all,
  size = "h-7 px-2.5 text-[11px]",
  className = "",
}: Props<V>) {
  const { t } = useT();
  const pill = `${size} rounded-full font-semibold border transition-colors`;
  return (
    <div role="group" aria-label={label} className={`inline-flex items-center gap-1.5 flex-wrap ${className}`}>
      {all !== undefined && (
        <button
          type="button"
          onClick={() => onChange("all" as V)}
          aria-pressed={value === "all"}
          className={`${pill} ${value === "all" ? "bg-white text-[#0A1931] border-[#0A1931]" : OFF}`}
        >
          {all}
        </button>
      )}
      {PRIOS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p as string as V)}
          title={priorityLabel(t, p)}
          aria-pressed={value === p}
          className={`${pill} ${value === p ? ON[p] : OFF}`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
