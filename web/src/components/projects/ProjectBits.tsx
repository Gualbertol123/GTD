import type { ProjectStatus } from "../../lib/types";
import { statusLabel, useT } from "../../lib/i18n";
import { HEALTH_COLOR, PROJECT_STATUS_COLOR, TASK_STATUS_COLOR, type Health } from "../../lib/projects";
import { ownerInitial } from "../../lib/owners";

// Small presentational pieces shared by the overview, the detail page and the
// timeline. Colours come in as inline styles so both skins (classic and
// Liquid Glass) show the same accents.

export function ProgressRing({
  value,
  color,
  size = 56,
  stroke = 6,
  label,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(120,120,128,0.18)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: "stroke-dashoffset 400ms cubic-bezier(0.2,0.7,0.2,1)" }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums text-[#0A1931]"
        style={{ fontSize: Math.max(10, size * 0.24) }}
      >
        {label ?? `${Math.round(v * 100)}%`}
      </span>
    </div>
  );
}

export function Bar({ value, color, height = 6 }: { value: number; color: string; height?: number }) {
  return (
    <div className="flex-1 rounded-full overflow-hidden" style={{ height, background: "rgba(120,120,128,0.16)" }}>
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
          background: color,
          transition: "width 400ms cubic-bezier(0.2,0.7,0.2,1)",
        }}
      />
    </div>
  );
}

export function Pill({ color, children, solid = false }: { color: string; children: React.ReactNode; solid?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${solid ? "tint-solid" : "tint"}`}
      style={{ "--tint": color } as React.CSSProperties}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: ProjectStatus }) {
  const { t } = useT();
  const color = PROJECT_STATUS_COLOR[status];
  return (
    <Pill color={color}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {t(`projects.status.${status}`)}
    </Pill>
  );
}

export function HealthBadge({ health, daysLeft }: { health: Health; daysLeft: number | null }) {
  const { t } = useT();
  const color = HEALTH_COLOR[health];
  let detail = "";
  if (daysLeft !== null && health !== "done") {
    if (daysLeft < 0) detail = t("projects.daysLate", { n: -daysLeft });
    else if (daysLeft === 0) detail = t("projects.dueToday");
    else detail = t("projects.daysLeft", { n: daysLeft });
  }
  return (
    <Pill color={color}>
      {t(`projects.health.${health}`)}
      {detail && <span className="font-medium opacity-80">· {detail}</span>}
    </Pill>
  );
}

export function Avatars({ names, max = 3, size = 22 }: { names: string[]; max?: number; size?: number }) {
  if (!names.length) return null;
  const shown = names.slice(0, max);
  return (
    <span className="flex -space-x-1.5" title={names.join(", ")}>
      {shown.map((n, i) => (
        <span
          key={`${n}-${i}`}
          className="rounded-full bg-[#0A1931] text-white font-bold flex items-center justify-center ring-2 ring-white"
          style={{ width: size, height: size, fontSize: size * 0.45 }}
        >
          {ownerInitial(n)}
        </span>
      ))}
      {names.length > max && (
        <span
          className="rounded-full bg-[#EFECE6] text-[#6B6B6B] font-bold flex items-center justify-center ring-2 ring-white"
          style={{ width: size, height: size, fontSize: size * 0.4 }}
        >
          +{names.length - max}
        </span>
      )}
    </span>
  );
}

/** "12 dic" style, in the UI language. */
export function fmtDay(iso: string | undefined, lang: "it" | "en", withYear = false): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/** Linked tasks per board column as one stacked bar. */
export function StatusStack({
  byStatus,
  total,
  height = 8,
}: {
  byStatus: Record<import("../../lib/types").Status, number>;
  total: number;
  height?: number;
}) {
  const { lang } = useT();
  if (!total) return <div className="flex-1 rounded-full" style={{ height, background: "rgba(120,120,128,0.16)" }} />;
  return (
    <div className="flex-1 flex rounded-full overflow-hidden" style={{ height, background: "rgba(120,120,128,0.16)" }}>
      {STACK_ORDER.map((st) =>
        byStatus[st] ? (
          <div
            key={st}
            style={{ width: `${(byStatus[st] / total) * 100}%`, background: TASK_STATUS_COLOR[st] }}
            title={`${statusLabel(lang, st)}: ${byStatus[st]}`}
          />
        ) : null
      )}
    </div>
  );
}

// Done first, so the filled part reads as progress.
export const STACK_ORDER: import("../../lib/types").Status[] = ["DONE", "IN PROGRESS", "WAITING", "NEXT", "BACKLOG", "MAYBE"];

/** A millisecond time as fmtDay does it (local calendar day). */
export function fmtMs(ms: number, lang: "it" | "en", withYear = false): string {
  const d = new Date(ms);
  return d.toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

// ---- Icons ---------------------------------------------------------------------
// Small line icons drawn in currentColor, so the skins' colour remaps apply.

type IconName = "x" | "up" | "down" | "clock" | "warning" | "folder" | "arrow" | "ban" | "check" | "checklist";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  x: <path d="M6 6l12 12M18 6L6 18" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  clock: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2M9.5 2.5h5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5L2.5 20h19L12 3.5z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  arrow: <path d="M4 12h15M14 6.5l5.5 5.5-5.5 5.5" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checklist: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
};

export function Icon({ name, size = 12, className = "", strokeWidth = 2 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={`inline-block shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
