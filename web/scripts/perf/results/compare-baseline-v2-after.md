### Music UI perf — baseline-v2 (1835c83, reps=3) → after (a907d8a, reps=3), medians

| Scenario | Metric | baseline-v2 | after | Verdict | ≤100 ms |
|---|---|---|---|---|---|
| **S0** | Idle board: commits in 5 s | 0 | 0 | same |  |
| **S1** | Open MUSICA: page shown (ms) | 15 | 38 | worse | pass → pass |
|  | Open MUSICA: trends shown (ms) | 756 | 769 | same |  |
|  | Open MUSICA: player ready (ms) | 606 | 565 | same |  |
|  | Open MUSICA: requests | 60 | 61 | same |  |
|  | Open MUSICA: components rendered | 397 | 373 | same |  |
| **S2** | Play (cold): feedback (ms) | 9 | 13 | same | pass → pass |
|  | Play (cold): audio starts (ms) | 1296 | 1300 | same |  |
|  | Play (cold): wrong song shown (ms) | 0 | 0 | same |  |
|  | Play (another playing): feedback (ms) | 6 | 7 | same | pass → pass |
|  | Play (another playing): audio starts (ms) | 1990 | 1992 | same |  |
|  | Play (another playing): wrong song shown (ms) | 0 | 0 | same |  |
| **S3** | Pause while buffering: feedback (ms) | 1860 | 6 | better | fail → pass |
|  | Pause while buffering: honoured | 0/3 | 3/3 | better |  |
|  | Pause while playing: feedback (ms) | 19 | 4 | same | pass → pass |
|  | Play while paused: feedback (ms) | 254 | 4 | better | fail → pass |
|  | Play while paused: audio (ms) | 252 | 252 | same |  |
| **S4** | Next ×3: feedback (ms) | 1908 | 7 | better | fail → pass |
|  | Next ×3: old title stays (ms) | 1908 | 7 | better |  |
|  | Next ×3: audio of the last (ms) | 1905 | 1950 | same |  |
|  | Next ×3: title = song playing | 3/3 | 3/3 | same |  |
| **S5** | Playing, MUSICA tab: renders/s | 377.5 | 2 | better |  |
|  | Playing, ♪ panel: renders/s | 56 | 2 | better |  |
|  | Playing, board: renders/s | 28 | 0 | better |  |
| **S6** | Volume drag: components rendered | 4347 | 68 | better |  |
|  | Volume drag: player commands | 21 | 20 | same |  |
|  | Volume drag: worst input (ms) | 56 | 72 | same |  |
| **S7** | Search typing: suggest requests | 6 | 6 | same |  |
|  | Search typing: components rendered | 170 | 43 | better |  |
|  | Search typing: stale suggestions | 0 | 0 | same |  |
|  | Search submit: results (ms) | 595 | 601 | same |  |
| **S8** | Riproduci dopo: feedback (ms) | 11 | 8 | same | pass → pass |
|  | Riproduci dopo: music interrupted (ms) | 4030 | 0 | better |  |
|  | Riproduci dopo: Next plays it | 0/3 | 3/3 | better |  |
|  | Shuffle + enqueue: queue shown = order played | 0/3 | 3/3 | better |  |
| **S9** | Failing song: notice (ms) | 1285 | 1284 | same |  |
|  | Failing song: next one plays (ms) | 4297 | 3096 | better |  |
|  | Two failing: a song plays (ms) | 7809 | 5401 | better |  |
|  | Two failing: skip loop | 0/3 | 0/3 | same |  |
|  | Last song fails: bar = player | 0/3 | 3/3 | better |  |
| **S10** | Phone tap: feedback (ms) | 18 | 18 | same | pass → pass |
|  | Phone tap: audio (ms) | 2445 | 2442 | same |  |
|  | Phone long-press: menu | 3/3 | 3/3 | same |  |
|  | Phone long-press: also played | 0/3 | 0/3 | same |  |
| **S11** | Scroll (video docked): commits/event | 1.13 | 0.1 | better |  |
|  | Scroll: components rendered | 6392 | 3 | better |  |
|  | Scroll: video off its slot (px) | 0 | 1 | worse |  |
| **S12** | YouTube unreachable: error + Retry ≤ 13 s | 0/3 | 3/3 | better |  |
|  | YouTube unreachable: error shown (ms) | — | 1019 | new |  |
|  | YouTube back: Retry plays | 0/3 | 3/3 | better |  |
| **S13** | Playing on 50 search results: renders/s | 721.2 | 2 | better |  |
|  | Playing on 50 search results: commits/s | 2 | 2 | same |  |

#### Hard checks (after; baseline-v2 in brackets)

| Scenario | Check | Result |
|---|---|---|
| S2 | Play a song (cold): feedback ≤ 150 ms | pass (pass) |
| S2 | Play a song (another playing): feedback ≤ 150 ms | pass (pass) |
| S3 | Pause while buffering: feedback ≤ 150 ms | pass (FAIL) |
| S3 | Pause while playing: feedback ≤ 150 ms | pass (pass) |
| S3 | Play while paused: feedback ≤ 150 ms | pass (FAIL) |
| S4 | Next: feedback ≤ 150 ms | pass (FAIL) |
| S8 | Riproduci dopo: feedback ≤ 150 ms | pass (pass) |
| S2 | wrong song shown = 0 ms (cold) | pass (pass) |
| S2 | wrong song shown = 0 ms (warm) | pass (pass) |
| S3 | pause pressed while buffering is honoured | pass (FAIL) |
| S8 | queue shown = order played | pass (FAIL) |
| S9 | no skip loop (one) | pass (pass) |
| S9 | no skip loop (twoInARow) | pass (pass) |
| S9 | no skip loop (lastInList) | pass (pass) |
| S9 | last song failed: nothing plays and the button offers Play | pass (FAIL) |
| S9 | last song failed: no endless spinner | pass (pass) |

Verdict: numbers within 10% (and 20 ms) count as the same. `--all` prints every field.
