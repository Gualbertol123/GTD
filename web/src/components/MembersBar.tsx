import { useState } from "react";
import { isOwnedBy, withoutOwner } from "../lib/owners";
import type { Board, Op } from "../lib/types";
import { useT } from "../lib/i18n";
import { showUndo } from "./TaskDetails";

interface Props {
  board: Board;
  send: (op: Op) => void;
}

// Inline members management. Removing a member is immediate, with Annulla
// (the owner's rule, 2026-11-25: anything that can be put back is not asked
// about first); the toast says how many tasks it touched.
export function MembersBar({ board, send }: Props) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const commitAdd = () => {
    const v = name.trim();
    if (v && !board.members.includes(v)) {
      send({ type: "setMembers", members: [...board.members, v] });
    }
    setName("");
    setAdding(false);
  };

  const remove = (m: string, viaKeyboard: boolean) => {
    const before = [...board.members];
    // Next occurrences not shown yet too (board.upcoming): they would keep
    // the departed member otherwise.
    const held = [...board.tasks, ...(board.upcoming ?? [])].filter((tk) => isOwnedBy(tk, m));
    // Snapshot what the removal changes on each task, for the undo.
    const snap = held.map((tk) => ({
      id: tk.id,
      patch: tk.assignees ? { owner: tk.owner, assignees: [...tk.assignees] } : { owner: tk.owner },
    }));
    send({ type: "setMembers", members: board.members.filter((x) => x !== m) });
    // Take the departing member off every task they held. A task shared with
    // other people keeps them; only a task nobody else holds goes unassigned.
    held.forEach((tk) => send({ type: "updateTask", id: tk.id, patch: withoutOwner(tk, m) }));
    const text = held.length ? t("ux.board.memberRemovedN", { name: m, n: held.length }) : t("ux.board.memberRemoved", { name: m });
    showUndo(
      text,
      () => {
        send({ type: "setMembers", members: before });
        snap.forEach((s) => send({ type: "updateTask", id: s.id, patch: s.patch }));
      },
      8000,
      // From the keyboard the × is gone with the chip: focus goes to Annulla.
      { focus: viaKeyboard }
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-trajan text-[10px] uppercase tracking-widest text-ink-2 mr-1">
        {t("members.team")}
      </span>
      {board.members.map((m) => (
        <span
          key={m}
          className="inline-flex items-center gap-1.5 min-h-8 pl-1 pr-2 rounded-full border text-[12px] text-[#0A1931] max-w-full bg-white border-[#E8E6E1]"
        >
          <span className="w-6 h-6 shrink-0 rounded-full bg-[#0A1931] text-white text-[10px] font-bold flex items-center justify-center">
            {m.charAt(0).toUpperCase()}
          </span>
          <span className="max-w-[160px] truncate" title={m}>
            {m}
          </span>
          <button
            type="button"
            onClick={(e) => remove(m, e.detail === 0)}
            className="shrink-0 w-5 h-5 rounded-full inline-flex items-center justify-center text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ctl-focus)]"
            title={t("ux.board.removeMemberLabel", { name: m })}
            aria-label={t("ux.board.removeMemberLabel", { name: m })}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </span>
      ))}

      {adding ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitAdd}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAdd();
            if (e.key === "Escape") {
              setName("");
              setAdding(false);
            }
          }}
          placeholder={t("members.newName")}
          className="h-8 rounded-full bg-white border border-[#C9A96E] px-3 text-[12px] outline-none"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="h-8 px-3 rounded-full border border-dashed border-[#C9A96E] text-[#7A5F30] text-[12px] font-semibold"
        >
          + {t("members.add")}
        </button>
      )}
    </div>
  );
}
