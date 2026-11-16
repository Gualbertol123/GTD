import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useBackClose } from "../lib/history";
import {
  ARTISTS,
  attachPlayer,
  mlog,
  coverOf,
  forgetMusicFailures,
  detachPlayer,
  fetchExplore,
  fetchSuggestions,
  formatTime,
  music,
  musicErrorText,
  musicUsedThisSession,
  onYtError,
  onYtState,
  parseYouTube,
  registerDockTarget,
  searchMusic,
  setMusic,
  setMusicTranslator,
  sourceLabel,
  useLastRequest,
  useMusicSel,
  useMusicTime,
  youtubeSearchUrl,
  takeEnginePending,
  spotifyFailed,
  toast,
  type MusicErrorCode,
  type Track,
  type YtLike,
} from "../lib/music";
import { usePlaylist, usePlaylists } from "../lib/musicDb";
import { spotifyLoginAvailable, useSpotifyAuth } from "../lib/spotifyAuth";
// Spotify mode's engine registers itself with lib/music.ts when loaded.
import { prepareSpotifyPlayer } from "../lib/spotifyPlayer";
import { SongMenuHost, openSongMenu, songMenuProps } from "./SongMenu";
import { HiddenNote, KindBadge, SortBar, sortable, useSortedResults } from "./MusicSearchSort";
import {
  IconBack,
  IconChevronDown,
  IconClose,
  IconExpand,
  IconExternal,
  IconMore,
  IconNext,
  IconNote,
  IconPause,
  IconPlay,
  IconPrev,
  IconQueue,
  IconShuffle,
  IconSpinner,
  IconSwap,
  IconTrend,
  IconVideo,
} from "./MusicIcons";
import "../styles/music.css";

// -----------------------------------------------------------------------------
// The music player: YouTube's official embedded player (IFrame Player API),
// mounted ONCE at the root of the app so the music keeps playing across tabs
// and across the desktop / phone layouts. Only its frame changes:
//
//   open    the full panel: cover (or video), controls, favourites, search
//   mini    small, in a corner: a slim bar with the cover (music only), or
//           the 200 × 200 video (video mode)
//   closed  stopped and out of sight
//   tab     the desktop Music tab is on screen and shows the controls itself;
//           in video mode the video is placed inside the tab (setDockRect)
//
// Music only (the default) keeps the YouTube frame on the page but out of
// sight. YouTube's embedding rules ask for a visible player of at least
// 200 × 200 px, which is what Video mode shows.
//
// This file makes the frame and forwards YouTube's events; what to play and
// when is decided by the engine in lib/music.ts. Each piece of the UI below
// reads only the part of the state it shows, so the time ticking re-renders
// the seek bar alone.
// -----------------------------------------------------------------------------

interface YTPlayer extends YtLike {
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLIFrameElement, opts: { events?: Record<string, (e: { data: number }) => void> }) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_URL = "https://www.youtube.com/iframe_api";
const API_TIMEOUT_MS = 12000;
/** A player whose onReady has not come by then is dropped (blocked embed, wall, broken frame): Retry makes a new one. */
const READY_TIMEOUT_MS = 15000;

let apiPromise: Promise<YTNamespace> | null = null;
/** YouTube's IFrame API script, once. A failure or a timeout can be retried. */
function loadApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    const s = document.createElement("script");
    const fail = () => {
      clearTimeout(timer);
      apiPromise = null;
      window.onYouTubeIframeAPIReady = prev;
      s.remove();
      reject(new Error("YouTube could not be reached"));
    };
    const timer = setTimeout(fail, API_TIMEOUT_MS);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      prev?.();
      resolve(window.YT!);
    };
    s.src = API_URL;
    s.async = true;
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return apiPromise;
}

/** The player itself. Render once, at the app's root. */
export function MusicPlayer({ mobile }: { mobile: boolean }) {
  const { t } = useT();
  const view = useMusicSel((s) => s.view);
  const mode = useMusicSel((s) => s.mode);
  const tab = useMusicSel((s) => s.tab);
  const docked = useMusicSel((s) => s.docked);
  const side = useMusicSel((s) => s.side);
  const failed = useMusicSel((s) => s.failed);
  const premium = useMusicSel((s) => s.premium);
  const rebuild = useMusicSel((s) => s.rebuild);
  // YouTube refused a start from the app (a phone's rule, a wall in its frame):
  // its frame is shown, tappable, until the music plays.
  const needsTap = useMusicSel((s) => s.needsTap);
  // Made the first time it is needed: a panel or the tab opened, something
  // played, or a music control about to be used (music.warm).
  const wanted = useMusicSel((s) => s.view !== "closed" || s.tab || s.warm || !!s.source);
  // Spotify mode: YouTube's frame is hidden entirely (never seen or heard) and not even made until YouTube is back.
  const sp = useMusicSel((s) => s.engine === "spotify");
  const auth = useSpotifyAuth();
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const creating = useRef(false);
  const mounted = useRef(true);
  const builtFor = useRef(premium);
  const builtRebuild = useRef(rebuild);
  const [ready, setReady] = useState(false);

  // The engine's own messages follow the UI language.
  useEffect(() => setMusicTranslator(t), [t]);

  useEffect(() => {
    mounted.current = true;
    registerDockTarget(root.current);
    return () => {
      mounted.current = false;
      registerDockTarget(null);
      detachPlayer();
      try {
        player.current?.destroy();
      } catch {
        /* already gone */
      }
      player.current = null;
    };
  }, []);

  // Music was played earlier in this session: get YouTube ready while idle.
  useEffect(() => {
    if (!musicUsedThisSession()) return;
    const w = window as Window & { requestIdleCallback?: (f: () => void) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => music.warm());
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => music.warm(), 2000);
    return () => clearTimeout(id);
  }, []);

  /** Make the frame and the player (one at a time: never two frames). */
  const build = (YT: YTNamespace) => {
    const box = host.current;
    if (!mounted.current || !box || player.current || box.querySelector("iframe")) {
      creating.current = false;
      return;
    }
    // The frame is made here, not by the API, for one attribute: since 2025
    // YouTube refuses to play an embed whose page sends no referrer ("Error
    // 153"), and this site sends none (netlify.toml). So this one frame tells
    // YouTube the site's address (origin only, no path); every other request
    // still sends nothing.
    const frame = document.createElement("iframe");
    const vars = new URLSearchParams({
      enablejsapi: "1",
      origin: window.location.origin,
      playsinline: "1",
      rel: "0",
      controls: "1",
      fs: "0",
      iv_load_policy: "3",
    });
    // youtube-nocookie keeps YouTube's cookies out (more private), but that
    // also leaves out a YouTube Premium login, so Premium members would still
    // see ads. "Ho YouTube Premium" switches to youtube.com, where their login
    // (and so no ads) applies.
    const premiumNow = builtFor.current;
    const ytHost = premiumNow ? "www.youtube.com" : "www.youtube-nocookie.com";
    frame.src = `https://${ytHost}/embed/?${vars}`;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow = "autoplay; encrypted-media; picture-in-picture";
    frame.title = "YouTube";
    box.appendChild(frame);
    const r = frame.getBoundingClientRect();
    mlog("creating the YouTube player", { host: ytHost, w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(root.current ?? box).display });
    const t0 = performance.now();
    // No onReady in time: drop this player, so the spinner stops and Retry
    // (music.retry clears `failed`, the effect below runs create again) makes a new one.
    const readyTimer = setTimeout(() => {
      if (player.current !== p || !mounted.current) return;
      mlog("player made but never ready: dropped, Retry shown", { ms: Math.round(performance.now() - t0) }, "warn");
      player.current = null;
      creating.current = false;
      try {
        p.destroy();
      } catch {
        /* already gone */
      }
      host.current?.querySelectorAll("iframe").forEach((f) => f.remove());
      setReady(false);
      setMusic({ failed: "player" });
    }, READY_TIMEOUT_MS);
    const p: YTPlayer = new YT.Player(frame, {
      events: {
        onReady: () => {
          clearTimeout(readyTimer);
          if (player.current !== p) return;
          mlog("player ready", { ms: Math.round(performance.now() - t0) });
          setReady(true);
          attachPlayer(p);
        },
        onStateChange: (e) => {
          if (player.current === p) onYtState(e.data);
        },
        onError: (e) => {
          if (player.current === p) onYtError(e.data);
        },
      },
    });
    // Kept at once (not on ready), so a quick close and reopen cannot make a second one.
    player.current = p;
    creating.current = false;
  };

  const create = () => {
    if (creating.current || player.current || host.current?.querySelector("iframe")) return;
    creating.current = true;
    loadApi()
      .then(build)
      .catch(() => {
        creating.current = false;
        mlog("YouTube's player script could not be loaded (ad-blocker, network?)", undefined, "warn");
        if (mounted.current) setMusic({ failed: "api", playing: false, status: "idle" });
      });
  };

  useEffect(() => {
    if (wanted && !failed && !sp) create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, failed, sp]);

  // "Spotify" was chosen before signing in: once the sign-in is back, switch.
  // Signed out (Esci, a refused refresh) while in Spotify mode: back to YouTube.
  useEffect(() => {
    if (auth.status === "in" && takeEnginePending()) {
      mlog("signed in to Spotify after choosing Spotify mode: switching now");
      music.setEngine("spotify");
    } else if (auth.status === "out" && sp) {
      // Like a failure: back to YouTube PAUSED. YouTube never carries on Spotify's queue by itself.
      spotifyFailed("after signing out of Spotify");
      toast(t("music.sp.signedOut"), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  // Signed in and the music is in view (♪ panel, Music tab): Spotify's player object is made now, so the
  // first click on the switch or Play can activate it synchronously (phones, Safari).
  useEffect(() => {
    if (auth.status === "in" && spotifyLoginAvailable() && (view === "open" || tab || sp)) prepareSpotifyPlayer();
  }, [auth.status, view, tab, sp]);

  // "Ho YouTube Premium" changed (the other host), or the stall rescue asked
  // for a fresh player (a new frame, a new connection): the player is built
  // again; the engine puts the song, second and queue back when it is ready.
  useEffect(() => {
    if (builtFor.current === premium && builtRebuild.current === rebuild) return;
    if (builtRebuild.current !== rebuild) mlog("building a new YouTube player (stall rescue)");
    builtFor.current = premium;
    builtRebuild.current = rebuild;
    const p = player.current;
    if (!p) return; // not made yet: it will use the new host
    detachPlayer();
    player.current = null;
    setReady(false);
    try {
      p.destroy();
    } catch {
      /* already gone */
    }
    host.current?.querySelectorAll("iframe").forEach((f) => f.remove());
    create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [premium, rebuild]);

  const audio = mode === "audio" || sp;
  // On the Music tab the tab is the player: this one only hosts the frame
  // (and, in video mode, shows the video on the tab's slot).
  const inTab = tab && !mobile;

  // On the phone the page is told when the small player covers its bottom
  // (<html data-music="mini" | "mini-video" | "open">), so mobile.css can pad
  // the screens and the last card can be scrolled out from under it.
  // While YouTube's frame waits for a tap, the small player is as tall as in video mode.
  const tall = !audio || needsTap;
  useEffect(() => {
    if (!mobile) return;
    const html = document.documentElement;
    const v = view === "mini" ? (tall ? "mini-video" : "mini") : view === "open" ? "open" : "";
    if (v) html.dataset.music = v;
    else delete html.dataset.music;
    // ...and the toasts move to the top, off the frame (music.css).
    if (audio && needsTap && view === "mini") html.dataset.musicTap = "";
    else delete html.dataset.musicTap;
  }, [mobile, view, audio, tall, needsTap]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.music;
      delete document.documentElement.dataset.musicTap;
    },
    []
  );
  // Music only, but YouTube wants a tap: its frame is shown like in Video mode
  // (only classes change: the frame itself is never moved or re-created).
  const tap = audio && needsTap && !sp;
  useEffect(() => {
    if (tap) mlog("showing YouTube's frame for a tap", { view, inTab });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tap]);
  const isDocked = inTab && (!audio || tap) && docked;
  const cls = [
    "mp",
    inTab ? "mp--tab" : `mp--${view}`,
    `mp--${mobile ? "phone" : "desk"}`,
    `mp--${side}`,
    audio ? "mp--audio" : "mp--video",
    isDocked ? "mp--docked" : "",
    tap ? "mp--tap" : "",
    sp ? "mp--spotify" : "",
  ].join(" ");

  return (
    <div ref={root} className={cls} role="region" aria-label={t("music.title")} aria-hidden={!inTab && view === "closed"} data-ready={ready}>
      {mobile && view === "open" && <BackToMini />}
      {!inTab && view === "open" && <Head />}
      <div className="mp-video" ref={host} aria-hidden={sp || undefined} />
      {tap && !inTab && <TapHint />}
      {!inTab && audio && view === "open" && <BigCover />}
      {/* The song and its controls; on the phone they stay pinned while the rest scrolls.
          The seek bar is always there in the panel, so nothing moves when a song starts. */}
      {!inTab && (
        <div className="mp-deck">
          <Strip view={view} audio={audio} phone={mobile} />
          {view === "open" && <Progress />}
        </div>
      )}
      {!inTab && view === "open" && <MusicBrowser phone={mobile} />}
      <MenuHost />
      <MusicToast />
    </div>
  );
}

const MenuHost = memo(SongMenuHost);

/** Under YouTube's frame while it waits for a tap: "Tap the video to start the music". */
export function TapHint({ className = "mp-tapnote" }: { className?: string }) {
  const { t } = useT();
  return (
    <div className={className} role="status">
      <IconPlay size={14} />
      <span>{t("music.tapVideo")}</span>
    </div>
  );
}

function Head() {
  const { t } = useT();
  return (
    <div className="mp-head">
      <span className="mp-head__title">
        <IconNote size={17} /> <span className="mp-head__label">{t("music.title")}</span>
      </span>
      <ModeSwitch />
      <button className="mp-icon" onClick={music.minimize} aria-label={t("music.minimize")} title={t("music.minimize")}>
        <IconChevronDown size={18} />
      </button>
      <button className="mp-icon mp-icon--close" onClick={music.close} aria-label={t("music.close")} title={t("music.close")}>
        <IconClose size={17} />
      </button>
    </div>
  );
}

function BigCover() {
  const id = useMusicSel((s) => s.now?.id);
  const sp = useMusicSel((s) => s.engine === "spotify");
  return (
    <div className={`mp-cover${sp ? " mp-cover--sp" : ""}`}>
      {id ? (
        <NowCover big />
      ) : (
        <div className="mp-cover__ph">
          <IconNote size={44} />
        </div>
      )}
      <SpotifyCredit />
    </div>
  );
}

/**
 * The cover of the song playing: in Spotify mode Spotify's own album image
 * (its policy: Spotify content is always shown with its cover art), else
 * YouTube's picture.
 */
export function NowCover({ big, className }: { big?: boolean; className?: string }) {
  const id = useMusicSel((s) => s.now?.id);
  const spCover = useMusicSel((s) => (s.engine === "spotify" ? s.spNow?.cover ?? "" : null));
  if (spCover !== null) {
    // Nothing from Spotify yet (loading): a placeholder, never YouTube's picture for Spotify's song.
    return <Cover src={spCover || undefined} big={big} className={className} />;
  }
  return <Cover id={id} big={big} className={className} />;
}

/** "Song supplied by Spotify" + "Open in Spotify" for the song playing (Spotify mode only). */
export function SpotifyCredit({ compact }: { compact?: boolean }) {
  const { t } = useT();
  const sp = useMusicSel((s) => (s.engine === "spotify" ? s.spNow : null));
  const on = useMusicSel((s) => s.engine === "spotify");
  if (!on) return null;
  return (
    <div className={`mp-spcredit${compact ? " mp-spcredit--compact" : ""}`}>
      <span className="mp-spcredit__by" title={t("music.sp.by")}>
        <IconSpotifyMark size={14} />
        <span>{compact ? t("music.engineSp") : t("music.sp.by")}</span>
      </span>
      {sp?.url && (
        <a className="mp-spcredit__open" href={sp.url} target="_blank" rel="noopener noreferrer" title={sp.album ? `${sp.title} · ${sp.album}` : sp.title}>
          {t("music.sp.open")} <IconExternal size={12} />
        </a>
      )}
    </div>
  );
}

/**
 * The small player's attribution in Spotify mode: Spotify's mark, linking to
 * the song on Spotify (outside the open button: a link is never inside a button).
 */
function SpotifyMiniCredit() {
  const { t } = useT();
  const on = useMusicSel((s) => s.engine === "spotify");
  const sp = useMusicSel((s) => (s.engine === "spotify" ? s.spNow : null));
  if (!on) return null;
  const label = `${t("music.sp.by")} · ${t("music.sp.open")}`;
  if (!sp?.url) {
    return (
      <span className="mp-spmini" title={t("music.sp.by")} aria-label={t("music.sp.by")} role="img">
        <IconSpotifyMark size={16} />
      </span>
    );
  }
  return (
    <a className="mp-spmini mp-spmini--link" href={sp.url} target="_blank" rel="noopener noreferrer" title={`${label}: ${sp.title}`} aria-label={`${label}: ${sp.title}`}>
      <IconSpotifyMark size={16} />
    </a>
  );
}

/** A plain mark for "Spotify" next to the word (not Spotify's logo file): a disc with sound waves. */
export function IconSpotifyMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="mi" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M7.6 9.6c3-.9 6.1-.6 8.8.8M8.2 12.6c2.4-.6 4.8-.4 7 .7M8.8 15.4c1.8-.4 3.6-.2 5.2.5" />
    </svg>
  );
}

/**
 * YouTube | Spotify: who plays the queue. Pointing at Spotify gets its device
 * ready; the click pauses the other service first (never both at once).
 * Shown when the site has a Spotify Client ID (or Spotify mode is on).
 */
export function EngineSwitch() {
  const { t } = useT();
  const engine = useMusicSel((s) => s.engine);
  const busy = useMusicSel((s) => s.engine === "spotify" && s.playing && (s.status === "loading" || s.status === "buffering"));
  const auth = useSpotifyAuth();
  if (!spotifyLoginAvailable() && engine !== "spotify") return null;
  const signing = auth.status === "busy" && engine !== "spotify";
  return (
    <div className="mp-mode mp-engine" role="group" aria-label={t("music.engine")}>
      <button aria-pressed={engine === "youtube"} onClick={() => music.setEngine("youtube")} title={t("music.engineYtHint")}>
        <IconVideo size={14} /> {t("music.engineYt")}
      </button>
      <button
        aria-pressed={engine === "spotify"}
        aria-busy={busy || signing}
        onPointerDown={music.warmSpotify}
        onPointerEnter={music.warmSpotify}
        onClick={() => music.setEngine("spotify")}
        title={t("music.engineSpHint")}
      >
        {busy || signing ? <IconSpinner size={14} title={t("music.loading")} /> : <IconSpotifyMark size={14} />} {t("music.engineSp")}
      </button>
    </div>
  );
}

/**
 * The song and the controls, in the panel and in the small player. In the
 * small player the cover and title are one big button that opens the panel.
 * On the phone the small player has no Close (it is in the panel's header),
 * so a missed tap on Open cannot stop the music.
 */
function Strip({ view, audio, phone }: { view: string; audio: boolean; phone: boolean }) {
  const { t } = useT();
  const nowId = useMusicSel((s) => s.now?.id);
  const title = useMusicSel((s) => s.now?.title);
  const author = useMusicSel((s) => s.now?.author);
  const has = useMusicSel((s) => !!s.source);
  // While a list loads (its songs not known yet), its name stands in for the title.
  const label = useMusicSel((s) => sourceLabel(s.source, t));
  const side = useMusicSel((s) => s.side);
  const mini = view === "mini";
  const name = title || label || t("music.nothing");
  const info = (
    <>
      {audio && mini && <span className="mp-thumb">{nowId ? <NowCover /> : <IconNote size={18} />}</span>}
      <span className="mp-now">
        <span className="mp-now__title">{name}</span>
        {(view === "open" || audio) && author && <span className="mp-now__author">{author}</span>}
      </span>
    </>
  );
  return (
    <div className="mp-strip">
      {mini ? (
        <button className="mp-open" onClick={music.open} aria-label={`${name}. ${t("music.expand")}`}>
          {info}
        </button>
      ) : (
        info
      )}
      <div className="mp-controls">
        {mini && <SpotifyMiniCredit />}
        {view === "open" && (
          <button className="mp-icon" onClick={music.prev} aria-label={t("music.prev")} disabled={!has}>
            <IconPrev size={17} />
          </button>
        )}
        <PlayButton className="mp-icon mp-icon--main" size={17} />
        <button className="mp-icon" onClick={music.next} aria-label={t("music.next")} disabled={!has}>
          <IconNext size={17} />
        </button>
        {mini && (
          <>
            <button className="mp-icon" onClick={music.open} aria-label={t("music.expand")}>
              <IconExpand size={16} />
            </button>
            {!audio && (
              <button className="mp-icon" onClick={() => setMusic({ side: side === "right" ? "left" : "right" })} aria-label={t("music.side")}>
                <IconSwap size={16} />
              </button>
            )}
            {!phone && (
              <button className="mp-icon mp-icon--close" onClick={music.close} aria-label={t("music.close")}>
                <IconClose size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Play / pause: the icon flips on the click (the intent); a ring turns while
 * YouTube loads or buffers. Pausing works during the loading too.
 */
export function PlayButton({ className, size = 17 }: { className: string; size?: number }) {
  const { t } = useT();
  const playing = useMusicSel((s) => s.playing);
  const busy = useMusicSel((s) => s.playing && (s.status === "loading" || s.status === "buffering"));
  const has = useMusicSel((s) => !!s.source);
  return (
    <button className={`${className}${busy ? " is-busy" : ""}`} onClick={music.toggle} aria-label={playing ? t("music.pause") : t("music.play")} aria-busy={busy} disabled={!has}>
      {playing ? <IconPause size={size} /> : <IconPlay size={size} />}
      {busy && <IconSpinner className="mp-busy-ring" size={size + 24} title={t("music.loading")} />}
    </button>
  );
}

/** A song's picture; ♪ when there is none or it does not load. */
export function Cover({ id, src, big, className }: { id?: string; src?: string; big?: boolean; className?: string }) {
  const url = src || coverOf(id, big);
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  if (!url || bad)
    return (
      <span className={`mp-noimg ${className ?? ""}`}>
        <IconNote size={big ? 40 : 18} />
      </span>
    );
  return <img className={className} src={url} alt="" loading="lazy" onError={() => setBad(true)} />;
}

/** Video or music only. */
export function ModeSwitch() {
  const { t } = useT();
  const mode = useMusicSel((s) => s.mode);
  // Spotify mode has no video (YouTube's frame is hidden entirely).
  const sp = useMusicSel((s) => s.engine === "spotify");
  if (sp) return null;
  return (
    <div className="mp-mode" role="group" aria-label={t("music.mode")}>
      <button aria-pressed={mode === "audio"} onClick={() => music.setMode("audio")}>
        <IconNote size={14} /> {t("music.audioOnly")}
      </button>
      <button aria-pressed={mode === "video"} onClick={() => music.setMode("video")}>
        <IconVideo size={14} /> {t("music.video")}
      </button>
    </div>
  );
}

/**
 * Time played, a seek bar, and the length. The only part that follows the
 * time. After a seek the engine holds the new position until YouTube reports it.
 */
export function Progress({ hideEmpty }: { hideEmpty?: boolean }) {
  const { t } = useT();
  const { time, duration } = useMusicTime();
  const has = useMusicSel((s) => !!s.source);
  const [drag, setDrag] = useState<number | null>(null);
  if (hideEmpty && !has) return null;
  const value = drag ?? time;
  const commit = () => {
    if (drag !== null) music.seek(drag);
    setDrag(null);
  };
  return (
    <div className="mp-progress">
      <span>{formatTime(value)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.floor(duration))}
        step={1}
        value={Math.floor(value)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label={t("music.seek")}
        aria-valuetext={t("music.timeOf", { a: formatTime(value), b: formatTime(duration) })}
        disabled={!has}
        style={{ ["--p" as string]: `${duration ? Math.min(100, (value / duration) * 100) : 0}%` }}
      />
      <span>{formatTime(duration)}</span>
    </div>
  );
}

/** On a phone, Back folds the full player into the small one. */
function BackToMini() {
  useBackClose(music.minimize);
  return null;
}

/**
 * Short messages ("Added to the queue", "can't play here") in their own pill,
 * never in place of the song title, plus "YouTube can't be reached · Retry".
 * Into <body>: the player itself may be hidden (aria-hidden) or closed.
 */
function MusicToast() {
  const { t } = useT();
  const toast = useMusicSel((s) => s.toast);
  const failed = useMusicSel((s) => s.failed);
  return createPortal(
    <div className="mp-toasts" role="status" aria-live="polite">
      {failed && (
        <div className="mp-toast mp-toast--error">
          <span>{t("music.failed")}</span>
          <button className="mp-toast__btn" onClick={music.retry}>
            {t("music.retry")}
          </button>
        </div>
      )}
      {toast && (
        <div key={toast.id} className={`mp-toast mp-toast--${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
    </div>,
    document.body
  );
}

/** What the phone's list sheet shows: a team playlist, or the queue. */
type ListView = { kind: "pl"; id: string } | { kind: "queue" };

/** Favourites, playlists, search and links: what to play. */
const MusicBrowser = memo(function MusicBrowser({ phone }: { phone: boolean }) {
  const { t } = useT();
  const srcKey = useMusicSel((s) => s.source?.key);
  const nowId = useMusicSel((s) => s.now?.id);
  const queued = useMusicSel((s) => s.queue.length);
  // Spotify mode: the mix and the artists' channels are YouTube lists (no song list to match).
  const sp = useMusicSel((s) => s.engine === "spotify");
  const { playlists, loaded } = usePlaylists();
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Track[] | null>(null);
  const [error, setError] = useState<MusicErrorCode | null>(null);
  const [link, setLink] = useState("");
  const [linkErr, setLinkErr] = useState(false);
  const [trendBusy, setTrendBusy] = useState(false);
  const [trendErr, setTrendErr] = useState(false);
  const [trendLabel, setTrendLabel] = useState(t("mt.trends"));
  const [sheet, setSheet] = useState<ListView | null>(null);
  const [typing, setTyping] = useState(false);
  const [sugg, setSugg] = useState<string[]>([]);
  const searchReq = useLastRequest();
  const suggReq = useLastRequest();
  const field = useRef<HTMLInputElement>(null);
  const found = useRef<HTMLDivElement>(null);
  // Official first (or YouTube's order, or most viewed), covers hidden if asked: at once, no new request.
  const sorted = useSortedResults(results, searched);

  // Suggestions while typing (the last request wins; a search drops them).
  useEffect(() => {
    const text = q.trim();
    if (!typing || text.length < 2) {
      suggReq.abort();
      setSugg([]);
      return;
    }
    const id = setTimeout(() => {
      const signal = suggReq.next();
      void fetchSuggestions(text, { signal }).then((list) => {
        if (!signal.aborted) setSugg(list.filter((x) => x !== text.toLowerCase()).slice(0, 5));
      });
    }, 220);
    return () => clearTimeout(id);
  }, [q, typing, suggReq]);

  const playTrends = async () => {
    setTrendBusy(true);
    setTrendErr(false);
    const r = await fetchExplore();
    setTrendBusy(false);
    const sec = "sections" in r ? r.sections?.[0] : undefined;
    if (!sec) return setTrendErr(true);
    setTrendLabel(sec.title);
    music.play({ kind: "videos", label: sec.title, key: "trends", tracks: sec.tracks, start: 0 });
  };

  const search = async (raw: string = q) => {
    const text = raw.trim();
    if (!text) return;
    suggReq.abort();
    setSugg([]);
    // On the phone the keyboard goes away, so the results can be seen.
    if (phone) field.current?.blur();
    // The last search wins: an older answer arriving late is dropped.
    const signal = searchReq.next();
    setBusy(true);
    setError(null);
    const r = await searchMusic(text, { signal });
    if (signal.aborted) return;
    setBusy(false);
    setSearched(text);
    if ("tracks" in r) setResults(r.tracks);
    else setError(r.error);
    // ...and the panel scrolls to them (below the pinned controls, see music.css).
    if (phone) requestAnimationFrame(() => found.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const pick = (text: string) => {
    setQ(text);
    void search(text);
  };

  const playLink = () => {
    const p = parseYouTube(link);
    if (!p) return setLinkErr(true);
    setLinkErr(false);
    if (p.list) music.play({ kind: "list", label: t("music.link"), list: p.list, video: p.video });
    else music.play({ kind: "videos", label: t("music.link"), key: `video:${p.video}`, tracks: [{ id: p.video!, title: "", channel: "" }], start: 0 });
    setLink("");
  };

  return (
    <div className="mp-body">
      {/* YouTube | Spotify: its own row (the header has no room on a phone or in the 400 px panel). */}
      {spotifyLoginAvailable() || sp ? (
        <div className="mp-enginerow">
          <span className="mp-enginerow__label">{t("music.engine")}</span>
          <EngineSwitch />
        </div>
      ) : null}
      <button className={`mp-mix${srcKey === "trends" ? " is-on" : ""}`} onClick={() => void playTrends()} disabled={trendBusy} aria-busy={trendBusy}>
        <span className="mp-mix__icon">{trendBusy ? <IconSpinner size={20} title={t("music.loading")} /> : <IconTrend size={20} />}</span>
        <span>
          <b>{trendLabel}</b>
          <small>{trendErr ? t("music.trendErr") : t("music.trendHint")}</small>
        </span>
      </button>

      {/* The phone has no Music tab: the queue opens in a sheet. Always there, so nothing moves. */}
      {phone && (
        <button className="mp-qbtn" onClick={() => setSheet({ kind: "queue" })} disabled={!queued}>
          <IconQueue size={18} />
          <span>{t("music.queue")}</span>
          <small>{queued ? t("music.songs", { n: queued }) : t("music.queueEmpty")}</small>
        </button>
      )}

      {/* The row is kept while the playlists load (no jump under the finger). */}
      <div className="mp-label">{t("music.playlists")}</div>
      {!loaded ? (
        <div className="mp-chips" aria-busy="true">
          <span className="mp-chip mp-chip--ph" />
          <span className="mp-chip mp-chip--ph" />
          <span className="mp-chip mp-chip--ph" />
        </div>
      ) : playlists.length === 0 ? (
        <div className="mp-chips">
          <div className="mp-note mp-note--slot">{t("music.noPlaylists")}</div>
        </div>
      ) : (
        <div className="mp-chips">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              className={`mp-chip${srcKey === `pl:${pl.id}` ? " is-on" : ""}`}
              disabled={!phone && pl.tracks.length === 0}
              title={pl.name}
              // On the phone a playlist opens to its songs; in the desktop panel it plays.
              onClick={() =>
                phone ? setSheet({ kind: "pl", id: pl.id }) : music.play({ kind: "videos", label: pl.name, key: `pl:${pl.id}`, tracks: pl.tracks, start: 0 })
              }
            >
              <span className="mp-chip__name">{pl.name}</span>
              <span className="mp-chip__n"> · {pl.tracks.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mp-label">{t("music.searchTitle")}</div>
      <form
        className="mp-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          ref={field}
          className="mp-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={t("music.searchPh")}
          enterKeyHint="search"
          aria-label={t("music.searchTitle")}
          autoComplete="off"
        />
        <button className="mp-btn" type="submit" disabled={busy || !q.trim()} aria-busy={busy} aria-label={t("music.search")}>
          {busy ? <IconSpinner size={18} /> : t("music.search")}
        </button>
      </form>
      {sugg.length > 0 && (
        <div className="mp-sugg" role="group" aria-label={t("music.suggestions")}>
          {sugg.map((s) => (
            // pointerdown keeps the focus in the field, so the list is still there for the click.
            <button key={s} type="button" className="mp-sugg__item" onPointerDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div ref={found} className="mp-found">
        {error && <SearchError error={error} q={searched || q} onRetry={() => void search(searched || q)} />}
        {results && (
          <div className="mp-results">
            {results.length === 0 && <div className="mp-note">{t("music.noResults")}</div>}
            {sortable(results) && <SortBar id="panel" res={sorted} compact />}
            {/* Play and the queue follow the order shown. */}
            {sorted.shown.map((tr, i) => (
              <SongRow
                key={`${tr.id}:${i}`}
                tr={tr}
                i={i}
                tracks={sorted.shown}
                label={searched}
                srcKey={`search:${searched}`}
                on={nowId === tr.id}
                mark={tr.kind ? (tr.id === sorted.primary ? "primary" : "kind") : undefined}
              />
            ))}
            <HiddenNote res={sorted} className="mp-note" />
          </div>
        )}
      </div>

      <div className="mp-label">{t("music.linkTitle")}</div>
      <div className="mp-row">
        <input
          className="mp-input"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setLinkErr(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && playLink()}
          placeholder={t("music.linkPh")}
          aria-label={t("music.linkTitle")}
        />
        <button className="mp-btn" onClick={playLink} disabled={!link.trim()}>
          {t("music.play")}
        </button>
      </div>
      {linkErr && <div className="mp-note">{t("music.badLink")}</div>}

      <div className="mp-label">{t("mt.teamArtists")}</div>
      <div className="mp-chips">
        <button
          className={`mp-chip${srcKey === "mix" ? " is-on" : ""}`}
          aria-pressed={srcKey === "mix"}
          disabled={sp}
          title={sp ? t("music.sp.radioHint") : undefined}
          onClick={() => music.play({ kind: "mix" })}
        >
          {t("music.mix")}
        </button>
        {ARTISTS.map((a) => (
          <button
            key={a.name}
            className={`mp-chip${srcKey === `artist:${a.name}` ? " is-on" : ""}`}
            aria-pressed={srcKey === `artist:${a.name}`}
            disabled={sp}
            title={sp ? t("music.sp.radioHint") : undefined}
            onClick={() => music.play({ kind: "artist", artist: a.name })}
          >
            {a.name}
          </button>
        ))}
      </div>

      <PremiumToggle />
      <p className="mp-fine">{t("music.adsNote")}</p>

      {sheet && <ListSheet view={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
});

/**
 * One song in a list (search results, a playlist, the queue): a tap plays it
 * in its list, "⋯" (or a long press) opens the song menu. Re-renders only when
 * it starts or stops being the song playing.
 */
const SongRow = memo(function SongRow({
  tr,
  i,
  tracks,
  label,
  srcKey,
  on,
  queue,
  playlistId,
  mark,
}: {
  tr: Track;
  i: number;
  tracks: Track[];
  label: string;
  srcKey: string;
  on: boolean;
  /** A row of the queue itself: a tap jumps there instead of starting a new list. */
  queue?: boolean;
  playlistId?: string;
  /** Search results: show what it is (Ufficiale, Live, Cover…) before the channel; "primary" = the first official one. */
  mark?: "kind" | "primary";
}) {
  const { t } = useT();
  // A queue row: "Riproduci" in its menu jumps there (keeps the queue).
  const ctx = queue ? { queueIndex: i } : { list: { tracks, label, index: i, key: srcKey || undefined }, playlistId };
  return (
    <div className={`mp-result${on ? " is-on" : ""}`}>
      <button
        className="mp-result__main"
        onClick={() => (queue ? music.playAt(i) : music.play({ kind: "videos", label, key: srcKey, tracks, start: i }))}
        aria-current={on || undefined}
        {...songMenuProps(tr, ctx)}
      >
        <Cover id={tr.id} src={tr.thumb} className="mp-result__img" />
        <span className="mp-result__text">
          <b>{tr.title}</b>
          <small>
            {mark && <KindBadge tr={tr} primary={mark === "primary"} />}
            {tr.channel}
          </small>
        </span>
      </button>
      <button className="mp-result__more" aria-label={t("sm.more")} title={t("sm.more")} aria-haspopup="menu" onClick={(e) => openSongMenu(tr, ctx, e.currentTarget)}>
        <IconMore size={18} />
      </button>
    </div>
  );
});

/**
 * The phone's song list for a team playlist (Play / Shuffle, pick a song, ⋯ to
 * remove or add elsewhere) or for the queue. A sheet over the panel with its
 * own Back entry: Back closes it before folding the player.
 */
function ListSheet({ view, onClose }: { view: ListView; onClose: () => void }) {
  const { t } = useT();
  useBackClose(onClose);
  const pl = usePlaylist(view.kind === "pl" ? view.id : null);
  const queue = useMusicSel((s) => s.queue);
  const index = useMusicSel((s) => s.index);
  const srcKey = useMusicSel((s) => s.source?.key);
  const nowId = useMusicSel((s) => s.now?.id);
  const back = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const isQueue = view.kind === "queue";
  const tracks = isQueue ? queue : pl?.tracks ?? [];
  const key = pl ? `pl:${pl.id}` : "";
  const title = isQueue ? t("music.queue") : pl?.name ?? "";

  useEffect(() => {
    back.current?.focus({ preventScroll: true });
    // The queue opens on the song playing.
    if (isQueue) list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The playlist was deleted meanwhile: nothing to show.
  useEffect(() => {
    if (!isQueue && !pl) onClose();
  }, [isQueue, pl, onClose]);

  const playAll = (shuffle: boolean) => {
    if (!pl || !pl.tracks.length) return;
    music.setShuffle(shuffle);
    music.play({ kind: "videos", label: pl.name, key, tracks: pl.tracks, start: shuffle ? Math.floor(Math.random() * pl.tracks.length) : 0 });
  };

  return (
    <div className="mp-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="mp-sheet__head">
        <button ref={back} className="mp-icon" onClick={onClose} aria-label={t("music.back")}>
          <IconBack size={18} />
        </button>
        <span className="mp-sheet__title">
          <b>{title}</b>
          <small>{isQueue ? t("music.queueHint") : t("music.songs", { n: tracks.length })}</small>
        </span>
      </div>
      {!isQueue && (
        <div className="mp-sheet__actions">
          <button className="mp-btn" onClick={() => playAll(false)} disabled={!tracks.length}>
            <IconPlay size={16} /> {t("music.play")}
          </button>
          <button className="mp-btn mp-btn--ghost" onClick={() => playAll(true)} disabled={tracks.length < 2}>
            <IconShuffle size={16} /> {t("music.shuffle")}
          </button>
        </div>
      )}
      <div ref={list} className="mp-results">
        {!tracks.length && <div className="mp-note">{isQueue ? t("music.queueEmpty") : t("music.plEmpty")}</div>}
        {tracks.map((tr, i) => (
          <SongRow
            key={`${tr.id}:${i}`}
            tr={tr}
            i={i}
            tracks={tracks}
            label={title}
            srcKey={key}
            queue={isQueue}
            playlistId={pl?.id}
            on={isQueue ? i === index : srcKey === key && nowId === tr.id}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * "Ho YouTube Premium": the player comes from youtube.com, so a Premium login
 * in this browser removes the ads. Applied at once: the player is rebuilt and
 * picks up the same song, second and queue.
 */
export function PremiumToggle() {
  const { t } = useT();
  const on = useMusicSel((s) => s.premium);
  return (
    <div className="mp-premium">
      <label>
        <input type="checkbox" checked={on} onChange={(e) => music.setPremium(e.target.checked)} />
        <span>
          <b>{t("music.premium")}</b>
          <small>
            {t("music.premiumHint")} {t("music.premiumCookies")}
          </small>
        </span>
      </label>
    </div>
  );
}

/**
 * What went wrong with a search, in words (never a raw code), with Riprova
 * when a retry is given and YouTube's own search as a way out.
 */
export function SearchError({ error, q, onRetry }: { error: string; q: string; onRetry?: () => void }) {
  const { t } = useT();
  if (error === "aborted") return null;
  return (
    <div className="mp-note mp-note--error">
      {musicErrorText(error, t)}{" "}
      {onRetry && (
        <button
          type="button"
          className="mp-retry"
          onClick={() => {
            forgetMusicFailures();
            onRetry();
          }}
        >
          {t("music.retry")}
        </button>
      )}{" "}
      {q.trim() && (
        <a href={youtubeSearchUrl(q)} target="_blank" rel="noopener noreferrer">
          {t("music.openYt")} <IconExternal size={13} />
        </a>
      )}
    </div>
  );
}

/** The header button (desktop) that opens or folds the player. Pointing at it gets YouTube ready. */
export function MusicButton() {
  const { t } = useT();
  const view = useMusicSel((s) => s.view);
  return (
    <button
      onClick={() => (view === "open" ? music.minimize() : music.open())}
      onPointerEnter={music.warm}
      onPointerDown={music.warm}
      onFocus={music.warm}
      aria-pressed={view !== "closed"}
      title={t("music.title")}
      aria-label={t("music.title")}
      className={`h-9 w-9 rounded-full border text-[15px] leading-none flex items-center justify-center transition-colors ${
        view !== "closed" ? "bg-[#C9A96E] text-[#0A1931] border-[#C9A96E]" : "bg-transparent text-white border-white/35 hover:border-[#C9A96E]"
      }`}
    >
      <IconNote size={17} />
    </button>
  );
}
