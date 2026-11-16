// Fake YouTube IFrame Player API, served in place of
// https://www.youtube.com/iframe_api. lib/shared.js is prepended to it.
//
// SLOW and realistic on purpose:
//   - onReady ~400 ms after the player is constructed;
//   - a load / play emits UNSTARTED(-1), then BUFFERING(3) for 1000–2000 ms
//     (per video id), then PLAYING(1);
//   - getPlaylist() is null until the list has "loaded" (~1.5 s after
//     loadPlaylist); getPlaylistIndex() is known at once;
//   - getVideoData(): video_id changes at once, title/author only when the
//     buffering ends;
//   - ~1 in 8 ids fire onError(150) instead of playing (isBad(id));
//   - time advances while PLAYING; at the end ENDED(0) then auto-advance;
//   - setShuffle(true) reorders the list (like the real player) and
//     getPlaylistIndex() follows the current video.
// Everything is logged in window.__fake.log as {t, cmd, args} / {t, state, id}
// / {t, error, id} with t = performance.now() (same clock as event.timeStamp).

(function () {
  if (window.YT && window.YT.Player) return;
  var log = [];
  var F = (window.__fake = window.__fake || {});
  F.log = log;
  F.players = [];
  function rec(e) {
    e.t = performance.now();
    log.push(e);
    if (log.length > 20000) log.splice(0, 5000);
  }
  F.rec = rec;
  /**
   * The current player's connection gets stuck: BUFFERING with the second
   * frozen, whatever it is asked (seek, play, reload). A NEW player (a
   * rebuild) works normally — like a dead stream connection.
   */
  F.stallCurrent = function () {
    var p = F.players[F.players.length - 1];
    if (!p) return false;
    p._clear();
    if (p.state === S.PLAYING) p.time = p.getCurrentTime();
    p.stuck = true;
    p._emit(S.BUFFERING);
    return true;
  };
  F.current = function () {
    var p = F.players[F.players.length - 1];
    if (!p) return null;
    return {
      state: p.state,
      index: p.index,
      id: p.order ? p.order[p.index] : null,
      title: p.vd.title,
      order: p.order ? p.order.slice() : null,
      shuffle: p.shuffle,
      listLoaded: p.order ? performance.now() >= p.listReadyAt : false,
      time: p.getCurrentTime(),
      volume: p.vol,
      muted: p.muted,
    };
  };

  var S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  function seeded(seed) {
    var h = fnv1a(String(seed));
    return function () {
      h = fnv1a("r" + h);
      return h / 4294967296;
    };
  }

  function Player(el, opts) {
    this.el = typeof el === "string" ? document.getElementById(el) : el;
    this.ev = (opts && opts.events) || {};
    this.order = null;
    this.orig = null;
    this.index = -1;
    this.state = S.UNSTARTED;
    this.listReadyAt = 0;
    this.vd = { video_id: "", title: "", author: "" };
    this.time = 0;
    this.playingSince = 0;
    this.dur = 0;
    this.vol = 100;
    this.muted = false;
    this.shuffle = false;
    this.loop = false;
    this.timers = [];
    this.played = {};
    F.players.push(this);
    var self = this;
    rec({ cmd: "construct" });
    setTimeout(function () {
      rec({ ready: true });
      self.ev.onReady && self.ev.onReady({ target: self });
    }, 400);
    this.ticker = setInterval(function () {
      self._tick();
    }, 250);
  }

  var P = Player.prototype;

  P._later = function (fn, ms) {
    var self = this;
    var id = setTimeout(function () {
      self.timers = self.timers.filter(function (x) { return x !== id; });
      fn();
    }, ms);
    this.timers.push(id);
  };
  P._clear = function () {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  };
  P._emit = function (state) {
    // A stuck connection (F.stallCurrent): this player never reaches PLAYING again.
    if (this.stuck && state === S.PLAYING) state = S.BUFFERING;
    if (state === S.PLAYING) this.playingSince = performance.now();
    if (this.state === S.PLAYING && state !== S.PLAYING) this.time = this.getCurrentTime();
    this.state = state;
    var id = this.order ? this.order[this.index] : null;
    rec({ state: state, id: id, index: this.index });
    var cb = this.ev.onStateChange;
    var self = this;
    // Real events arrive by postMessage: a separate task.
    if (cb) setTimeout(function () { cb({ data: state, target: self }); }, 0);
  };
  P._error = function (code) {
    var id = this.order ? this.order[this.index] : null;
    rec({ error: code, id: id, index: this.index });
    var cb = this.ev.onError;
    var self = this;
    if (cb) setTimeout(function () { cb({ data: code, target: self }); }, 0);
  };
  P._startBuffering = function (ms) {
    var self = this;
    var id = this.order[this.index];
    this._emit(S.BUFFERING);
    this._later(function () {
      if (isBad(id)) {
        self.state = S.UNSTARTED;
        self._error(150);
        return;
      }
      self.vd = { video_id: id, title: titleFor(id), author: artistFor(id) };
      self.dur = durationFor(id);
      self.played[id] = true;
      self._emit(S.PLAYING);
    }, ms);
  };
  P._load = function (i, start, autoplay) {
    this._clear();
    if (!this.order || i < 0 || i >= this.order.length) return;
    this.index = i;
    var id = this.order[i];
    this.vd = { video_id: id, title: this.vd.title, author: this.vd.author };
    this.time = start || 0;
    this.dur = 0;
    this._emit(S.UNSTARTED);
    var self = this;
    if (autoplay === false) {
      this._later(function () { self._emit(S.CUED); }, 30);
      return;
    }
    this._later(function () { self._startBuffering(bufferFor(id)); }, 30);
  };
  P._tick = function () {
    if (this.state !== S.PLAYING) return;
    var t = this.getCurrentTime();
    if (this.dur && t >= this.dur) {
      this.time = this.dur;
      this._emit(S.ENDED);
      var self = this;
      if (this.index + 1 < this.order.length) this._later(function () { self._load(self.index + 1, 0); }, 200);
      else if (this.loop) this._later(function () { self._load(0, 0); }, 200);
    }
  };
  P._setList = function (ids, index, start, autoplay) {
    this.orig = ids.slice();
    this.order = ids.slice();
    this.shuffle = false; // a new list starts in order
    this.listReadyAt = performance.now() + 1300 + (fnv1a(ids.join(",")) % 400);
    this._load(Math.max(0, Math.min(index || 0, ids.length - 1)), start, autoplay);
  };
  function idsOf(arg) {
    if (Array.isArray(arg)) return { ids: arg.slice() };
    if (typeof arg === "string") return { ids: [arg] };
    if (arg && arg.list) {
      var ids = [];
      for (var k = 0; k < 30; k++) ids.push(vid("list:" + arg.list + ":" + k));
      return { ids: ids, index: arg.index, start: arg.startSeconds };
    }
    if (arg && arg.playlist) return idsOf(arg.playlist);
    return { ids: [] };
  }
  function short(a) {
    try {
      var s = JSON.stringify(a);
      return s && s.length > 160 ? s.slice(0, 160) + "…" : s;
    } catch (e) {
      return String(a);
    }
  }

  // ---- Public API ----------------------------------------------------------
  P.loadPlaylist = function (arg, index, start) {
    rec({ cmd: "loadPlaylist", args: short([arg, index, start]) });
    var o = idsOf(arg);
    this._setList(o.ids, index != null ? index : o.index, start != null ? start : o.start, true);
  };
  P.cuePlaylist = function (arg, index, start) {
    rec({ cmd: "cuePlaylist", args: short([arg, index, start]) });
    var o = idsOf(arg);
    this._setList(o.ids, index != null ? index : o.index, start != null ? start : o.start, false);
  };
  P.loadVideoById = function (arg, start) {
    rec({ cmd: "loadVideoById", args: short([arg, start]) });
    var id = typeof arg === "object" ? arg.videoId : arg;
    this._setList([id], 0, typeof arg === "object" ? arg.startSeconds : start, true);
  };
  P.cueVideoById = function (arg, start) {
    rec({ cmd: "cueVideoById", args: short([arg, start]) });
    var id = typeof arg === "object" ? arg.videoId : arg;
    this._setList([id], 0, start, false);
  };
  P.playVideo = function () {
    rec({ cmd: "playVideo" });
    if (!this.order) return;
    var id = this.order[this.index];
    if (this.state === S.PLAYING || this.state === S.BUFFERING) return;
    this._clear();
    // Resuming something that already played: a short re-buffer.
    this._startBuffering(this.played[id] && this.vd.title === titleFor(id) ? 250 : bufferFor(id));
  };
  P.pauseVideo = function () {
    rec({ cmd: "pauseVideo" });
    if (this.state === S.PLAYING || this.state === S.BUFFERING) {
      this._clear();
      this._emit(S.PAUSED);
    }
  };
  P.stopVideo = function () {
    rec({ cmd: "stopVideo" });
    this._clear();
    this.time = 0;
    this._emit(S.CUED);
  };
  P.nextVideo = function () {
    rec({ cmd: "nextVideo" });
    if (!this.order) return;
    if (this.index + 1 < this.order.length) this._load(this.index + 1, 0);
    else if (this.loop) this._load(0, 0);
  };
  P.previousVideo = function () {
    rec({ cmd: "previousVideo" });
    if (!this.order) return;
    if (this.index > 0) this._load(this.index - 1, 0);
    else if (this.loop) this._load(this.order.length - 1, 0);
  };
  P.playVideoAt = function (i) {
    rec({ cmd: "playVideoAt", args: short([i]) });
    this._load(i, 0);
  };
  P.seekTo = function (s) {
    rec({ cmd: "seekTo", args: short([s]) });
    if (this.state === S.PLAYING) {
      var self = this;
      this._clear();
      this._emit(S.BUFFERING);
      this.time = s;
      this._later(function () { self._emit(S.PLAYING); }, 200);
    } else this.time = s;
  };
  P.setVolume = function (v) {
    rec({ cmd: "setVolume", args: short([v]) });
    this.vol = Math.max(0, Math.min(100, Number(v) || 0));
  };
  P.getVolume = function () { return this.vol; };
  P.mute = function () { rec({ cmd: "mute" }); this.muted = true; };
  P.unMute = function () { rec({ cmd: "unMute" }); this.muted = false; };
  P.isMuted = function () { return this.muted; };
  P.setShuffle = function (on) {
    rec({ cmd: "setShuffle", args: short([on]) });
    on = !!on;
    if (!this.order || on === this.shuffle) {
      this.shuffle = on;
      return;
    }
    var cur = this.order[this.index];
    if (on) {
      var a = this.orig.slice();
      var rnd = seeded(a.join(","));
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1));
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      }
      this.order = a;
    } else {
      this.order = this.orig.slice();
    }
    this.shuffle = on;
    this.index = this.order.indexOf(cur);
  };
  P.setLoop = function (on) { rec({ cmd: "setLoop", args: short([on]) }); this.loop = !!on; };
  P.getPlayerState = function () { return this.state; };
  P.getCurrentTime = function () {
    if (this.state === S.PLAYING) return this.time + (performance.now() - this.playingSince) / 1000;
    return this.time;
  };
  P.getDuration = function () { return this.dur; };
  P.getVideoData = function () { return { video_id: this.vd.video_id, title: this.vd.title, author: this.vd.author }; };
  P.getPlaylist = function () {
    if (!this.order || performance.now() < this.listReadyAt) return null;
    return this.order.slice();
  };
  P.getPlaylistIndex = function () { return this.index; };
  P.getVideoUrl = function () { return "https://www.youtube.com/watch?v=" + (this.order ? this.order[this.index] : ""); };
  P.getIframe = function () { return this.el; };
  P.addEventListener = function (name, fn) { this.ev[name] = fn; };
  P.removeEventListener = function (name) { delete this.ev[name]; };
  P.destroy = function () { rec({ cmd: "destroy" }); this._clear(); clearInterval(this.ticker); };

  window.YT = { Player: Player, PlayerState: S, loaded: 1, ready: function (f) { f(); } };
  if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady();
})();
