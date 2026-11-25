import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Public files the app needs to start, besides the built ones (index.html
// links the favicon and touch icon; the manifest names the rest).
const PRECACHE_PUBLIC = [
  "/manifest.webmanifest",
  "/icons/favicon-32.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

// Writes the precache list into dist/sw.js: the HTML shell, every file this
// build emitted (hashed, under /assets) and the public files above, so the
// first visit caches all the app needs to open offline (public/sw.js).
function swPrecache(): Plugin {
  let outDir = "dist";
  let built: string[] = [];
  return {
    name: "gtd-sw-precache",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    generateBundle(_options, bundle) {
      built = Object.keys(bundle)
        .filter((f) => f !== "index.html")
        .map((f) => "/" + f.replace(/\\/g, "/"))
        .sort();
    },
    // After the public folder (and so sw.js) has been copied into dist.
    writeBundle() {
      const file = resolve(outDir, "sw.js");
      const src = readFileSync(file, "utf8");
      const marker = "const PRECACHE = []; // @precache";
      if (!src.includes(marker)) throw new Error("public/sw.js: the PRECACHE marker line is missing");
      const list = ["/", ...PRECACHE_PUBLIC, ...built];
      writeFileSync(file, src.replace(marker, `const PRECACHE = ${JSON.stringify(list, null, 2)};`));
    },
  };
}

// Static SPA. No backend server — the app talks straight to Supabase from the
// browser. Served at a domain root on Netlify.
export default defineConfig(({ command, mode }) => {
  // A production build without the team e-mail would publish a site nobody
  // can log in to. Fail the build instead: Netlify then keeps the previous
  // deploy live.
  if (command === "build") {
    const env = { ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") };
    const email = (env.VITE_TEAM_EMAIL ?? "").trim();
    if (!email.includes("@")) {
      throw new Error("VITE_TEAM_EMAIL is not set (the shared team account's e-mail). Add it in Netlify → Environment variables.");
    }
  }
  return {
    plugins: [react(), swPrecache()],
    base: "/",
    server: { port: 5173 },
    build: {
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          // Keep the rarely-changing Supabase client in its own chunk so an
          // ordinary app deploy does not invalidate the browser's cached copy.
          // Filenames stay content-hashed, so this is safe to cache forever
          // (see the immutable Cache-Control on /assets/* in netlify.toml).
          manualChunks: {
            supabase: ["@supabase/supabase-js"],
          },
        },
      },
      // jsPDF (loaded only when a PDF is made) is a large chunk by itself.
      chunkSizeWarningLimit: 1200,
    },
  };
});
