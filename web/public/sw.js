// -----------------------------------------------------------------------------
// Service worker — makes the site installable, quick to open, and able to
// open offline.
//
// It caches the app's CODE only. It never touches board data: Supabase lives
// on another origin and is never intercepted, and only GET requests to this
// site are looked at, so tasks, notes and reflections stay in memory only,
// exactly as without it. Offline, the app opens and says so; edits are
// refused up front (lib/optimisticSend.ts), nothing is queued or stored.
//
// The first visit caches everything the app needs to start: the HTML shell,
// every built file under /assets (the build writes their hashed names into
// PRECACHE below, see swPrecache in vite.config.ts), the manifest and the
// icons. So after one visit the installed app opens with no network at all,
// on any tab (a lazily loaded screen is already there too).
//
//   page loads (navigation)  network first, so a deploy shows up at once;
//                            the cached shell only when offline
//   /assets/* (hashed)       cache first: a hashed file never changes
//   other same-site files    network first, cached copy when offline
//   Supabase, other sites,   not handled at all (straight to the network)
//   POST, /.netlify/
//
// On activate, files of older builds are dropped from the cache (anything
// under /assets that is not in this build's PRECACHE), so it never grows.
// Change VERSION to drop every cached file on the next visit.
// -----------------------------------------------------------------------------

const VERSION = "v2";
const SHELL = `gtd-shell-${VERSION}`;
const ASSETS = `gtd-assets-${VERSION}`;

// Filled in by the build. Empty here (the dev server never registers this).
const PRECACHE = []; // @precache

const isAsset = (path) => path.startsWith("/assets/");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const [shell, assets] = await Promise.all([caches.open(SHELL), caches.open(ASSETS)]);
      // A hashed file kept from the previous build is not downloaded again.
      const missing = [];
      for (const p of PRECACHE.filter(isAsset)) if (!(await assets.match(p))) missing.push(p);
      await assets.addAll(missing);
      // The shell, manifest and icons: always fresh from the server.
      await shell.addAll(PRECACHE.filter((p) => !isAsset(p)).map((p) => new Request(p, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)));
      // Older builds' files go: only this build's are kept.
      if (PRECACHE.length) {
        const keep = new Set(PRECACHE.map((p) => new URL(p, self.location.origin).href));
        const assets = await caches.open(ASSETS);
        for (const req of await assets.keys()) if (!keep.has(req.url)) await assets.delete(req);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, Google Fonts: untouched
  if (url.pathname.startsWith("/.netlify/")) return; // the report PDF function

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const html = (res.headers.get("content-type") || "").includes("text/html");
          if (res.ok && html) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/", { cacheName: SHELL }).then((r) => r || Response.error()))
    );
    return;
  }

  if (isAsset(url.pathname)) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone()); // dropped on the next activate if not this build's
        return res;
      })
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only plain paths (a fixed set of public files), so the cache stays bounded.
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { cacheName: SHELL }).then((r) => r || Response.error()))
  );
});
