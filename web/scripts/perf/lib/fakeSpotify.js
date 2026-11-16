// Fake Spotify Web Playback SDK, served in place of
// https://sdk.scdn.co/spotify-player.js (scripts/perf/spotify.mjs). Nothing
// reaches Spotify. It behaves like the real one where the app depends on it:
//   - new Spotify.Player({ name, getOAuthToken }); connect() asks for the
//     token, then "ready" { device_id } ~300 ms later;
//   - the mocked PUT /me/player/play calls window.__fakeSp.play(uris, meta, pos)
//     (from the Node route handler): player_state_changed loading, then
//     playing ~400 ms later;
//   - pause / resume / seek / nextTrack / previousTrack / setVolume /
//     getCurrentState / activateElement;
//   - a song plays to its end, then the next uri, or paused at 0 after the last.
// Everything is logged in window.__fakeSp.log as {t, cmd} / {t, state}.
(function () {
  if (window.Spotify && window.Spotify.Player) return;
  var F = (window.__fakeSp = window.__fakeSp || {});
  F.log = [];
  F.players = [];
  F.uris = [];
  F.meta = {};
  F.index = -1;
  F.paused = true;
  F.loading = false;
  F.position = 0;
  F.at = performance.now();
  F.duration = 180000;
  F.volume = 1;
  function rec(e) {
    e.t = performance.now();
    F.log.push(e);
  }
  function pos() {
    return F.paused || F.loading ? F.position : Math.min(F.duration, F.position + (performance.now() - F.at));
  }
  function track(uri) {
    if (!uri) return null;
    var m = F.meta[uri] || {};
    var id = uri.split(":").pop();
    return {
      id: id,
      uri: uri,
      name: m.name || "Track " + id.slice(0, 4),
      duration_ms: F.duration,
      artists: [{ name: m.artist || "Artist", uri: "spotify:artist:x" }],
      album: { name: m.album || "Album", uri: "spotify:album:x", images: [{ url: m.cover || "https://i.scdn.co/image/fake-640", width: 640, height: 640 }, { url: "https://i.scdn.co/image/fake-64", width: 64, height: 64 }] },
    };
  }
  function state() {
    if (F.index < 0) return null;
    return {
      paused: F.paused,
      loading: F.loading,
      position: Math.round(pos()),
      duration: F.duration,
      timestamp: Date.now(),
      track_window: {
        current_track: track(F.uris[F.index]),
        previous_tracks: F.uris.slice(Math.max(0, F.index - 2), F.index).map(track),
        next_tracks: F.uris.slice(F.index + 1, F.index + 3).map(track),
      },
    };
  }
  function emit(ev, arg) {
    var p = F.players[F.players.length - 1];
    if (p && p.l[ev]) p.l[ev].forEach(function (cb) { try { cb(arg); } catch (e) { console.error(e); } });
  }
  function changed() {
    rec({ state: F.paused ? "paused" : F.loading ? "loading" : "playing", uri: F.uris[F.index] || null, position: Math.round(pos()) });
    emit("player_state_changed", state());
  }
  F.isPlaying = function () {
    return !F.paused && !F.loading && F.index >= 0;
  };
  F.current = function () {
    return { playing: F.isPlaying(), paused: F.paused, loading: F.loading, uri: F.uris[F.index] || null, index: F.index, uris: F.uris.slice(), position: Math.round(pos()) };
  };
  var startTimer = 0;
  function startAt(i, posMs) {
    clearTimeout(startTimer);
    F.index = i;
    F.position = posMs || 0;
    F.paused = false;
    F.loading = true;
    changed();
    startTimer = setTimeout(function () {
      if (F.paused) return;
      F.loading = false;
      F.at = performance.now();
      changed();
    }, 400);
  }
  /** PUT /me/player/play (the Node route handler calls this). */
  F.play = function (uris, meta, posMs) {
    rec({ cmd: "PUT play", n: uris.length });
    F.uris = uris.slice();
    for (var k in meta || {}) F.meta[k] = meta[k];
    startAt(0, posMs || 0);
  };
  /** Tests: jump to the end of the song. */
  F.finish = function () {
    F.position = F.duration - 50;
    F.at = performance.now();
  };
  setInterval(function () {
    if (F.paused || F.loading || F.index < 0) return;
    if (pos() < F.duration) return;
    if (F.index + 1 < F.uris.length) return startAt(F.index + 1, 0);
    F.position = 0;
    F.paused = true;
    changed();
  }, 100);

  function Player(opts) {
    this.opts = opts;
    this.l = {};
    F.players.push(this);
    rec({ cmd: "new Player", name: opts && opts.name });
  }
  var P = Player.prototype;
  P.addListener = P.on = function (ev, cb) {
    (this.l[ev] = this.l[ev] || []).push(cb);
    return true;
  };
  P.removeListener = function (ev) {
    delete this.l[ev];
    return true;
  };
  P.connect = function () {
    var self = this;
    rec({ cmd: "connect" });
    return new Promise(function (resolve) {
      self.opts.getOAuthToken(function (tok) {
        F.token = tok;
        resolve(true);
        setTimeout(function () {
          if (F.fail) return emit(F.fail, { message: "fake " + F.fail });
          emit("ready", { device_id: "fake-device-1" });
        }, 300);
      });
    });
  };
  P.disconnect = function () { rec({ cmd: "disconnect" }); };
  P.getCurrentState = function () { return Promise.resolve(state()); };
  P.setName = function () { return Promise.resolve(); };
  P.getVolume = function () { return Promise.resolve(F.volume); };
  P.setVolume = function (v) { rec({ cmd: "setVolume", v: v }); F.volume = v; return Promise.resolve(); };
  P.pause = function () {
    rec({ cmd: "pause" });
    if (!F.paused) {
      F.position = pos();
      F.paused = true;
      clearTimeout(startTimer);
      F.loading = false;
      changed();
    }
    return Promise.resolve();
  };
  P.resume = function () {
    rec({ cmd: "resume" });
    if (F.paused && F.index >= 0) {
      F.paused = false;
      F.at = performance.now();
      changed();
    }
    return Promise.resolve();
  };
  P.togglePlay = function () { return F.paused ? this.resume() : this.pause(); };
  P.seek = function (ms) { rec({ cmd: "seek", ms: ms }); F.position = ms; F.at = performance.now(); changed(); return Promise.resolve(); };
  P.nextTrack = function () {
    rec({ cmd: "nextTrack" });
    if (F.index + 1 < F.uris.length) startAt(F.index + 1, 0);
    return Promise.resolve();
  };
  P.previousTrack = function () {
    rec({ cmd: "previousTrack" });
    startAt(Math.max(0, F.index - 1), 0);
    return Promise.resolve();
  };
  P.activateElement = function () { rec({ cmd: "activateElement" }); return Promise.resolve(); };

  window.Spotify = { Player: Player };
  if (typeof window.onSpotifyWebPlaybackSDKReady === "function") window.onSpotifyWebPlaybackSDKReady();
})();
