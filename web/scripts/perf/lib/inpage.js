// Injected with page.addInitScript BEFORE the app loads.
//
//  window.__commits   React commit counter that works in a PRODUCTION build:
//                     a minimal React DevTools hook. React 18 calls
//                     onCommitFiberRoot on every commit; we walk the new tree
//                     and count the composite components that actually
//                     rendered in that commit (see walk() below).
//  window.__lt        long tasks (PerformanceObserver 'longtask')
//  window.__ev        Event Timing entries (durationThreshold 16)
//  window.__rec       a DOM recorder: arm(cfg) → watch text/attrs/existence of
//                     selectors with timestamps, and remember the timeStamp of
//                     the first trusted input event after arming (t0).
(function () {
  // ---- Commit counter ------------------------------------------------------
  var C = (window.__commits = { commits: 0, fibersRendered: 0, byName: {}, errors: 0, lastErr: null });
  // Function, Class, ForwardRef, SimpleMemo. (MemoComponent=14 wraps a
  // separate inner fiber that is counted itself.)
  var COMPOSITE = { 0: 1, 1: 1, 11: 1, 15: 1 };
  var PERFORMED_WORK = 1;
  function nameOf(f) {
    var t = f.type;
    if (!t) return "?";
    if (typeof t === "function") return t.displayName || t.name || "Anonymous";
    if (typeof t === "object") {
      if (t.displayName) return t.displayName;
      var inner = t.render || t.type;
      if (inner) return inner.displayName || inner.name || "Anonymous";
    }
    return "?";
  }
  // A fiber "rendered in this commit" when it is new (no alternate: mounted)
  // or it was re-rendered (PerformedWork flag; createWorkInProgress resets the
  // flags of every fiber it clones, so a bail-out has it cleared). A subtree
  // React did not even clone shares its child pointer with the previous tree
  // (current.child === alternate.child): it is skipped, so its stale flags
  // from an older commit are never counted. Same rule React DevTools uses.
  function walk(root) {
    var stack = [root];
    var n = 0;
    while (stack.length) {
      var f = stack.pop();
      var prev = f.alternate;
      var rendered = !prev || (f.flags & PERFORMED_WORK) === PERFORMED_WORK;
      if (rendered && COMPOSITE[f.tag]) {
        n++;
        var name = nameOf(f);
        C.byName[name] = (C.byName[name] || 0) + 1;
      }
      if (prev && f.child === prev.child) continue;
      var c = f.child;
      while (c) {
        stack.push(c);
        c = c.sibling;
      }
    }
    return n;
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: function (r) {
      this.renderers.set(1, r);
      return 1;
    },
    onCommitFiberRoot: function (_id, root) {
      C.commits++;
      try {
        C.fibersRendered += walk(root.current);
      } catch (e) {
        C.errors++;
        C.lastErr = String(e);
      }
    },
    onCommitFiberUnmount: function () {},
    onPostCommitFiberRoot: function () {},
    onScheduleFiberRoot: function () {},
    checkDCE: function () {},
  };
  window.__commitsSnap = function () {
    return { commits: C.commits, fibersRendered: C.fibersRendered, byName: Object.assign({}, C.byName), t: performance.now() };
  };

  // ---- Long tasks + Event Timing ------------------------------------------
  window.__lt = [];
  window.__ev = [];
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        window.__lt.push({ s: e.startTime, d: e.duration });
      });
    }).observe({ type: "longtask", buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        window.__ev.push({ name: e.name, s: e.startTime, ps: e.processingStart, pe: e.processingEnd, d: e.duration, id: e.interactionId || 0 });
      });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (e) {}

  // ---- Scroll counter (S11) -------------------------------------------------
  window.__scrolls = 0;
  window.addEventListener("scroll", function () { window.__scrolls++; }, { capture: true, passive: true });

  // ---- DOM recorder ------------------------------------------------------------
  // Shown to the user: has a box, is not hidden by CSS / opacity, and is not
  // inside an aria-hidden subtree.
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  }
  window.__shown = shown;
  function readOne(w) {
    var el;
    try {
      if (w.kind === "count") return document.querySelectorAll(w.sel).length;
      // The text of every match, joined (toasts, status lines…).
      if (w.kind === "anytext")
        return Array.prototype.map
          .call(document.querySelectorAll(w.sel), function (e) { return (e.textContent || "").trim(); })
          .filter(Boolean)
          .join(" | ");
      el = document.querySelector(w.sel);
    } catch (e) {
      return null;
    }
    if (w.kind === "exists") return !!el;
    if (!el) return null;
    // A play button's "busy" look: aria-busy, an is-busy class, or a spinner inside.
    if (w.kind === "busy")
      return el.getAttribute("aria-busy") === "true" || /\bis-busy\b/.test(String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className)) || !!el.querySelector('[class*="spin"], [class*="busy"]');
    // The button's icon (its first svg's markup), so a play ↔ pause flip is seen.
    if (w.kind === "icon") {
      var svg = el.querySelector("svg");
      return svg ? svg.innerHTML : "";
    }
    if (w.kind === "visible") return el.getClientRects().length > 0;
    if (w.kind === "attr") return el.getAttribute(w.attr);
    if (w.kind === "class") return el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    return (el.textContent || "").trim();
  }
  window.__rec = {
    st: null,
    arm: function (watch) {
      this.disarm();
      var st = (this.st = { t0: null, inputs: [], changes: [], initial: {}, last: {}, armedAt: performance.now(), watch: watch });
      Object.keys(watch).forEach(function (k) {
        st.initial[k] = st.last[k] = readOne(watch[k]);
      });
      var read = function () {
        var now = performance.now();
        Object.keys(watch).forEach(function (k) {
          var v = readOne(watch[k]);
          if (v !== st.last[k]) {
            st.changes.push({ t: now, k: k, v: v });
            st.last[k] = v;
          }
        });
      };
      st.mo = new MutationObserver(read);
      st.mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      st.onInput = function (e) {
        if (!e.isTrusted) return;
        if (e.type === "pointerdown" || e.type === "keydown" || e.type === "touchstart") st.inputs.push({ t: e.timeStamp, type: e.type });
        if (st.t0 === null) st.t0 = e.timeStamp;
      };
      ["pointerdown", "mousedown", "touchstart", "keydown", "click"].forEach(function (n) {
        window.addEventListener(n, st.onInput, true);
      });
    },
    disarm: function () {
      var st = this.st;
      if (!st) return;
      st.mo && st.mo.disconnect();
      ["pointerdown", "mousedown", "touchstart", "keydown", "click"].forEach(function (n) {
        window.removeEventListener(n, st.onInput, true);
      });
    },
    collect: function () {
      var st = this.st;
      if (!st) return null;
      this.disarm();
      var out = { t0: st.t0, inputs: st.inputs, changes: st.changes, initial: st.initial, last: st.last, armedAt: st.armedAt, now: performance.now() };
      this.st = null;
      return out;
    },
  };
})();
