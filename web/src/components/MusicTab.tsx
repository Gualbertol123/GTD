import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import {
  ARTISTS,
  coverOf,
  fetchCharts,
  fetchExplore,
  fetchMusicArtist,
  fetchSuggestions,
  fetchYtPlaylist,
  fetchSpotify,
  findYtPlaylists,
  isSpotifyLink,
  matchSpotify,
  getMusic,
  music,
  playlistIdFrom,
  searchMusic,
  setMusic,
  useMusic,
  type Artist,
  type ChartArtist,
  type ChartList,
  type Track,
  type SpotifyList,
  type YtPlaylist,
} from "../lib/music";
import {
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  moveInPlaylist,
  removeFromPlaylist,
  renamePlaylist,
  usePlaylists,
  type Playlist,
} from "../lib/musicDb";
import { Cover, ModeSwitch, PremiumToggle, Progress, SearchError } from "./MusicPlayer";
import { songMenuProps } from "./SongMenu";
import {
  IconBack,
  IconBars,
  IconCheck,
  IconClose,
  IconDown,
  IconHome,
  IconImport,
  IconLink,
  IconMute,
  IconNext,
  IconNote,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrev,
  IconRepeat,
  IconSearch,
  IconShuffle,
  IconTrend,
  IconUp,
  IconVolume,
} from "./MusicIcons";
import "../styles/musicTab.css";

// -----------------------------------------------------------------------------
// The MUSIC tab (desktop): a full music app around the same player.
//
//   sidebar   Home, Search, the favourite artists, the team's playlists
//   main      Home · Search · an artist · a playlist
//   right     what is playing (cover, or the video in Video mode) and the queue
//   bottom    the player bar: song, controls, seek bar, music/video, volume
//
// The YouTube player itself stays in MusicPlayer (mounted once at the root);
// this tab drives it through lib/music and, in Video mode, gives it a slot
// (state.dock) to sit in.
// -----------------------------------------------------------------------------

type View =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "import" }
  | { kind: "spotify"; url?: string }
  | { kind: "yt"; list: string }
  | { kind: "artist"; name: string }
  | { kind: "martist"; id: string; name: string }
  | { kind: "playlist"; id: string };

// The page you were on, kept while you visit other tabs (until a reload).
let lastView: View = { kind: "home" };

export function MusicTab() {
  const { t } = useT();
  const [view, setViewState] = useState<View>(lastView);
  const setView = (v: View) => {
    lastView = v;
    setViewState(v);
  };
  const { playlists, available } = usePlaylists();
  const { me } = useMe();

  // While the tab is on screen it is the player's face.
  useEffect(() => {
    setMusic({ tab: true });
    return () => {
      // Leaving the tab with music on: it carries on in the small player.
      const cur = getMusic();
      setMusic({ tab: false, dock: null, view: cur.source ? "mini" : "closed" });
    };
  }, []);

  const newPlaylist = async () => {
    const name = window.prompt(t("mt.newName"), t("mt.newDefault"));
    if (!name?.trim()) return;
    const p = await createPlaylist(name, me);
    setView({ kind: "playlist", id: p.id });
  };

  return (
    <div className="mt">
      <aside className="mt-side">
        <nav className="mt-box">
          <button className={`mt-nav${view.kind === "home" ? " is-on" : ""}`} onClick={() => setView({ kind: "home" })}>
            <IconHome size={22} /> {t("mt.home")}
          </button>
          <button className={`mt-nav${view.kind === "search" ? " is-on" : ""}`} onClick={() => setView({ kind: "search" })}>
            <IconSearch size={22} /> {t("mt.search")}
          </button>
          <button
            className={`mt-nav${view.kind === "import" || view.kind === "yt" || view.kind === "spotify" ? " is-on" : ""}`}
            onClick={() => setView({ kind: "import" })}
          >
            <IconImport size={22} /> {t("mt.import")}
          </button>
        </nav>
        <div className="mt-box mt-lib">
          <div className="mt-lib__head">
            <span>{t("mt.library")}</span>
            <button className="mt-round" onClick={newPlaylist} title={t("mt.create")} aria-label={t("mt.create")} disabled={!available}>
              +
            </button>
          </div>
          <div className="mt-lib__list">
            {playlists.map((p) => (
              <button
                key={p.id}
                className={`mt-libitem${view.kind === "playlist" && view.id === p.id ? " is-on" : ""}`}
                onClick={() => setView({ kind: "playlist", id: p.id })}
              >
                <Mosaic tracks={p.tracks} size={44} />
                <span>
                  <b>{p.name}</b>
                  <small>
                    {t("mt.playlist")} · {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
                  </small>
                </span>
              </button>
            ))}
            {available && playlists.length === 0 && (
              <p className="mt-hint">
                {t("mt.libEmpty")}{" "}
                <button className="mt-link" onClick={() => setView({ kind: "import" })}>
                  {t("mt.import")} →
                </button>
              </p>
            )}
            {!available && <p className="mt-hint">{t("mt.needMigration")}</p>}
          </div>
        </div>
      </aside>

      <main className="mt-main">
        {view.kind === "home" && <Home go={setView} playlists={playlists} />}
        {view.kind === "search" && <Search playlists={playlists} />}
        {view.kind === "import" && <ImportPage go={setView} />}
        {view.kind === "spotify" && <SpotifyPage key={view.url ?? ""} initial={view.url} playlists={playlists} available={available} go={setView} />}
        {view.kind === "yt" && (
          <YtPlaylistPage key={view.list} list={view.list} playlists={playlists} available={available} go={setView} />
        )}
        {view.kind === "martist" && <MusicArtistPage key={view.id} id={view.id} name={view.name} playlists={playlists} />}
        {view.kind === "artist" && <ArtistPage artist={ARTISTS.find((a) => a.name === view.name)!} playlists={playlists} />}
        {view.kind === "playlist" && (
          <PlaylistPage
            playlist={playlists.find((p) => p.id === view.id)}
            playlists={playlists}
            onDeleted={() => setView({ kind: "home" })}
          />
        )}
      </main>

      <NowPlaying />
      <PlayerBar playlists={playlists} />
    </div>
  );
}

// ---- Bits -------------------------------------------------------------------

const GRADIENTS = [
  "linear-gradient(135deg,#5e5ce6,#bf5af2)",
  "linear-gradient(135deg,#0a84ff,#64d2ff)",
  "linear-gradient(135deg,#ff9f0a,#ff375f)",
  "linear-gradient(135deg,#30d158,#0a84ff)",
];
function gradientFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

function ArtistAvatar({ name, size }: { name: string; size: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  return (
    <span className="mt-avatar" style={{ width: size, height: size, background: gradientFor(name), fontSize: size * 0.36 }}>
      {initials}
    </span>
  );
}

/** A playlist's cover: its first four songs' pictures, or a note. */
function Mosaic({ tracks, size }: { tracks: Track[]; size: number }) {
  const pics = tracks.slice(0, 4).map((t) => coverOf(t.id));
  if (pics.length === 0) return <span className="mt-mosaic mt-mosaic--empty" style={{ width: size, height: size }}><IconNote size={Math.max(18, size * 0.36)} /></span>;
  if (pics.length < 4)
    return (
      <span className="mt-mosaic" style={{ width: size, height: size, display: "inline-grid" }}>
        <Cover src={pics[0]} className="mt-mosaic__one" />
      </span>
    );
  return (
    <span className="mt-mosaic mt-mosaic--grid" style={{ width: size, height: size }}>
      {pics.map((p, i) => (
        <Cover key={i} src={p} />
      ))}
    </span>
  );
}

function greeting(t: (k: string) => string) {
  const h = new Date().getHours();
  return h < 13 ? t("m.hello.morning") : h < 18 ? t("m.hello.afternoon") : t("m.hello.evening");
}

// ---- Home ---------------------------------------------------------------------

/** The countries offered for charts on the home ("ZZ" = the world). */
const COUNTRIES = ["IT", "ZZ", "ES", "US", "MX", "GB", "FR", "BR"];

function countryName(code: string, lang: string, world: string): string {
  if (code === "ZZ") return world;
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A section's data, loaded once per session (the answers are memoised in lib/music). */
function useLoad<T>(load: () => Promise<T | { error: string }>, deps: unknown[]): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null });
    void load().then((r) => {
      if (!alive) return;
      if (r && typeof r === "object" && "error" in (r as object)) setState({ data: null, error: (r as { error: string }).error });
      else setState({ data: r as T, error: null });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Home({ go, playlists }: { go: (v: View) => void; playlists: Playlist[] }) {
  const { t, lang } = useT();
  const st = useMusic();
  const [country, setCountry] = useState(() => (typeof window !== "undefined" && sessionStorage.getItem("gtd-music-country")) || "IT");
  const pickCountry = (c: string) => {
    setCountry(c);
    try {
      sessionStorage.setItem("gtd-music-country", c);
    } catch {
      /* fine */
    }
  };
  const explore = useLoad(fetchExplore, []);
  const charts = useLoad(() => fetchCharts(country), [country]);
  const trends = explore.data?.sections?.[0];
  const fresh = explore.data?.sections?.slice(1) ?? [];
  const trendLabel = trends?.title ?? t("mt.trends");
  const playingTrends = st.source?.kind === "videos" && st.source.label === trendLabel && st.playing;

  return (
    <div className="mt-page">
      <div className="mt-hero" style={{ background: "linear-gradient(180deg, rgba(94,92,230,.45), transparent)" }}>
        <h1>{greeting(t)}</h1>
        <p className="mt-hint" style={{ margin: "4px 0 0" }}>{t("mt.homeIntro")}</p>
      </div>

      <div className="mt-quick">
        <button
          className="mt-qtile"
          disabled={!trends}
          onClick={() => trends && (playingTrends ? music.toggle() : music.play({ kind: "videos", label: trendLabel, tracks: trends.tracks, start: 0 }))}
        >
          <span className="mt-qtile__art mt-glyph" style={{ background: "linear-gradient(135deg,#ff375f,#ff9f0a)" }}>
            <IconTrend size={28} />
          </span>
          <b>{trendLabel}</b>
          <PlayFab on={playingTrends} />
        </button>
        {charts.data?.lists?.slice(0, 2).map((l) => (
          <button key={l.list} className="mt-qtile" onClick={() => go({ kind: "yt", list: l.list })}>
            <Cover src={l.thumb} className="mt-qtile__img" />
            <b>{l.title}</b>
          </button>
        ))}
        {playlists.slice(0, 5).map((p) => (
          <button key={p.id} className="mt-qtile" onClick={() => go({ kind: "playlist", id: p.id })}>
            <Mosaic tracks={p.tracks} size={56} />
            <b>{p.name}</b>
          </button>
        ))}
      </div>

      {/* Trends: the songs, playable straight away. */}
      <div className="mt-h2row">
        <h2 className="mt-h2">{trendLabel}</h2>
        {trends && (
          <button className="mt-pill mt-pill--solid" onClick={() => music.play({ kind: "videos", label: trendLabel, tracks: trends.tracks, start: 0 })}>
            <IconPlay size={15} /> {t("mt.playAll")}
          </button>
        )}
      </div>
      {explore.error && <p className="mt-hint">{t("mt.homeErr")}</p>}
      {!trends && !explore.error && <div className="mt-spin mt-spin--block" />}
      {trends && <TrackGrid tracks={trends.tracks.slice(0, 12)} label={trendLabel} />}

      {/* Charts: country picker + the chart playlists + most listened artists. */}
      <div className="mt-h2row">
        <h2 className="mt-h2">{t("mt.charts")}</h2>
      </div>
      <div className="mt-chips" style={{ marginTop: 0 }}>
        {COUNTRIES.map((c) => (
          <button key={c} className={`mt-chip${country === c ? " is-on" : ""}`} onClick={() => pickCountry(c)}>
            {countryName(c, lang, t("mt.world"))}
          </button>
        ))}
      </div>
      {!charts.data && !charts.error && <div className="mt-spin mt-spin--block" />}
      {charts.error && <p className="mt-hint">{t("mt.homeErr")}</p>}
      {charts.data?.lists && <ChartCards lists={charts.data.lists} go={go} />}

      <h2 className="mt-h2">{t("mt.teamPlaylists")}</h2>
      {playlists.length === 0 ? (
        <p className="mt-hint">
          {t("mt.noPlaylists")}{" "}
          <button className="mt-link" onClick={() => go({ kind: "import" })}>
            {t("mt.importCta")}
          </button>
        </p>
      ) : (
        <div className="mt-cards">
          {playlists.map((p) => (
            <div key={p.id} className="mt-card" onClick={() => go({ kind: "playlist", id: p.id })} role="button" tabIndex={0}>
              <div className="mt-card__art">
                <Mosaic tracks={p.tracks} size={150} />
                {p.tracks.length > 0 && (
                  <button
                    className="mt-play mt-play--float"
                    aria-label={`${t("music.play")} ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      music.play({ kind: "videos", label: p.name, tracks: p.tracks, start: 0 });
                    }}
                  >
                    <IconPlay size={18} />
                  </button>
                )}
              </div>
              <b>{p.name}</b>
              <small>
                {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
              </small>
            </div>
          ))}
        </div>
      )}

      {charts.data?.artists && charts.data.artists.length > 0 && (
        <>
          <h2 className="mt-h2">
            {t("mt.topArtists")} · {countryName(country, lang, t("mt.world"))}
          </h2>
          <div className="mt-cards">
            {charts.data.artists.slice(0, 12).map((a) => (
              <ChartArtistCard key={a.id} artist={a} go={go} />
            ))}
          </div>
        </>
      )}

      {fresh.map((sec) => (
        <div key={sec.title}>
          <h2 className="mt-h2">{sec.title}</h2>
          <TrackCards tracks={sec.tracks.slice(0, 12)} label={sec.title} />
        </div>
      ))}

      <h2 className="mt-h2">{t("mt.teamArtists")}</h2>
      <div className="mt-chips" style={{ marginTop: 0 }}>
        <button className="mt-chip" onClick={() => music.play({ kind: "mix" })}>
          <IconPlay size={14} /> {t("music.mix")}
        </button>
        {ARTISTS.map((a) => (
          <button key={a.name} className="mt-chip" onClick={() => go({ kind: "artist", name: a.name })}>
            {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Songs as a compact two-column grid (number, cover, title), playable. */
function TrackGrid({ tracks, label }: { tracks: Track[]; label: string }) {
  const { t } = useT();
  const st = useMusic();
  return (
    <div className="mt-tgrid">
      {tracks.map((tr, i) => (
        <div key={tr.id} className={`mt-trow${st.now?.id === tr.id ? " is-on" : ""}`} {...songMenuProps(tr, { list: { tracks, label, index: i } })}>
          <span className="mt-trow__n">{i + 1}</span>
          <button className="mt-trow__main" onClick={() => music.play({ kind: "videos", label, tracks, start: i })} aria-label={`${t("music.play")} ${tr.title}`}>
            <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
            <span>
              <b>{tr.title}</b>
              <small>{tr.channel}</small>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** Songs as cards (cover, title, artist), playable. */
function TrackCards({ tracks, label }: { tracks: Track[]; label: string }) {
  const { t } = useT();
  return (
    <div className="mt-cards">
      {tracks.map((tr, i) => (
        <div
          key={tr.id}
          className="mt-card"
          onClick={() => music.play({ kind: "videos", label, tracks, start: i })}
          role="button"
          tabIndex={0}
          {...songMenuProps(tr, { list: { tracks, label, index: i } })}
        >
          <div className="mt-card__art mt-card__art--wide">
            <Cover id={tr.id} src={tr.thumb} className="mt-card__img" />
            <span className="mt-play mt-play--float" aria-label={`${t("music.play")} ${tr.title}`}>
              <IconPlay size={18} />
            </span>
          </div>
          <b title={tr.title}>{tr.title}</b>
          <small>{tr.channel}</small>
        </div>
      ))}
    </div>
  );
}

function ChartCards({ lists, go }: { lists: ChartList[]; go: (v: View) => void }) {
  return (
    <div className="mt-cards">
      {lists.map((l) => (
        <div key={l.list} className="mt-card" onClick={() => go({ kind: "yt", list: l.list })} role="button" tabIndex={0}>
          <div className="mt-card__art">
            <Cover src={l.thumb} className="mt-card__img" />
          </div>
          <b title={l.title}>{l.title}</b>
          <small>YouTube Music</small>
        </div>
      ))}
    </div>
  );
}

function ChartArtistCard({ artist, go }: { artist: ChartArtist; go: (v: View) => void }) {
  const { t } = useT();
  return (
    <div className="mt-card" onClick={() => go({ kind: "martist", id: artist.id, name: artist.name })} role="button" tabIndex={0}>
      <div className="mt-card__art mt-card__art--round">
        {artist.thumb ? <Cover src={artist.thumb} className="mt-card__img mt-card__img--round" /> : <ArtistAvatar name={artist.name} size={150} />}
      </div>
      <b>{artist.name}</b>
      <small>{t("mt.artist")}</small>
    </div>
  );
}

function PlayFab({ on }: { on: boolean }) {
  return <span className={`mt-play mt-play--tile${on ? " is-on" : ""}`}>{on ? <IconPause size={16} /> : <IconPlay size={16} />}</span>;
}

// ---- Search -------------------------------------------------------------------

function Search({ playlists }: { playlists: Playlist[] }) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const [sugs, setSugs] = useState<string[]>([]);
  const [showSugs, setShowSugs] = useState(false);
  // Suggestions while typing (free), a moment after the last key.
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return setSugs([]);
    const id = setTimeout(() => void fetchSuggestions(text).then(setSugs), 200);
    return () => clearTimeout(id);
  }, [q]);

  const run = async (words = q) => {
    setShowSugs(false);
    if (!words.trim()) return;
    setBusy(true);
    setError(null);
    const r = await searchMusic(words.trim());
    setBusy(false);
    if ("tracks" in r) setTracks(r.tracks);
    else setError(r.error);
  };

  return (
    <div className="mt-page">
      <form
        className="mt-search"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span aria-hidden="true" className="mt-search__icon"><IconSearch size={20} /></span>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShowSugs(true);
          }}
          onFocus={() => setShowSugs(true)}
          onBlur={() => setTimeout(() => setShowSugs(false), 150)}
          onKeyDown={(e) => e.key === "Escape" && setShowSugs(false)}
          placeholder={t("mt.searchPh")}
          aria-label={t("mt.search")}
          autoComplete="off"
        />
        {busy && <span className="mt-spin" aria-hidden="true" />}
        {showSugs && sugs.length > 0 && (
          <div className="mt-sugs" role="listbox">
            {sugs.map((sg) => (
              <button
                key={sg}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQ(sg);
                  void run(sg);
                }}
              >
                <IconSearch size={16} /> {sg}
              </button>
            ))}
          </div>
        )}
      </form>
      {error && <SearchError error={error} q={q} />}
      {tracks && (tracks.length ? <TrackTable tracks={tracks} label={q} playlists={playlists} /> : <p className="mt-hint">{t("music.noResults")}</p>)}
      {!tracks && !error && (
        <>
          <h2 className="mt-h2">{t("mt.browse")}</h2>
          <div className="mt-genres">
            {["Pop latino", "Cantautori italiani", "Reggaeton", "Ballate", "Anni 2000", "Flamenco pop", "Dance", "Acoustic"].map((g, i) => (
              <button
                key={g}
                className="mt-genre"
                style={{ background: GRADIENTS[i % GRADIENTS.length] }}
                onClick={() => {
                  setQ(g);
                  setBusy(true);
                  void searchMusic(g).then((r) => {
                    setBusy(false);
                    if ("tracks" in r) setTracks(r.tracks);
                    else setError(r.error);
                  });
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Import ------------------------------------------------------------------

/** Searches suggested on the Import page; the first three run on their own. */
const SUGGESTED = [
  "Enrique Iglesias greatest hits",
  "Ricky Martin greatest hits",
  "Tiziano Ferro best of",
  "Latin pop hits",
  "Hit italiane",
  "Reggaeton classics",
  "Ballate romantiche",
  "Pop anni 2000",
  "Musica per concentrarsi",
];

function ImportPage({ go }: { go: (v: View) => void }) {
  const { t } = useT();
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ title: string; lists: YtPlaylist[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<YtPlaylist[] | null>(null);

  // "For your artists": the top lists for each favourite, from the day's cache.
  useEffect(() => {
    let alive = true;
    void Promise.all(SUGGESTED.slice(0, 3).map((s) => findYtPlaylists(s, true))).then((rs) => {
      if (!alive) return;
      const err = rs.find((r): r is { error: string } => "error" in r);
      const lists = rs.flatMap((r) => ("lists" in r ? r.lists.slice(0, 4) : []));
      if (lists.length) setPicks(lists);
      else if (err) setError(err.error);
      else setPicks([]);
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = async (words: string) => {
    if (!words.trim()) return;
    setQ(words);
    setBusy(true);
    setError(null);
    const r = await findYtPlaylists(words.trim(), SUGGESTED.includes(words));
    setBusy(false);
    if ("lists" in r) setFound({ title: words.trim(), lists: r.lists });
    else setError(r.error);
  };

  return (
    <div className="mt-page">
      <div className="mt-hero" style={{ background: "linear-gradient(180deg, rgba(255,55,95,.4), transparent)" }}>
        <h1>{t("mt.import")}</h1>
        <p className="mt-hint" style={{ margin: "6px 0 0" }}>{t("mt.importIntro")}</p>
      </div>

      <button className="mt-spotify" onClick={() => go({ kind: "spotify" })}>
        <span className="mt-spotify__icon" aria-hidden="true">
          <IconImport size={22} />
        </span>
        <span>
          <b>{t("sp.button")}</b>
          <small>{t("sp.buttonHint")}</small>
        </span>
      </button>

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          if (isSpotifyLink(link)) return go({ kind: "spotify", url: link.trim() });
          const list = playlistIdFrom(link);
          if (!list) return setLinkError(true);
          setLinkError(false);
          go({ kind: "yt", list });
        }}
      >
        <span aria-hidden="true" className="mt-search__icon"><IconLink size={20} /></span>
        <input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setLinkError(false);
          }}
          placeholder={t("mt.linkPh")}
          aria-label={t("mt.linkPh")}
        />
        <button type="submit" className="mt-pill mt-pill--solid" disabled={!link.trim()}>
          {t("mt.open")}
        </button>
      </form>
      {linkError && <div className="mp-note">{t("mt.badLink")}</div>}

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <span aria-hidden="true" className="mt-search__icon"><IconSearch size={20} /></span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("mt.findPh")} aria-label={t("mt.findPh")} />
        {busy && <span className="mt-spin" aria-hidden="true" />}
      </form>
      <div className="mt-chips">
        {SUGGESTED.map((s) => (
          <button key={s} className={`mt-chip${found?.title === s ? " is-on" : ""}`} onClick={() => void run(s)}>
            {s}
          </button>
        ))}
      </div>

      {error && <SearchError error={error} q={q} />}

      {found && (
        <>
          <h2 className="mt-h2">{found.title}</h2>
          {found.lists.length ? <ListCards lists={found.lists} go={go} /> : <p className="mt-hint">{t("music.noResults")}</p>}
        </>
      )}

      <h2 className="mt-h2">{t("mt.forArtists")}</h2>
      {!picks && !error && <div className="mt-spin mt-spin--block" />}
      {picks && <ListCards lists={picks} go={go} />}
    </div>
  );
}

function ListCards({ lists, go }: { lists: YtPlaylist[]; go: (v: View) => void }) {
  return (
    <div className="mt-cards">
      {lists.map((l) => (
        <div key={l.list} className="mt-card" onClick={() => go({ kind: "yt", list: l.list })} role="button" tabIndex={0}>
          <div className="mt-card__art">
            <Cover src={l.thumb} className="mt-card__img" />
          </div>
          <b title={l.title}>{l.title}</b>
          <small>{l.channel || "YouTube"}</small>
        </div>
      ))}
    </div>
  );
}

/**
 * Importa da Spotify: paste a Spotify playlist or album link, the app reads
 * its songs, finds each one on YouTube (progress bar), then plays it or saves
 * it as a team playlist. Songs not found are listed.
 */
function SpotifyPage({
  initial,
  playlists,
  available,
  go,
}: {
  initial?: string;
  playlists: Playlist[];
  available: boolean;
  go: (v: View) => void;
}) {
  const { t } = useT();
  const { me } = useMe();
  const st = useMusic();
  const [link, setLink] = useState(initial ?? "");
  const [phase, setPhase] = useState<"idle" | "reading" | "matching" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<SpotifyList | null>(null);
  const [done, setDone] = useState(0);
  const [matches, setMatches] = useState<(Track | null)[]>([]);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  const start = async (url: string) => {
    if (!isSpotifyLink(url)) return setError("bad-link");
    setError(null);
    setList(null);
    setMatches([]);
    setDone(0);
    setPhase("reading");
    const r = await fetchSpotify(url);
    if (!alive.current) return;
    if ("error" in r) {
      setPhase("idle");
      return setError(r.error);
    }
    setList(r);
    setPhase("matching");
    const found = await matchSpotify(r.songs, (n) => alive.current && setDone(n), () => !alive.current);
    if (!alive.current) return;
    setMatches(found);
    setPhase("done");
  };

  // A link handed over from the Import page starts straight away.
  useEffect(() => {
    if (initial) void start(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tracks = matches.filter((m): m is Track => !!m);
  const missing = list ? list.songs.filter((_, i) => phase === "done" && !matches[i]) : [];
  const label = list?.name ?? "Spotify";
  const saved = list && playlists.find((p) => p.name === list.name && p.tracks[0]?.id === tracks[0]?.id);
  const playingThis = st.source?.kind === "videos" && st.source.label === label && st.playing;
  const errorText =
    error === "bad-link" ? t("sp.badLink") : error === "not-found" ? t("sp.notFound") : error === "no-functions" ? t("music.noKey") : error ? t("sp.failed") : null;

  return (
    <div className="mt-page">
      <button className="mt-link" onClick={() => go({ kind: "import" })}>
        <IconBack size={15} /> {t("mt.import")}
      </button>
      <div className="mt-hero mt-hero--artist mt-hero--spotify">
        {list?.cover ? <Cover src={list.cover} className="mt-hero__img" /> : <span className="mt-hero__img mt-spotify__big" aria-hidden="true"><IconImport size={56} /></span>}
        <div>
          <small>{list ? t(list.kind === "album" ? "sp.album" : "sp.playlist") : t("sp.button")}</small>
          <h1>{list?.name ?? t("sp.title")}</h1>
          <small>{list ? `${list.owner} · ${t("mt.songs").replace("{n}", String(list.songs.length))}` : t("sp.intro")}</small>
        </div>
      </div>

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          void start(link);
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconLink size={20} />
        </span>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t("sp.linkPh")} aria-label={t("sp.linkPh")} />
        <button type="submit" className="mt-pill mt-pill--solid" disabled={!link.trim() || phase === "reading" || phase === "matching"}>
          {t("sp.go")}
        </button>
      </form>
      {errorText && <div className="mp-note">{errorText}</div>}
      {phase === "idle" && !list && <p className="mt-hint">{t("sp.how")}</p>}

      {phase === "reading" && <div className="mt-spin mt-spin--block" />}
      {phase === "matching" && list && (
        <div className="mt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={list.songs.length} aria-valuenow={done}>
          <div className="mt-progress__label">{t("sp.matching").replace("{n}", String(done)).replace("{m}", String(list.songs.length))}</div>
          <div className="mt-progress__bar">
            <span style={{ width: `${list.songs.length ? (done / list.songs.length) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {phase === "done" && list && (
        <>
          <div className="mt-actions">
            <button
              className="mt-play mt-play--big"
              disabled={!tracks.length}
              aria-label={t("music.play")}
              onClick={() => (playingThis ? music.toggle() : music.play({ kind: "videos", label, tracks, start: 0 }))}
            >
              {playingThis ? <IconPause size={24} /> : <IconPlay size={24} />}
            </button>
            {saved ? (
              <button className="mt-pill" onClick={() => go({ kind: "playlist", id: saved.id })}>
                <IconCheck size={16} /> {t("mt.saved")}
              </button>
            ) : (
              <button
                className="mt-pill mt-pill--solid"
                disabled={!available || saving || !tracks.length}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const p = await createPlaylist(list.name, me, tracks);
                    go({ kind: "playlist", id: p.id });
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "…" : (
                  <>
                    <IconPlus size={16} /> {t("mt.saveTeam")}
                  </>
                )}
              </button>
            )}
            <span className="mt-hint">{t("sp.found").replace("{n}", String(tracks.length)).replace("{m}", String(list.songs.length))}</span>
          </div>
          {list.kind === "playlist" && list.songs.length >= 100 && <p className="mt-hint">{t("sp.first100")}</p>}
          {tracks.length > 0 && <TrackTable tracks={tracks} label={label} playlists={playlists} />}
          {missing.length > 0 && (
            <details className="mt-missing">
              <summary>{t("sp.missing").replace("{n}", String(missing.length))}</summary>
              <ul>
                {missing.map((s, i) => (
                  <li key={i}>
                    {s.artist} — {s.title}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** A YouTube playlist before it is saved: listen to it, or keep it for the team. */
function YtPlaylistPage({
  list,
  playlists,
  available,
  go,
}: {
  list: string;
  playlists: Playlist[];
  available: boolean;
  go: (v: View) => void;
}) {
  const { t } = useT();
  const { me } = useMe();
  const st = useMusic();
  const [data, setData] = useState<YtPlaylist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchYtPlaylist(list).then((r) => {
      if (!alive) return;
      if ("error" in r) setError(r.error);
      else setData(r);
    });
    return () => {
      alive = false;
    };
  }, [list]);

  if (error)
    return (
      <div className="mt-page">
        <button className="mt-link" onClick={() => go({ kind: "import" })}><IconBack size={15} /> {t("mt.import")}</button>
        <div style={{ height: 44 }} />
        {error === "not-found" ? <div className="mp-note">{t("mt.listNotFound")}</div> : <SearchError error={error} q="" />}
      </div>
    );
  if (!data) return <div className="mt-page"><div className="mt-spin mt-spin--block" /></div>;

  const tracks = data.tracks ?? [];
  const label = data.title;
  const saved = playlists.find((p) => p.name === data.title && p.tracks[0]?.id === tracks[0]?.id);
  const playingThis = st.source?.kind === "videos" && st.source.label === label && st.playing;

  const save = async () => {
    setSaving(true);
    try {
      const p = await createPlaylist(data.title, me, tracks);
      go({ kind: "playlist", id: p.id });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-page">
      <button className="mt-link" onClick={() => go({ kind: "import" })}><IconBack size={15} /> {t("mt.import")}</button>
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(data.title) }}>
        {data.thumb ? <Cover src={data.thumb} className="mt-hero__img" /> : <Mosaic tracks={tracks} size={160} />}
        <div>
          <small>{t("mt.ytPlaylist")}</small>
          <h1>{data.title}</h1>
          <small>
            {data.channel || "YouTube"} · {t("mt.songs").replace("{n}", String(tracks.length))}
            {data.total && data.total > tracks.length ? ` (${t("mt.ofTotal").replace("{n}", String(data.total))})` : ""}
          </small>
        </div>
      </div>
      <div className="mt-actions">
        <button
          className="mt-play mt-play--big"
          disabled={!tracks.length}
          aria-label={t("music.play")}
          onClick={() => (playingThis ? music.toggle() : music.play({ kind: "videos", label, tracks, start: 0 }))}
        >
          {playingThis ? <IconPause size={24} /> : <IconPlay size={24} />}
        </button>
        {saved ? (
          <button className="mt-pill" onClick={() => go({ kind: "playlist", id: saved.id })}>
            <IconCheck size={16} /> {t("mt.saved")}
          </button>
        ) : (
          <button className="mt-pill mt-pill--solid" disabled={!available || saving || !tracks.length} onClick={() => void save()}>
            {saving ? "…" : <><IconPlus size={16} /> {t("mt.saveTeam")}</>}
          </button>
        )}
        {!available && <span className="mt-hint">{t("mt.needMigration")}</span>}
      </div>
      {tracks.length ? <TrackTable tracks={tracks} label={label} playlists={playlists} /> : <p className="mt-hint">{t("mt.listEmpty")}</p>}
    </div>
  );
}

// ---- Artist ------------------------------------------------------------------

function ArtistPage({ artist, playlists }: { artist: Artist; playlists: Playlist[] }) {
  const { t } = useT();
  const st = useMusic();
  const [top, setTop] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setTop(null);
    setError(null);
    void searchMusic("", { channelId: artist.channel, order: "viewCount" }).then((r) => {
      if (!alive) return;
      if ("tracks" in r) setTop(r.tracks);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [artist.channel]);
  const playing = st.source?.kind === "artist" && st.source.artist === artist.name && st.playing;

  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: `${gradientFor(artist.name)}` }}>
        <ArtistAvatar name={artist.name} size={160} />
        <div>
          <small>{t("mt.artist")}</small>
          <h1>{artist.name}</h1>
        </div>
      </div>
      <div className="mt-actions">
        <button className="mt-play mt-play--big" onClick={() => (playing ? music.toggle() : music.play({ kind: "artist", artist: artist.name }))} aria-label={t("music.play")}>
          {playing ? <IconPause size={24} /> : <IconPlay size={24} />}
        </button>
        <span className="mt-hint">{t("mt.artistAll")}</span>
      </div>
      <h2 className="mt-h2">{t("mt.popular")}</h2>
      {error && <SearchError error={error} q={artist.name} />}
      {!top && !error && <div className="mt-spin mt-spin--block" />}
      {top && <TrackTable tracks={top.slice(0, 15)} label={artist.name} playlists={playlists} />}
    </div>
  );
}

/** Any YouTube Music artist (from the charts). */
function MusicArtistPage({ id, name, playlists }: { id: string; name: string; playlists: Playlist[] }) {
  const { t } = useT();
  const st = useMusic();
  const { data, error } = useLoad(() => fetchMusicArtist(id), [id]);
  const title = data?.name || name;
  const playing = st.source?.kind === "videos" && st.source.label === title && st.playing;
  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(title) }}>
        {data?.thumb ? <Cover src={data.thumb} className="mt-hero__img mt-hero__img--round" /> : <ArtistAvatar name={title} size={160} />}
        <div>
          <small>{t("mt.artist")}</small>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="mt-actions">
        <button
          className="mt-play mt-play--big"
          disabled={!data?.tracks?.length}
          aria-label={t("music.play")}
          onClick={() => data && (playing ? music.toggle() : music.play({ kind: "videos", label: title, tracks: data.tracks, start: 0 }))}
        >
          {playing ? <IconPause size={24} /> : <IconPlay size={24} />}
        </button>
      </div>
      {error && <p className="mt-hint">{t("mt.homeErr")}</p>}
      {!data && !error && <div className="mt-spin mt-spin--block" />}
      {data?.tracks && <TrackTable tracks={data.tracks} label={title} playlists={playlists} />}
    </div>
  );
}

// ---- Playlist ----------------------------------------------------------------

function PlaylistPage({ playlist, playlists, onDeleted }: { playlist?: Playlist; playlists: Playlist[]; onDeleted: () => void }) {
  const { t } = useT();
  const st = useMusic();
  const [confirm, setConfirm] = useState(false);
  if (!playlist) return <div className="mt-page"><p className="mt-hint">{t("mt.gone")}</p></div>;
  const p = playlist;
  const playingThis = st.source?.kind === "videos" && st.source.label === p.name;

  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(p.name) }}>
        <Mosaic tracks={p.tracks} size={160} />
        <div>
          <small>{t("mt.playlist")}</small>
          <h1
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            title={t("mt.rename")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLElement).blur();
              }
            }}
            onBlur={(e) => {
              const name = e.currentTarget.textContent?.trim() ?? "";
              if (name && name !== p.name) void renamePlaylist(p.id, name);
              else e.currentTarget.textContent = p.name;
            }}
          >
            {p.name}
          </h1>
          <p>
            {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
          </p>
        </div>
      </div>
      <div className="mt-actions">
        <button
          className="mt-play mt-play--big"
          disabled={!p.tracks.length}
          onClick={() => (playingThis ? music.toggle() : music.play({ kind: "videos", label: p.name, tracks: p.tracks, start: 0 }))}
          aria-label={t("music.play")}
        >
          {playingThis && st.playing ? <IconPause size={24} /> : <IconPlay size={24} />}
        </button>
        <button
          className={`mt-ghost${st.shuffle ? " is-on" : ""}`}
          onClick={() => music.setShuffle(!st.shuffle)}
          title={t("mt.shuffle")}
          aria-pressed={st.shuffle}
        >
          <IconShuffle size={16} /> {t("mt.shuffle")}
        </button>
        <span style={{ flex: 1 }} />
        {confirm ? (
          <>
            <span className="mt-hint">{t("mt.deleteQ")}</span>
            <button
              className="mt-ghost mt-ghost--danger"
              onClick={() => {
                void deletePlaylist(p.id);
                onDeleted();
              }}
            >
              {t("mt.delete")}
            </button>
            <button className="mt-ghost" onClick={() => setConfirm(false)}>
              {t("task.no")}
            </button>
          </>
        ) : (
          <button className="mt-ghost" onClick={() => setConfirm(true)}>
            {t("mt.delete")}
          </button>
        )}
      </div>
      {p.tracks.length === 0 ? (
        <p className="mt-hint">{t("mt.emptyPlaylist")}</p>
      ) : (
        <TrackTable tracks={p.tracks} label={p.name} playlists={playlists} inPlaylist={p} />
      )}
    </div>
  );
}

// ---- Track table ---------------------------------------------------------------

function TrackTable({ tracks, label, playlists, inPlaylist }: { tracks: Track[]; label: string; playlists: Playlist[]; inPlaylist?: Playlist }) {
  const { t } = useT();
  const st = useMusic();
  return (
    <div className="mt-table" role="table">
      <div className="mt-tr mt-tr--head" role="row">
        <span>#</span>
        <span>{t("mt.title")}</span>
        <span />
      </div>
      {tracks.map((tr, i) => {
        const on = st.now?.id === tr.id;
        return (
          <div
            key={tr.id + i}
            className={`mt-tr${on ? " is-on" : ""}`}
            role="row"
            tabIndex={0}
            onDoubleClick={() => music.play({ kind: "videos", label, tracks, start: i })}
            {...songMenuProps(tr, { list: { tracks, label, index: i }, playlistId: inPlaylist?.id })}
          >
            <span className="mt-tr__n">
              <span className="mt-tr__num">{on && st.playing ? <IconBars size={16} className="mi-eq" /> : i + 1}</span>
              <button className="mt-tr__play" onClick={() => music.play({ kind: "videos", label, tracks, start: i })} aria-label={`${t("music.play")} ${tr.title}`}>
                <IconPlay size={15} />
              </button>
            </span>
            <span className="mt-tr__title">
              <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
              <span>
                <b>{tr.title || tr.id}</b>
                <small>{tr.channel}</small>
              </span>
            </span>
            <span className="mt-tr__act">
              {inPlaylist && (
                <>
                  <button className="mt-iconbtn" title={t("mt.up")} aria-label={t("mt.up")} disabled={i === 0} onClick={() => void moveInPlaylist(inPlaylist.id, i, i - 1)}>
                    <IconUp size={16} />
                  </button>
                  <button className="mt-iconbtn" title={t("mt.down")} aria-label={t("mt.down")} disabled={i === tracks.length - 1} onClick={() => void moveInPlaylist(inPlaylist.id, i, i + 1)}>
                    <IconDown size={16} />
                  </button>
                  <button className="mt-iconbtn" title={t("mt.remove")} aria-label={t("mt.remove")} onClick={() => void removeFromPlaylist(inPlaylist.id, tr.id)}>
                    <IconClose size={16} />
                  </button>
                </>
              )}
              <AddToPlaylist track={tr} playlists={playlists} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** "+": add this song to a playlist, or to a new one. */
function AddToPlaylist({ track, playlists }: { track: Track; playlists: Playlist[] }) {
  const { t } = useT();
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className="mt-add" ref={ref}>
      <button className="mt-iconbtn" title={t("mt.addTo")} aria-label={t("mt.addTo")} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {done ? <IconCheck size={17} /> : <IconPlus size={17} />}
      </button>
      {open && (
        <div className="mt-menu" role="menu">
          <div className="mt-menu__head">{t("mt.addTo")}</div>
          {playlists.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              disabled={p.tracks.some((x) => x.id === track.id)}
              onClick={async () => {
                await addToPlaylist(p.id, track);
                setOpen(false);
                setDone(p.name);
                setTimeout(() => setDone(null), 1500);
              }}
            >
              {p.name}
              {p.tracks.some((x) => x.id === track.id) && <IconCheck size={14} />}
            </button>
          ))}
          <button
            role="menuitem"
            className="mt-menu__new"
            onClick={async () => {
              const name = window.prompt(t("mt.newName"), t("mt.newDefault"));
              if (!name?.trim()) return;
              await createPlaylist(name, me, [{ id: track.id, title: track.title, channel: track.channel, thumb: track.thumb }]);
              setOpen(false);
              setDone(name);
              setTimeout(() => setDone(null), 1500);
            }}
          >
            <IconPlus size={15} /> {t("mt.create")}
          </button>
        </div>
      )}
    </span>
  );
}

// ---- Now playing + queue ---------------------------------------------------------

function NowPlaying() {
  const { t } = useT();
  const st = useMusic();
  const slot = useRef<HTMLDivElement>(null);
  const video = st.mode === "video";

  // In Video mode the player (fixed, at the root) sits exactly on this slot.
  useLayoutEffect(() => {
    if (!video) {
      setMusic({ dock: null });
      return;
    }
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = slot.current?.getBoundingClientRect();
        if (r) setMusic({ dock: { x: r.left, y: r.top, w: r.width, h: r.height } });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (slot.current) ro.observe(slot.current);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [video]);

  const upNext = useMemo(() => (st.index >= 0 ? st.queue.slice(st.index + 1, st.index + 30) : []), [st.queue, st.index]);

  return (
    <aside className="mt-now">
      <div className="mt-box mt-now__box">
        <div className="mt-now__head">{t("mt.nowPlaying")}</div>
        {video ? (
          <div className="mt-now__video" ref={slot} />
        ) : (
          <div className="mt-now__cover" {...(st.now ? songMenuProps({ id: st.now.id, title: st.now.title, channel: st.now.author }) : {})}>
            {st.now ? <Cover id={st.now.id} big /> : <IconNote size={48} />}
          </div>
        )}
        <div className="mt-now__title">{st.notice ?? st.now?.title ?? t("music.nothing")}</div>
        <div className="mt-now__author">{st.now?.author}</div>
        {upNext.length > 0 && (
          <>
            <div className="mt-now__head" style={{ marginTop: 18 }}>
              {t("mt.next")}
            </div>
            <div className="mt-queue">
              {upNext.map((tr, i) => (
                <button key={tr.id + i} className="mt-qitem" onClick={() => music.playAt(st.index + 1 + i)} {...songMenuProps(tr)}>
                  <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
                  <span>
                    <b>{tr.title}</b>
                    <small>{tr.channel}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mt-now__fine">
          <PremiumToggle />
        </div>
      </div>
    </aside>
  );
}

// ---- Player bar ------------------------------------------------------------------

function PlayerBar({ playlists }: { playlists: Playlist[] }) {
  const { t } = useT();
  const st = useMusic();
  const current: Track | null = st.now ? { id: st.now.id, title: st.now.title, channel: st.now.author } : null;
  return (
    <footer className="mt-bar">
      <div className="mt-bar__song" {...(current ? songMenuProps(current) : {})}>
        {st.now ? <Cover id={st.now.id} className="mt-bar__img" /> : <span className="mt-bar__ph"><IconNote size={22} /></span>}
        <span>
          <b>{st.notice ?? st.now?.title ?? t("music.nothing")}</b>
          <small>{st.now?.author}</small>
        </span>
        {current && <AddToPlaylist track={current} playlists={playlists} />}
      </div>
      <div className="mt-bar__center">
        <div className="mt-bar__controls">
          <button className={`mt-iconbtn${st.shuffle ? " is-on" : ""}`} onClick={() => music.setShuffle(!st.shuffle)} aria-pressed={st.shuffle} title={t("mt.shuffle")} aria-label={t("mt.shuffle")}>
            <IconShuffle size={18} />
          </button>
          <button className="mt-iconbtn" onClick={music.prev} disabled={!st.source} aria-label={t("music.prev")}>
            <IconPrev size={18} />
          </button>
          <button className="mt-play" onClick={music.toggle} disabled={!st.source} aria-label={st.playing ? t("music.pause") : t("music.play")}>
            {st.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button className="mt-iconbtn" onClick={music.next} disabled={!st.source} aria-label={t("music.next")}>
            <IconNext size={18} />
          </button>
          <button className={`mt-iconbtn${st.repeat ? " is-on" : ""}`} onClick={() => music.setRepeat(!st.repeat)} aria-pressed={st.repeat} title={t("mt.repeat")} aria-label={t("mt.repeat")}>
            <IconRepeat size={18} />
          </button>
        </div>
        <Progress />
      </div>
      <div className="mt-bar__right">
        <ModeSwitch />
        <button className="mt-iconbtn" onClick={() => music.setMuted(!st.muted)} aria-label={st.muted ? t("mt.unmute") : t("mt.mute")}>
          {st.muted || st.volume === 0 ? <IconMute size={18} /> : <IconVolume size={18} />}
        </button>
        <input
          className="mt-volume"
          type="range"
          min={0}
          max={100}
          value={st.muted ? 0 : st.volume}
          onChange={(e) => music.setVolume(Number(e.target.value))}
          aria-label={t("mt.volume")}
          style={{ ["--p" as string]: `${st.muted ? 0 : st.volume}%` }}
        />
      </div>
    </footer>
  );
}
