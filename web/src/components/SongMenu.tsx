import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { music, playRadio, setMusic, type Track } from "../lib/music";
import { addToPlaylist, createPlaylist, removeFromPlaylist, usePlaylists } from "../lib/musicDb";
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

// -----------------------------------------------------------------------------
// The song menu: right-click a song anywhere in the music player (desktop),
// long-press it (touch), or press the keyboard's menu key on it:
//
//   Riproduci · Riproduci dopo · Aggiungi alla coda · Avvia radio
//   Aggiungi a playlist ▸ · Rimuovi da questa playlist
//   Apri su YouTube · Copia link
//
// One menu for the whole app, rendered by <SongMenuHost/> (inside the player,
// which is mounted once at the root). Songs opt in with songMenuProps().
// -----------------------------------------------------------------------------

export interface SongMenuRequest {
  track: Track;
  /** The list the song was shown in, so "Riproduci" plays it in context. */
  list?: { tracks: Track[]; label: string; index: number };
  /** Shown inside this team playlist: offer "remove". */
  playlistId?: string;
  x: number;
  y: number;
}

let current: SongMenuRequest | null = null;
const listeners = new Set<() => void>();
function setMenu(r: SongMenuRequest | null) {
  current = r;
  listeners.forEach((l) => l());
}

export function openSongMenu(r: SongMenuRequest) {
  setMenu(r);
}

// A long press must not also count as the click that ends it.
let swallowClick = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "click",
    (e) => {
      if (swallowClick) {
        swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
}

/** Spread on a song's element: right-click, long-press and the menu key open the menu. */
export function songMenuProps(
  track: Track,
  ctx: Omit<SongMenuRequest, "track" | "x" | "y"> = {}
): Pick<HTMLAttributes<HTMLElement>, "onContextMenu" | "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel"> {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = undefined;
    start = null;
  };
  return {
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The keyboard's menu key reports 0,0: place the menu on the element.
      let { clientX: x, clientY: y } = e;
      if (!x && !y) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        x = r.left + 24;
        y = r.top + r.height / 2;
      }
      openSongMenu({ track, ...ctx, x, y });
    },
    onTouchStart: (e) => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      timer = window.setTimeout(() => {
        if (!start) return;
        swallowClick = true;
        navigator.vibrate?.(10);
        openSongMenu({ track, ...ctx, x: start.x, y: start.y });
        start = null;
      }, 480);
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}

/** The menu itself. Render once. */
export function SongMenuHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  // Into <body>: a parent with a filter or transform would otherwise move a
  // position:fixed menu away from the pointer.
  return current ? createPortal(<Menu key={`${current.track.id}:${current.x}:${current.y}`} req={current} />, document.body) : null;
}

function Menu({ req }: { req: SongMenuRequest }) {
  const { t } = useT();
  const { me } = useMe();
  const { playlists, available } = usePlaylists();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: req.x, top: req.y, ready: false });
  const [sub, setSub] = useState(false);
  const tr = req.track;
  const close = () => setMenu(null);
  const toast = (msg: string) => {
    setMusic({ notice: msg });
    window.setTimeout(() => setMusic({ notice: null }), 1800);
  };

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(req.x, window.innerWidth - r.width - 8));
    const top = req.y + r.height > window.innerHeight - 8 ? Math.max(8, req.y - r.height) : req.y;
    setPos({ left, top, ready: true });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [req.x, req.y, sub]);

  // Close on click outside, Escape, scroll or resize; arrows move between items.
  useEffect(() => {
    const down = (e: Event) => !box.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    // A scroll still finishing as the menu opens (inertia, scroll-into-view)
    // must not close it: only scrolls after the first moment do.
    const opened = Date.now();
    const away = (e: Event) => {
      if (Date.now() - opened < 250) return;
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
    };
  }, []);

  const run = (fn: () => void | Promise<void>) => () => {
    close();
    void fn();
  };
  const url = `https://www.youtube.com/watch?v=${tr.id}`;

  return (
    <div
      ref={box}
      className="song-menu"
      role="menu"
      aria-label={tr.title}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="song-menu__head">
        <b>{tr.title || tr.id}</b>
        {tr.channel && <small>{tr.channel}</small>}
      </div>
      {sub ? (
        <>
          <Item icon={<IconChevronRight className="song-menu__back" />} onClick={() => setSub(false)}>
            {t("mt.addTo")}
          </Item>
          <div className="song-menu__sep" />
          <div className="song-menu__scroll">
            {playlists.map((p) => {
              const has = p.tracks.some((x) => x.id === tr.id);
              return (
                <Item
                  key={p.id}
                  icon={has ? <IconCheck /> : <span className="song-menu__dot" />}
                  disabled={has}
                  onClick={run(async () => {
                    await addToPlaylist(p.id, tr);
                    toast(t("sm.added").replace("{p}", p.name));
                  })}
                >
                  {p.name}
                </Item>
              );
            })}
          </div>
          <Item
            icon={<IconPlus />}
            disabled={!available}
            onClick={run(async () => {
              const name = window.prompt(t("mt.newName"), t("mt.newDefault"));
              if (!name?.trim()) return;
              await createPlaylist(name, me, [{ id: tr.id, title: tr.title, channel: tr.channel, thumb: tr.thumb }]);
              toast(t("sm.added").replace("{p}", name.trim()));
            })}
          >
            {t("mt.create")}
          </Item>
        </>
      ) : (
        <>
          <Item
            icon={<IconPlay />}
            onClick={run(() =>
              req.list
                ? music.play({ kind: "videos", label: req.list.label, tracks: req.list.tracks, start: req.list.index })
                : music.play({ kind: "videos", label: tr.title, tracks: [tr], start: 0 })
            )}
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
            onClick={run(async () => {
              const err = await playRadio(tr, t("mt.radio"));
              if (err) toast(t("mt.radioErr"));
            })}
          >
            {t("sm.radio")}
          </Item>
          <div className="song-menu__sep" />
          <Item icon={<IconPlus />} after={<IconChevronRight size={15} />} onClick={() => setSub(true)} disabled={!available}>
            {t("mt.addTo")}
          </Item>
          {req.playlistId && (
            <Item icon={<IconTrash />} danger onClick={run(() => removeFromPlaylist(req.playlistId!, tr.id))}>
              {t("mt.remove")}
            </Item>
          )}
          <div className="song-menu__sep" />
          <Item icon={<IconExternal />} onClick={run(() => void window.open(url, "_blank", "noopener,noreferrer"))}>
            {t("sm.openYt")}
          </Item>
          <Item
            icon={<IconCopy />}
            onClick={run(async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast(t("sm.copied"));
              } catch {
                window.prompt(t("sm.copyLink"), url);
              }
            })}
          >
            {t("sm.copyLink")}
          </Item>
        </>
      )}
    </div>
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
    <button role="menuitem" className={`song-menu__item${danger ? " is-danger" : ""}`} onClick={onClick} disabled={disabled}>
      <span className="song-menu__icon">{icon}</span>
      <span className="song-menu__label">{children}</span>
      {after && <span className="song-menu__after">{after}</span>}
    </button>
  );
}
