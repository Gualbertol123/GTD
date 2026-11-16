# Music performance harness

Two measurement tools for the music system (README §1e). Neither needs a
secret, and neither touches `src/` or `netlify/`.

| Command | What it measures |
|---|---|
| `npm run perf:music -- --label baseline` | The UI: a production build in headless Chromium, with everything around it mocked |
| `npm run perf:fns -- --label baseline` | The server functions `netlify/functions/music-*.mts`, against real YouTube / Spotify |
| `npm run perf:music -- --compare baseline after` | A before / after table of two UI runs |

Results go to `scripts/perf/results/<label>.json` (UI) and
`results/fns-<label>.json` (functions), and a markdown table is printed on
stdout. Progress goes to stderr, so `> table.md` captures only the table.

## UI harness (`run.mjs`)

```
node scripts/perf/run.mjs --label after              # build + all scenarios, 3 reps, medians
node scripts/perf/run.mjs --label after --no-build   # reuse scripts/perf/.build/dist
node scripts/perf/run.mjs --only S2,S4 --reps 1      # quick check
node scripts/perf/run.mjs --compare baseline after
node scripts/perf/run.mjs --web /path/to/other/checkout/web --label baseline
```

`--web DIR` (both tools) builds or bundles from another checkout of `web/`,
for example a frozen worktree of the original commit. Results and `.build/`
still go to this script's folder.

- **Build**: `vite build --minify false` into `scripts/perf/.build/dist` (the
  real `dist/` is left alone), with `VITE_SUPABASE_URL=http://supabase.mock`,
  `VITE_SUPABASE_ANON_KEY=anon`, `VITE_TEAM_EMAIL=team@example.com`. It is still
  a production React build; minify is off only so component names survive.
  Served with `vite preview --port 4179`, which the script starts and stops.
- **Mocks** (`lib/mocks.mjs`): a logged-in session is put in localStorage
  before load, and Supabase REST, RPC, Auth and the Realtime websocket are
  answered locally (3 team playlists of 30 songs, one of them full of songs that
  fail). The music functions answer after 300–900 ms with the shapes the real
  ones return. Thumbnails are 1-px PNGs, and anything else outside the app
  (fonts) is blocked. Every request is counted per scenario.
- **Fake YouTube** (`lib/fakeYT.js`, served as `iframe_api`): it is slow on
  purpose. onReady comes after 400 ms, then BUFFERING lasts 1–2 s before PLAYING.
  `getPlaylist()` is null for about 1.5 s after a load, and the title changes
  only when the buffering ends. About 1 in 8 ids fire onError 150, decided by
  the id (`lib/shared.js`, `isBad`). `setShuffle` reorders the list like the
  real player. Every command and state is logged in `window.__fake.log` (same
  clock as `event.timeStamp`).
- **Commit counter** (`lib/inpage.js`): a minimal
  `__REACT_DEVTOOLS_GLOBAL_HOOK__`. React counts as rendered a component that is
  new or has the PerformedWork flag. Subtrees that React did not clone are
  skipped, which is the same rule React DevTools uses. Scenario S0 checks it:
  an idle board gives 0 commits.
- **Timings**: `t0` is the trusted `pointerdown` / `keydown` / `touchstart` of
  the user's action. *feedback* is the first change React makes to the DOM
  after it. This comes before the paint, by about one frame. *command* is the
  fake player's first command, and *PLAYING* is the "audio start". Event Timing
  (threshold 16 ms) gives the INP-style max / p75 and the input delay. Long
  tasks are reported as well.
- A selector that fails makes that scenario `n/a: reason`, and the run
  continues. All the selectors are in `SEL` at the top of `run.mjs` (roles and
  aria-labels in IT + EN first, then class names).

Scenarios: S0 sanity (idle), S1 open MUSICA, S2 play a trending song (cold,
then while another plays), S3 pause / play while buffering and while playing,
S4 Next ×3, S5 steady playback (MUSICA tab, ♪ panel, board with mini player),
S6 volume drag, S7 search typing + submit, S8 shuffle + "Riproduci dopo", S9
failing songs (one, two in a row, the last in the list), S10 phone (iPhone 13:
Altro → Musica, tap, long-press), S11 scroll with Video mode on.

## Function bench (`fns.mjs`)

```
node scripts/perf/fns.mjs --label after [--warm 5] [--gap 500] [--rpc-delay 80-150] [--only search,radio]
```

Each `music-*.mts` is bundled with esbuild into `.build/fns/`. A local HTTP
mock answers Supabase's `is_team_member` RPC with `true` after 80–150 ms. Each
case runs in a fresh node process:

- **cold**: import, plus the first call, plus the YouTube.js client.
- **warm**: the median of the next `--warm` calls that succeeded.

A fetch hook splits each call into the auth RPC part and the upstream part.
`YOUTUBE_API_KEY` is removed from the environment. When YouTube.js fails, the
function falls back to the Data API, which then answers `501 no-key`. That
call is counted as failed, and its YouTube.js error is shown. Node's fetch goes
through the sandbox proxy with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21). The
numbers depend on the network and on YouTube, so compare runs made close
together.
