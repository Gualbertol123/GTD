import { useEffect, useRef, useState } from "react";
import type { TabId } from "../lib/constants";
import { useT } from "../lib/i18n";
import { music } from "../lib/music";

// The desktop's sections (owner's decision, 2026-11-25): six places in the
// tab bar, mirroring the phone's five + Altro.
//
//   BOARD · PROGETTI · CALENDARIO · SETTIMANA · RIFLESSIONE · ALTRO ▾
//
// SETTIMANA holds the three weekly outputs (Weekly, Report, Mail), switched by
// WeekSwitch at the top of the page; ALTRO is a menu with Prodotti, Musica and
// Impostazioni. Every page keeps its own address (#/weekly, #/report, #/mail,
// #/products, …), so links, Back and the phone's mappings are unchanged.

export const WEEK_PAGES: TabId[] = ["weekly", "report", "mail"];
export const MORE_PAGES: TabId[] = ["products", "music", "settings"];

// The week page last opened (per tab, this session): SETTIMANA goes back to it.
let lastWeekPage: TabId = "weekly";

export function TabNav({ tab, go }: { tab: TabId; go: (t: TabId, viaKeyboard: boolean) => void }) {
  const { t } = useT();
  if (WEEK_PAGES.includes(tab)) lastWeekPage = tab;
  const top: { id: string; active: boolean; open: (kb: boolean) => void }[] = [
    { id: "board", active: tab === "board", open: (kb) => go("board", kb) },
    { id: "projects", active: tab === "projects", open: (kb) => go("projects", kb) },
    { id: "calendario", active: tab === "calendario", open: (kb) => go("calendario", kb) },
    { id: "settimana", active: WEEK_PAGES.includes(tab), open: (kb) => go(lastWeekPage, kb) },
    { id: "reflection", active: tab === "reflection", open: (kb) => go("reflection", kb) },
  ];
  return (
    <nav aria-label={t("ux.shell.tabsNav")} className="max-w-[1500px] mx-auto px-4 mt-4">
      <div className="flex flex-wrap gap-2">
        {top.map((x) => (
          <button
            key={x.id}
            aria-current={x.active ? "page" : undefined}
            // Keyboard activation (detail 0) carries on into the new section;
            // a mouse click leaves focus and scroll alone.
            onClick={(e) => x.open(e.detail === 0)}
            className="tab px-4 h-9 text-[12px] font-semibold tracking-wide"
          >
            {t(`tabs.${x.id}`)}
          </button>
        ))}
        <MoreMenu tab={tab} go={go} />
      </div>
    </nav>
  );
}

/** ALTRO ▾: Prodotti, Musica, Impostazioni. A menu button (WAI-ARIA menu). */
function MoreMenu({ tab, go }: { tab: TabId; go: (t: TabId, viaKeyboard: boolean) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = MORE_PAGES.includes(tab) ? tab : null;

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  // Opened from the keyboard: focus the current page's item (or the first).
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const list = items();
    const cur = list.find((b) => b.getAttribute("aria-current") === "page");
    (focusOnOpen.current === "last" ? list[list.length - 1] : cur ?? list[0])?.focus();
    focusOnOpen.current = null;
  }, [open]);

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!menuRef.current?.contains(n) && !btnRef.current?.contains(n)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length]?.focus();
    else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list[list.length - 1]?.focus();
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "more-menu" : undefined}
        aria-current={current ? "page" : undefined}
        onClick={(e) => {
          if (e.detail === 0) focusOnOpen.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            focusOnOpen.current = e.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
        className="tab px-4 h-9 text-[12px] font-semibold tracking-wide gap-1.5"
      >
        {current ? `${t("tabs.more")} · ${t(`tabs.${current}`)}` : t("tabs.more")}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id="more-menu"
          ref={menuRef}
          role="menu"
          aria-label={t("ux.shell.moreMenu")}
          onKeyDown={onMenuKey}
          className="menu-pop absolute left-0 top-full mt-2 z-40 min-w-[200px] rounded-[14px] bg-white border border-[#E8E6E1] shadow-xl p-1.5"
        >
          {MORE_PAGES.map((id) => (
            <button
              key={id}
              role="menuitem"
              aria-current={tab === id ? "page" : undefined}
              onPointerDown={id === "music" ? music.warm : undefined}
              onClick={(e) => {
                setOpen(false);
                go(id, e.detail === 0);
              }}
              className="w-full flex items-center justify-between gap-3 h-10 px-3 rounded-lg text-left text-[13px] font-semibold text-[#0A1931]"
            >
              {t(`tabs.${id}`)}
              {tab === id && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Weekly | Report | Mail, at the top of the SETTIMANA pages. */
export function WeekSwitch({ tab, go }: { tab: TabId; go: (t: TabId, viaKeyboard: boolean) => void }) {
  const { t } = useT();
  return (
    <div role="group" aria-label={t("tabs.settimana")} className="seg mb-4">
      {WEEK_PAGES.map((id) => (
        <button
          key={id}
          aria-current={tab === id ? "page" : undefined}
          onClick={(e) => go(id, e.detail === 0)}
          className="tab h-8 px-4 text-[12px] font-semibold"
        >
          {t(`week.${id}`)}
        </button>
      ))}
    </div>
  );
}
