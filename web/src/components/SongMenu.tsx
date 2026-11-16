import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useBackClose } from "../lib/history";
import { useMe } from "../lib/identity";
import { getMusic, music, musicErrorText, playRadio, toast, type Track } from "../lib/music";
import { addToPlaylist, createPlaylist, createRadioPlaylist, removeFromPlaylist, usePlaylists, type PlaylistError, type WriteResult } from "../lib/musicDb";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconExternal,
  IconPlay,
  IconPlayNext,
  IconPlus,
  IconQueue,
  IconRadio,
  IconTrash,
} from "./MusicIcons";
import "../styles/songMenu.css";

// -----------------------------------------------------------------------------
// The song menu: right-click a song anywhere in the music player (desktop),
// long-press it (touch), press the keyboard's menu key on it, or tap its "⋯":
//
//   Riproduci · Riproduci dopo · Aggiungi alla coda · Avvia radio
//   Salva radio come playlist (the longest radio, updated daily: lib/musicDb.ts)
//   Aggiungi a playlist ▸ · Rimuovi da questa playlist
//   Apri su YouTube · Copia link
//
// One menu for the whole app, rendered by <SongMenuHost/> (inside the player,
// which is mounted once at the root). Songs opt in with songMenuProps(); "⋯"
// buttons call openSongMenu(track, ctx, button).
//
// Touch: the long-press state lives in this module, not in a render's closure,
// so a re-render mid-press can't leave a timer running. A long-press that
// opened the menu cancels its own click (preventDefault on touchend), and a
// transparent backdrop takes the tap that closes the menu, so the song under
// it is not played.
// -----------------------------------------------------------------------------

/** Where a song was shown. The same shape for songMenuProps and openSongMenu. */
export interface SongMenuCtx {
  /** The list the song was shown in, so "Riproduci" plays it in context. `key` is the list's Source.key. */
  list?: { tracks: Track[]; label: string; index: number; key?: string };
  /** Shown inside this team playlist: offer "remove". */
  playlistId?: string;
  /** A row of the play queue at this absolute index: "Riproduci" jumps there and keeps the queue. */
  queueIndex?: number;
  /** The song now playing (the player bar): "Riproduci" restarts it. */
  current?: boolean;
}

/** What "Riproduci" does for a menu request, given the live queue. */
export type MenuPlay =
  | { kind: "restart" }
  | { kind: "at"; index: number }
  | { kind: "list"; label: string; key?: string; tracks: Track[]; start: number }
  | { kind: "single"; track: Track };

/**
 * Picks the "Riproduci" action. A queue row jumps to its index only while the
 * queue still holds that song there (the queue may have moved on while the
 * menu was open); otherwise it falls back to playing the list or the song.
 */
export function menuPlayAction(req: SongMenuCtx & { track: Track }, queue: readonly Track[]): MenuPlay {
  if (req.current) return { kind: "restart" };
  const qi = req.queueIndex;
  if (qi !== undefined && queue[qi]?.id === req.track.id) return { kind: "at", index: qi };
  if (req.list) return { kind: "list", label: req.list.label, key: req.list.key, tracks: req.list.tracks, start: req.list.index };
  return { kind: "single", track: req.track };
}

export interface SongMenuRequest extends SongMenuCtx {
  track: Track;
  x: number;
  y: number;
  /** Opened from a button: the menu sits under it instead of at x/y. */
  anchor?: Box;
  /** Gets the focus back when the menu closes. */
  opener?: HTMLElement | null;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let current: SongMenuRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
function setMenu(r: SongMenuRequest | null) {
  current = r;
  seq++;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * Opens the menu for a song under `anchor` (a "⋯" button). Focus returns to
 * the anchor when the menu closes. Call it from the button's onClick.
 */
export function openSongMenu(track: Track, ctx: SongMenuCtx, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  setMenu({ track, ...ctx, x: r.right, y: r.bottom, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, opener: anchor });
}

export function closeSongMenu(): void {
  if (current) setMenu(null);
}

// ---- Long-press (touch and pen) ------------------------------------------------

const PRESS_MS = 480;
const SLOP = 9; // px of finger movement that turns a press into a scroll

interface Press {
  el: HTMLElement;
  id: number; // pointerId
  x: number;
  y: number;
  timer: number | undefined;
  firedAt: number; // 0 = not fired yet
}
let press: Press | null = null;
// A last-resort click blocker for platforms that still send a click after a
// long-press: only inside the pressed element, only briefly.
let swallow: { el: HTMLElement; until: number } | null = null;

function cancelPress() {
  if (press && !press.firedAt) {
    window.clearTimeout(press.timer);
    press = null;
  }
}

if (typeof window !== "undefined") {
  // Any scroll while the finger is down means it was a scroll, not a press.
  window.addEventListener("scroll", cancelPress, { capture: true, passive: true });
  // A new gesture: the old long-press can no longer have a click to cancel.
  window.addEventListener("pointerdown", () => (swallow = null), { capture: true, passive: true });
  window.addEventListener(
    "click",
    (e) => {
      const s = swallow;
      if (!s) return;
      swallow = null;
      if (Date.now() < s.until && e.target instanceof Node && s.el.contains(e.target)) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
}

function firePress(track: Track, ctx: SongMenuCtx) {
  const p = press;
  if (!p || p.firedAt) return;
  window.clearTimeout(p.timer);
  p.firedAt = Date.now();
  swallow = { el: p.el, until: p.firedAt + 900 };
  navigator.vibrate?.(10);
  setMenu({ track, ...ctx, x: p.x, y: p.y, opener: p.el });
}

/** Marks an element as long-pressable (no iOS callout or text selection). Also set by songMenuProps. */
export const SONG_PRESS_CLASS = "sm-press";

type PressProps = Pick<
  HTMLAttributes<HTMLElement>,
  "onContextMenu" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onTouchEnd"
> & { "data-sm-press": "" };

/**
 * Spread on a song's element: right-click, long-press and the menu key open
 * the menu. It adds no className (so it can't override yours): the
 * `data-sm-press` attribute turns off the iOS callout and text selection.
 * The handlers keep no state of their own, so any render's copy is correct.
 */
export function songMenuProps(track: Track, ctx: SongMenuCtx = {}): PressProps {
  return {
    "data-sm-press": "",
    onPointerDown: (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      if (press) window.clearTimeout(press.timer);
      swallow = null;
      const el = e.currentTarget as HTMLElement;
      press = { el, id: e.pointerId, x: e.clientX, y: e.clientY, timer: undefined, firedAt: 0 };
      press.timer = window.setTimeout(() => firePress(track, ctx), PRESS_MS);
    },
    onPointerMove: (e) => {
      const p = press;
      if (p && p.id === e.pointerId && !p.firedAt && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) cancelPress();
    },
    onPointerUp: (e) => {
      if (press && press.id === e.pointerId) cancelPress();
    },
    onPointerCancel: cancelPress,
    onTouchEnd: (e) => {
      // The long-press opened the menu: this touch is not also a tap.
      const p = press;
      if (p && p.firedAt && p.el === e.currentTarget) {
        if (e.cancelable) e.preventDefault();
        press = null;
      }
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      // Android sends contextmenu for the same long-press: open once.
      if (press && press.el === el) {
        if (!press.firedAt) firePress(track, ctx);
        return;
      }
      // The keyboard's menu key reports 0,0: place the menu on the element.
      let { clientX: x, clientY: y } = e;
      if (!x && !y) {
        const r = el.getBoundingClientRect();
        x = r.left + 24;
        y = r.top + r.height / 2;
      }
      setMenu({ track, ...ctx, x, y, opener: el });
    },
  };
}

// ---- Pure helpers (unit-tested) ----------------------------------------------

/**
 * Where the menu goes: at the point (opening down-right, flipped up when it
 * doesn't fit), or under an anchor button, right-aligned to it. Always ≥ 8 px
 * inside the viewport.
 */
export function placeMenu(
  at: { x: number; y: number; anchor?: Box },
  size: { w: number; h: number },
  view: { w: number; h: number }
): { left: number; top: number } {
  const m = 8;
  const clampX = (x: number) => Math.max(m, Math.min(x, view.w - size.w - m));
  const clampY = (y: number) => Math.max(m, Math.min(y, view.h - size.h - m));
  if (at.anchor) {
    const a = at.anchor;
    const below = a.bottom + 4;
    const top = below + size.h <= view.h - m ? below : a.top - 4 - size.h >= m ? a.top - 4 - size.h : clampY(below);
    return { left: clampX(a.right - size.w), top };
  }
  const top = at.y + size.h > view.h - m ? Math.max(m, at.y - size.h) : at.y;
  return { left: clampX(at.x), top };
}

const WHY: Record<PlaylistError, string> = {
  offline: "sm.why.offline",
  forbidden: "sm.why.forbidden",
  "missing-table": "sm.why.missingTable",
  "not-found": "sm.why.notFound",
  server: "sm.why.server",
};

/** "Non aggiunto a «X»: sei offline." — what failed, then why, in the UI's language. */
export function playlistErrorText(what: string, code: PlaylistError | string, t: (key: string) => string): string {
  return t("sm.failWhy").replace("{what}", what).replace("{why}", t(WHY[code as PlaylistError] ?? WHY.server));
}

// ---- The menu --------------------------------------------------------------

/** The menu itself. Render once. */
export function SongMenuHost() {
  const req = useSyncExternalStore(subscribe, () => current, () => null);
  // Into <body>: a parent with a filter or transform would otherwise move a
  // position:fixed menu away from the pointer.
  return req ? createPortal(<Menu key={seq} req={req} />, document.body) : null;
}

const ITEMS = "button.song-menu__item:not(:disabled)";

function Menu({ req }: { req: SongMenuRequest }) {
  const { t } = useT();
  const { me } = useMe();
  const { playlists, available } = usePlaylists();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: req.x, top: req.y, ready: false });
  const [sub, setSub] = useState(false);
  const [naming, setNaming] = useState(false);
  const [copyField, setCopyField] = useState(false);
  // Where the pointer went down: a click counts only if it started on the same
  // layer (so the click that ends a long-press, or a tap that began on the
  // row underneath, doesn't pick an item or close the menu).
  const downOn = useRef<"menu" | "backdrop" | null>(null);
  const openedAt = useRef(Date.now());
  const tr = req.track;
  const url = `https://www.youtube.com/watch?v=${tr.id}`;
  const close = () => {
    if (current === req) setMenu(null);
  };

  // Android Back closes the menu first.
  useBackClose(close);

  // Keep the menu on screen (again whenever its content changes size).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = placeMenu(req, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight });
    setPos({ ...p, ready: true });
  }, [req, sub, naming, copyField]);

  // Focus the first item once the menu is visible (a hidden element can't take
  // focus), and give the focus back to the opener when the menu goes away.
  useEffect(() => {
    if (!pos.ready || naming || copyField) return;
    box.current?.querySelector<HTMLButtonElement>(ITEMS)?.focus({ preventScroll: true });
  }, [pos.ready, sub, naming, copyField]);
  useEffect(() => {
    const opener = req.opener;
    const el = box.current;
    return () => {
      const a = document.activeElement;
      if (opener?.isConnected && (!a || a === document.body || !a.isConnected || el?.contains(a))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [req.opener]);

  // Keys: Escape, arrows, Home/End, Tab kept inside. Scroll or resize closes,
  // except while the name field is focused (the phone keyboard resizes).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      const inField = e.target instanceof HTMLInputElement && el.contains(e.target);
      if (e.key === "Escape") {
        e.preventDefault();
        if (inField && naming) return setNaming(false);
        return close();
      }
      if (e.key === "Tab") {
        const all = [...el.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
        if (!all.length) return;
        const i = all.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i < 0 || i === all.length - 1 ? 0 : i + 1;
        e.preventDefault();
        all[next].focus();
        return;
      }
      if (inField) return;
      const moves: Record<string, (i: number, n: number) => number> = {
        ArrowDown: (i, n) => (i + 1) % n,
        ArrowUp: (i, n) => (i - 1 + n) % n,
        Home: () => 0,
        End: (_i, n) => n - 1,
      };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const items = [...el.querySelectorAll<HTMLButtonElement>(ITEMS)];
      if (!items.length) return;
      items[move(items.indexOf(document.activeElement as HTMLButtonElement), items.length)]?.focus();
    };
    // A scroll still finishing as the menu opens (inertia, scroll-into-view)
    // must not close it: only scrolls after the first moment do.
    const opened = Date.now();
    const away = (e: Event) => {
      if (Date.now() - opened < 250) return;
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      if (e.type === "resize" && document.activeElement instanceof HTMLInputElement && box.current?.contains(document.activeElement)) return;
      close();
    };
    document.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
    };
  }, [naming]);

  /** Close at once, then do it: feedback never waits for the network. */
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  /** A playlist write: success was already shown; a failure says what and why. */
  const onFail = (what: string) => (r: WriteResult) => {
    if (!r.ok) toast(playlistErrorText(what, r.error, t), "error");
  };

  const add = (id: string, name: string) =>
    run(() => {
      toast(t("sm.added").replace("{p}", name));
      void addToPlaylist(id, tr).then(onFail(t("sm.addFail").replace("{p}", name)));
    });

  const create = (raw: string) => {
    const name = raw.trim() || t("mt.newDefault");
    close();
    const { saved } = createPlaylist(name, me, [{ id: tr.id, title: tr.title, channel: tr.channel, thumb: tr.thumb }]);
    toast(t("sm.created").replace("{p}", name));
    void saved.then(onFail(t("sm.createFail").replace("{p}", name)));
  };

  /** "Salva radio come playlist": a toast at once, then the result. */
  const saveRadio = () => {
    toast(t("sm.radioSaving"));
    const seed: Track = { id: tr.id, title: tr.title, channel: tr.channel, thumb: tr.thumb };
    void createRadioPlaylist(seed, me).then((r) => {
      if (!r.ok) {
        const why = r.error === "empty" ? t("mt.radioErr") : musicErrorText(r.error, t);
        toast(t("sm.failWhy").replace("{what}", t("sm.radioSaveFail")).replace("{why}", why), "error");
        return;
      }
      const name = r.playlist.name;
      void r.saved.then((s) => {
        if (!s.ok) return toast(playlistErrorText(t("sm.createFail").replace("{p}", name), s.error, t), "error");
        const key = s.radioSaved ? "sm.radioSaved" : "sm.radioSavedPlain";
        toast(t(key).replace("{p}", name).replace("{n}", String(r.playlist.tracks.length)));
      });
    });
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      close();
      toast(t("sm.copied"));
    } catch {
      // No clipboard here (http, old WebView, denied): show the link, selected.
      setCopyField(true);
    }
  };

  return (
    <>
      <div
        className="sm-backdrop"
        aria-hidden="true"
        onPointerDown={(e) => {
          downOn.current = "backdrop";
          if (e.pointerType === "mouse") e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (downOn.current === "backdrop") close();
        }}
        onWheel={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={box}
        className="song-menu"
        role="menu"
        aria-label={tr.title}
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={() => (downOn.current = "menu")}
        onClickCapture={(e) => {
          // Only the stray click that ends the opening gesture is dropped:
          // keyboard (detail 0), a tap that began here, and screen readers'
          // later activations all go through.
          if (e.detail !== 0 && downOn.current !== "menu" && Date.now() - openedAt.current < 700) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div className="song-menu__head">
          <b>{tr.title || tr.id}</b>
          {tr.channel && <small>{tr.channel}</small>}
        </div>
        {copyField ? (
          <div className="sm-field" role="none">
            <label className="sm-field__hint" htmlFor="sm-link">
              {t("sm.copyHint")}
            </label>
            <input
              id="sm-link"
              className="sm-field__input"
              readOnly
              value={url}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        ) : sub ? (
          <>
            <Item icon={<IconChevronRight className="song-menu__back" />} onClick={() => (setSub(false), setNaming(false))}>
              {t("mt.addTo")}
            </Item>
            <div className="song-menu__sep" />
            <div className="song-menu__scroll">
              {playlists.map((p) => {
                const has = p.tracks.some((x) => x.id === tr.id);
                return (
                  <Item key={p.id} icon={has ? <IconCheck /> : <span className="song-menu__dot" />} disabled={has} onClick={add(p.id, p.name)}>
                    {p.name}
                  </Item>
                );
              })}
            </div>
            {naming ? (
              <form
                className="sm-field sm-field--row"
                onSubmit={(e) => {
                  e.preventDefault();
                  create(new FormData(e.currentTarget).get("name") as string);
                }}
              >
                <input
                  name="name"
                  className="sm-field__input"
                  defaultValue={t("mt.newDefault")}
                  placeholder={t("mt.newName")}
                  aria-label={t("mt.newName")}
                  enterKeyHint="done"
                  autoComplete="off"
                  maxLength={80}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="submit" className="sm-field__ok" aria-label={t("mt.create")} title={t("mt.create")}>
                  <IconCheck />
                </button>
              </form>
            ) : (
              <Item icon={<IconPlus />} disabled={!available} onClick={() => setNaming(true)}>
                {t("mt.create")}
              </Item>
            )}
          </>
        ) : (
          <>
            <Item
              icon={<IconPlay />}
              onClick={run(() => {
                const a = menuPlayAction(req, getMusic().queue);
                if (a.kind === "restart") music.seek(0);
                else if (a.kind === "at") music.playAt(a.index);
                else if (a.kind === "list") music.play({ kind: "videos", label: a.label, key: a.key, tracks: a.tracks, start: a.start });
                else music.play({ kind: "videos", label: a.track.title, tracks: [a.track], start: 0 });
              })}
            >
              {t("music.play")}
            </Item>
            <Item
              icon={<IconPlayNext />}
              onClick={run(() => {
                music.enqueue([tr], "next", tr.title);
                toast(t("sm.nextDone"));
              })}
            >
              {t("sm.playNext")}
            </Item>
            <Item
              icon={<IconQueue />}
              onClick={run(() => {
                music.enqueue([tr], "end", tr.title);
                toast(t("sm.queueDone"));
              })}
            >
              {t("sm.addQueue")}
            </Item>
            <Item
              icon={<IconRadio />}
              onClick={run(() => {
                // playRadio plays the seed and shows its own "loading" at once.
                void playRadio(tr, t("mt.radio")).then((err) => {
                  if (err) toast(err === "empty" ? t("mt.radioErr") : musicErrorText(err, t), "error");
                });
              })}
            >
              {t("sm.radio")}
            </Item>
            <Item icon={<IconRadioSave />} disabled={!available} onClick={run(saveRadio)}>
              {t("sm.radioSave")}
            </Item>
            <div className="song-menu__sep" />
            <Item icon={<IconPlus />} after={<IconChevronRight size={15} />} onClick={() => setSub(true)} disabled={!available}>
              {t("mt.addTo")}
            </Item>
            {req.playlistId && (
              <Item
                icon={<IconTrash />}
                danger
                onClick={run(() => {
                  toast(t("sm.removed"));
                  void removeFromPlaylist(req.playlistId!, tr.id, req.list?.index).then(onFail(t("sm.removeFail")));
                })}
              >
                {t("mt.remove")}
              </Item>
            )}
            <div className="song-menu__sep" />
            <Item icon={<IconExternal />} onClick={run(() => void window.open(url, "_blank", "noopener,noreferrer"))}>
              {t("sm.openYt")}
            </Item>
            <Item icon={<IconCopy />} onClick={() => void copy()}>
              {t("sm.copyLink")}
            </Item>
          </>
        )}
      </div>
    </>
  );
}

function Item({
  icon,
  after,
  children,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  after?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`song-menu__item${danger ? " is-danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="song-menu__icon">{icon}</span>
      <span className="song-menu__label">{children}</span>
      {after && <span className="song-menu__after">{after}</span>}
    </button>
  );
}

/** A radio with a "+": save the radio as a playlist. Same outline style as MusicIcons. */
function IconRadioSave() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="mi" aria-hidden="true">
      <circle cx="10" cy="12" r="2" />
      <path d="M13.54 8.46a5 5 0 0 1 0 7.08" />
      <path d="M6.46 15.54a5 5 0 0 1 0-7.08" />
      <path d="M3.64 18.36a9 9 0 0 1 0-12.72" />
      <path d="M19 4v6" />
      <path d="M16 7h6" />
    </svg>
  );
}
