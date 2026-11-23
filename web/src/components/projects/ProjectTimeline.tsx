import type { Project } from "../../lib/types";
import { useT } from "../../lib/i18n";
import { toISODate } from "../../lib/dates";
import { HEALTH_COLOR, projectColor, type ProjectStats } from "../../lib/projects";
import { fmtDay } from "./ProjectBits";

const DAY = 86400000;

function toMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Every dated project as a bar from its start to its target date, with its
// progress filled in and a line for today.
// A project with a target but no start runs from the day it was created.
export function ProjectTimeline({
  projects,
  stats,
  onOpen,
}: {
  projects: Project[];
  stats: Map<string, ProjectStats>;
  onOpen: (id: string) => void;
}) {
  const { t, lang } = useT();
  const today = toMs(toISODate(new Date()));

  const rows = projects
    .filter((p) => p.targetDate)
    .map((p) => {
      const end = toMs(p.targetDate!);
      let start = p.startDate ? toMs(p.startDate) : p.createdAt ? toMs(toISODate(new Date(p.createdAt))) : end;
      if (start > end) start = end;
      return { p, start, end };
    });
  const undated = projects.filter((p) => !p.targetDate);

  if (!rows.length) {
    return (
      <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-8 text-center text-[13px] text-ink-3">
        {t("projects.timeline.empty")}
        {undated.length > 0 && <Undated list={undated} onOpen={onOpen} />}
      </div>
    );
  }

  // Range: every bar and today, padded and snapped to whole months.
  let lo = Math.min(today, ...rows.map((r) => r.start));
  let hi = Math.max(today, ...rows.map((r) => r.end));
  const loD = new Date(lo);
  lo = new Date(loD.getFullYear(), loD.getMonth(), 1).getTime();
  const hiD = new Date(hi);
  hi = new Date(hiD.getFullYear(), hiD.getMonth() + 1, 1).getTime();
  const span = Math.max(DAY, hi - lo);
  const pos = (ms: number) => ((ms - lo) / span) * 100;

  const months: { ms: number; label: string }[] = [];
  for (let d = new Date(lo); d.getTime() < hi; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push({
      ms: d.getTime(),
      label: d.toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
        month: "short",
        ...(d.getMonth() === 0 || months.length === 0 ? { year: "2-digit" } : {}),
      }),
    });
  }
  // Too many months to label each one: label every 2nd/3rd.
  const step = months.length > 18 ? 3 : months.length > 9 ? 2 : 1;

  return (
    <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-3 sm:p-4">
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* Month header */}
          <div className="grid grid-cols-[180px_1fr] gap-3">
            <div />
            <div className="relative h-6">
              {months.map((m, i) =>
                i % step === 0 ? (
                  <span
                    key={m.ms}
                    className="absolute top-0 text-[10px] font-semibold uppercase tracking-wide text-[#6B6B6B]"
                    style={{ left: `${pos(m.ms)}%` }}
                  >
                    {m.label}
                  </span>
                ) : null
              )}
            </div>
          </div>

          <div className="relative">
            {/* Grid + today line, behind the rows */}
            <div className="absolute inset-0 grid grid-cols-[180px_1fr] gap-3 pointer-events-none">
              <div />
              <div className="relative">
                {months.map((m) => (
                  <span
                    key={m.ms}
                    className="absolute top-0 bottom-0 w-px"
                    style={{ left: `${pos(m.ms)}%`, background: "rgba(120,120,128,0.14)" }}
                  />
                ))}
                <span className="absolute top-0 bottom-0 w-0.5 rounded-full" style={{ left: `${pos(today)}%`, background: "#FF3B30" }}>
                  <span className="absolute -top-0.5 left-1 text-[10px] font-bold uppercase text-[#C81E1E] whitespace-nowrap">
                    {t("projects.timeline.today")}
                  </span>
                </span>
              </div>
            </div>

            <div className="relative space-y-1.5 py-3">
              {rows.map(({ p, start, end }) => {
                const s = stats.get(p.id)!;
                const color = projectColor(p);
                const left = pos(start);
                const width = Math.max(0.8, pos(end + DAY) - left);
                const pct = Math.round(s.share * 100);
                // A small share leaves the label on the pale tint: dark text there.
                const onTint = s.share < 0.15;
                const health = t(`projects.health.${s.health}`);
                return (
                  <button
                    key={p.id}
                    onClick={() => onOpen(p.id)}
                    title={`${p.name || "—"} · ${t("ux.projects.health", { h: health })}`}
                    className="w-full grid grid-cols-[180px_1fr] gap-3 items-center text-left group"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: color }} aria-hidden />
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: HEALTH_COLOR[s.health] }}
                        role="img"
                        aria-label={t("ux.projects.health", { h: health })}
                        title={t("ux.projects.health", { h: health })}
                      />
                      <span className="truncate text-[12px] font-semibold text-[#0A1931] group-hover:underline">
                        {p.name || "—"}
                      </span>
                    </span>
                    <span className="relative h-7 block">
                      <span
                        className="absolute top-0.5 bottom-0.5 rounded-full overflow-hidden"
                        style={{ left: `${left}%`, width: `${width}%`, background: `${color}2E`, boxShadow: `inset 0 0 0 1px ${color}66` }}
                        title={`${fmtDay(p.startDate, lang, true) || "…"} → ${fmtDay(p.targetDate, lang, true)} · ${pct}% · ${health}`}
                      >
                        <span className="absolute inset-y-0 left-0" style={{ width: `${s.share * 100}%`, background: color }} />
                        {onTint ? (
                          <span
                            className="relative z-10 pr-2 text-[10px] leading-6 font-bold text-[#0A1931] whitespace-nowrap"
                            style={{ paddingLeft: `calc(${s.share * 100}% + 6px)` }}
                          >
                            {pct}%
                          </span>
                        ) : (
                          <span className="relative z-10 px-2 text-[10px] leading-6 font-bold text-white mix-blend-normal whitespace-nowrap" style={{ textShadow: "0 0 3px rgba(0,0,0,0.35)" }}>
                            {pct}%
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {undated.length > 0 && <Undated list={undated} onOpen={onOpen} />}
    </div>
  );
}

function Undated({ list, onOpen }: { list: Project[]; onOpen: (id: string) => void }) {
  const { t } = useT();
  return (
    <div className="mt-3 pt-3 border-t border-[#E8E6E1] flex flex-wrap items-center gap-1.5 text-left">
      <span className="text-[11px] font-semibold text-[#6B6B6B] mr-1">{t("projects.timeline.noDates")}:</span>
      {list.map((p) => (
        <button
          key={p.id}
          onClick={() => onOpen(p.id)}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[#F5F3EF] border border-[#E8E6E1] text-[12px] text-[#0A1931] hover:border-[#C9A96E]"
        >
          <span className="w-2 h-2 rounded-full" style={{ background: projectColor(p) }} />
          {p.name || "—"}
        </button>
      ))}
    </div>
  );
}
