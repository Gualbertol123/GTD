import { Fragment, useState } from "react";
import type { Op, Task } from "../lib/types";
import { PRIORITY_DOT } from "../lib/constants";
import { ownerLabel, priorityLabel, statusLabel, useT, localeCode } from "../lib/i18n";
import { TaskDetails } from "./TaskDetails";
import { ownersLabel } from "../lib/owners";

interface Props {
  tasks: Task[]; // already filtered to visible columns + search
  members: string[];
  send: (op: Op) => void;
  showNames?: boolean; // false hides owner names (screenshot mode)
  multiAssign?: boolean;
}

// Flat list of every activity in the viewable columns. Click a row (or its
// title button, from the keyboard) to expand its full details inline.
//
// Row tints use #F5F3EF, never #FAF9F6: the glass skin turns #FAF9F6 into a
// blurred panel with a ::before sheen, and on a <tr> that pseudo-element
// becomes an extra table cell that shifts every column by one.
export function ListView({ tasks, members, send, showNames = true, multiAssign = true }: Props) {
  const { t, lang } = useT();
  const [openId, setOpenId] = useState<string | null>(null);

  if (tasks.length === 0) {
    return (
      <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-8 text-center text-[13px] text-ink-3">
        {t("list.empty")}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[14px] border border-[#E8E6E1] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[680px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-ink-2 bg-[#F5F3EF]">
              <th className="font-semibold px-4 py-2.5">{t("list.task")}</th>
              <th className="font-semibold px-3 py-2.5">{t("list.owner")}</th>
              <th className="font-semibold px-3 py-2.5">{t("list.priority")}</th>
              <th className="font-semibold px-3 py-2.5">{t("list.status")}</th>
              <th className="font-semibold px-3 py-2.5">{t("list.due")}</th>
              <th className="font-semibold px-3 py-2.5 text-center">{t("list.subtasks")}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((tk) => {
              const done = tk.subtasks.filter((s) => s.done).length;
              const total = tk.subtasks.length;
              const dueFmt = tk.dueDate ? new Date(tk.dueDate).toLocaleDateString(localeCode(lang)) : "—";
              const isOpen = openId === tk.id;
              const toggle = () => setOpenId(isOpen ? null : tk.id);
              const detailsId = `list-details-${tk.id}`;
              return (
                <Fragment key={tk.id}>
                  <tr
                    onClick={toggle}
                    className={`border-t border-[#F0EDE8] cursor-pointer ${
                      isOpen ? "bg-[#F5F3EF]" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          // The row's own click would toggle a second time.
                          e.stopPropagation();
                          toggle();
                        }}
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? detailsId : undefined}
                        className="flex items-center gap-2 text-left rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ctl-focus)] focus-visible:ring-offset-2"
                      >
                        <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 mt-1 ${PRIORITY_DOT[tk.priority]}`} />
                        <span className="sr-only">{t("ux.board.priority", { p: priorityLabel(t, tk.priority) })}:</span>
                        <span className="text-[13px] font-medium text-[#0A1931] break-words">
                          {tk.title}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-2">
                      {showNames ? ownersLabel(tk, (name) => ownerLabel(t, name)) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] font-semibold text-[#0A1931]">{tk.priority}</td>
                    <td className="px-3 py-2.5">
                      <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full bg-[#0A1931] text-[#C9A96E]">
                        {statusLabel(lang, tk.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-2">{dueFmt}</td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-2 text-center">
                      {total ? `${done}/${total}` : "—"}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={detailsId} className="bg-[#F5F3EF]">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="max-w-[560px]">
                          <TaskDetails
                            task={tk}
                            multiAssign={multiAssign}
                            members={members}
                            send={send}
                            showNames={showNames}
                            onDeleted={() => setOpenId(null)}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
