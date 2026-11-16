# Music performance harness

Two measurement tools for the music system (README §1e). Neither needs a
secret, and neither touches `src/` or `netlify/`.

| Command | What it measures |
|---|---|
| `npm run perf:music -- --label baseline` | The UI: a production build in headless Chromium, with everything around it mocked |
| `npm run perf:fns -- --label baseline` | The server functions `netlify/functions/music-*.mts`, against real YouTube / Spotify |
| `npm run perf:music -- --compare baseline-v2 after` | A before / after table of two UI runs, with a better / worse column |
| `npm run perf:music:check` | Fast smoke test (S2, S3, S4, S8, S9 once); exits 1 if a hard check fails |

Results go to `scripts/perf/results/<label>.json` (UI) and
`results/fns-<label>.json` (functions), and a markdown table is printed on
stdout. Progress goes to stderr, so `> table.md` captures only the table.

## UI harness (`run.mjs`)

```
node scripts/perf/run.mjs --label after              # build + all scenarios, 3 reps, medians
node scripts/perf/run.mjs --label after --no-build   # reuse scripts/perf/.build/dist
node scripts/perf/run.mjs --only S2,S4 --reps 1      # quick check
node scripts/perf/run.mjs --compare baseline-v2 after         # the clean table
node scripts/perf/run.mjs --compare baseline-v2 after --all   # every field, with Δ
node scripts/perf/run.mjs --web /path/to/other/checkout/web --label baseline-v2
node scripts/perf/run.mjs --check                             # = npm run perf:music:check
```

`--web DIR` (both tools) builds or bundles from another checkout of `web/`,
for example a frozen worktree of the original commit. Results and `.build/`
still go to this script's folder. Each checkout gets its own build folder
(`.build/dist` for this one, `.build/dist-<hash>` for another; `--out DIR`
picks one), and the preview takes the first free port from 4179 to 4199, so
two runs at the same time do not serve each other's files.

**Reference results.** `results/baseline.json` is the original code measured
with the first version of the scenarios. It is committed and the script
refuses `--label baseline`. `results/baseline-v2.json` is the same original
code (a worktree of commit 1835c83) measured with the current scenarios
(3 reps): compare new runs against **baseline-v2**. Comparing against
`baseline` still works, but the newer fields show as "—".

### Compare (`--compare A B`)

One table of the headline metrics (`HEADLINE` in `run.mjs`): the two medians,
a verdict (`better`, `worse`, `same` within 10 % and 20 ms, `new` when only B
has it) and, for each click, whether it gave visible feedback within 100 ms in
every rep (`pass → fail`…). The hard checks of B follow, with A's result in
brackets. `--all` prints every field instead, with a plain Δ. Fields marked
† are legacy: kept so older results load, never used by the table or
`--check`.

### Smoke check (`npm run perf:music:check`)

`--check` builds the current code and runs S2, S3, S4, S8 and S9 once
(`--reps 1 --only S2,S3,S4,S8,S9`, label `check`), in about 1.5 minutes plus
the build. It prints the usual table and then the hard checks, and exits with
code 1 when any of them fails (a check that could not be measured, or a
scenario that ended n/a, fails too):

- every click (play cold / warm, pause while buffering, pause, resume, Next,
  "Riproduci dopo") gives visible feedback within **150 ms**;
- a wrong song title is shown for **0 ms** after a play click (S2);
- the pause pressed while a song buffers is **honoured**: it ends PAUSED (S3);
- **no skip loop** on failing songs (at most 3 errors, S9);
- the last song of a list fails: nothing plays **and** the button offers
  Play, with no spinner left turning (S9, no stuck state);
- the **queue shown = the order the songs play** (S8).

Add `--no-build` to reuse the last build. The same table is printed at the
end of every normal run (its exit code is 0 there).

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
  the user's action. *feedback* is the first change React makes to the
  watched DOM after it (title, queue, the main button's aria-label /
  aria-busy / icon, a toast). This comes before the paint, by about one
  frame. *spinner* is when the main button first looks busy (aria-busy, an
  `is-busy` class or a spinner inside). *command* is the fake player's first
  command, and *PLAYING* is the "audio start". Event Timing (threshold 16 ms)
  gives the INP-style max / p75 and the input delay. Long tasks are reported
  as well. Every run ends with a "Click → visible feedback ≤ 100 ms" table,
  one pass / fail row per control measured (`FEEDBACK` in `run.mjs`).
- A selector that fails makes that scenario `n/a: reason`, and the run
  continues. All the selectors are in `SEL` at the top of `run.mjs` (roles and
  aria-labels in IT + EN first, then class names).

Scenarios: S0 sanity (idle), S1 open MUSICA, S2 play a trending song (cold,
then while another plays), S3 pause / play while buffering and while playing,
S4 Next ×3, S5 steady playback (MUSICA tab, ♪ panel, board with mini player),
S6 volume drag, S7 search typing + submit, S8 shuffle + "Riproduci dopo", S9
failing songs (one, two in a row, the last in the list), S10 phone (iPhone 13:
Altro → Musica, tap, long-press), S11 scroll with Video mode on, S12 YouTube
API unreachable, S13 renders per second while playing on 50 search results.

What some scenarios judge (the selectors work on the old and the wave-2 UI:
rows play from their play button, a single click or a double-click, and the
song menu opens by right-click or the row's "⋯" button):

- **S3** has three independent parts, each started from a known state that
  is set up and not measured: (1) press while the clicked song BUFFERS:
  `feedbackMs` (first change of the bar button's aria-label / aria-busy /
  icon), `pressHonoured` (ends PAUSED) and `playedAnywayMs` (audio heard
  after the press); (2) the song PLAYING, press pause; (3) the player PAUSED
  and the button offering Play, press play: `spinnerMs` / `spinnerShownMs`.
- **S4** `staleTitleMs`: how long the old title stays after the first Next.
  (`staleTitleShownMs` † is the older "title ≠ the final song" time.)
- **S8** judges what PLAYS: after shuffle, Next must play the song the queue
  shows next (`shuffle.nextPlaysShownNext`); after "Riproduci dopo", Next ×3
  must play the queue shown, in order (`play.afterEnqueueMatchesQueue`).
  `play.queueMatchesPlayed` (both) is the verdict the compare table and
  `--check` use; songs that cannot play are left out of the expected order.
  The fake's internal playlist at the moment of the enqueue is not a judge
  (the app may sync YouTube's list at the next song): those fields are †.
- **S9** finds the notice anywhere (a `role=status` toast or the title:
  `noticeWhere`). `barMatchesPlayer` = a song plays with its title and a
  Pause button, or nothing plays and the button offers Play (any title).
  `spinnerAtEnd` = the button still looks busy.
- **S12** aborts `iframe_api`, opens MUSICA and clicks a song: are a "YouTube
  can't be reached" message and a Retry button visible within 13 s
  (`errorAndRetryWithin13s`)? Then it unblocks YouTube and presses Retry
  (`retryWorks`: a song plays within 8 s, pressing the song again if Retry
  only reloaded the player). Without a Retry, `playAgainWorks` says whether
  pressing play again recovers. `spinnerStuck` = the button still looks
  busy after 13 s.
- **S13** plays the trends, searches "tiziano 50" (the mock answers 50
  songs), and counts commits and rendered components per second for 10 s.

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

## S14: a song stuck mid-play

`window.__fake.stallCurrent()` makes the current fake player's connection die. It stays BUFFERING with the second frozen, whatever it is asked. A new player (a rebuild) works normally.

S14 plays a song, kills its connection, and checks four things:
- the music comes back by itself;
- it is the same song;
- it resumes within 3 s of where it froze;
- the UI never shows paused in the meantime.

S14 also reports `recoveredMs`, how long the silence lasted. It is part of `npm run perf:music:check`.
