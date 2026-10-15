# Vue port plan

Written 2026-10-14 (planning session on Opus 5.5). Moves Clone Hero Chart Manager from React + TypeScript to
**Vue 3 + JavaScript (JSDoc)**, keeping its look and its hard-won backend behaviour. Tickets are sized for cheaper
models; one ticket = one commit. Read §1 to §3 before starting any ticket.

Related documents:
- `docs/video-tools-plan.md`: the video features. Its backend tickets still apply (converted to JS); its UI tickets
  are rebuilt in Vue in Phase 6 here. Its T0.1b (release setup) is superseded by Phase 0 here.
- `docs/upstream/`: upstream tracking state for the `upstream-sync` skill.
- `.claude/skills/upstream-sync/SKILL.md`: reviews upstream commits and records decisions.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Strategy | **Hybrid.** Port the main process and shared code module by module (types out, comments translated, behaviour locked by tests first). Port the renderer's non-visual logic into Pinia/plain JS. **Rebuild** the screens in Vue from a written per-screen spec. Keep `styles.css` and its class names as the visual contract. |
| Why not translate the React views | `LibraryView` is one 2,094-line function (41 `useState`, 27 `useEffect`); two copy-pasted modal systems with 31 Escape handlers; 100+ direct `window.api` calls from components; weak accessibility. Translating would carry all of that over. |
| Why not rebuild the backend | It encodes API/format/OS knowledge a rebuild would rediscover one bug report at a time (Encore and RhythmVerse quirks, Google Drive confirm pages, 7-Zip flags, Onyx non-ASCII crash, `.setlist` byte layout, MIDI header lies, Windows file locks, AppImage env). The comments are the spec. |
| Language | JavaScript (ES modules) with JSDoc types, type-checked by `tsc --checkJs` / `vue-tsc`. No `.ts` files in the final app. Shared types become `@typedef`s in `src/shared/types.js`, imported with `/** @import { X } from '...' */`. |
| UI stack | Vue 3.5 (`<script setup>`, JS), Pinia, vue-router with **memory history** (replaces the custom `screenhistory.ts`; back/forward come for free), `@tanstack/vue-virtual` for long lists. No UI component library: the existing CSS is the design system. |
| Tests | **Vitest** for everything (main-process pure functions, stores, components with `@vue/test-utils`). The existing `node:test` video tests move to Vitest. |
| Lint | ESLint (flat config) with `eslint-plugin-vue`, `eslint-plugin-vuejs-accessibility`, `eslint-plugin-jsdoc`. Accessibility rules are errors, not warnings. |
| Spotify | **Log in with Spotify** (Authorization Code + PKCE, no secret, no server). Each user registers their own Spotify developer app (Development Mode needs Premium, max 5 users per app) and pastes its Client ID in Settings. Reads full playlists the user owns or collaborates on. Keep the keyless embed fallback (public playlists, first 100 tracks). Remove the dependency on the upstream contributor's Cloudflare Worker. |
| Upstream | Read-only remote `upstream`; changes are reviewed with the `upstream-sync` skill and re-implemented by hand. Port module by module so `docs/upstream/file-map.md` stays a 1:1 map. |
| Repo | The existing public fork, renamed `randland/chartroom` (§2). |
| Coexistence during the port | The React UI keeps working until the Vue UI reaches parity. Both renderers build side by side; `CHM_UI=vue` selects Vue in dev. Releases ship React until cut-over (Phase 5). |
| Games (decided 2026-10-15) | The app serves **Clone Hero and YARG** equally. A **"Games I play"** setting (`clone-hero`, `yarg`, `both`) drives defaults instead of each feature assuming Clone Hero: the Rock Band download format, whether the video health check requires VP8, which formats count as playable, and which game the rescan hints name. The library recognises every song container either game plays, including Rock Band CON files that only YARG reads. See §5a. |

### App identity (decided 2026-10-14)

The app is **Chartroom**: `productName` "Chartroom", `appId` `com.randland.chartroom`, repo `randland/chartroom`.
It gets its own `userData`, so it installs next to upstream CHM without sharing config, catalog DB or caches. On
first run it offers a one-time import of upstream CHM's config and catalog (P0.2).

---

## 2. Repo: the existing public fork

The repo is `randland/chartroom`, a public GitHub fork of `xlzipx/clone-hero-chart-manager` (decided and renamed
2026-10-14). Public means unlimited
free Actions minutes on Linux, Windows and macOS runners, and electron-updater can read its releases without a token.

- Remotes: `origin` = the fork, `upstream` = `xlzipx/clone-hero-chart-manager` (push disabled), `gh` default repo =
  the fork. Already set up.
- Renamed from `clone-hero-chart-manager`; GitHub redirects the old URL. `origin` already points at the new name.
- Forks start with Actions workflows disabled: enable them once on the repo's Actions tab.
- Staying in the fork network is fine: PRs default to the fork through `gh repo set-default`, and nothing can be
  pushed upstream.
- Keep `LICENSE` with ZIPEEK's MIT copyright line; add your own line below it.

---

## 3. Rules for every ticket

1. **Style** (user rules): descriptive names; single-line arrow functions where possible; ternaries of medium size or
   larger over 3 lines; guard clauses over if/else; no trailing whitespace (`git diff --check`); English comments.
2. **JSDoc:** every exported function has `@param`/`@returns`; module-level state has a `@type`. Prefer
   `/** @import { Song } from '../shared/types.js' */` over inline `import('...')` types. Files start with
   `// @ts-check` until `checkJs` is on globally (P0.3).
3. **Port tickets preserve behaviour.** A port commit changes language, comments and structure only. Behaviour
   changes (bug fixes, cleanups) are separate tickets with their own tests. When translating Czech comments, keep the
   "why"; drop comments that only restate the code.
4. **Characterization tests before porting** a module: write Vitest tests against the TypeScript version first; they
   must pass unchanged against the JS version.
5. **Renderer architecture:**
   - Components never call `window.api`. Only `src/renderer-vue/api/*.js` service modules do; stores and composables
     use the services. (Upstream had 100+ direct calls; this is the fix.)
   - Screens are route components; long screens split into child components of ≤ 300 lines.
   - Every dialog uses `BaseDialog` (P2.3). No hand-made overlays.
   - Reuse existing CSS class names exactly; new styles go in a scoped `<style>` block or a new section at the end of
     `styles.css`, using the existing CSS variables.
6. **Accessibility** (user rule): `aria-label` on every icon-only button; `role`/`aria-*` on custom widgets (listbox,
   switch, radiogroup, tabs, progressbar); visible focus; full keyboard operation; `role="status"` for live messages;
   no colour-only signals. The ESLint a11y plugin must pass.
7. **Definition of done:** `npm run lint`, `npm run typecheck`, `npm test` pass; UI tickets also checked by hand in
   `npm run dev` (Playwright, if used, only through a subagent); `docs/upstream/file-map.md` updated when a file
   is ported.

### Model tiers

- **Haiku:** config, mechanical wiring, small components with a spec.
- **Sonnet:** most tickets (module ports with tests, screen specs, screen builds).
- **Opus:** flagged tickets only (store decomposition, Library screen architecture), or after two failed Sonnet attempts.

---

## 4. Target layout

```
app/
  src/
    main/            JS, ported module by module (core/*.js, ipc/*.js split by domain, index.js)
    preload/         index.js (contract = RendererApi typedef in shared/types.js)
    shared/          types.js (@typedefs), errors.js, songid.js, foldertemplate.js
    renderer/        React UI (until Phase 5 cut-over, then deleted)
    renderer-vue/
      index.html, main.js, App.vue, router.js
      api/           one module per domain wrapping window.api (catalog, library, jobs, player, config, ...)
      stores/        Pinia: config, search, jobs, player, preview, library, playlists, ui, updates, video
      composables/   useDialog, useRangeSelect, useHotkeys, useAudioElements, ...
      components/
        base/        BaseDialog, BaseSwitch, BaseSegmented, BaseCheckbox, PathField, CommitInput, ProgressBar,
                     Toast, Icon, VirtualList, Dropdown, Card, SettingRow
        search/ library/ settings/ player/ playlists/ shell/ video/
      styles.css     (moved from renderer/src at cut-over; imported from there until then)
  tests/             Vitest: main/*.test.js, renderer/*.test.js, fixtures/
docs/specs/          one spec per screen (Phase 3)
```

---

## 5. Phases and tickets

### Phase 0: repo, tooling, release pipeline

#### P0.1 Repo housekeeping (user + Haiku)
Repo, rename and Actions are done (§2). Commit the uncommitted video work and docs on
`feature/video-tools` (video plan T0.1: `npm ci`, `npm run typecheck`, `npm run test:video`), push the branch and
merge it into `main`.
- **Accept:** Actions enabled, `main` contains the video backend and the plans, `upstream/main` still an ancestor.

#### P0.2 Repoint everything upstream-owned (Haiku)
- `src/shared/repo.js`: `GITHUB_REPO = 'randland/chartroom'`, `RELEASES_PAGE`, `REPO_URL`. Use it in `update.ts:12`,
  `WhatsNew.tsx:5`, `UpdateNotes.tsx:6`, `AboutModal.tsx:10`; `package.json` `build.publish[0].owner`/`repo`.
- Until the fork has published its first release, electron-updater finds nothing: make sure that case is silent
  (no error banner), and the "What's new" link opens the repo's releases page.
- App identity (§1): `appId` `com.randland.chartroom`, `productName` `Chartroom`, and a one-time import of upstream CHM's `userData`
  (`config.json`, `catalog.db`, caches) on first launch, with a confirmation dialog.
- **Accept:** `grep -rn xlzipx app/src app/package.json .github` returns nothing; the app runs.

#### P0.3 JS toolchain: jsconfig, Vitest, ESLint (Sonnet)
- `npm i -D vitest @vue/test-utils happy-dom eslint @eslint/js eslint-plugin-vue eslint-plugin-vuejs-accessibility eslint-plugin-jsdoc vue-tsc`.
- `tsconfig.node.json` / new `tsconfig.vue.json`: `allowJs: true`, `checkJs: true` for `src/main`, `src/preload`,
  `src/shared`, `src/renderer-vue`; React renderer config unchanged.
- Scripts: `test` (vitest run), `test:watch`, `lint`, `typecheck` (node + web + vue).
- Move `tests/video.test.ts` to Vitest (`describe/it/expect`), keep the ffmpeg-generated fixtures.
- `.editorconfig` (`trim_trailing_whitespace = true`, `insert_final_newline = true`).
- **Accept:** `npm test`, `npm run lint`, `npm run typecheck` all green on the untouched codebase (lint scoped to new
  dirs only for now).

#### P0.4 CI and three-OS release workflows (Sonnet)
- `.github/workflows/ci.yml` on push/PR: `ubuntu-latest` lint + typecheck + test; a `windows-latest` and
  `macos-latest` test job only for `tests/main/**` path-sensitive suites (keeps macOS minutes low).
- `.github/workflows/release.yml` on `v*` tags: matrix Linux (AppImage), Windows (NSIS: fetch Windows Onyx zip and
  `7z.exe`/`7z.dll` into `native/`, per `docs/building.md` and `win.extraResources`), macOS arm64 (existing steps +
  ad-hoc signing). Upload to one draft release per tag. Replaces `build-linux.yml` and `build-macos.yml`.
- **Accept:** a `v1.7.0-test.1` tag produces installable artifacts for all three OSes in one draft release.

---

### Phase 1: backend port (main, preload, shared)

Order: shared first (everything imports it), then leaf modules, then modules that depend on them, `ipc` and `index`
last. Each ticket: (a) characterization tests against the TS module, (b) port to JS + JSDoc with translated comments,
(c) same tests green, (d) update `file-map.md`. Bug fixes come after, in P1.12.

| Ticket | Modules | Tests to write first | Tier |
|---|---|---|---|
| P1.1 | `shared/types.ts` → `types.js` (`@typedef` for every interface; `RendererApi` documented as the IPC contract), `errors`, `songid`, `foldertemplate`, `utils` | `songid` keys and normalisation, folder template rendering, `userMsg` mapping | Sonnet |
| P1.2 | `platform`, `proc`, `filetype`, `filemeta`, `roots` | `cleanChildEnv` (AppImage vars), `resolveRel`/`toRel` incl. `::id` extra folders and traversal rejection | Sonnet |
| P1.3 | `songmeta`, `chartlevels`, `sngextract`, `sngpreview` | song.ini round-trip (CRLF, unknown keys, `$` in values); `.mid`/`.chart` level fixtures incl. running status and wrong track lengths; GHL ranges | Sonnet |
| P1.4 | `playlists` | `.setlist` encode/decode byte-exact against fixture files; lock + atomic write | Sonnet |
| P1.5 | `extractor`, `converter` | argument building (`-p`, `--`), CRC-tolerance decision, `ensurePsTarget` for DTX, ASCII staging path choice | Sonnet |
| P1.6 | `enchor`, `rhythmverse`, `spotify`, `preview` | `normalizeSong` fixtures from captured API JSON (store under `tests/fixtures/api/`), paging limits, dedup, joke-year filter | Sonnet |
| P1.7 | `download` | URL classification (Drive file/folder, Mediafire, Dropbox, shorteners); Drive confirm-page parsing from saved HTML; byte-shortfall retry decision | Sonnet |
| P1.8 | `catalog`, `catalogsync`, `catalogreader`, `catalogworker` | `queryCatalog` against a small SQLite fixture (filters, sort, "Both" merge); migration from an older schema fixture | Opus |
| P1.9 | `library`, `librarymgr`, `duplicates`, `localaudio` | install name reservation, path guards, `problemFromNames`, duplicate grouping; trash/permanent selection with an injected remover | Sonnet |
| P1.10 | `gamedetect`, `jobs`, `autoupdate`, `update`, `config`, `hotkeys`, `menu`, `tray`, `reminder`, `overlay` | config defaults/merge; job state machine with injected steps; game path candidates per OS | Sonnet |
| P1.11 | `ipc.ts` → `main/ipc/*.js` split by domain (`library`, `catalog`, `jobs`, `player`, `config`, `system`, `video`), business logic moved out (e.g. the "Both" merge into `catalog`), lightweight argument validation helpers; `preload/index.js`; `index.js` | an IPC registration test asserting every `RendererApi` member has a handler | Sonnet |

Also port `src/main/core/video/*` (already Electron-free) into JS in P1.3's style; its tests are already
characterization tests.

#### P1.12 Fixes found by the code review (Sonnet, one commit each, each with a regression test)
1. `library.ts:297`: nested install folders joined with `\` create a literal `A\B` folder on Linux/macOS. Use `path.join`.
2. `catalogsync.ts` (~`:301-339`): `syncing` not reset if a sync throws. Reset in `finally`.
3. `catalog.ts:635`: `q.system` interpolated into SQL from IPC. Whitelist values.
4. `download.ts` and `rhythmverse.search()`: no timeouts on stalled requests. Add `AbortSignal.timeout` and a stall
   detector for downloads (no bytes for 60 s).
5. `gamedetect.ts:163,234,691`: the upstream author's `G:\` paths. Remove; detect from registry/launcher data only.
6. `converter.ts` (~`:198-212`): staging dir leaks if `cpSync` throws before the `try`. Move into the `try`.
7. `librarymgr.ts:552`: `libMoveOut` uses sync `cpSync` and freezes the main process. Use async `cp`.
8. Three `song.ini` parsers (`songmeta`, `library.ts:130`, video `songini`): merge into `songmeta`.
9. Three copies of `SONG_MARKERS` / library walkers and the rich-text tag regex: one shared module each.
10. `playlists.ts:40`: `Documents/Clone Hero/Setlists` on every OS: verify the Linux and macOS Clone Hero paths and fix.
11. Remove the 8 dead exports the review listed (`isGameRunning`, `sendHotkey`, `encodeSetlist`, `converterAvailable`,
    `isArchive`, `chartLevels`, `midLevels`, `IS_WIN`) after confirming with grep.

#### P1.13 Toolchain upgrade (Sonnet)
Electron 33, electron-vite 2 and Vite 5 are behind. Upgrade to current supported Electron, electron-vite and Vite
**after** P1 tests exist (they catch regressions). Re-run `build/fetch-sqlite-prebuild.cjs` for the new Electron ABI.
- **Accept:** all tests green, app runs on Linux, release workflow green on all three OSes.

#### P1.14 to P1.17: Clone Hero and YARG
Behaviour changes, so they come after the ports they touch (P1.9, P1.10) and after P1.12 item 9. Details in §5a.

---

### Phase 2: Vue foundation

#### P2.1 Second renderer entry (Haiku)
- `npm i vue pinia vue-router @tanstack/vue-virtual` and `-D @vitejs/plugin-vue`.
- `electron.vite.config`: renderer inputs `index.html` (React) and `renderer-vue/index.html`; both plugins.
- `src/main/index.js`: load the Vue entry when `process.env.CHM_UI === 'vue'` (dev) or a hidden setting
  `uiPreview: 'vue'` is set. Same preload.
- `renderer-vue/main.js` creates the app with Pinia and the router; imports `../renderer/src/styles.css` and fonts.
- **Accept:** `CHM_UI=vue npm run dev` shows a Vue page styled by the existing CSS.

#### P2.2 API service layer (Sonnet)
`renderer-vue/api/*.js`: one module per domain, thin wrappers over `window.api` with JSDoc types from
`RendererApi`; event subscriptions return unsubscribe functions and are wrapped as composables
(`useJobUpdates`, `useCatalogStatus`, ...). An ESLint rule (`no-restricted-globals` / `no-restricted-properties`)
forbids `window.api` outside `api/`.

#### P2.3 Base components (Sonnet)
`components/base/`: `BaseDialog` (teleported, `.modal-overlay` or `.lib__dialog-overlay` via a `size` prop so the
old CSS applies, `role="dialog"`, `aria-modal`, `aria-labelledby`, focus trap, Escape, focus restore, backdrop click
opt-in), `BaseSwitch` (`role="switch"`), `BaseSegmented` (radiogroup), `BaseCheckbox` (the `.chk` markup),
`PathField`, `CommitInput`, `ProgressBar` (`role="progressbar"`), `Toast` (`role="status"`), `Icon` (port of
`Icon.tsx` PATHS + `film`, `wand`), `VirtualList` (`@tanstack/vue-virtual`, fixed and variable row heights),
`Dropdown`, `SortSelect`, `Pager`, `RichText`, `DifficultyDots`, `InstrumentDifficulty`, `LevelsBadge`.
- Component tests for keyboard behaviour (dialog trap/escape, switch, radiogroup arrows, checkbox shift-range).

#### P2.4 Store decomposition (Opus)
Inventory `store.ts` (≈176 fields/actions, 20 module-level `let`s, 4 module Maps) into a table in
`docs/specs/stores.md`: field → new Pinia store, persisted? (config), who reads it. Then create the store skeletons
with state and getters only. Target stores: `config`, `search`, `jobs`, `player`, `preview`, `library` (cross-screen
library state: reveal, fix flows, bulk fix), `playlists`, `ui` (toasts, open dialogs, screen), `updates`/`catalog`,
`video`.
- **Accept:** the table accounts for every field; skeletons typecheck.

#### P2.5 Port non-visual logic into stores (Sonnet, one ticket per store)
Order: `config` → `jobs` → `preview` + `player` (audio element pool, loudness gain graph, `seekReady`, spliced-preview
clock workaround from `store.ts:603-610`, `crossOrigin` before `src`) → `search` (local catalog vs deep scan vs server
paging, RV chunking past page 249, `doSearch` `store.ts:2289-2400`) → `library` → `playlists` → `ui`/`updates`.
Each with Vitest tests using a mocked `api` layer.

#### P2.6 App shell (Sonnet)
`App.vue`, `router.js` (routes `/search`, `/library/:path(.*)?`, `/library/tools/:tool`, `/settings/:section?`;
memory history; back/forward buttons and mouse buttons 3/4; navigation blocked while a dialog is open, replacing
`screenhistory.ts` `overlayOpen()`), `TitleBar`, `Sidebar`, global hotkeys composable, `TipsTicker`, `CatalogActivity`,
update banners.
- **Accept:** navigation and back/forward behave like the React app (spec `docs/specs/shell.md`, written in this ticket).

---

### Phase 3: screen specs

One ticket per screen (Sonnet). Output: `docs/specs/<screen>.md` using this template, written by reading the React
code (cite `file:line` for every non-obvious behaviour):

1. Purpose and entry points (routes, buttons, hotkeys that open it).
2. Layout regions with the CSS classes each uses (so the Vue template reproduces the markup).
3. Every user action → effect (store action / API call), including multi-select, drag and drop, context menus.
4. State: what persists in config, what survives screen switches (upstream module-level caches), what resets.
5. Loading, empty, error and partial states.
6. Keyboard shortcuts and focus behaviour.
7. Accessibility requirements, including fixes for gaps the React version has.
8. Edge cases encoded in the React code (with `file:line`).
9. Game awareness: what changes with the "Games I play" setting (§5a), and any text that names Clone Hero but should
   name the selected game(s).
10. Acceptance checklist the Vue build is tested against.

Before the first spec, run the game checks G1 to G5 (§5a); their answers feed the `setlists`, `playlist-import`,
`library` and `downloads` specs.

Screens: `settings`, `search` (SearchBar, FilterPanel, FilterBar, SongRow, DownloadOptions, TargetFolderModal,
LocalDropModal, MarketplaceModal), `downloads` (DownloadQueue, FixBanner, BulkFixModal), `player` (PlayerBar,
LocalPreview), `library` (browser, filters, detail panel, dialogs, SongMetaDialog), `setlists`, `duplicates`,
`playlist-import` (PlaylistImportModal, PlaylistDialog, plus the new Spotify login), `about-updates` (AboutModal,
WhatsNew, UpdateNotes, HotkeyInput, RowMenu).

The user reviews each spec before its build ticket starts: this is where you decide what to keep, drop or change.

---

### Phase 4: build the screens in Vue

Each screen: build from its spec, component tests for the acceptance checklist items that are testable, manual
check against the React version side by side (`CHM_UI=vue` vs default).

| Ticket | Screen | Notes | Tier |
|---|---|---|---|
| P4.1 | Settings | Small; proves base components and the config store. Adds the **Games I play** card and the three-way Rock Band format control (§5a, P4.1 notes). | Sonnet |
| P4.2 | Search | Results list virtualized; filters; download options; target folder; local drop. Instrument filters gain the parts added by P1.17. | Sonnet |
| P4.3 | Downloads | Queue panel, fix banner, bulk fix dialog. The "scan your songs" hint names the selected game(s) (G5). | Sonnet |
| P4.4 | Player + previews | PlayerBar, LocalPreview ring, mutual exclusion of preview/player. | Sonnet |
| P4.5a | Library: architecture | Split plan for the 2,094-line component: `LibraryScreen`, `FolderTree`, `LibraryToolbar`, `FilterPanel`, `LibraryList` (virtual cards/list), `LibraryRow`, `DetailPanel` (+ sections), dialogs; composables `useLibraryFolder`, `useLibraryFilters`, `useLibrarySelection`, `useLibraryNavigation`. Written into `docs/specs/library.md`. Includes song containers (§5a P1.15). | Opus |
| P4.5b-e | Library: build | Browser + navigation; filters + sort; detail panel + dialogs; selection, clipboard, drag and drop. Format badge and filter, "Convert for Clone Hero" action (§5a). | Sonnet |
| P4.6 | Setlists | Library tool route. Scope depends on G1 (§5a). | Sonnet |
| P4.7 | Duplicates | Library tool route; scan, review, inline confirm bar. Rock Band containers per P1.16. | Sonnet |
| P4.8 | Playlist import + Spotify login | See P4.8 detail below. Output depends on G1 (§5a). | Sonnet |
| P4.9 | About, What's new, update notes, hotkey input, row menus | | Haiku |

#### P4.8 Spotify login detail
- Settings → Spotify: a "Client ID" field with step-by-step help (create an app at developer.spotify.com, Web API,
  redirect URI `http://127.0.0.1:43821/callback`, add your own account under User Management; needs Premium).
  Verify in the ticket whether Spotify accepts a dynamic loopback port; if so drop the fixed port.
- Main: `spotifyauth.js`: PKCE verifier/challenge, open the system browser to the authorize URL (scopes
  `playlist-read-private playlist-read-collaborative`), one-shot loopback HTTP server receives the code, exchange
  for tokens, store the refresh token with Electron `safeStorage`, refresh on expiry, "Log out" clears it.
- Import flow: logged in → list `GET /me/playlists` to pick from, or paste a link; read tracks with
  `GET /playlists/{id}/items` (paginate). If Spotify returns metadata only (playlist not owned/collaborative),
  tell the user and fall back to the embed reader (first 100) with a hint to copy the playlist into their own.
  Not logged in → embed reader only.
- Remove `SPOTIFY_WORKER_URL` and the Worker path from `spotify.js`; leave `worker/` in the repo marked unused or
  delete it.
- Tests: PKCE challenge, URL building, pagination, metadata-only handling with mocked responses.

---

### Phase 5: parity and cut-over

#### P5.1 Parity checklist (Sonnet + user)
Walk every spec's acceptance checklist in the Vue build on Linux, then Windows and macOS (release-workflow
artifacts). Record results in `docs/specs/parity.md`. Gaps become tickets.

#### P5.2 Cut-over (Haiku)
Make Vue the only renderer: move `renderer-vue` to `renderer`, move `styles.css`, delete React, zustand, the React
plugin and types, `screenhistory.ts`, the second entry, the `CHM_UI` switch. Prune CSS classes no template uses
(script: list classes from `styles.css`, grep templates and dynamic class builders, remove confirmed-dead ones).
Update `file-map.md` (renderer files → Vue counterparts or `dropped`). Release `2.0.0`.

---

### Phase 6: video tools on the new stack

Apply `docs/video-tools-plan.md` with these substitutions:
- Backend tickets (T0.2, T0.3, T1.0 to T1.4, T1.6, T1.7, T2.7 main part, T4.1, T4.3, T5.0 to T5.3, T5.5) are written in JS + JSDoc
  in `src/main/core/video/*.js` and tested with Vitest. Their rules (Electron-free core, injected remover,
  portability rule 9) still apply.
- T1.5 (IPC) goes into `main/ipc/video.js` + `renderer-vue/api/video.js` + `stores/video.js`.
- UI tickets T2.1 to T2.6, T2.7 (dialog), T3.1, T3.2, T4.2 (UI part), T5.4 are rebuilt as Vue components under
  `components/video/` using `BaseDialog`, `VirtualList`, `BaseSegmented` etc.; T2.1's `useDialogA11y` is
  replaced by `BaseDialog`.
- T0.1b is superseded by P0.1 to P0.4.
- Game awareness (§5a): the `needs-conversion` check and convert-on-install apply only when the games setting
  includes YARG; `.sng` files are inspected for their video (video plan T2.7); Rock Band containers are skipped and
  counted. The video plan has these edits already.

If you want the video tools sooner, Phase 6's backend tickets can start right after P1 (they don't depend on the
Vue UI) and be used through the CLI (`npm run video`) until the screens exist.

---

## 5a. Clone Hero and YARG

Upstream already detects and launches both games (`chExePath`, `yargExePath`, `gamedetect.ts`) and has
`rbFormat: 'convert' | 'original'` (`config.ts:230`), which keeps a Rock Band CON file as downloaded. Upstream frames
"original" as being for Rock Band 3 on Xbox 360 (`Settings.tsx:745-747`), but YARG plays those files too.
Everything else assumes Clone Hero:
- Library code (`library.ts:12`, `librarymgr.ts:44`, `duplicates.ts:22`, `playlists.ts:33`, `video/audit.ts:29`)
  recognises a song only by `song.ini` / `notes.chart` / `notes.mid`. A kept CON file (e.g. `song_rb3con`, no
  extension) shows up as a plain file and is missing from counts, duplicates, problem checks and the video tools.
- The video plan requires VP8 for every song, but that is a YARG-on-Linux requirement.
- The rescan hint says "Settings → Scan Songs" (`DownloadQueue.tsx:115`), which is Clone Hero's menu.

**Facts used here** (verify in the tickets that depend on them): Clone Hero plays song folders and `.sng`; YARG plays
song folders, `.sng`, Rock Band CON files and extracted CON folders. Clone Hero does not read CON files.

### Game checks (Sonnet with web search + user, before Phase 3)
Record each answer in this section under "Results", with the source (YARG docs, YARG.Core source file, or a test in
the game).

| Check | Question | Feeds |
|---|---|---|
| G1 | Does YARG read Clone Hero `.setlist` files? If not, does it have its own playlists, where are they stored and in what format? | P4.6 Setlists, P4.8 Playlist import |
| G2 | What does YARG use from a Rock Band CON that the Onyx conversion to Clone Hero format loses (e.g. multitrack audio, pro guitar/bass, real keys, harmonies, venue, lip sync)? Convert one song both ways and compare in YARG. | Default Rock Band format for the `yarg` profile (P1.14) |
| G3 | Which files does YARG show as a song background besides `video.*` (still images, its own background format)? | Video health check: such songs are not "No video" |
| G4 | Do the Encore and RhythmVerse API responses and `song.ini` carry pro drums and harmony vocals (e.g. `pro_drums`, `diff_vocals_harm`)? Use the captured fixtures from P1.6. | P1.17 |
| G5 | Where does YARG store its song folder list per OS, in what format? What is YARG's menu path for rescanning songs? | P1.14 (profile default), P4.1 Settings, P4.3 rescan hint |

### Results

(fill in)

### P1.14 "Games I play" setting (Sonnet)
- Config: `games: 'clone-hero' | 'yarg' | 'both'`. When a config has no `games` key (first run and upgrades), derive
  it once from detected installs (`gamedetect`): only YARG found → `yarg`, only Clone Hero → `clone-hero`, both or
  neither → `both`. Save the derived value so it never changes behind the user's back.
- `rbFormat` becomes `'auto' | 'convert' | 'original'`. `auto` follows the games setting: `original` for `yarg`
  (unless G2 finds conversion loses nothing), `convert` for `clone-hero` and `both` (the Clone Hero format plays in
  both games). Migration: existing `convert` → `auto` (same behaviour for the current default), `original` stays.
  The per-download choice (`rbChoice`, `store.ts:176`) still overrides.
- `src/shared/games.js`: `targetsYarg(games)`, `targetsCloneHero(games)`, `resolveRbFormat(config)`,
  `gamesLabel(games)` ("Clone Hero", "YARG", "Clone Hero and YARG"). Every feature reads these helpers, never the raw
  config key.
- Tests: derivation matrix (4 detection cases), `resolveRbFormat` matrix, the `rbFormat` migration.

### P1.15 Song containers (Sonnet)
Do together with or right after P1.12 item 9: the shared walker it creates becomes this module.
1. Check first: read YARG.Core's song scanner source and record in "Results" exactly how YARG recognises a CON file
   (header bytes) and an extracted CON folder (expected layout, e.g. `songs/songs.dta` plus one subfolder per song).
2. `main/core/songcontainers.js`:
   - `/** @typedef {'clone-hero' | 'yarg'} GameId */`,
     `/** @typedef {'folder' | 'sng' | 'con' | 'rb-folder'} ContainerKind */`.
   - `detectContainer(absPath, dirent)` → `{ kind, playableIn: GameId[] } | null`:
     `folder` (song markers, both games), `sng` (`isSngFile`, both), `con` (a file whose header matches step 1;
     check only files with no extension or `.con` / `.rb3con`, never trust the name alone; YARG only), `rb-folder`
     (step 1 layout; YARG only).
   - `readSongsDta(text)` → `{ shortName, name, artist }[]`: a small parser for the DTA format (nested parentheses,
     quoted strings, `;` comments). DTA text is Latin-1 unless the entry has `(encoding utf8)`. One `songs.dta` can
     list several songs (packs).
   - CON files are STFS packages; reading the `songs.dta` inside one is out of scope here. A CON shows its file name
     until a later ticket adds a small STFS reader.
3. Library listing and counts (`library`, `librarymgr`): containers appear as songs with `container` and
   `playableIn` on the item (`LibItem` typedef). An `rb-folder` with a pack counts as its number of songs.
- Tests: a fixture tree with each kind (fake CON = header bytes + padding), an extensionless non-CON file (ignored),
  nested folders, junk files; `readSongsDta` with a 2-song pack in Latin-1 and in UTF-8.

### P1.16 Containers in the other library features (Sonnet)
- Duplicates: compare `rb-folder` songs by `songs.dta` artist/title; CON files are listed as "not compared" with a
  count, not silently skipped.
- Problem checks: `problemFromNames` applies to `folder` only; an `rb-folder` song is broken if its `.mid` or `.mogg`
  is missing.
- Convert for Clone Hero: `libConvertRb(rel)` runs the existing Onyx converter (`converter.ts`) on a library CON
  file or `rb-folder` and installs the result next to it. Whether the original is removed (through `deleteMode`) is
  a choice in the confirm dialog, default keep.
- Setlists and video tools skip YARG-only containers (until G1 says otherwise) and report how many they skipped.
- Tests: each rule with the P1.15 fixture tree.

### P1.17 Missing instrument parts (Sonnet, after G4)
If G4 finds the data: add `proDrums` and `vocalsHarmony` to `InstrumentDifficulties` (`types.ts:4`), map them in
`enchor` / `rhythmverse` `normalizeSong` and in `songmeta` (song.ini), and add them to the catalog schema with a
migration (P1.8 migration test pattern). Skip the ticket if G4 finds no data.

### UI notes for Phase 3 and 4
- **P4.1 Settings:** a "Games I play" card at the top of the Game section: a radiogroup (Clone Hero / YARG / Both) and a
  short list of what the choice changes ("Rock Band downloads: kept as original files", "Video check: VP8 required").
  The Rock Band format control becomes three options: "Follow games setting (recommended)", "Convert to Clone Hero
  format", "Keep original". If G5 finds YARG's song folder list, offer "Use YARG's song folders".
- **P4.3 Downloads:** the rescan hint names the right game(s) and their menu paths, using `gamesLabel` and G5.
- **P4.5 Library:** a format badge for `con` and `rb-folder` items ("RB", `aria-label="Rock Band file, plays in YARG
  only"`), shown as a warning when the games setting includes Clone Hero, with a "Convert for Clone Hero" action
  (P1.16). A "Format" filter: Any / Song folders / .sng / Rock Band. The detail panel lists the songs inside a pack.
- **P4.6 Setlists / P4.8 Playlist import:** if G1 says YARG doesn't read `.setlist`, label the tool "Clone Hero
  setlists" when the games setting is `both`, and hide or explain it when it is `yarg`. If YARG has its own playlist
  format, a follow-up ticket adds an export to it.

---

## 6. Order at a glance

```
P0 repo + tooling + CI/release
P1 backend port (tests first) ──► P1.12 fixes ──► P1.13 toolchain upgrade ──► P1.14-P1.17 Clone Hero + YARG
                     └──────────► video backend (Phase 6 backend tickets, optional early)
P2 Vue foundation (entry, api layer, base components, stores, shell)
G1-G5 game checks ──► P3 specs (user reviews each) ──► P4 screens ──► P5 parity + cut-over (2.0.0) ──► P6 video UI
```

Rough size: ~60 tickets. P1 and P4 are the big ones; P3 is where your review time matters most.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Behaviour lost in the backend port | Characterization tests before each module port; port commits change no behaviour. |
| Screens drift from the original | Per-screen specs with `file:line` citations; side-by-side parity walk; CSS class names kept. |
| Long period with two UIs | Releases ship React until P5; Vue is a dev flag. Don't add features to the React UI meanwhile. |
| Upstream keeps moving (≈60 commits/month) | `upstream-sync` skill; 1:1 module port keeps the file map useful; decide per commit. |
| Spotify changes rules again | Embed fallback stays; login path is isolated in `spotifyauth.js`. |
| Electron upgrade breaks natives | Done after tests exist (P1.13), with the release workflow as the cross-OS check. |
| Guessing what YARG supports | Every YARG claim the code relies on is a G check or a step-1 check with its source recorded in §5a "Results". |
| Treating random files as CON files | Header bytes decide, never the file name (P1.15); fixture test with an extensionless non-CON file. |
