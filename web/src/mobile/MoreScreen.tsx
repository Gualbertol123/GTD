import { useEffect, useRef, useState } from "react";
import { IconNote } from "../components/MusicIcons";
import type { Board, Weekly } from "../lib/types";
import { WEEKLY_COLUMNS, genId } from "../lib/constants";
import { periodBounds, taskCompletedAt, weekPeriod } from "../lib/reportData";
import { taskOwners } from "../lib/owners";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { readAppearanceChoice, readBlur, readSkin, writeAppearance, writeBlur, writeSkin, type AppearanceChoice } from "../lib/skin";
import { COLOR_DEFAULT, COLOR_MAX, COLOR_MIN, readColor, writeColor } from "../lib/skin";
import { WeeklyItemField } from "../components/WeeklyView";
import { DailyReflection } from "../components/DailyReflection";
import { SettingsView } from "../components/SettingsView";
import { ReportView } from "../components/ReportView";
import { ProductTreeView } from "../components/ProductTreeView";
import { Avatar, Avatars, Sheet, useToast } from "./ui";
import { useInstall } from "../lib/pwa";
import { music } from "../lib/music";
import { IconBack, IconChevron, IconClose, IconAuto, IconDesktop, IconDownload, IconMoon, IconSun, IconGear, IconLeaf, IconMail, IconReport, IconTree, IconUser, IconWeekly } from "./icons";
import type { Send } from "./actions";
import type { LayoutChoice } from "./useLayout";

export type MorePage = "weekly" | "report" | "reflection" | "products" | "settings" | null;

/** Everything that is not one of the four main tabs. */
export function MoreScreen({
  board,
  send,
  page,
  setPage,
  onMail,
  onMe,
}: {
  board: Board;
  send: Send;
  page: MorePage;
  setPage: (p: MorePage) => void;
  onMail: () => void;
  onMe: () => void;
}) {
  const { t } = useT();
  const { me } = useMe();

  if (page) {
    const back = (
      <div className="m-embed__bar">
        <button className="m-iconbtn" aria-label={t("m.back")} onClick={() => setPage(null)}>
          <IconBack size={18} />
        </button>
      </div>
    );
    if (page === "weekly")
      return (
        <div className="m-page" style={{ paddingTop: 8 }}>
          {back}
          <WeeklyPage board={board} send={send} />
        </div>
      );
    return (
      <div className="m-embed">
        {back}
        {page === "report" && (
          <>
            <p className="m-sub" style={{ margin: "0 4px 12px" }}>
              {t("ux.report.mobileHint")}
            </p>
            <div className="m-scroll-x">
              <ReportView board={board} send={send} />
            </div>
          </>
        )}
        {page === "reflection" && <DailyReflection board={board} members={board.members} send={send} />}
        {page === "products" && (
          <div className="m-scroll-x">
            <ProductTreeView />
          </div>
        )}
        {page === "settings" && <SettingsView board={board} send={send} />}
      </div>
    );
  }

  // Musica gets YouTube ready on the touch itself (music.warm), before the tap ends.
  const rows: { icon: React.ReactNode; tile: string; title: string; hint: string; onClick: () => void; warm?: boolean }[] = [
    { icon: <IconNote size={18} />, tile: "var(--m-red)", title: t("music.title"), hint: t("music.more"), onClick: () => music.open(), warm: true },
    { icon: <IconWeekly size={18} />, tile: "var(--m-indigo)", title: t("m.page.weekly"), hint: t("m.more.weekly"), onClick: () => setPage("weekly") },
    { icon: <IconMail size={18} />, tile: "var(--m-blue)", title: t("app.mail"), hint: t("m.more.mail"), onClick: onMail },
    { icon: <IconReport size={18} />, tile: "var(--m-orange)", title: t("m.page.report"), hint: t("m.more.report"), onClick: () => setPage("report") },
    { icon: <IconLeaf size={18} />, tile: "var(--m-green)", title: t("m.page.reflection"), hint: t("m.more.reflection"), onClick: () => setPage("reflection") },
    { icon: <IconTree size={18} />, tile: "var(--m-teal)", title: t("m.page.products"), hint: t("m.more.products"), onClick: () => setPage("products") },
    { icon: <IconGear size={18} />, tile: "var(--m-grey)", title: t("m.page.settings"), hint: t("m.more.settings"), onClick: () => setPage("settings") },
  ];

  return (
    <div className="m-page">
      <button className="m-panel m-row" onClick={onMe}>
        {me ? (
          <Avatar name={me} large />
        ) : (
          <span className="m-row__icon">
            <IconUser size={18} />
          </span>
        )}
        <span className="m-row__main">
          <span className="m-row__title">{me || t("m.pickMe")}</span>
          <span className="m-row__hint" style={{ display: "block" }}>
            {t("m.meHint")}
          </span>
        </span>
        <IconChevron size={18} />
      </button>

      <div className="m-label" style={{ marginTop: 18 }}>
        {t("skin.appearance")}
      </div>
      <AppearanceControl />
      <BlurControl />
      <ColorAmountControl />

      <div className="m-panel m-list" style={{ marginTop: 18 }}>
        {rows.map((r) => (
          <button key={r.title} className="m-row" onClick={r.onClick} onPointerDown={r.warm ? music.warm : undefined}>
            <span className="m-row__icon" style={{ ["--tile" as string]: r.tile }}>
              {r.icon}
            </span>
            <span className="m-row__main">
              <span className="m-row__title">{r.title}</span>
              <span className="m-row__hint" style={{ display: "block" }}>
                {r.hint}
              </span>
            </span>
            <span className="m-row__end">
              <IconChevron size={18} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The weekly review, stacked: this week's wins from the board, then the five lists. */
function WeeklyPage({ board, send }: { board: Board; send: Send }) {
  const { t } = useT();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const clearBtn = useRef<HTMLButtonElement>(null);
  const refocusClear = useRef(false);

  // The same Monday–Sunday week as the desktop Recap and the Report.
  const { start, end } = periodBounds(weekPeriod(0));
  const done = board.tasks
    .filter((tk) => {
      if (tk.status !== "DONE") return false;
      const at = taskCompletedAt(tk);
      return at >= start && at < end;
    })
    .sort((a, b) => taskCompletedAt(b) - taskCompletedAt(a));

  const itemCount = WEEKLY_COLUMNS.reduce((n, c) => n + board.weekly[c.key].length, 0);

  useEffect(() => {
    if (!confirm && refocusClear.current) {
      refocusClear.current = false;
      clearBtn.current?.focus();
    }
  }, [confirm]);
  const cancelClear = () => {
    refocusClear.current = true;
    setConfirm(false);
  };
  const clearAll = () => {
    const snapshot: { column: keyof Weekly; item: { id: string; text: string } }[] = [];
    for (const c of WEEKLY_COLUMNS) for (const item of board.weekly[c.key]) snapshot.push({ column: c.key, item });
    send({ type: "weeklyClear" });
    setConfirm(false);
    // Undo puts every line back, in its order.
    toast(t("weekly.cleared", { n: snapshot.length }), () => {
      for (const r of snapshot) send({ type: "weeklyAdd", column: r.column, item: { ...r.item } });
    });
  };

  return (
    <>
      <p className="m-sub" style={{ margin: "0 4px 12px" }}>
        {t("weekly.helpV2")}
      </p>
      <button
        className="m-panel m-row"
        onClick={() => setShowDone((v) => !v)}
        aria-expanded={showDone}
        aria-controls="m-weekly-recap"
      >
        <span className="m-row__icon" style={{ ["--tile" as string]: "var(--m-green)", fontWeight: 800 }}>
          {done.length}
        </span>
        <span className="m-row__main">
          <span className="m-row__title">{t("weekly.recapTitle")}</span>
          <span className="m-row__hint" style={{ display: "block" }}>
            {t("m.weeklyFromBoard")}
          </span>
        </span>
        <IconChevron size={18} className={showDone ? "rotate-90" : ""} />
      </button>
      {showDone && (
        <div id="m-weekly-recap" className="m-panel m-list" style={{ marginTop: 8 }}>
          {done.length === 0 ? (
            <div className="m-empty" style={{ padding: "14px" }}>
              {t("weekly.noneDone")}
            </div>
          ) : (
            done.map((tk) => (
              <div key={tk.id} className="m-row" style={{ minHeight: 0, padding: "10px 14px" }}>
                <Avatars task={tk} max={taskOwners(tk).length} />
                <span className="m-row__main" style={{ fontSize: 14 }}>
                  {tk.title}
                </span>
                <span className="m-chip">{tk.priority}</span>
              </div>
            ))
          )}
        </div>
      )}

      {WEEKLY_COLUMNS.map((col) => (
        <WeeklyBucket key={col.key} bucket={col.key} label={t(`m.weekly.${col.key}`)} items={board.weekly[col.key]} send={send} />
      ))}

      <div style={{ marginTop: 26 }}>
        {confirm ? (
          <div
            role="alertdialog"
            aria-labelledby="m-weekly-clear-q"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                cancelClear();
              }
            }}
          >
            <p id="m-weekly-clear-q" className="m-sub" style={{ margin: "0 4px 10px", color: "var(--m-red)" }}>
              {t("weekly.confirmClearN", { n: itemCount })}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="m-btn" style={{ flex: 1 }} autoFocus onClick={cancelClear}>
                {t("task.no")}
              </button>
              <button className="m-btn m-btn--danger" style={{ flex: 1.4 }} onClick={clearAll}>
                {t("m.clearYes")}
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={clearBtn}
            className="m-btn m-btn--block"
            onClick={() => setConfirm(true)}
            disabled={itemCount === 0}
            title={itemCount === 0 ? t("weekly.clearEmpty") : undefined}
          >
            {t("weekly.clear")}
          </button>
        )}
      </div>
    </>
  );
}

function WeeklyBucket({
  bucket,
  label,
  items,
  send,
}: {
  bucket: keyof Weekly;
  label: string;
  items: { id: string; text: string }[];
  send: Send;
}) {
  const { t } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    send({ type: "weeklyAdd", column: bucket, item: { id: genId(), text: v } });
    setDraft("");
  };
  const remove = (it: { id: string; text: string }) => {
    send({ type: "weeklyDelete", column: bucket, id: it.id });
    // Undo puts the line back (at the end of the list).
    toast(t("ux.m.weeklyDeleted"), () => send({ type: "weeklyAdd", column: bucket, item: it }));
  };
  return (
    <>
      <h2 className="m-h2">
        {label} <span className="m-count">{items.length}</span>
      </h2>
      <div className="m-panel m-list">
        {items.map((it) => (
          <div key={it.id} className="m-sub-row" style={{ alignItems: "center" }}>
            <WeeklyItemField
              text={it.text}
              onSave={(v) => send({ type: "weeklyUpdate", column: bucket, id: it.id, text: v })}
              onDelete={() => remove(it)}
              ariaLabel={t("weekly.itemLabel", { col: label })}
              className="m-sub-row__text"
            />
            <button className="m-hit" aria-label={t("m.delete")} onClick={() => remove(it)}>
              <IconClose size={16} />
            </button>
          </div>
        ))}
        <div className="m-sub-row" style={{ alignItems: "center" }}>
          <input
            className="m-sub-row__text"
            style={{ background: "transparent", border: 0, outline: "none", color: "var(--m-text)", fontSize: 16 }}
            placeholder={t(`weekly.ph.${bucket}`)}
            aria-label={t("weekly.addTo", { col: label })}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
            }}
            enterKeyHint="done"
          />
          {draft.trim() && (
            <button style={{ color: "var(--m-gold)", fontWeight: 700, fontSize: 14 }} onClick={add}>
              {t("m.add")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Who you are on this device, language, light/dark, and the desktop layout. */
export function MeSheet({
  members,
  onClose,
  setLayout,
}: {
  members: string[];
  onClose: () => void;
  setLayout: (c: LayoutChoice) => void;
}) {
  const { t, lang, setLang } = useT();
  const { me, setMe } = useMe();

  return (
    <Sheet title={t("m.me")} onClose={onClose}>
      <div className="m-label">{t("m.whoAmI")}</div>
      <div className="m-choices">
        {members.map((m) => (
          <button key={m} className="m-choice" aria-pressed={me === m} onClick={() => setMe(m)}>
            <Avatar name={m} /> {m}
          </button>
        ))}
      </div>
      <p className="m-sub" style={{ marginTop: 8 }}>
        {t("m.whoAmIHint")}
      </p>

      <div className="m-field">
        <span className="m-label">{t("m.language")}</span>
        <div className="m-seg">
          <button aria-pressed={lang === "it"} onClick={() => setLang("it")}>
            Italiano
          </button>
          <button aria-pressed={lang === "en"} onClick={() => setLang("en")}>
            English
          </button>
        </div>
      </div>

      <div className="m-field">
        <span className="m-label">{t("skin.appearance")}</span>
        <AppearanceControl />
      <BlurControl />
      <ColorAmountControl />
      </div>

      <InstallRow />

      <button className="m-btn m-btn--block" style={{ marginTop: 12 }} onClick={() => setLayout("desktop")}>
        <IconDesktop size={18} /> {t("m.useDesktop")}
      </button>
    </Sheet>
  );
}

/** "Install the app": the browser's prompt where there is one, a hint on iOS. */
function InstallRow() {
  const { t } = useT();
  const install = useInstall();
  const [hint, setHint] = useState(false);
  if (install.installed || (!install.canPrompt && !install.iosHint)) return null;
  return (
    <div style={{ marginTop: 22 }}>
      <button
        className="m-btn m-btn--primary m-btn--block"
        onClick={() => (install.canPrompt ? void install.prompt() : setHint((v) => !v))}
      >
        <IconDownload size={18} /> {t("m.install")}
      </button>
      {hint && (
        <div className="m-panel" style={{ marginTop: 10, padding: "12px 14px", fontSize: 14, lineHeight: 1.45 }}>
          {t("m.installIos")}
        </div>
      )}
    </div>
  );
}

/**
 * Dark, light, or automatic (follows the phone's own setting, live). Picking
 * one also turns the Liquid Glass skin on, which is what the phone layout is
 * designed for. Shared with the desktop's ☀ / ☾ / A control on this device.
 */
// The look as stored and applied now. Every control reads it from here, so the
// Altro page and the "Tu" sheet always agree, also after a change made
// elsewhere (desktop toggle, device setting in Auto).
const lookListeners = new Set<() => void>();
function notifyLook(): void {
  lookListeners.forEach((f) => f());
}
function readLook() {
  return { skin: readSkin(), choice: readAppearanceChoice(), blur: readBlur() };
}
function useLook() {
  const [look, setLook] = useState(readLook);
  useEffect(() => {
    const sync = () =>
      setLook((prev) => {
        const next = readLook();
        return prev.skin === next.skin && prev.choice === next.choice && prev.blur === next.blur ? prev : next;
      });
    lookListeners.add(sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-appearance", "data-blur"] });
    sync();
    return () => {
      lookListeners.delete(sync);
      mo.disconnect();
    };
  }, []);
  return look;
}

function AppearanceControl() {
  const { t } = useT();
  const { skin, choice } = useLook();
  const pick = (c: AppearanceChoice) => {
    writeSkin("glass");
    writeAppearance(c);
    notifyLook();
  };
  return (
    <>
    {skin !== "glass" && (
      <div className="m-row__hint" style={{ margin: "0 4px 6px" }}>
        {t("ux.m.pickSwitchesGlass")}
      </div>
    )}
    <div className="m-seg" role="group" aria-label={t("skin.appearance")}>
      <button aria-pressed={choice === "dark"} onClick={() => pick("dark")}>
        <IconMoon size={16} /> {t("skin.dark")}
      </button>
      <button aria-pressed={choice === "light"} onClick={() => pick("light")}>
        <IconSun size={16} /> {t("skin.light")}
      </button>
      <button aria-pressed={choice === "auto"} onClick={() => pick("auto")}>
        <IconAuto size={16} /> {t("m.auto")}
      </button>
    </div>
    </>
  );
}

/** Colour intensity for the whole app, 0-150 % (same as the desktop's). */
function ColorAmountControl() {
  const { t } = useT();
  const [pct, setPct] = useState<number>(() => readColor());
  const set = (n: number) => {
    setPct(n);
    writeColor(n);
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="m-row__hint" style={{ margin: "0 4px 6px", display: "flex", justifyContent: "space-between" }}>
        <label htmlFor="m-color-amount">{t("color.amount")}</label>
        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{pct}%</span>
      </div>
      <div className="m-color">
        <input
          id="m-color-amount"
          type="range"
          min={COLOR_MIN}
          max={COLOR_MAX}
          step={5}
          value={pct}
          onChange={(e) => set(Number(e.target.value))}
          aria-valuetext={`${pct}%`}
        />
        <button type="button" className="m-pill" disabled={pct === COLOR_DEFAULT} onClick={() => set(COLOR_DEFAULT)}>
          100%
        </button>
      </div>
    </div>
  );
}

/** Glass blur on/off (same as the desktop toggle). */
function BlurControl() {
  const { t } = useT();
  const { skin, blur: on } = useLook();
  const pick = (v: boolean) => {
    writeBlur(v);
    notifyLook();
  };
  if (skin !== "glass") return null; // blur exists only in the Glass look
  return (
    <div style={{ marginTop: 10 }}>
      <div className="m-row__hint" style={{ margin: "0 4px 6px" }}>{t("skin.blur")}</div>
      <div className="m-seg" role="group" aria-label={t("skin.blur")}>
        <button aria-pressed={on} onClick={() => pick(true)}>{t("m.on")}</button>
        <button aria-pressed={!on} onClick={() => pick(false)}>{t("m.off")}</button>
      </div>
    </div>
  );
}
