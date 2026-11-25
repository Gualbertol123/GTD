import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useBoard } from "./lib/useBoard";
import { TABS, type TabId } from "./lib/constants";
import { useT } from "./lib/i18n";
import { TopBar } from "./components/TopBar";
import { Filters, type FilterState } from "./components/Filters";
import { BoardView } from "./components/BoardView";
import { ProjectsView } from "./components/ProjectsView";
import { WeeklyView } from "./components/WeeklyView";
import { isOwnedBy } from "./lib/owners";
import { DailyReflection } from "./components/DailyReflection";
import { MailComposer } from "./components/MailModal";
import { TabNav, WEEK_PAGES, WeekSwitch } from "./components/TabNav";
import { ConnBadge } from "./components/ConnBadge";
import { IdentityPicker } from "./components/IdentityPicker";
import { AppearanceMenu } from "./components/AppearanceMenu";
import { ProjectsProvider } from "./lib/projectsContext";
import { PHONE_QUERY, useLayout } from "./mobile/useLayout";
import { MusicButton, MusicPlayer } from "./components/MusicPlayer";
import { UndoToastHost, showNotice } from "./components/TaskDetails";
import { onSaveError } from "./lib/saveErrors";
import { navigate, useRoute } from "./lib/history";

// Screens other than the board load when first opened (each is its own
// chunk): the first paint downloads the board and the shell only.
const ReportView = lazy(() => import("./components/ReportView").then((m) => ({ default: m.ReportView })));
const CalendarView = lazy(() => import("./components/CalendarView").then((m) => ({ default: m.CalendarView })));
const SettingsView = lazy(() => import("./components/SettingsView").then((m) => ({ default: m.SettingsView })));
const ProductTreeView = lazy(() => import("./components/ProductTreeView").then((m) => ({ default: m.ProductTreeView })));
const MusicTab = lazy(() => import("./components/MusicTab").then((m) => ({ default: m.MusicTab })));
// The phone layout is its own chunk: desktop visitors never download it.
const MobileApp = lazy(() => import("./mobile/MobileApp").then((m) => ({ default: m.MobileApp })));

export default function App() {
  const { board, conn, error, send } = useBoard();
  const { t, lang } = useT();
  const layout = useLayout();
  // The tab lives in the URL (#/board, #/projects/<id>, …) so the browser's
  // Back and Forward move between tabs. Addresses from the phone layout are
  // translated, so switching layout keeps your place.
  const route = useRoute();
  const tab = desktopTab(route.tab, route.sub);
  const setTab = (t: TabId) => navigate({ tab: t });
  useEffect(() => {
    if (!layout.mobile && (route.tab !== tab || (route.sub && tab !== "projects" && tab !== "music")))
      navigate({ tab, sub: tab === "projects" || tab === "music" ? route.sub : undefined }, { replace: true });
  }, [layout.mobile, route.tab, route.sub, tab]);
  // A refused write that its screen did not report: say so (both layouts).
  useEffect(
    () =>
      onSaveError((msg) =>
        showNotice(typeof navigator !== "undefined" && navigator.onLine === false ? t("save.offline") : t("save.failed", { msg }))
      ),
    [t]
  );
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    owner: "all",
    priority: "all",
    focusP1: false,
  });

  const members = board?.members ?? [];
  const mainRef = useRef<HTMLElement>(null);

  // The browser tab, history and Back/Forward entries name the section you
  // are on (both layouts: the phone's addresses map to the same tabs).
  const boardName = board?.boardName?.trim() || "Team GTD";
  // The phone names its own sections (Oggi, Altro › Riflessione, …).
  const phoneKey = route.tab === "more" && route.sub ? `m.page.${route.sub}` : `m.tab.${route.tab}`;
  const phoneLabel = t(phoneKey);
  const section = layout.mobile && phoneLabel !== phoneKey ? phoneLabel : t(`tabs.${tab}`);
  useEffect(() => {
    document.title = board ? `${section} · ${boardName}` : t("app.loadingTitle");
  }, [section, lang, boardName, !!board, t]);

  // Apply the custom favicon (shared) to this tab.
  const faviconUrl = board?.faviconUrl;
  useEffect(() => {
    if (!faviconUrl) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    const prev = link.href;
    link.href = faviconUrl;
    return () => {
      if (prev) link!.href = prev;
    };
  }, [faviconUrl]);

  if (!board) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F3EF]">
        <div className="text-center px-4">
          <div className="font-trajan text-[22px] tracking-widest text-[#0A1931]">
            {t("app.loadingTitle")}
          </div>
          <div className="mt-3 text-[13px] text-[#6B6B6B]">
            {conn === "offline" ? t("app.connectFailed") : t("app.connecting")}
          </div>
          {error && (
            <div className="mt-2 text-[11px] text-[#C81E1E] max-w-[420px]">{error}</div>
          )}
        </div>
      </div>
    );
  }

  const projectsValue = { projects: board.projects, tasks: board.tasks, available: !!board.projectsV2Available, recurring: !!board.recurringAvailable };

  // The music player sits first, outside both layouts, so it keeps playing
  // when the layout switches (it is never re-mounted).
  return (
    <>
      <MusicPlayer mobile={layout.mobile} />
      {/* The one Undo toast (delete a task, a project, a member…), on every tab. */}
      <UndoToastHost />
      {layout.mobile ? (
        <ProjectsProvider value={projectsValue}>
          <Suspense fallback={<div className="min-h-screen bg-[#0A1931]" />}>
            <MobileApp board={board} conn={conn} error={error} send={send} setLayout={layout.setChoice} />
          </Suspense>
        </ProjectsProvider>
      ) : (
        renderDesktop(board)
      )}
    </>
  );

  function renderDesktop(board: import("./lib/types").Board) {
  return (
    <ProjectsProvider value={projectsValue}>
    <div className="min-h-screen bg-[#F5F3EF] text-[#0A1931] pb-16">
      {/* First stop for the keyboard: straight past the header and the tabs. */}
      <a
        href="#main"
        onClick={(e) => {
          // A plain #main would change the hash route; move focus instead.
          e.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-full focus:bg-[#C9A96E] focus:text-[#0A1931] focus:text-[13px] focus:font-semibold focus:shadow-lg"
      >
        {t("ux.shell.skipToContent")}
      </a>
      {/* On a phone showing the desktop layout by choice: the way back. */}
      {layout.choice === "desktop" && window.matchMedia?.(PHONE_QUERY).matches && (
        <button
          onClick={() => layout.setChoice("auto")}
          style={{ display: "block", width: "100%", padding: "12px 16px", background: "#C9A96E", color: "#0A1931", fontSize: 14, fontWeight: 700 }}
        >
          {t("m.useMobile")} →
        </button>
      )}
      <TopBar
        board={board}
        conn={conn}
        onRename={(name) => send({ type: "renameBoard", name })}
        onOpenMail={() => setTab("mail")}
        send={send}
        rightSlot={
          <>
            <MusicButton />
            <IdentityPicker members={members} />
            <ConnBadge conn={conn} />
            <AppearanceMenu />
          </>
        }
      />

      {/* Tabs: six places (components/TabNav.tsx). */}
      <TabNav
        tab={tab}
        go={(id, viaKeyboard) => {
          setTab(id);
          // Keyboard activation carries on into the new section; a mouse
          // click leaves focus and scroll alone.
          if (viaKeyboard) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
        }}
      />

      <main id="main" ref={mainRef} tabIndex={-1} className="max-w-[1500px] mx-auto px-4 mt-4 outline-none">
        {WEEK_PAGES.includes(tab) && (
          <WeekSwitch
            tab={tab}
            go={(id, viaKeyboard) => {
              setTab(id);
              if (viaKeyboard) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
            }}
          />
        )}
        <Suspense fallback={<div role="status" aria-busy="true" className="min-h-[50vh]" />}>
        {tab === "board" && (
          <BoardView
            board={board}
            members={members}
            send={send}
            filters={filters}
            setFilters={setFilters}
          />
        )}
        {tab === "projects" && <ProjectsView board={board} send={send} />}
        {tab === "weekly" && <WeeklyView board={board} send={send} />}
        {tab === "report" && <ReportView board={board} send={send} />}
        {tab === "mail" && (
          <section className="bg-white rounded-[14px] border border-[#E8E6E1] max-w-[720px]">
            <MailComposer board={board} titleId="mail-page-title" headingLevel={2} />
          </section>
        )}
        {tab === "products" && <ProductTreeView />}
        {tab === "calendario" && (
          <div className="space-y-4">
            <Filters filters={filters} setFilters={setFilters} members={members} />
            <CalendarView
              board={board}
              tasks={filteredForCalendar(board.tasks, filters)}
              members={members}
              send={send}
            />
          </div>
        )}
        {tab === "reflection" && (
          <div className="max-w-[900px] mx-auto">
            <DailyReflection board={board} members={members} send={send} />
          </div>
        )}
        {tab === "settings" && <SettingsView board={board} send={send} />}
        {tab === "music" && <MusicTab />}
        </Suspense>
      </main>

    </div>
    </ProjectsProvider>
  );
  }
}

const DESKTOP_TABS = new Set<string>(TABS.map((x) => x.id));

/** The desktop tab for a URL, including the phone layout's addresses. */
function desktopTab(tab: string, sub?: string): TabId {
  if (DESKTOP_TABS.has(tab)) return tab as TabId;
  if (tab === "agenda") return "calendario";
  if (tab === "more" && sub && DESKTOP_TABS.has(sub)) return sub as TabId;
  return "board";
}

function filteredForCalendar(
  tasks: import("./lib/types").Task[],
  f: FilterState
) {
  const q = f.search.trim().toLowerCase();
  return tasks.filter((tk) => {
    const text = !q || tk.title.toLowerCase().includes(q) || tk.desc.toLowerCase().includes(q);
    const owner = f.owner === "all" || isOwnedBy(tk, f.owner);
    const prio = f.priority === "all" || tk.priority === f.priority;
    const focus = !f.focusP1 || tk.priority === "P1";
    return text && owner && prio && focus;
  });
}
