# TEAM GTD FINALE — realtime collaborative board (handoff)

A team GTD + Kanban board, rebuilt from the original single-file HTML artifact
into a modern React app with **real-time multi-user collaboration**, hosted for
free on **Netlify** (frontend) + **Supabase** (Postgres + realtime).

This README doubles as the project handoff: what it does, how it's built, the
full file map, how to run and deploy it, and how to extend it.

- **Stack:** React 18 + Vite + TypeScript + Tailwind CSS · Supabase (Postgres
  realtime, auto REST) · Netlify static hosting.
- **Repo:** `Gualbertol123/prova_sito_GTD`. Active work is on branch
  `claude/hopeful-noether-u6oblf` (Netlify currently deploys this branch). The
  frontend lives entirely in `web/`; there is **no custom backend server** — the
  browser talks straight to Supabase.
- **Look:** navy `#0A1931`, gold `#C9A96E`, cream backgrounds; **Cinzel**
  (display) + **Inter** (body) fonts. Bilingual **Italian / English**.

---

## 1. Feature tour (by tab)

| Tab | What it does |
| --- | --- |
| **BOARD** | Kanban with 6 columns (Backlog · Next · In Progress · Waiting · Done · Maybe) **and** a List view (toggle, remembered). Cards expand **inline** (no popups) into a full editor: assignees, priority pills, due date, description, notes, a **File Directory** field with a copy button, a "move to section" dropdown, prev/next arrows, and drag-reorderable subtasks. Columns fill the width edge-to-edge, wrap instead of scrolling, can be shown/hidden (**Columns** editor), and resized in an **edit-layout** mode (neighbours adjust). Below the columns are two full-width collapsible bars, each with its own search: a **Done** bar (this week's completed tasks — a searchable mirror of the DONE column, cards stay in the column too) and an **Archived** bar (tasks completed more than a week ago, auto-moved out of the DONE column). A **Team** panel (collapsed) manages members; a collapsible **priority distribution** chart; a full new-task bar (choose assignees/priority/status/due up front); search + owner/priority/Focus-P1 filters. A task can be held by **one person or several** — open the assignee pill to tick names; the first one stays the `owner` column, so filters and the weekly recap all count a shared task for everyone on it. Below Archived, a **Menu mensa** bar (open by default) shows the canteen menu of today and the next four menu days — today highlighted, its dish of the day in the bar's header — from `web/src/data/menu.json` (§8, updated monthly; past days never shown). A **Names** toggle next to **Columns** blanks every owner name on the board (cards, list rows, the expanded editor and the new-task bar) so you can screenshot it — it is per-session only and names are always back on next load. |
| **PROJECTS** | Two filters, **Ongoing** and **Completed**. A project's status is never set by hand: it is *ongoing* until it has linked board tasks and **every one is DONE**, then it moves to *completed* on its own (dated by its last task's completion), and back to ongoing if a task is reopened or a new one is added. **Ongoing** shows figures (ongoing, completed this week, need attention, open tasks), search, a lead filter, sorting, and two views: **Cards** (colour, priority, progress ring, a bar of its tasks by status, overdue count, next task due, leads, target date, health badge) and **Timeline** (start-to-target bars with progress and a line for today). **Completed** works like the board's Done/Archived: **Recently completed** (last 7 days) as cards, then a collapsible **Older** list. A project's **page** has name, priority, start/target dates, colour, leads, a short description, a progress ring, health (on track / at risk / overdue), tasks per status, a time-vs-work strip, a small **Notes** box, and the **Tasks** section: a status breakdown, a new-task form (title, status, priority, holder, due date) that creates the task on the board already linked, a picker to link an existing board task, search and a person filter, and two views — a **List** grouped by status (tick done, change status inline, due/overdue chips, holders, subtasks, waiting days, unlink, open the full task editor; completed tasks hidden until shown) and a **Board** of the project's tasks where cards are dragged between columns. Progress = linked tasks in DONE ÷ linked tasks. Each project also chooses how its tasks reach the main board (**On the BOARD**: *All tasks* · *In sequence* · *Project only*): in sequence only the current step — the first task in the project's order that is not DONE — is on the BOARD, and when it is done the next one appears there by itself (the list then shows numbered steps with ▲ ▼ to reorder; board cards show *Step n/N*); *Project only* keeps them off the BOARD altogether. Tasks kept off the BOARD are also left out of the report's Next and Planner pages and the mail update's next steps, but still count in Done and appear in the Calendar. On the BOARD, a task card shows its project as a coloured chip and the task editor has a project picker. Projects used to have checklists; a project that still holds one shows it once, with **Turn into tasks** / **Copy into notes**. Needs migration 015 (§3); before it, projects have a name only and the tab says what to run. |
| **WEEKLY** | Weekly review: a "Recap" block auto-fills from tasks completed **this week** (with owner + subtask progress), a collapsible **Archived** section for tasks done more than a week ago, plus 5 editable retro columns: WINS · LEARNINGS · TO IMPROVE · BLOCKERS · FOCUS NEXT WEEK. |
| **REPORT** | Builds the weekly report as **A4 pages in Liquid Glass** (light mode) right in the tab (see §5): a cover with the week's numbers, then Done, Next, Projects and the Planner. Click any text on the pages to edit it; hover a card and press × to leave it out; **Download PDF** saves exactly what is on screen. The old Intesa Sanpaolo Word template is still one click away as **Word (classic template)**. |
| **CALENDAR** | Month grid; drag a task onto a day to set its due date. Click any task to open its full details in the left panel. Day cells grow to fit all their items. |
| **REFLECTION** | **Personal**, behind a per-user password (initial password `password`; choose your name + password to enter, with a "remember on this device for" duration incl. Forever). Log one entry per day with 4 fields (Done today · What went well · What to improve · Learning notes); see only **your own** recent entries and a **spaced-repetition review** (1/3/7/14/30-day intervals + random). Inside you can change your own password (the current one is required). Passwords are stored as **bcrypt hashes** and checked by the database (`reflection_login`); 5 wrong tries lock that name for 5 minutes; an admin resets a forgotten one from Supabase (§11). A **Diary / Notes** switch at the top of the tab, behind the same password, holds **Personal notes**: free-form notes only you see, in the `personal_notes` table (the chip carries their count, and the tab reopens on whichever half you used last). Private from outsiders, but *within the team* the privacy is in the interface only — see §11. |
| **SETTINGS** | Custom logo (round header box) + favicon upload (rasterised & downscaled, ≤5 MB input); change the shared team password (current one required; logs every other device out); login duration; log out this device. Subtitle is edited **inline** by double-clicking it in the header. |

### 1b. On a phone

A phone-sized screen (767 px wide or less) gets a separate **mobile version**
built for one hand, on the same board, live sync, data and operations; nothing
about the desktop changes. A floating glass bar at the bottom holds **Oggi ·
Board · ＋ · Progetti · Agenda** (the + in the middle adds a task); **Altro**
is the avatar button at the top right. The bar steps aside while you type,
and sheets move up above the on-screen keyboard. The screens:

| Tab | What it does |
| --- | --- |
| **Oggi / Today** | What needs *you*: your overdue and due-today tasks, what you are in the middle of, the next 7 days, what you are waiting on (longest first), the week's done count, and the canteen's dish of the day (tap for the full menu). The tab shows a badge with your overdue + due-today count. |
| **Board** | As many columns side by side as the screen fits (about 300 px each: one on a phone held upright, two or three in landscape or on a tablet); swipe sideways to move along them, column by column, or tap a column pill (with counts). **Colonne** hides and shows columns (at least one stays; the same per-device setting as the desktop's Columns editor). A sideways swipe here always changes column, even over a card: cards are completed with their round check. Cards are sorted by priority, then due date. Search, **Only mine** and P1–P4 filters. DONE shows this week; archived ones are one tap away. Each column has **Add here**. |
| **Progetti / Projects** | Ongoing / Completed. Cards with a progress ring, a bar of tasks by status, health, target date, open and overdue counts. A project opens as a sheet: its tasks by column, add a task to it, notes. Dates, colour, leads and step order are edited on the desktop. |
| **Agenda** | A week strip (dots = tasks due), the chosen day's tasks, overdue ones on today, then the next two weeks. Add a task straight onto a day. Shows every dated task, like the desktop calendar. |
| **Altro / More** | Weekly review (stacked, mobile-native), Mail update, and the desktop Report, Reflection, Products and Settings screens. |

On any task card the round check on the left (its ring is the priority
colour: red P1, orange P2, grey P3) marks it done; **swipe right** does the
same and **swipe left** opens *Move to…* (on Oggi, Agenda and project
lists; on the Board a sideways swipe changes column); **tap** opens the task as a
full-height sheet: the title with its check, then the details as a grouped
list (Status, Priority, Due, Assigned to, Project), where each row opens its
own chooser. The project chooser shows every project with its colour, a
progress ring, open tasks, target date and health, completed ones apart.
Then subtasks, description, notes, file folder, and Delete / Mark as done.
Done, move and delete each show a toast with **Undo** instead of an "are you
sure?". The blue **+** in the middle of the bar adds a task: type a title; the
other properties (priority, due, people, status, project) start from
defaults and sit below it as tokens, each one tap from the same choosers.

**Altro → your name** (the first row) sets who you are on this device,
the language, light or dark, and **Use the desktop version**. The desktop
layout on a phone then shows a **Mobile version →** bar at the top to switch
back. The choice is per device (`gtd-layout` in localStorage: `auto`, `mobile`
or `desktop`). The mobile app wears the same **Liquid Glass** as the desktop
(§10): it reads the desktop skin's own tokens — wallpaper, glass film, rims,
sheen, Apple's system colours, label steps — so it follows light / dark with
it. The tab bar floats as a glass capsule with the + beside it, as on iOS 26.
With the classic skin it falls back to the cream / navy / gold look.
**Intensità colori** (the ◐ button in the desktop header, or Altro → Aspetto
on a phone) turns the colour of the whole GTD down to grey (0%) or up to more
vivid (150%); 100% is the design as drawn. It is per device (`gtd-color`) and
never affects printing or the PDF report.
**Aspetto** (Altro, right under your name) is Scuro, Chiaro or **Auto**:
Auto follows the phone's or computer's own light / dark setting, live, which
suits the installed app. The desktop header has the same choice (☀ ☾ A).

### 1c. Addresses and the Back button

Where you are is part of the address (`lib/history.ts`), so the browser's
**Back** and **Forward** work and a link or a reload opens the same place:
`#/board`, `#/projects`, `#/projects/<id>` (an open project), `#/weekly`,
`#/calendario`, … on the desktop; `#/today`, `#/board`, `#/projects`,
`#/agenda`, `#/more`, `#/more/weekly`, … on a phone. Each layout understands
the other's addresses (the desktop calendar is the phone's Agenda, the
desktop Weekly is *More → Weekly*), so switching layout keeps your place.
Sheets and pop-ups (the task, project, add and chooser sheets on a phone, the
mail pop-up on the desktop) add a step of their own: Back closes the one on
top first. Closing one with ×, a swipe or Escape removes its step again.

### 1d. Install it as an app (PWA)

The site is an installable app. On Android / Chrome / Edge: the **Install the
app** button in the phone's *You* sheet (or the browser's own install icon on
a computer). On iPhone / iPad: Safari → **Share → Add to Home Screen** (the
same button shows these steps). It then opens full screen from its own icon,
with long-press shortcuts **New task**, **Today** and **Agenda**. On iOS the
installed app keeps its own login, so the team password is asked once more.

`public/manifest.webmanifest` describes it (name, colours, icons in
`public/icons/`, shortcuts); `public/sw.js` is the service worker, registered
in production only (`lib/pwa.ts`). It caches the app's **code only** — the
HTML shell, the hashed `/assets` files, icons, fonts — so it opens fast and
still opens offline (it then says it cannot reach the server). It never
caches board data: Supabase is on another origin and is never intercepted,
and only GET requests to the site itself are handled, so tasks, notes and
reflections still live in memory only. Page loads go to the network first,
so a new deploy shows up at once. To throw away every cached file, change
`VERSION` in `sw.js`. Netlify serves `sw.js` and the manifest with
`Cache-Control: no-cache` (`netlify.toml`).

### 1e. Music

A music player for the team, on desktop and phone, built on **YouTube's
official embedded player** (the same source as freefy.app): free, and the app
adds no ads. YouTube itself may show ads on some videos (none with YouTube
Premium). Nothing is downloaded or stored: only video ids and titles.

- **Finding music: YouTube.js, no quota.** Search, suggestions while typing,
  *Radio* (a song + ~50 like it), YouTube Music's trends and charts (per
  country), any artist's page and playlist import all go through
  [YouTube.js](https://ytjs.dev) (`youtubei.js`) in the server functions
  (`netlify/lib/ytjs.mts`): it reads YouTube like its own website does, so
  there is **no API key involved and no daily limit**. It is unofficial: if
  YouTube changes its internals or challenges the server, search and import
  fall back automatically to the official Data API key (100 units a search,
  10,000 a day); trends, charts, radio and suggestions just say "try again".
- **Playing has no limit either:** songs always play in YouTube's official
  embedded player in the browser, which no quota applies to.
- **Home (MUSICA tab):** trending songs (play all, or one), quick tiles,
  charts by country (Italia, Mondo, Spagna, USA, …) with YouTube Music's chart
  playlists, the team's playlists, the most listened artists, new music
  videos. The three favourite artists (**Enrique Iglesias, Ricky Martin,
  Tiziano Ferro**, *Mix preferiti*) are still there, at the bottom.
- **Song menu:** right-click any song (long-press on a touch screen, or the
  keyboard's menu key): *Riproduci*, *Riproduci dopo*, *Aggiungi alla coda*,
  *Avvia radio* (the song + ~50 like it), *Salva radio come playlist* (see
  *Radio playlists* below), *Aggiungi a playlist*, *Rimuovi
  dalla playlist* (inside a team playlist), *Apri su YouTube*, *Copia link*
  (`components/SongMenu.tsx`). Icons are one SVG set in the Liquid Glass style
  (`components/MusicIcons.tsx`), no emoji.
- **Ads:** the app adds none; YouTube may show its own on some videos.
  *Ho YouTube Premium* (♪ panel / *In riproduzione*) loads the player from
  youtube.com instead of youtube-nocookie.com, so a Premium login in that
  browser removes them (not in Safari / on iPhone, which block YouTube's
  cookies in other sites). Saved per browser (`gtd-music-premium`).
- **Solo musica / Video:** music only by default (the song's cover is shown,
  the video is hidden); Video shows it. Note: YouTube's rules for embedded
  players ask for a visible player of at least 200 × 200 px, which only Video
  mode does.
- **One player everywhere:** the YouTube player is mounted once at the app's
  root (`components/MusicPlayer.tsx`), so it keeps playing across tabs and
  layouts, and every view — the ♪ panel, the small player, the phone's
  *Altro → Musica*, the MUSICA tab — shows the same song, position, play /
  pause, queue, shuffle, repeat and volume (`lib/music.ts` is the one state).
- **MUSICA tab (desktop):** a full music app — Home (mix, artists, team
  playlists), Search, artist pages (play all, *Popolari* by views), playlist
  pages (play, shuffle, rename by clicking the title, reorder, remove,
  delete), *In riproduzione* with the queue, and a player bar with seek,
  shuffle, repeat, volume and the music / video switch.
- **Search results, official first:** every search result is classified on
  the server (`classify` in `src/lib/musicSort.ts`, shared with `matchSong`):
  *official* (the artist's own channel — YouTube's ♪ "Official Artist
  Channel" badge with the channel named in the title, VEVO, or the channel
  being the artist named first), *official audio* ("- Topic", "Official
  Audio"), *live*, *cover* (covers, karaoke, lyric uploads, remixes and
  slowed / 8D / loop edits, fan uploads) or *other*. The Search page and the ♪
  panel sort them instantly, no new request: **Ufficiali prima** (default;
  YouTube's order inside each group, an official video of another song or by
  another act goes with the rest), **Pertinenza** (YouTube's order), **Più
  visti** (when YouTube.js gave view counts), plus **Nascondi cover e versioni
  non ufficiali**. Both choices are kept per browser (`gtd-music-sort`). The
  first official result has an *Ufficiale* badge; play and the queue follow
  the order shown.
- **Team playlists:** stored in Supabase (`music_playlists`, migration 018),
  shared by everyone on the team and live-updated; **+** on any song adds it
  to a playlist or a new one. Also playable from the ♪ panel and on a phone.
- **Radio playlists (updated daily):** *Salva radio come playlist* in the song
  menu saves the song's radio as a team playlist, *Radio · (song title)*, with the
  longest radio YouTube gives: YouTube Music's up-next mix (`RDAMVM<id>`)
  with its continuations (`radioFull` in `netlify/lib/ytjs.mts`,
  `music-browse?radio=ID&full=1`). That is usually **~60–110 songs**: after
  that YouTube only repeats them (the cap is 200, never reached in tests).
  Where YouTube answers with its short generic mix, songs by the same artist
  are mixed in, as for *Avvia radio*. Once a day a team browser with the
  music open asks for the radio again and saves the new songs, or just the
  check if they are the same (`music_playlist_radio_refresh`, migration 021:
  only one browser can do it per day). A song that is playing keeps playing:
  only the stored list changes. The playlist page shows *Radio · aggiornata
  ogni giorno* with the last update and **Stacca** (stop updating). Editing
  its songs (add, remove, reorder) also stops the updates, so they never
  overwrite your changes; renaming does not. Before migration 021 runs, the
  radio is saved as an ordinary playlist and the app says the update needs 021.
- **Imported playlists stay in sync (daily + Sincronizza):** a playlist
  imported from a Spotify playlist / album link, from *La mia libreria
  Spotify* (a playlist, an album, the liked songs) or from a YouTube playlist
  remembers its source (migration 022; a pasted list of track links has none).
  Once a day a team browser with the music open (after load and when the page
  comes back, at most hourly per browser) reads the source again: Spotify with
  the signed-in person's token when there is one, else the server (the embed
  page gives a playlist's first 100: the sync is then *limited* and keeps the
  songs already there past those); the liked songs only with the sign-in of
  whoever imported them (otherwise skipped). Songs are compared by their
  Spotify id (or title + artist when the server gave no id) or YouTube id:
  existing matches are kept, only NEW songs are searched on YouTube, songs
  removed at the source are dropped, and the source's order is followed.
  `music_playlist_source_sync` writes only if the playlist is still due by
  the database clock, so only one browser does it per day, and only if the
  list is still the one the sync was planned on (`p_expect`): a song added or
  removed by hand during a sync is kept as edited (the sync plans again). A queue that is
  playing is never changed. The playlist header shows the source, the last
  sync, *Auto ogni giorno · Stacca* and **Sincronizza** (also on radio
  playlists, where it refreshes the radio now): spinner, "n di m" while
  matching, then "+3 nuovi, −1 rimossi, 2 non trovati" or "Già aggiornata",
  with the songs not found listed and *Cerca manualmente*. Editing the songs
  by hand detaches the daily sync (`source_auto = false`, the source is
  kept): **Sincronizza** still works as a one-off and *Riattiva sync
  automatica* turns it back on. Renaming keeps it.
- **One click: *Aggiungi tutte le mie playlist* and the check**
  (`src/lib/spotifyAddAll.ts`, `components/SpotifyCheck.tsx`). One primary
  button, on *La mia libreria Spotify* and on *Importa*: it adds every own and
  collaborative Spotify playlist plus *Brani che ti piacciono* to the team
  library, saved straight away under the Spotify name with their source (no
  review, no edit step: rename later on the playlist page). Not signed in, it
  starts *Accedi con Spotify* and the import starts by itself on the way back.
  A list already added (a team playlist with source `spotify-playlist/<id>`,
  or `spotify-liked` of this Spotify account) is skipped; an older import of
  yours with the same name and no source (every song from Spotify) is linked
  to it instead of duplicated, and its first sync keeps all its songs; a
  same-name playlist made by hand or by someone else is never touched (the
  list is added as its own playlist); empty playlists are not followed; Spotify's
  own and other people's playlists can't be read (details only) and are left
  out with a note. The job runs in the background (it survives navigation),
  one list at a time, a song in several playlists is matched once, one failing
  list never stops the others, and *Annulla* stops it. Progress: *Playlist 3 di
  12 · brani 40 di 85*, and the sidebar's *Importa* shows `3/12`. **The
  check**, *Le tue playlist Spotify* (top of *Le mie playlist*), lists each
  list against the team playlists' sources (realtime, so it is the real state):
  *Aggiunta* (songs vs Spotify's count, last sync), *In corso*, *Incompleta*
  (N songs not found on YouTube at the last import / sync, kept in this
  browser, never Spotify's raw count: *Riprova i mancanti* syncs that same team
  playlist; *Vedi*), *Errore* (why, *Riprova*), *Da aggiungere* (*Aggiungi*),
  with a summary: *12 di 12 playlist aggiunte*, or *9 di 12 aggiunte · 2
  incomplete · 1 da aggiungere*. The same one click everywhere else: a list's
  *Aggiungi alla libreria del team* in the library (a playlist, an album, the
  liked songs; *Già nella libreria · Apri* when it is in), and the Importa
  link field (a Spotify playlist / album link, pasted Spotify track links named
  *Da Spotify (N brani)*, or a YouTube / YouTube Music playlist with source
  `youtube-playlist`), each ending with a toast *Aggiunta «X» (N brani, M non
  trovati)* and *Apri*. *Anteprima* next to the field is the old look-first
  page, optional. Check: `node scripts/e2e/spotify-addall.mjs` (Playwright,
  everything mocked).
- **Importa (MUSICA tab):** bring any public YouTube or YouTube Music
  playlist into the team library — paste its link (`…playlist?list=…`, also
  `music.youtube.com` links) and press *Aggiungi* (one click, above), or
  search YouTube's playlists (suggested
  searches for the three favourite artists and a few genres). The preview
  plays it straight away; **Salva nella libreria del team** stores it (up to
  200 songs, deleted / private videos skipped) as an ordinary team playlist.
  YouTube's auto-generated *Mix* lists (`RD…`) and private lists can't be read.
  Server side: `netlify/functions/music-playlist.mts` (same key and login).
- **Importa da Spotify (the Importa link field, or *Anteprima* to look
  first):** paste a public Spotify playlist or album link. Its songs are
  read, each one is found on YouTube with YouTube.js, preferring official
  videos (`matchSong` in `netlify/lib/ytjs.mts`, with a progress bar that keeps
  going if you leave the page), then it is saved as a team playlist (with
  *Anteprima*: it plays, then *Salva*); songs not found are listed. Where the songs come from
  (`netlify/lib/spotify.mts`, function `netlify/functions/music-spotify.mts`):
  - **With the site's Spotify keys** (optional, see Setup step 4): the official
    Spotify Web API. Since Spotify's February/March 2026 rules, an app in
    *Development Mode* (the default) gets with these keys (Client Credentials,
    no user) **only a playlist's details** (name, cover): the songs then come
    from the embed page below (first 100), keeping the API's name and cover,
    and the page says why. Albums, and apps in *Extended Quota Mode*, still
    give every song, up to 1000. Both the old (`tracks`) and new (`items`)
    answer shapes are read.
  - **Accedi con Spotify** (optional, Setup step 4): a person signs in with
    their own Spotify account in the browser (Authorization Code with PKCE,
    no secret). The sign-in belongs to the **person picked in the identity
    menu on this device** (the team shares one login), never to the shared
    account and never in the database; see *Spotify sign-in: per person, per
    device* below. Their **own and collaborative
    playlists** are then read whole (up to 1000) straight from Spotify; for
    anyone else's playlist Spotify still gives only the details, so the
    first 100 come from the embed page. A Development Mode app needs its
    owner to have **Spotify Premium** and allows **at most 5 users**, each
    added in the dashboard under *User Management* (name + Spotify e-mail).
  - **Without keys**, or when the API refuses: Spotify's public embed page, no
    account and no key, but only a playlist's **first 100 songs** (an album's
    all). The page then explains how to get the rest. Since late 2024 Spotify
    refuses new apps the playlists made by Spotify itself (editorial and
    algorithmic ones, ids often starting `37i9dQZF1`), so those need the
    paste method below even with keys.
  - **Paste the songs (no key needed, any length, works for every playlist):** in the Spotify desktop or
    web app open the playlist, click a song, press **Ctrl+A** (Cmd+A on a
    Mac), then **Ctrl+C**, and paste into the Spotify link field. That copies
    one `https://open.spotify.com/track/…` link per song; each song is read
    from its own public embed page (step 1 of 2), then found on YouTube (step
    2 of 2). The list is named *Da Spotify (N brani)* (rename it on its page).

  The embed pages are unofficial: if Spotify changes them, the import says so.
  Nothing taken from them is used to call Spotify's API; only the site's own
  keys and the signed-in person's own token are.
- **La mia libreria Spotify (MUSICA tab sidebar, after *Accedi con
  Spotify*):** your own Spotify library, read in the browser with your token
  (`src/lib/spotifyLibrary.ts`, `components/SpotifyLibrary.tsx`,
  `#/music/splib/…`). Sections: *Le mie playlist* (`/me/playlists`, every
  page), *Brani che ti piacciono* (`/me/tracks`, 50 a page, up to 2000, with a
  note when there are more), *Album salvati*, *Artisti seguiti* (an artist
  opens its albums, an album its songs), *Ascoltati di recente* (last 50) and
  *Cerca su Spotify* (songs, albums, playlists; 10 per type, *Altri risultati*
  pages on). Anything opens to its songs; someone else's or Spotify's own
  playlists give only the details (Spotify's 2026 rule), and the page offers
  the paste method. **Aggiungi alla libreria del team** on any playlist,
  album, the liked songs or the recent list saves it in one click (the
  background job above: each song found on YouTube, named after the list,
  with its source); **+** on a
  single song adds it to a team playlist. Every song saved this way, and every
  song of the link / pasted import when Spotify gave its id, keeps its Spotify
  track id (`Track.spotify`), so Spotify mode plays it without searching.
  Every item shows its cover, a *da Spotify* label and *Apri su Spotify*
  (Spotify's attribution rules); Spotify is credited in words, never with a
  redrawn copy of its icon (its branding rules allow only the official mark).
  **Policy risk, still to be decided by the site owner:** Spotify's Developer
  Policy forbids products "integrated with streams or content from another
  service", and this import turns Spotify metadata into YouTube songs that
  play YouTube audio in YouTube mode. To keep that apart, the import carries no
  Spotify cover art or mark into the team library, song rows with **+** show
  no Spotify art, and the import sits in its own panel saying the result is
  YouTube songs. The fully compliant alternative is to play the library only
  in Spotify mode and drop the YouTube import. Calls: a 10 s timeout, one
  token refresh on 401 (shared with the player, never cancelled by leaving a
  page; a refresh that does not answer says "network", a second 401 signs
  out); a 429 (the app's rate limit / Development Mode quota) shows "riprova
  tra N s". Signing in again once is needed to grant the library permissions.
  Check: `node scripts/e2e/spotify-library.mjs` (Playwright, everything mocked).
- **YouTube | Spotify (play with Spotify):** a switch in the player bar
  (MUSICA tab) and at the top of the ♪ panel / phone player chooses who plays
  the queue. **Spotify** plays it in this browser through Spotify's official
  Web Playback SDK, as a Spotify device called *Team GTD*
  (`src/lib/spotifyPlayer.ts`); YouTube is the default.
  - **Kept separate by design** (Spotify's Developer Policy forbids mixing
    its streams with another service's): switching pauses the other service
    first, the queue is kept, and in Spotify mode everything plays only on
    Spotify. YouTube's frame is hidden entirely; radio, *Mix preferiti*, the
    artists' channels and pasted YouTube playlist links stay YouTube only (a
    hint says so).
  - Each song plays as its Spotify twin: the Spotify id kept in the team
    playlist (`Track.spotify`), or one found with Spotify's search (title,
    artist, length; official versions over live / remix / karaoke) and kept in
    this browser. A song not on Spotify is **skipped** with a toast, never
    played from YouTube. Spotify gets up to 50 songs at a time
    (`PUT /me/player/play`); next, pause, seek and volume go to the SDK.
  - Spotify's cover art and its own title and artists are shown for the song
    playing, with *Brano fornito da Spotify* and **Apri su Spotify**.
  - **Needs:** Spotify **Premium** for every listener, the person added in the
    Spotify app's *User Management* (Development Mode: at most 5), and
    signing in again once (*Accedi con Spotify*) for the playback
    permissions. Choosing Spotify without a sign-in starts it. No Premium, an
    unsupported browser or an old sign-in: a toast says why and the player
    goes back to YouTube. Works best on desktop Chrome, Edge or Firefox; on a
    phone, iOS needs a tap to start (*Riproduci*) and the volume is the
    phone's buttons. Check: `node scripts/perf/spotify.mjs` (Playwright, a
    fake SDK and a mocked Spotify; nothing real is called).
  - **Spotify sign-in: per person, per device** (`src/lib/spotifyAuth.ts`).
    The token (access, refresh, expiry) is kept under
    `gtd-spotify-token:<name>` for the name picked on this device, sealed with
    AES-GCM under a key made on this device by WebCrypto with
    `extractable: false` and kept in IndexedDB (`gtd-spotify` / `keys`).
    localStorage holds only `{iv, ct}`, and the name is sealed in too. A copy
    of the entry on another browser or device can't be opened there: it is
    removed and that person is signed out. The token is decrypted once into
    memory, at startup or when the name changes. Without WebCrypto or
    IndexedDB (private mode, an old browser) it stays in memory for the tab
    only, never in plain storage. Plain-text tokens from older versions are
    removed, so people sign in again once. Without a name picked there is no
    sign-in. A name change switches the session, also when the name is
    changed in another tab (the `storage` event, or the next Spotify call
    notices it); in Spotify mode, if the new person isn't signed in here, the
    player goes back to YouTube with a toast. A player command never goes out
    with another person's token to the previous person's device. Token
    refreshes are per person and serialized across tabs (Web Locks): a tab
    that finds a newer token stored by another tab uses it instead of spending
    the rotated refresh token again. Only Spotify's `400 invalid_grant` signs
    that person out (only them, even if the name changed meanwhile); a 5xx,
    429 or no answer keeps the sign-in. If IndexedDB does not answer within
    3 s (a stuck WebKit open), the tab is signed out with a toast and the
    sealed entry is kept for later.
    **Limit:** anyone using the same browser profile who picks someone else's
    name in the menu gets that person's session on that device. The menu is a
    convenience, not a login. Use separate browser profiles, or *Esci*, on
    shared computers.
  - **Plays only on this device** (`src/lib/spotifyPlayer.ts`). Every
    player command carries `device_id` = this browser's *Team GTD* device;
    anything else is refused before it is sent, so Spotify's "active device"
    (someone's phone, another computer) is never used. If the device isn't
    ready, nothing is sent and a toast says so. If playback moves to another
    device (from the Spotify app, or `GET /me/player` names another device),
    the player shows paused here with *In riproduzione su un altro
    dispositivo* and does not take it back. Only *Riproduci* here does.
  - **A network that blocks Spotify:** if the SDK script fails or takes more
    than 10 s, a fetch fails, or the SDK's websocket gives no *ready* within
    15 s, a toast says *Spotify non è raggiungibile da questa rete: torno a
    YouTube* and the player goes back to YouTube with the same queue (details
    in the `[music]` log). Nothing tries to get round the block: no proxy and
    no other host. A network admin can allow `accounts.spotify.com`,
    `api.spotify.com`, `*.spotify.com` (https and wss), `sdk.scdn.co`,
    `*.scdn.co` and `*.spotifycdn.com`.
- On a phone the music stops when the screen locks or the app goes to the
  background (a limit of YouTube embeds on iOS / Android).
- **Every control answers at once.**
  - The app keeps the queue itself, in the order songs will play, shuffle included. YouTube only receives the ids, so the song shown, the queue and the highlighted row always agree.
  - Play, pause, next and a song click change the screen immediately. A ring spins on the play button until YouTube confirms the song is playing, and a pause pressed while it buffers is honoured.
  - Messages appear in a small pill and never replace the song title.
  - A song YouTube refuses is skipped straight away. Playback stops after 5 refusals in a row or a full lap of the list.
  - If YouTube can't be reached (an ad-blocker or the network), the player says so and offers *Riprova*.
  - The 500 ms position update redraws only the seek bar.
  - **If YouTube refuses to start** (a phone's autoplay rule, or YouTube's own "confirm you're not a bot" / age wall), the app doesn't spin forever. It shows YouTube's frame with *Tocca il video per avviare la musica*, and one tap inside the frame starts the music. A stall while loading, or a song that doesn't move on, also gives up after a few seconds instead of spinning.
  - **A song that stalls while playing is rescued by itself, at the same second.** This is YouTube stuck reloading it, which is network trouble. Each step runs only if the one before didn't help, and the screen keeps the loading ring the whole time:
    1. after 4 s, the app nudges YouTube (it seeks to the same point and resumes);
    2. then it reloads the song at that second (a new stream connection);
    3. as a last resort it builds a fresh YouTube player (a new connection) and goes on at the same song and second.
    - If the device is offline, the song goes on the moment the connection returns.
    - A song that already played is never stopped or shown as paused. The page being in the background never counts as a stall.
  - **Console log:** every command sent to YouTube, every YouTube event, and what the app decided, as `[music] …` lines in the browser console.
    - `__music.dump()` prints the last 500 lines with the current state. Send it along when reporting a playback problem.
    - Turn it off with `localStorage.setItem("gtd-music-log","0")`.
- **Every song has a ⋯ button** for the song menu, alongside right-click and long-press.
  - A single click plays the song, and Enter / Space work from the keyboard.
  - Removing a song or deleting a playlist can be undone for a few seconds.
  - New names are typed in place; there are no browser pop-ups.
  - The MUSICA tab's pages are in the address (`#/music/search/…`, `#/music/playlist/…`), so Back returns to the previous music page.
- **Server:**
  - A team-login check is remembered for 5 minutes per login.
  - Answers are kept in memory for a while (search 10 min, charts 1 h, …), and every call has a time limit.
  - Errors come back as short codes, shown in Italian or English.
- **Measuring it:** `npm run perf:music` in `web/` drives the app in a headless browser, using a deliberately slow fake YouTube player and a mocked Supabase. `npm run perf:music:check` is the quick pass/fail version. `npm run perf:fns` times the four functions cold and warm. See `web/scripts/perf/README.md`.

**Setup (once):**
1. Supabase → SQL Editor: run `supabase/migration-018-music-playlists.sql`,
   then `supabase/migration-019-music-playlist-rpc.sql` (playlist edits made
   one step at a time in the database, so teammates editing the same playlist
   don't lose each other's songs; before it runs the app falls back to saving
   the whole list), then `supabase/migration-020-music-playlist-clock.sql`
   (the database stamps every playlist change with its own clock, so a
   teammate's computer clock being off can't hide newer edits).
2. Netlify → Site configuration → Environment variables: add
   `YOUTUBE_API_KEY` = your YouTube Data API v3 key, then redeploy. (Optional
   since YouTube.js: it is now only the fallback when YouTube.js fails.) The key is
   only read by the server function `netlify/functions/music-search.mts`
   (team login required), never sent to browsers, and **must never be put in
   the code** — this repository is public.
3. Google Cloud → Credentials → the key → *API restrictions*: allow only
   *YouTube Data API v3*. (Leave *Application restrictions* on None: the
   calls come from Netlify's servers, which have no fixed address.)
   The free quota is 10,000 units a day; a search (songs or playlists) costs
   100, so about 100 searches a day for the whole team. Importing a playlist
   costs only 1 unit per 50 songs, and the suggested playlist searches are
   kept in each browser for a day. When it runs out the player says so and
   offers YouTube's own search until the next day.
4. *(Optional)* **Spotify app**, for "Importa da Spotify" past the first 100
   songs. Free. Under Spotify's 2026 rules for *Development Mode* apps the
   site's keys give only a playlist's details; signing in (*Accedi con
   Spotify*) reads whole the playlists the person owns or collaborates on;
   the app owner needs Spotify Premium; at most 5 users. The paste method
   (Ctrl+A / Ctrl+C) works for every playlist without any of this.
   1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
      → *Create app* (any name and description; tick only *Web API*).
      *Redirect URIs*: add exactly `https://<your-site>/callback` (e.g.
      `https://<your-site>.netlify.app/callback`), then *Add* and *Save*.
      *User Management*: add each person who will sign in (name + the
      e-mail of their Spotify account; at most 5).
   2. Netlify → Site configuration → Environment variables:
      `VITE_SPOTIFY_CLIENT_ID` = the app's *Client ID* (public, read at
      **build** time; it turns on the *Accedi con Spotify* button), and keep
      `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` for the server path (keep
      the secret's scope including *Functions*).
   3. Redeploy (Deploys → Trigger deploy): the build and the functions read
      new variables only after a deploy.
   The secret is read only by `netlify/lib/spotify.mts` on the server, never
   sent to browsers or logged, and **must never be put in the code**. The
   sign-in (`src/lib/spotifyAuth.ts`) needs no secret: the browser exchanges
   the code itself (PKCE) and keeps the token in `sessionStorage`.
   **Spotify mode** (the YouTube | Spotify switch) uses the same app and
   Client ID: nothing more to set up in Netlify. Each listener needs Spotify
   Premium and must be in *User Management*; everyone signs in again once
   to grant the playback permissions (`streaming`, `user-modify-playback-state`,
   `user-read-playback-state`). The CSP in `netlify.toml` already allows the
   SDK (`sdk.scdn.co`, `*.spotify.com`, `*.scdn.co`, `*.spotifycdn.com`).
5. Supabase → SQL Editor: run `supabase/migration-021-music-radio-playlists.sql`
   (after 018–020), so playlists saved with *Salva radio come playlist* update
   themselves once a day. Before it, they are saved as ordinary playlists.
6. Supabase → SQL Editor: run `supabase/migration-022-music-playlist-sources.sql`
   (after 018–021), so playlists imported from Spotify or from a YouTube
   playlist remember their source, sync with it once a day and get the
   **Sincronizza** button. Before it, imports are saved as ordinary playlists
   (the app says so) and no button is shown.

**Why the player frame sends a referrer:** since 2025 YouTube refuses to play
an embed whose page sends none ("Error 153"), and this site sends
`Referrer-Policy: no-referrer`. The player's own frame therefore uses
`strict-origin-when-cross-origin` (YouTube sees the site's address, no path);
everything else still sends nothing. The CSP allows YouTube's script and
frame, and calls to `accounts.spotify.com` / `api.spotify.com` for *Accedi
con Spotify* (`netlify.toml`).

Header extras: editable board title + subtitle (double-click), a **"You"**
identity picker, a live-connection badge, an **IT/EN** toggle, a **Glass**
switch (§10, on by default), and a **Mail update** generator (Completed = DONE, Next steps = FOCUS + NEXT, → clipboard /
mail client). The whole app sits behind a real login (one shared Supabase Auth
account, §11) and is `noindex`.

---

## 2. How it works (architecture)

```
Browser — React SPA (state in memory only)
  │
  │  reads  : @supabase/supabase-js  → SELECT board_meta / tasks / weekly / reflections
  │  writes : one "Op" per edit      → INSERT / UPDATE / DELETE
  │  live   : Postgres realtime (WebSocket) → change events → debounced refetch
  ▼
Supabase project (free tier)
  Supabase Auth (one shared team account) → JWT on every request
  Postgres tables (RLS: logged-in team account only) + realtime publication
```

**Operation model.** The UI never writes SQL. Every edit is a typed `Op`
(`web/src/lib/types.ts`) dispatched through `send(op)`:

1. `useBoard.send(op)` applies the change **optimistically** in memory via
   `applyOpLocal` (`localReducer.ts`) so the UI updates instantly.
2. `writeOp(op, board)` (`db.ts`) translates the op into the matching Supabase
   write(s), mapping camelCase app fields to snake_case columns.
3. Supabase Postgres realtime broadcasts the change; **every** client (including
   the sender) re-reads **just the changed row** (`fetchChange` in `db.ts`;
   for reflections, personal notes and settings, just that table) and folds it
   in (`applyRowChange`, `rowSync.ts`), so the optimistic state reconciles with
   the authoritative rows without re-downloading the board. A burst of more
   than 20 changed rows takes one full `fetchBoard` instead.
4. Subtask edits (add, tick, edit, reorder, delete) go through database
   functions (migration 017) that change only that one subtask against the
   row as it is now, so two people editing the same task's subtasks at once
   do not overwrite each other. Before 017 runs, the app falls back to writing
   the whole array.

**Live-sync robustness** (`useBoard.ts`): realtime is the primary path, backed
by a 30s safety-net full reload while the tab is visible, plus a refetch on tab-focus
and on network `online`, and a full re-pull on every (re)subscribe. So clients
converge even if a realtime packet is missed.

**The report runs entirely in the browser.** It is laid out, edited and turned
into a PDF on the device; no report content is ever uploaded anywhere.

**What is cached in the browser.** Board **data is never cached** — it lives in
memory only, so closing the tab leaves no copy of any task. `localStorage` holds
the **login session** (Supabase access + refresh token, never the password; key
`gtd-session`, `supabaseClient.ts`) and **per-device UI preferences**
(`prefs.ts`):

| Key | Meaning |
| --- | --- |
| `gtd-lang` | UI language (it/en) |
| `gtd-view-mode` | board / list view |
| `gtd-hidden-cols` | hidden Kanban columns |
| `gtd-col-weights` | per-column widths (edit-layout mode) |
| `gtd-prio-collapsed` | priority chart collapsed |
| `gtd-me` | which member "you" are |
| `gtd-reviewed` | learnings reviewed today (spaced review) |
| `gtd-session` | the Supabase Auth session (tokens, not the password) |
| `gtd-auth` | when this device's login ends `{exp}` (Settings → login duration) |
| `gtd-refl-auth` | per-member Reflection login cache (`member → expiry \| "never"`) |
| `gtd-report-draft:<period>` | that week's report edits, kept 7 days; removed on logout |
| `gtd-skin` | mirror of the skin cookie (`glass` default / `classic`) |
| `gtd-appearance` | mirror of the appearance cookie (`dark` default / `light`) |
| `gtd-blur` | glass blur `on` (default) / `off` — off drops every backdrop blur (same as the OS "Reduce transparency"); fixes seams/lines some GPUs draw in blurred panels |
| `gtd-projects-view` | PROJECTS overview as `cards` or `timeline` |
| `gtd-project-tasks-view` | a project's tasks as `list` or `board` |
| `gtd-music-mode` | music player: `audio` (music only, default) / `video` |
| `gtd-music-volume` | music player volume (0–100) |
| `gtd-music-side` | the small video player's corner (`right` / `left`) |
| `gtd-layout` | `auto` (phone-sized → mobile) / `mobile` / `desktop` |
| `gtd-m-tab` | the mobile tab left open |
| `gtd-m-board-col` | the mobile board's column left open |

---

## 3. Data model (Supabase)

Seven tables in `public`, all with **RLS enabled and one policy: the logged-in
team account only** (`is_team_member()`; the anon key alone gets nothing — §11).
All except `reflection_access` are in the `supabase_realtime` publication. A
`private` schema, which the website's API cannot reach, holds the team list.

**`board_meta`** — one row, `id = 'main'`, holds board-wide state:
`board_name`, `members text[]`, `subtitle_it`, `subtitle_en`, `login_days`
(default 7), `logo_url`, `favicon_url` (data URLs). (The old clear-text
`access_password` column is dropped by migration 012.)

**`tasks`** — one row per task: `id`, `title`, `description` (app `desc`),
`owner`, `assignees text[]`, `priority`, `status`, `notes`, `subtasks jsonb`, `due_date`,
`waiting_since`, `file_dir`, `done_at` (completion time → auto-archive after a
week), `updated_at`, `created_at` (ordering within a column). Each entry in
`subtasks` is `{id, text, done, doneAt?}` — `doneAt` is stamped when the subtask
is ticked and cleared when it is unticked, which is what lets the weekly report
attribute partial progress to a week. It lives inside the existing jsonb, so it
needs no migration.

**`weekly`** — one row per weekly-review item: `id`, `bucket`
(well/learnings/improve/blockers/focus), `body`, `created_at`.

**`reflections`** — one row per member per day: `id = "<date>::<member>"`,
`member`, `date`, `done`, `well`, `improve`, `learning`, `updated_at`,
`created_at`.

**`projects`** — one row per project: `id`, `name`, `items jsonb` (the old
checklist, `[{id,text,done,doneAt}]` — no longer edited, offered for
conversion), `created_at`, `updated_at`, `report_hidden`, and since migration
015 `description`, `notes`, `owners text[]`, `priority` (P1–P4), `start_date`,
`target_date` (ISO text) and `color` (`#rrggbb`, empty = automatic). There is
**no status column**: ongoing/completed is worked out from the linked tasks
(`web/src/lib/projects.ts`, which also holds progress, health and the report
selection).

Since migration 016 also `board_mode` (`all` / `sequential` / `none`) and
`task_order` (jsonb array of task ids, the step order). Which tasks the BOARD
shows is worked out from these (`hiddenFromBoard` / `boardTasks` in
`projects.ts`); nothing is written when a step finishes.

**`tasks.project_id`** (migration 015) — the project a task belongs to;
`on delete set null`, so deleting a project unlinks its tasks and keeps them.

**`reflection_access`** — one row per member: `member`, `password_hash`
(bcrypt), `failed_attempts`, `locked_until`, `updated_at`. **Not readable from
the browser at all**; used only by the `reflection_login` /
`reflection_change_password` database functions. Reset a password with
`private.admin_set_reflection_password` (§11) — editing the table by hand does
not work any more.

**`personal_notes`** — one row per note: `id`, `member`, `body`, `created_at`,
`updated_at`.

**`private.team_accounts`** — the Supabase Auth user id(s) allowed to use the
board.

SQL files in `supabase/`:

- `schema.sql` — the **complete** schema for a fresh, empty project (all
  tables, team-only policies, password functions, realtime). Not for a project
  that already has data — use the migrations.
- `migration-002-settings.sql` — adds subtitle / access-password / login-days
  columns to `board_meta`.
- `migration-003-branding-filedir.sql` — adds `logo_url` / `favicon_url` and
  `tasks.file_dir`.
- `migration-004-reflections.sql` — adds the `reflections` table.
- `migration-005-projects.sql` — adds the `projects` table.
- `migration-006-reflection-access.sql` — adds `reflection_access` (per-member
  Reflection password; edit the `password` column in the Supabase Table Editor
  to reset someone's password).
- `migration-007-done-at.sql` — adds `tasks.done_at` (completion time) for
  auto-archiving DONE tasks after a week.
- `migration-008-suggestions.sql` — adds the `suggestions` table (anonymous
  improvement ideas).
- `migration-009-assignees.sql` — adds `tasks.assignees` so one task can be
  held by several people. `owner` stays the first name in that list.
- `migration-010-personal-notes.sql` — adds the `personal_notes` table (notes
  shown only to the member who wrote them, under the daily reflections).
- `migration-011-auth-step1.sql` — **real login, step 1 (additive).** Team
  list, bcrypt-hashed Reflection/Tracking passwords, the password functions and
  the admin tools. The old site keeps working after it. See §11.
- `migration-014-remove-ideas-tracking.sql` — **deletes** the data of the
  removed IDEE and TRACKING tabs: the `suggestions` table and the Tracking
  password (its hash and the two functions). Counts the rows of every other
  table before and after and rolls back if any changed.
- `migration-013-report-projects.sql` — adds `projects.report_hidden`: a
  project taken off the weekly report with its × stays off every later report
  until put back from REPORT → **Progetti esclusi**.
- `migration-015-projects-v2.sql` — the reworked Projects tab: adds
  `description`, `notes`, `owners`, `priority`, `start_date`, `target_date`,
  `color` to `projects` and `tasks.project_id`. Additive and re-runnable (an
  earlier version also added `status`/`phases`; if you ran that one, run this
  one again — the two extra columns are simply unused). The app probes for the
  columns and only writes them once they exist.
- `migration-016-project-board-mode.sql` — adds `projects.board_mode` and
  `projects.task_order` (how a project's tasks reach the BOARD, and their step
  order). Additive; run after 015. Before it, every project task is on the BOARD.
- `migration-017-subtask-functions.sql` — adds `subtask_add`,
  `subtask_update`, `subtask_delete` and `subtask_reorder`, so concurrent
  subtask edits no longer overwrite each other. Adds functions only; no data
  changes. Re-runnable.
- `migration-018-music-playlists.sql` — adds `music_playlists` (the music
  player's team playlists, §1e). Additive, re-runnable.
- `migration-019-music-playlist-rpc.sql` — adds `music_playlist_append`,
  `_insert`, `_remove`, `_move` and `_rename`, so concurrent playlist edits no
  longer overwrite each other. Adds functions only; run after 018. Re-runnable.
- `migration-020-music-playlist-clock.sql` — adds a trigger that stamps
  `music_playlists.updated_at` with the database clock on every insert and
  update. Adds a function and a trigger only; run after 018. Re-runnable.
- `migration-021-music-radio-playlists.sql` — adds `music_playlists.radio_seed`,
  `radio_title`, `radio_refreshed_at` (nullable) and the function
  `music_playlist_radio_refresh`, for radio playlists that update themselves
  once a day (§1e). Additive; run after 018–020. Re-runnable.
- `migration-022-music-playlist-sources.sql` — adds `music_playlists.source_kind`,
  `source_id`, `source_name`, `source_synced_at` (nullable), `source_auto`
  (default true) and the function `music_playlist_source_sync`, for imported
  playlists that sync with their Spotify / YouTube source once a day and on
  *Sincronizza* (§1e). Additive; run after 018–021. Re-runnable.
- `migration-012-auth-step2-lockdown.sql` — **real login, step 2.** Closes all
  tables to the anon key, hides `reflection_access`, deletes the clear-text
  password columns. Run only after the new site is live and you have logged in
  with it. See §11.

Migrations 002–011, 013 and 015–022 are additive and safe on live data; run any you haven't yet.
012 changes access rules (not data) and must follow the order in §11. The
app degrades gracefully before they're applied (settings can't save, reflections
stay empty, tasks stay single-assignee) thanks to tolerant reads and fallbacks —
and the screens that depend on a missing table now say so instead of looking
merely empty.

---

## 4. Project structure

```
prova_sito_GTD/
├── README.md                     ← this file
├── netlify.toml                  ← Netlify build (command, publish, SPA + noindex headers)
├── .gitignore
├── legacy/original-artifact.html ← the original single-file app, kept for reference
├── supabase/
│   ├── schema.sql                ← full schema for a fresh project
│   ├── migration-002-settings.sql
│   ├── migration-003-branding-filedir.sql
│   ├── migration-004-reflections.sql
│   ├── migration-005-projects.sql
│   ├── migration-006-reflection-access.sql … migration-010-personal-notes.sql
│   ├── migration-011-auth-step1.sql          ← real login, step 1 (additive)
│   ├── migration-012-auth-step2-lockdown.sql ← real login, step 2 (lockdown)
│   ├── migration-013-report-projects.sql · migration-014-remove-ideas-tracking.sql
│   ├── migration-015-projects-v2.sql         ← project details + notes, tasks.project_id
│   ├── migration-016-project-board-mode.sql  ← how project tasks reach the BOARD, step order
│   ├── migration-017-subtask-functions.sql   ← subtasks changed one at a time (no lost edits)
│   ├── migration-018-music-playlists.sql     ← the music player's team playlists
│   ├── migration-019-music-playlist-rpc.sql  ← playlist edits one step at a time (no lost songs)
│   ├── migration-020-music-playlist-clock.sql ← playlist changes stamped by the database clock
│   ├── migration-021-music-radio-playlists.sql ← radio playlists, updated once a day
│   └── migration-022-music-playlist-sources.sql ← imported playlists synced with their source daily
├── .github/workflows/ci.yml      ← on every push / PR: npm test + production build
├── menu/                        ← the canteen menu: monthly PDF → web/src/data/menu.json (§8)
│   ├── menu_from_pdf.py
│   └── README.md
└── web/                          ← the entire frontend (Vite root)
    ├── index.html                ← HTML shell (fonts, noindex meta, #root)
    ├── package.json              ← deps: react, react-dom, @supabase/supabase-js, fflate, @react-pdf/renderer (server PDF), @fontsource-variable/inter (screen), @fontsource/inter (PDF)
    ├── vite.config.ts · tailwind.config.js · postcss.config.js · tsconfig.json
    ├── .env.example              ← VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_TEAM_EMAIL
    ├── netlify/functions/report-pdf.mts ← POST → the weekly report PDF (team login only)
    ├── netlify/functions/music-search.mts ← GET → YouTube search for the music player (team login only; YOUTUBE_API_KEY)
    ├── netlify/functions/music-playlist.mts ← GET → read / find YouTube playlists for Importa (same rules)
    ├── netlify/functions/music-browse.mts ← GET → suggestions, radio, charts, trends, artists (YouTube.js)
    ├── netlify/functions/music-spotify.mts ← GET a Spotify playlist/album, POST pasted track links → songs, POST songs → YouTube matches
    ├── netlify/lib/spotify.mts          ← reads a Spotify playlist/album (Web API with the site's keys, else the embed page) and single tracks
    ├── netlify/lib/ytjs.mts             ← YouTube.js wrapper: every result shape → { id, title, channel, thumb }
    ├── netlify/lib/teamAuth.mts  ← the functions' shared "is this the team login?" check
    ├── netlify/lib/reportPdf.mts ← the PDF layout (@react-pdf/renderer)
    ├── scripts/gen-pdf-fonts.mjs ← embeds Inter into the function at build time
    ├── public/robots.txt         ← Disallow: / (noindex)
    ├── public/manifest.webmanifest · public/sw.js · public/icons/ ← the installable app (§1d)
    ├── public/report-template.docx ← the Intesa Sanpaolo Word template the report is built on
    ├── public/fonts/             ← EB Garamond + Cinzel TTFs embedded in the PDF (OFL)
    ├── vite.config.ts            ← manualChunks (Supabase cached separately); fails a build without VITE_TEAM_EMAIL
    └── src/
        ├── main.tsx              ← mounts <LangProvider><IdentityProvider><AuthGate><App/>
        ├── App.tsx               ← tabs, top bar, filters state, favicon effect, routing
        ├── index.css             ← Tailwind + small globals (drop-target, fonts)
        ├── styles/glass.css      ← the Liquid Glass skin, scoped to [data-skin="glass"]
        ├── lib/                  ← non-UI logic
        │   ├── types.ts          ← Task/Subtask/Weekly/Reflection/Board + the Op union
        │   ├── constants.ts      ← statuses, priorities, tabs, weekly columns (no passwords)
        │   ├── supabaseConfig.ts ← URL + anon key + team e-mail (env or placeholder)
        │   ├── supabaseClient.ts ← createClient; the login session is kept in localStorage
        │   ├── auth.ts           ← team login/logout/password change + Reflection checks
        │   ├── db.ts             ← row<->type mapping, fetchBoard, seedIfEmpty, writeOp
        │   ├── localReducer.ts   ← applyOpLocal (optimistic in-memory updates)
        │   ├── useBoard.ts       ← load + realtime + poll + optimistic send()  (core hook)
        │   ├── rowSync.ts        ← folds one changed row (from realtime) into the board
        │   ├── history.ts        ← tabs / project / More page in the URL; Back closes sheets
        │   ├── pwa.ts            ← service worker registration + the install prompt
        │   ├── music.ts          ← the music player's state, defaults, link parsing, search
        │   ├── musicDb.ts        ← team playlists (music_playlists), live
        │   ├── spotifyAuth.ts    ← "Accedi con Spotify": PKCE in the browser, /callback, token in sessionStorage
        │   ├── i18n.mobile.ts    ← the mobile app's IT/EN strings (merged into i18n.tsx)
        │   ├── __tests__/        ← Vitest: reducer, live sync, projects, subtask writes, i18n parity
        │   ├── seed.ts           ← initial data for a brand-new empty project
        │   ├── i18n.tsx          ← LangProvider + full IT/EN dictionary + label helpers
        │   ├── identity.tsx      ← IdentityProvider ("who am I", cached per device)
        │   ├── prefs.ts          ← all localStorage read/write helpers
        │   ├── image.ts          ← logo/favicon validate + rasterise + downscale
        │   ├── dates.ts          ← date math/formatting helpers
        │   ├── reportData.ts     ← week maths + Done / Next / Projects / Planner collection
        │   ├── glassReportModel.ts ← the Liquid Glass report as blocks + cover figures
        │   ├── reportDoc.ts      ← the report as data (texts read from the pages) for the server PDF
        │   ├── reportDocx.ts     ← the classic Word template (.docx, lazy-loaded)
        │   ├── projects.ts       ← derived status, progress, health, colours, sorting, report selection
        │   ├── projectsContext.tsx ← the board's projects for task cards / the task editor
        │   ├── skin.ts           ← which visual skin is on (glass / classic)
        │   └── useSyncedField.ts ← text field that syncs w/o clobbering active typing
        └── components/
            ├── TopBar.tsx        ← logo, editable title + subtitle, mail button, right slot
            ├── ConnBadge.tsx · LangToggle.tsx · IdentityPicker.tsx   ← header controls
            ├── GlassToggle.tsx    ← the Liquid Glass on/off switch
            ├── AuthGate.tsx      ← team login screen (Supabase Auth) + login-duration expiry
            ├── BoardView.tsx     ← toolbar, quick-add, columns, list toggle, edit-layout, DnD
            ├── QuickAdd.tsx      ← full new-task bar
            ├── TaskCard.tsx      ← compact card + inline expansion
            ├── TaskDetails.tsx   ← the reusable full task editor (card, list, calendar)
            ├── SortableSubtasks.tsx ← pointer drag-reorder subtasks (FLIP-animated cards)
            ├── AutoTextarea.tsx  ← auto-growing textarea
            ├── ListView.tsx      ← table view of all visible-column tasks
            ├── Filters.tsx       ← search/owner/priority/Focus-P1 (used by calendar)
            ├── MembersBar.tsx    ← inline add/remove team members
            ├── PriorityDistribution.tsx ← collapsible P1–P4 chart
            ├── ProjectsView.tsx  ← Projects: Ongoing (cards / timeline) and Completed (recent / older)
            ├── projects/ProjectDetail.tsx ← one project's page: details, notes, old-checklist conversion
            ├── projects/ProjectTasks.tsx ← the project's tasks: new-task form, link, list / mini board
            ├── projects/ProjectTimeline.tsx ← dated projects as bars, today line
            ├── projects/ProjectBits.tsx ← progress ring, pills, health badge, avatars
            ├── CalendarView.tsx  ← month grid + left detail panel
            ├── WeeklyView.tsx    ← recap + 5 retro columns
            ├── DailyReflection.tsx ← reflection form + recent + spaced review
            ├── SettingsView.tsx  ← branding upload, team password change, login duration
            ├── MusicPlayer.tsx   ← the one YouTube player + ♪ panel / small player (§1e)
            ├── MusicTab.tsx      ← the MUSICA tab: library, search, artists, playlists, player bar
            └── MailModal.tsx     ← mail-update text generator
        └── mobile/               ← the phone version (§1b), its own lazy-loaded chunk
            ├── MobileApp.tsx     ← shell: header, bottom tab bar, add button, sheets, toasts
            ├── useLayout.ts      ← phone or desktop: screen width + the per-device choice
            ├── TodayScreen.tsx · BoardScreen.tsx · ProjectsScreen.tsx · AgendaScreen.tsx · MoreScreen.tsx
            ├── TaskCard.tsx      ← swipeable card (right = done, left = move)
            ├── TaskSheet.tsx · AddSheet.tsx ← edit a task / add one, as bottom sheets
            ├── pickers.tsx       ← choosers: status, priority, due date, people, project
            ├── actions.tsx       ← done / move / delete with Undo; the Move sheet
            ├── ui.tsx · icons.tsx · nav.ts  ← sheet, toast, avatars, chips, ring; icons; navigation
            └── mobile.css        ← every mobile style (Liquid Glass via glass.css tokens), scoped to html[data-layout="mobile"]
```

Rough size: ~7.1k lines of TS/TSX. Largest files: `i18n.tsx` (dictionary),
`BoardView.tsx`, `db.ts`, `reportDocx.ts`, `TaskDetails.tsx`,
`DailyReflection.tsx`, `SortableSubtasks.tsx`.

---

## 5. Weekly report — Liquid Glass, edited in place, exported to PDF

```
REPORT tab ─▶ pick a week (or a custom period) ─▶ Generate report
   collectReport()  ─▶ buildBlocks() ─▶ measured and packed onto A4 pages (GlassReport)
                                          │  click any text to edit · × hides a card
                                          └─▶ Download PDF ─▶ server (Netlify Function) ─▶ .pdf
```

### What is in it

| Page | Content |
| --- | --- |
| Cover | board name and period, an editable headline and subtitle, tiles for completed tasks, closed subtasks, in progress, next and waiting, an **In evidenza** list whose tasks you pick with **Scegli attività** (up to 8, from the completed, in-progress, next and waiting tasks; left out of the PDF when empty), and an editable **In sintesi** paragraph |
| 01 Completate | every task that entered DONE inside the period, with priority, completion date, its subtasks and a progress bar |
| 02 Prossimi passi | the NEXT column now, with due dates and subtasks |
| 03 Progetti | every ongoing project, plus those completed inside the period — status, target date (or completion date), task count, description, % done and its linked tasks (open first); ongoing first, then by priority — except projects taken off with their × (`projects.report_hidden`, shared by the whole team): they stay off **every** later report until put back from the **Progetti esclusi** view of the REPORT tab |
| 04 Planner | always **one landscape page**: Backlog · Next · In Progress · Waiting side by side; a very full board is scaled down to fit |

Only the Done section is period-filtered; the rest is how the board stands when
the report is generated. Like the old Word report it is **name-free**: no owner
appears anywhere.

### How it is built

- **Blocks and pages.** `glassReportModel.ts` turns the data into blocks (a
  section heading, a task card, a project, a planner band).
  `GlassReport.tsx` renders every block once off-screen at page width,
  measures it, and packs blocks onto 794 × 1123 px pages (A4 at 96 dpi); a
  section heading always stays with its first card and no card is split.
  Pages are laid out by block id, so hiding a card (×) just drops it and the
  rest re-packs. The planner is its own 1123 × 794 landscape page.
- **Drafts.** Every change (texts, hidden cards, chosen highlights) is saved
  on this device straight away, per report period (`gtd-report-draft:<from>_<to>`
  in `localStorage`, `prefs.ts`), and kept for **7 days** after the last
  change: leave the tab or reload and the REPORT tab reopens that week's
  report as you left it. **Ripristina / Reset** throws the week's changes away.
  Drafts are deleted when the device logs out of the team.
- **Editing.** Every text on the pages is `contentEditable` — titles, labels,
  counts, dates, tile figures, headers and footers (only page numbers are
  automatic); planner items have their own × too. An edit is stored when the
  field loses focus, the blocks are measured again and re-packed — a longer
  text simply pushes the next card to the following page.
- **The look.** `styles/glassReport.css`: soft colour washes (radial
  gradients, arranged differently on each page) under white glass panels
  built from translucent fills, a bright rim, a specular sheen and soft
  shadows, in Apple's light system palette. It deliberately does not depend on
  `backdrop-filter`, so the PDF matches the screen. Type is Inter, self-hosted
  through `@fontsource-variable/inter`.

### PDF — made on the server

A PDF captured in the browser comes out differently on every device (each
lays out text with its own fonts and engine), so the PDF is made on the server
instead, by a Netlify Function: `web/netlify/functions/report-pdf.mts`.

1. **Download PDF** builds a `ReportDoc` (`web/src/lib/reportDoc.ts`): the
   report's structure from the same model the pages use, and every text
   exactly as it currently reads on the pages (each editable text carries a
   `data-ed-id`), so edits, hidden cards and the chosen highlights are all in
   it. It is POSTed to `/.netlify/functions/report-pdf` with the person's
   Supabase access token.
2. The function checks that token with the database's own
   `is_team_member()` (401/403 otherwise), then lays the report out with
   **@react-pdf/renderer** (`web/netlify/lib/reportPdf.mts`) — its own layout
   engine and the **Inter** font files embedded in the function — and returns
   the file. Nothing is stored.

So the same report gives the same PDF on every device. The text is real PDF
text (selectable, searchable, sharp at any zoom). The design follows the
pages: colour washes as SVG radial gradients, white glass cards with a soft
shadow, accent bars, pills, progress bars, checkmarks; cards are never split
across pages and a heading never ends a page; the planner is one landscape
page — its size is found by measuring: the planner page is rendered alone
and its pages counted, shrinking until it is exactly one; a long column
spreads its cards over sub-columns, and only a board too full even at the
smallest readable size ends a column with "+N" — page numbers are automatic.
The headline's colour sweep is done word by word (PDF text cannot carry a
gradient).

**Fonts** are generated into `web/netlify/lib/fonts.generated.mjs` by
`scripts/gen-pdf-fonts.mjs` on every build (from `@fontsource/inter`: Latin,
plus Latin Extended as a fallback). `@react-pdf/renderer` is shipped to the
function unbundled (`external_node_modules` in `netlify.toml`).

**Netlify needs** the existing `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` variables to be available to **Functions** too (the
default "All scopes"); the function uses them to check the login.

### Word (classic template)

The previous Intesa Sanpaolo Word report is still available as a direct
download (**Word (classic template)**): `reportDocx.ts` fills
`web/public/report-template.docx` with the same Done / Next / Projects /
Planner content. There is no Word editor any more — edit the downloaded file in
Word if needed.

---

## 6. Run locally

```bash
cd web
cp .env.example .env      # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_TEAM_EMAIL
npm install
npm run dev               # http://localhost:5173
npm test                  # Vitest unit tests (no Supabase needed)
npm run build             # type-check (tsc -b) + production build to web/dist
```

GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` and `npm run build`
on every push and pull request, so a change that breaks either shows up there
before Netlify deploys it.

You need a Supabase project (the app talks to it directly). Point `.env` at any
project set up as in §7 / §11 and log in with the team password.

---

## 7. Deploy — browser only, ~15 minutes

### Part 1 — Supabase backend

1. **https://supabase.com** → sign in → **New project** (any region; a strong DB
   password you won't reuse). Wait ~2 min.
2. **Authentication → Sign In / Providers**: turn **off** "Allow new users to
   sign up". **Authentication → Users → Add user → Create new user**: the team
   e-mail + a strong team password, tick **Auto Confirm User**.
3. **SQL Editor → New query** → paste **all** of `supabase/schema.sql`, put the
   team e-mail on its last line → **Run**.
   For an existing project with data, follow §11 instead.
4. **Project Settings → API** → copy the **Project URL** and the **anon public**
   key.

### Part 2 — Netlify frontend

1. **https://app.netlify.com** → **Add new site → Import an existing project →
   GitHub** → pick `Gualbertol123/prova_sito_GTD`.
2. `netlify.toml` already sets the build (`npm --prefix web install && npm
   --prefix web run build`, publish `web/dist`). Choose the branch that holds the
   code (currently `claude/hopeful-noether-u6oblf`; switch to `main` after
   merging).
3. **Site configuration → Environment variables** → add `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY` and `VITE_TEAM_EMAIL` (the team user's e-mail). None
   is secret: the anon key is meant to ship in the browser and gets nothing
   without the team password.
4. **Deploy**. Open the URL; enter the team password; the board seeds itself on
   first load and the badge reads **Live**. Open a second browser to see edits
   sync.

Env-var changes require a **redeploy** (Vite inlines `VITE_*` at build time).
Alternative hosts (Vercel / Cloudflare Pages / GitHub Pages) work identically —
same build command, publish `web/dist`, same three env vars.

---

## 8. Operations & gotchas

- **Free Supabase pauses after ~7 days of inactivity.** The first visitor after
  a quiet week sees errors until someone clicks **Restore** in the Supabase
  dashboard (~1–2 min). Regular use keeps it awake.
- **Access is a real login** (§11): one shared Supabase Auth account, and the
  database refuses every request that is not logged in as it. The site is also
  `noindex` (meta + robots.txt + `X-Robots-Tag`) and sends strict security
  headers (`netlify.toml`).
- **Logo/favicon are stored as data URLs in `board_meta`**, which the board
  refetches on its sync cycle. Uploads accept up to 5 MB but are **rasterised and
  downscaled** to a small icon before storage (`image.ts`) precisely so the
  shared row — and everyone's bandwidth — stays light. Don't bypass that.
- **Free-tier limits** (≈500 MB DB, ≈200 concurrent realtime connections) are far
  above a small team's needs.
- **Two identities in the header** — the "You" picker (per-device default author
  / task owner) and the Reflection login — are conveniences, not accounts; the
  only account is the shared team login.

### Canteen menu — updated once a month

The canteen sends its menu as a PDF (one page per week, courses down the left,
Monday–Friday across). To update it:

```bash
pip install pymupdf
python3 -I menu/menu_from_pdf.py Menu.pdf     # updates web/src/data/menu.json
```

then commit `web/src/data/menu.json` and deploy. The script reads each cell
from the table's grid lines (so a dish that wraps over two lines stays one
dish, even when the next line starts with a capital, as in "alla / Milanese"),
splits off the allergen numbers, **drops every day before today** (from the
PDF and from what the file already holds) and replaces the days that are in
the new PDF, so running it twice is harmless. The file is loaded only when it is
needed, by the BOARD's **Menu mensa** bar, which shows today and the next
days and never a past day. The
menu is not confidential, so it is fine that it is in this public repository.

---

## 9. Extending it

Because everything flows through the `Op` union, most changes follow one path:

- **Add a task field:** add it to `Task` in `types.ts` → map it in `db.ts`
  (`rowToTask`, `taskToRow`, `patchToRow`) → add a column via a new
  `supabase/migration-00X-*.sql` (additive) → surface it in `TaskDetails.tsx`.
  Keep reads tolerant so the app still works before the migration runs.
- **Add an operation:** extend the `Op` union → handle it in both `localReducer.ts`
  (optimistic) and `db.ts` `writeOp` (persist) → dispatch it from a component via
  `send(op)`.
- **Add a tab:** add the id to `TabId`/`TABS` in `constants.ts` → add `tabs.<id>`
  to both languages in `i18n.tsx` → render it in `App.tsx`.
- **Add a table:** create it in `schema.sql` + a migration, and end the
  migration with `select private.lock_table('<table>');` — that gives it the
  same team-only policy and grants as the others (new tables are closed to the
  anon key by default, but a table without that call is not usable by the team
  either) — fetch it tolerantly in
  `db.ts` `fetchBoard`, add a realtime listener in `useBoard.ts`, and default it
  to empty in `localReducer.ts`.
- **Translations:** every user-facing string goes through `t('key')`; keep the IT
  and EN dictionaries in `i18n.tsx` at parity.

### Possible next steps (not done)
- Per-person accounts (one Supabase Auth user per member) + per-member RLS, if
  reflections and personal notes must be private *between teammates* too. With
  the shared account, every logged-in device downloads every reflection and
  note; only the Reflection password in the interface keeps them apart (§11).
- Merge `claude/hopeful-noether-u6oblf` into `main` and point Netlify at `main`.
- Drag-to-reorder for weekly items / members (subtasks already have it).
- A weekly "learning digest" and per-member reflection streaks.

---

## 10. The Liquid Glass skin

The **Glass** switch in the header turns the redesign on and off, and when it
is on a **☀ / ☾ control** next to it picks the light or dark appearance. Glass
is **on by default**, dark is the default appearance, and both choices are
remembered in **cookies** (`gtd-skin` and `gtd-appearance`, one year,
`SameSite=Lax`, `Secure` on https), mirrored into `localStorage` so they
survive cookies being cleared or blocked.

A round **blur** button after ☀ ☾ A (on the phone: Altro → *Sfocatura vetro*)
switches the frosted blur off while keeping the glass colours: panels turn
opaque. Use it if a browser or graphics card draws thin lines or seams in the
glass, or on a slow computer. It is stored per browser (`gtd-blur`).

### The design

A Control Center redesign, not a tint pass. Reference points: iOS 26's Control
Center, its notification stack, and the way visionOS floats glass in space —
checked against the iOS 26 and 27 home screens, which are a deep saturated
wallpaper with translucent chrome floating over it, each panel carrying a
bright rim where the light catches its edge.

| Property of the material | How it is built |
| --- | --- |
| **Wallpaper** — Control Center is glass over a dimmed wallpaper, not over a flat fill | Deep indigo/blue/purple fields on `body`, `background-attachment: fixed` |
| **Dark glass** — panels are a light film over that wallpaper, not white cards | `rgba(255,255,255,.08…​.17)` plus `backdrop-filter: blur(32px) saturate(190%)` |
| **Lensing** — light bends at the rim, so edges read brighter than the middle | Inset hairline, brightest along the top edge |
| **Specular** — a sheen from an implied light above-left | Soft diagonal gradient on a `::before`, under the content |
| **Depth** — panels float rather than sit in a frame | Big soft shadows, no hard borders |
| **Radii** — Control Center tiles are large continuous curves | Panel radii lifted to 22px; controls stay capsules |

**Light and dark.** Liquid Glass has both on Apple's platforms and the system
palette ships a light and a dark variant of every colour, so the skin is
written entirely against tokens and `[data-appearance]` swaps the set — same
structure, same rules, different material and palette. Dark is a light film at
low alpha over a deep indigo wallpaper; light is a white film at higher alpha
over a bright one. Three colours are darkened from Apple's light values
(yellow, green, cyan) because the published ones are unreadable as text on
white glass.

Colour is Apple's system palette in its dark-mode (vibrant) variants, which is
what the platform uses on top of glass — red `#FF453A`, orange `#FF9F0A`,
yellow `#FFD60A`, green `#30D158`, cyan `#64D2FF`, blue `#0A84FF`, indigo
`#5E5CE6`, purple `#BF5AF2`, gray `#8E8E93` — with Apple's label hierarchy and
fill hierarchy. Primary actions become systemBlue, the gold accent becomes
systemOrange, priority dots and status chips map onto the system colours, and
the skin toggle itself is a systemGreen iOS switch.

Two judgement calls worth knowing:

- **Tinted, not clear.** iOS 26.1 added that choice because clear glass was
  hard to read; this app is dense small text, so it takes the tinted reading.
- **Labels are lifted above Apple's own values.** Measured against these
  wallpapers, Apple's `tertiaryLabel` came out at **2.7:1**. The lower two
  steps were raised, in both appearances, until every step clears WCAG AA on
  both card and panel surfaces — measured 16.2 / 6.4 / 6.0 in light and
  12.0 / 6.0 / 5.8 in dark.

### It is only paint

Everything lives in `web/src/styles/glass.css`, scoped to
`html[data-skin="glass"]`, targeting the utility classes the components already
carry. No component renders differently and nothing in logic reads the skin, so
`classic` restores the original stylesheet exactly. `initSkin()` runs before
React mounts so the first frame is already the right skin.

### What it deliberately does not touch

- **The report.** The weekly report has its own light Liquid Glass design
  (`styles/glassReport.css`, scoped to `.gr-root`), which the app skin does not
  restyle.
- **Printing.** Background, colour, translucency, blur and shadow are all
  stripped. Print output measures identical in both appearances and to the
  pre-skin baseline (73% ink on page 1) with white paper.

### Two things the skin required

- `backdrop-filter` makes an element the containing block for
  `position: fixed` descendants. The subtask drag preview is fixed at viewport
  coordinates, so it is portalled to `<body>` — verified to land in the
  identical position in both skins, and the mail modal checked the same way.
- Form controls opt out of the panel material. A control sitting on a panel is
  an inset well, not another sheet of glass; left as glass-on-glass inside a
  tinted panel it rendered as mud.
- The header's own pills — identity picker, connection badge, language toggle —
  take neutral fill rather than the systemBlue the primary-action rule gives
  everything else. They are containers, not actions, and in light mode blue
  pills on a white header were unreadable.

---

## 11. Security — login, passwords and admin resets

### How it works

- **One shared team account in Supabase Auth.** The login screen sends the
  password to Supabase Auth together with the team e-mail (`VITE_TEAM_EMAIL`);
  the browser never downloads any password. Supabase stores it as a bcrypt hash.
- **The database only answers to that account.** Every table in `public` has
  one policy: `to authenticated using ((select public.is_team_member()))`, and
  `anon` has no table rights at all (new tables start closed too).
  `is_team_member()` checks the caller against `private.team_accounts` **and**
  checks that the login session still exists, so an account created by mistake
  gets nothing, and a logged-out or reset session is refused at once. The anon
  key in the site's code is therefore harmless on its own.
- **Reflection passwords are bcrypt hashes** checked by database
  functions (`reflection_login`, `reflection_change_password`),
  callable only by the logged-in team account. Five wrong
  tries in a row lock that password for 5 minutes. None of them is in the code.
- **Sessions.** A device stays logged in for Settings → *Login duration* days
  (the Supabase session is kept in `localStorage`, refreshed automatically);
  then it must log in again. *Log out this device* ends it at once (and forgets
  the Reflection logins on that device); changing the team password in Settings
  logs every other device out within about 30 seconds.
- **Transport and browser.** Everything is HTTPS; `netlify.toml` sends HSTS, a
  strict Content Security Policy, `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer` and a locked-down `Permissions-Policy`.

**What the shared account does not do:** separate teammates from each other.
Anyone with the team password can read every reflection and personal note
through the API; the per-member Reflection password keeps them apart in the
interface only. If that matters, move to one Supabase Auth user per member.

### Supabase settings

Keep:
- **Authentication → Sign In / Providers → "Allow new users to sign up": OFF.**
- **Email → Minimum password length: 12** (the app also asks for 12).
- **"Require current password when updating"** may be turned on — the app
  sends it.
- The team e-mail must be a **mailbox only admins can read**: anyone who can
  read it can log in through a recovery / magic-link e-mail.
- Keep the **service_role** key out of the site and out of Git — the site only
  ever needs the anon key.

Leave OFF (the app does not support them and nobody could log in): **CAPTCHA**
(Attack Protection), **MFA** on the team user, **single session per user**.

The Security Advisor will warn that `is_team_member`, `reflection_login` and
`reflection_change_password` are SECURITY DEFINER
functions callable by `authenticated`; that is intended — each one checks the
team login itself.

### Upgrading a live project (done once, in this order)

Board data is never modified by these steps; only access rules and the old
clear-text password columns change. Taking a copy first is still wise:
Table Editor → each table → **Export → CSV** (works on the free plan).

1. **Supabase → Authentication → Sign In / Providers**: turn off
   *Allow new users to sign up*.
2. **Authentication → Users → Add user → Create new user**: an e-mail for the
   team (e.g. a shared mailbox you control) and a **new** strong password —
   not the old `IBDGTDTEAM`, which has been visible in the site's code. Tick
   **Auto Confirm User**.
3. **SQL Editor**: open `supabase/migration-011-auth-step1.sql`, replace
   `team@example.com` on its last lines with that e-mail, **Run**. (If the
   e-mail does not match the user, it stops and changes nothing.) The current
   site keeps working.
4. **Netlify → Site configuration → Environment variables**: add
   `VITE_TEAM_EMAIL` = that e-mail. Then deploy the new code (push to the
   deployed branch, or *Deploys → Trigger deploy*).
5. Open the site, log in with the new team password, check the board, the
   Reflection tab (everyone's current password still works).
6. **SQL Editor**: run `supabase/migration-012-auth-step2-lockdown.sql`. From
   now on **every table** is closed to everyone but the team account — it
   lists (as warnings) any extra table it closed, such as the old app's
   `boards` table. Any old copy of the site still online (e.g. a GitHub Pages
   copy of the original app) stops working, as it should. Other open tabs
   need a reload and a login.
7. **Change the passwords that were exposed** — all of them were readable
   before this upgrade:
   have **every member** change their Reflection password in the
   Reflection tab (or reset it for them, below).

If step 5 fails, nothing is lost: the database is still open as before; fix
the cause (see the message on the login screen) before running step 6.

### Admin: resets and account changes (Supabase → SQL Editor)

These functions live in the `private` schema, which the website cannot call;
only someone signed in to the Supabase dashboard can run them.

| To… | Run |
| --- | --- |
| Reset the **team** password (12–72 characters; logs every device out) | `select private.admin_set_team_password('new password');` |
| …without logging devices out | `select private.admin_set_team_password('new password', false);` |
| …when there is more than one team account | `select private.admin_set_team_password('new password', true, 'e-mail');` |
| Reset a member's **Reflection** password (also unlocks it) | `select private.admin_set_reflection_password('Name', 'new password');` |
| Put a member back on the initial password | `select private.admin_set_reflection_password('Name', 'password');` |
| Allow another Auth user to use the board | `select private.admin_add_team_account('e-mail');` |
| Stop an Auth user from using the board (not the last one) | `select private.admin_remove_team_account('e-mail');` |
| Close a table you added | `select private.lock_table('table_name');` |

A logged-in teammate can also change the team password in Settings (the
current one is required). Stored passwords cannot be read back by anyone —
only replaced.

**Order matters only once:** 011 refuses to run after 012 (re-run 012
instead; it is safe to repeat), and `schema.sql` refuses to run on a project
that already has the board tables. The older migrations 004–010 re-close their
table automatically if run after 012.

