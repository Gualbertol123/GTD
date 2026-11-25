import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Priority, Status, Task } from "../lib/types";
import { UNASSIGNED } from "../lib/constants";
import { daysUntil } from "../lib/dates";
import { useT } from "../lib/i18n";
import { useBackClose } from "../lib/history";
import { taskOwners } from "../lib/owners";
import { IconClose } from "./icons";

// ---- Colours ------------------------------------------------------------------

// Priority shows as the colour of a task's check ring (as in Reminders).
export const PRIO_VAR: Record<Priority, string> = {
  P1: "var(--m-red)",
  P2: "var(--m-orange)",
  P3: "var(--m-grey)",
  P4: "var(--m-fill-2)",
};

// The same column colours as the desktop's project bars (lib/projects.ts).
export const STATUS_VAR: Record<Status, string> = {
  BACKLOG: "var(--m-grey)",
  NEXT: "var(--m-blue)",
  "IN PROGRESS": "var(--m-purple)",
  WAITING: "var(--m-orange)",
  DONE: "var(--m-green)",
  MAYBE: "var(--m-teal)",
};

const AVATAR_COLORS = ["#2F5DA8", "#8E5BC9", "#C2563E", "#1F8A70", "#B07A1E", "#3C7DC4", "#A2456E", "#5C6B7E"];

// Team members get colours in list order, so no two share one (up to eight);
// anyone else falls back to a colour picked from the name.
let memberOrder: string[] = [];
export function setAvatarMembers(members: string[]): void {
  memberOrder = members;
}

export function avatarColor(name: string): string {
  if (name === UNASSIGNED) return "#7B8190";
  const i = memberOrder.indexOf(name);
  if (i >= 0) return AVATAR_COLORS[i % AVATAR_COLORS.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Avatar({ name, large }: { name: string; large?: boolean }) {
  const letter = name === UNASSIGNED ? "?" : name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={`m-avatar${large ? " m-avatar--lg" : ""}`} style={{ background: avatarColor(name) }} title={name}>
      {letter}
    </span>
  );
}

export function Avatars({ task, max = 3 }: { task: Pick<Task, "owner" | "assignees">; max?: number }) {
  const names = taskOwners(task);
  return (
    <span className="m-avatars">
      {names.slice(0, max).map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </span>
  );
}

// ---- Due date chip ------------------------------------------------------------

export function DueChip({ task }: { task: Task }) {
  const { t, lang } = useT();
  if (!task.dueDate || task.status === "DONE") return null;
  const d = daysUntil(task.dueDate);
  if (d === null) return null;
  let cls = "m-chip";
  let text: string;
  if (d < 0) {
    cls += " m-chip--red";
    text = t("m.due.late").replace("{n}", String(-d));
  } else if (d === 0) {
    cls += " m-chip--amber";
    text = t("m.due.today");
  } else if (d === 1) {
    cls += " m-chip--blue";
    text = t("m.due.tomorrow");
  } else {
    text = shortDay(task.dueDate, lang);
  }
  return <span className={cls}>{text}</span>;
}

export function shortDay(iso: string, lang: "it" | "en"): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// ---- Bottom sheet -------------------------------------------------------------

// While a sheet is open the page behind it must not move. iOS Safari ignores
// overflow:hidden on <body>, so the page is pinned with position:fixed at its
// current offset, and put back where it was when the last sheet closes.
let lockedY = 0;
function lockScroll(): void {
  lockedY = window.scrollY;
  const b = document.body.style;
  b.position = "fixed";
  b.top = `-${lockedY}px`;
  b.left = "0";
  b.right = "0";
  b.overflow = "hidden";
}
function unlockScroll(): void {
  const b = document.body.style;
  b.position = "";
  b.top = "";
  b.left = "";
  b.right = "";
  b.overflow = "";
  window.scrollTo(0, lockedY);
}

// Open sheets, oldest first: Escape and the page scroll lock act on the top one.
const sheetStack: number[] = [];
let sheetSeq = 0;

/**
 * A panel of thick glass that rises from the bottom. Closes on the ×, a tap
 * on the dimmed page, Escape (top sheet only), or dragging the handle down.
 * While any sheet is open the page behind it does not scroll.
 */
export function Sheet({
  title,
  onClose,
  children,
  full,
  headEnd,
  lead,
  tint,
}: {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  full?: boolean;
  /** Buttons before the close button. */
  headEnd?: React.ReactNode;
  /** A button on the left of the header (e.g. Back). */
  lead?: React.ReactNode;
  /** A colour washed into the top of the sheet (a project's colour). */
  tint?: string;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; dy: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Fields inside a sheet save on blur, and React fires no blur when the sheet
  // unmounts: blur the focused field first, so its change is sent before it goes.
  const closeSafely = useRef(() => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && ref.current?.contains(a)) a.blur();
    close.current();
  }).current;
  useBackClose(closeSafely); // the browser's / phone's Back closes the top sheet

  // What had focus when the sheet opened, captured once at first render: an
  // effect that runs twice (React's StrictMode in development) would
  // otherwise record the sheet itself the second time, and a picker opened
  // from a task sheet lost focus to <body> on close.
  const openerRef = useRef<Element | null | undefined>(undefined);
  if (openerRef.current === undefined) openerRef.current = typeof document === "undefined" ? null : document.activeElement;

  useEffect(() => {
    const id = ++sheetSeq;
    const opener = openerRef.current;
    if (sheetStack.length === 0) {
      lockScroll();
      // The page behind is out of reach for keyboard and screen reader while
      // a sheet is open (sheets and the toast live outside .m-app).
      document.querySelector(".m-app")?.setAttribute("inert", "");
      document.documentElement.setAttribute("data-sheet", "");
    }
    sheetStack.push(id);
    const sheetEl = ref.current!;
    // Move focus into the sheet, unless something inside already took it.
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== id) return;
      if (e.key === "Escape") closeSafely();
      else if (e.key === "Tab" && ref.current) {
        // Keep Tab inside the top sheet.
        const items = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (items.length === 0) {
          e.preventDefault();
          ref.current.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const a = document.activeElement;
        const inside = a instanceof Node && ref.current.contains(a);
        if (e.shiftKey && (a === first || a === ref.current || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (a === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      sheetStack.splice(sheetStack.indexOf(id), 1);
      if (sheetStack.length === 0) {
        unlockScroll();
        document.querySelector(".m-app")?.removeAttribute("inert");
        document.documentElement.removeAttribute("data-sheet");
      }
      // Give focus back to what opened the sheet, if it is still there.
      if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
        const restore = () => opener.focus({ preventScroll: true });
        if (sheetStack.length === 0) restore();
        // A nested sheet (a picker over the task sheet): once its parent's
        // keyboard handling is back. Not if the sheet is still there (the
        // effect was only re-run): that pulled focus out of a picker
        // that had just opened.
        else setTimeout(() => !sheetEl.isConnected && restore(), 0);
      }
    };
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { y0: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    ref.current.style.transform = `translateY(${drag.current.dy}px)`;
    ref.current.style.transition = "none";
  };
  const onUp = () => {
    if (!drag.current || !ref.current) return;
    const { dy } = drag.current;
    drag.current = null;
    ref.current.style.transition = "transform 0.22s ease";
    if (dy > 110) {
      ref.current.style.transform = "translateY(105%)";
      setTimeout(closeSafely, 180);
    } else {
      ref.current.style.transform = "";
    }
  };
  const handlers = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  return createPortal(
    <>
      <div className="m-backdrop" onClick={closeSafely} />
      <div
        ref={ref}
        className={`m-sheet${full ? " m-sheet--full" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {tint && <div className="m-sheet__tint" style={{ ["--tint" as string]: tint }} />}
        <div className="m-sheet__grab" {...handlers} />
        <div className="m-sheet__head" {...handlers}>
          {lead}
          {title && <h3 className={headEnd ? "m-sheet__title--start" : undefined}>{title}</h3>}
          <span className="m-spacer" />
          {headEnd}
          <button className="m-iconbtn" onClick={closeSafely} aria-label={t("m.close")}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="m-sheet__body">{children}</div>
      </div>
    </>,
    document.body
  );
}

// ---- Toast with undo ------------------------------------------------------------

interface ToastMsg {
  id: number;
  text: string;
  undo?: () => void;
}

const ToastCtx = createContext<(text: string, undo?: () => void) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback((text: string, undo?: () => void) => {
    clearTimeout(timer.current);
    const id = Date.now();
    setMsg({ id, text, undo });
    // A longer message (a refused edit says why) stays long enough to read.
    const ms = undo ? 5000 : Math.max(2600, text.length * 60);
    timer.current = setTimeout(() => setMsg((m) => (m?.id === id ? null : m)), ms);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="m-toast" role="status" key={msg.id}>
          <span>{msg.text}</span>
          {msg.undo && (
            <button
              onClick={() => {
                msg.undo?.();
                setMsg(null);
              }}
            >
              {t("m.undo")}
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

// ---- Progress ring -----------------------------------------------------------

export function Ring({ share, color, size = 44 }: { share: number; color: string; size?: number }) {
  const { t } = useT();
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.round(share * 100);
  return (
    <svg
      className="m-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("ux.m.pctDone").replace("{n}", String(pct))}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--m-fill-2)" strokeWidth={5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${c * share} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={size * (pct >= 100 ? 0.23 : 0.26)}
        fontWeight={700}
        fill="var(--m-text)"
      >
        {pct}
        <tspan fontSize={size * 0.15} fontWeight={600}>
          %
        </tspan>
      </text>
    </svg>
  );
}
