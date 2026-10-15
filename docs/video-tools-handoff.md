# Video tools: handoff brief

Branch: `feature/video-tools` (uncommitted work, nothing pushed). Repo: Clone Hero Chart Manager (Electron + React, `app/`).
Written 2026-10-14. Task for the next agent: **produce a detailed implementation plan** for bringing the
user's video-management workflow into the app UI, then (once the user approves) build it.

## Goal
The user maintains a Clone Hero / YARG song library with per-song background videos. They built a pipeline
outside this repo (in `~/mnt/mamecade/.agents/video-finder/`, Python + bash + PowerShell, run through LLM agents)
and want it as **first-class, cross-platform (Windows, macOS, Linux) app features**, so they do not need an LLM
to run any of it. The user explicitly does not want the Python/bash/PowerShell carried over: port the logic to
TypeScript.

## Hard requirements learned (Linux/YARG)
1. YARG on Linux (Unity video player) only decodes **VP8 in a `.webm`**. H.264 MP4 shows nothing. Clone Hero
   plays anything because it decodes video itself.
2. A song folder must contain **exactly one `video.*` file**. If `video.mp4` and `video.webm` both exist, YARG can
   pick the MP4 and show a black background (YARG issue #1331).
3. The user's conversion recipe: keep the name `video`, drop audio (`-an`), cap at 720p, libvpx, container WebM;
   leave timing alone (`video_start_time` in song.ini unchanged); delete the source MP4 only after verifying the
   output is VP8 and its duration matches the source video track within ~2 s. The original script was never
   found on disk; `convert.ts` rebuilds it from that spec (CRF 30 is my choice, not the user's).
4. Default output format decision: WebM VP8 everywhere (the library lives on a shared exFAT/SMB drive used by
   several OSes). A "match this OS" option is a possible setting.
5. Large direct writes to SMB can stall: encode to a local temp dir, then copy in via a `.part` file + rename.
6. exFAT drives do not support hard links (the old `fix-duplicate-videos.ps1` used NTFS hard links): fall back to copy.

## What exists now (all uncommitted on the branch)
`app/src/main/core/video/` (no Electron dependency, extensions `.ts` in imports so Node 24 runs them directly;
`allowImportingTsExtensions` added to `app/tsconfig.node.json`, which now also includes `tools/` and `tests/`):
- `songini.ts`: read/write `video_start_time` (ms) in place, preserves EOL and other keys.
- `tools.ts`: locate/run ffmpeg & ffprobe (`CHM_FFMPEG_DIR` env, `setBundledToolDir()`, then PATH).
- `probe.ts`: ffprobe JSON wrapper (`probeVideo`, `isVp8Webm`).
- `audit.ts`: read-only scan. Issues: `no-video`, `multiple-video-files`, `needs-vp8-webm`, `unreadable-video`,
  `no-start-time`, `leftover-download-files`. `--probe` mode checks the real codec.
- `convert.ts`: `convertSongVideo()` with the verify-then-delete rules above; also handles "valid video.webm
  already present, just remove extras" and leaves originals on any failure.
- `clean.ts`: `cleanLeftovers()` removes yt-dlp/ffmpeg fragments (`video.f137.mp4`, `video.temp.mp4`, `*.part`,
  `.ytdl`, `.tmp`); keeps `.bak` unless `includeBackups` (a `.bak` can be the only copy of an original).
- `app/tools/chm-video.ts`: CLI (`npm run video -- audit|clean|convert --songs <dir> [--probe|--json|--dry-run|...]`).
- `app/tests/video.test.ts`: 10 passing tests (`npm run test:video`) using real ffmpeg-generated clips.
- Typechecked the new files standalone only (`node_modules` is not installed in this checkout; full
  `npm run typecheck` has not been run).

## Findings on the user's real library
`/media/nkarpenske/Clone Hero/Songs` (note capital S; exFAT; 7,057 song folders, 7,066 song.ini files, so ~9 song
folders probably nest inside other song folders, not investigated):
- 3,160 songs have `video.webm`, and a `--probe` run verified **all** are real VP8-in-WebM (0 unreadable).
- 3,897 songs have no video (the backlog for the downloader).
- 118 videos lack `video_start_time`.
- 3 songs have both `video.mp4` and `video.webm` (Amon Amarth / Twilight of the Thunder God; Dethklok / Laser Cannon
  Deth Sentence; Machine Head / Beautiful Mourning). **Not yet fixed.** `convert` would remove the MP4.
- 9 yt-dlp leftover files (300.6 MB) were deleted with `clean` (user asked for it). Kept on purpose:
  `Arcade Fire/Everything Now/video.mp4.bak` (75 MB original).
- Full audit ran in ~3 s without probe, ~72 s with probe.

## The pipeline to port (read these first)
In `~/mnt/mamecade/.agents/video-finder/` (SMB mount; `~/mnt/mamecade`):
- `video-wave.py` (1,123 lines): SQLite job queue (`~/video-staging/wave.db`), parallel workers, yt-dlp search
  (rounds: DDG, `ytsearch`, VEVO), download, static-image detection, fingerprint gate, serialized deploy, `--verify`,
  `--fix-offsets`, `--force-id FOLDER_PATTERN VIDEO_ID` (`id:NNN` selector).
- `fingerprint-sync.py` (394 lines): decides whether a video matches the song and computes `video_start_time`.
  **Not yet read.** Key unknown: does it need `fpcalc` (Chromaprint, not installed here) or numpy? That decides how
  hard the port is and what must be bundled.
- `classify-static.py` (211 lines): finds videos that are just album art (frame diff via ffmpeg). Easy to port.
- Notes: `mamecade-notes.md` (see "ScriptDoctor", "VideoReinject", "Static deletion", "REpack Video Wave"),
  `.agents/cataloger/yarg-video-metadata.md` (WRONG for the user's Linux setup: it concludes "no migration needed"
  because it assumed a Windows YARG build; correct it or ignore it).
- Known operational issue: YouTube currently bot-blocks this host's IP ("Sign in to confirm you're not a bot").
  `video-wave.py` calls plain `yt-dlp` with no cookies. Any in-app downloader needs a cookies setting
  (`--cookies-from-browser` or a cookies.txt) and should be built last.
- Old pipelines (`run-*.sh`, `download-*.sh`, `classify-gameplay.sh`) are abandoned. Do not port them.

## User's decisions (verbatim intent)
1. "Use existing standards": follow the app's existing UI/IPC/job patterns.
2. A **health check** is better for now than an automatic fix-everything.
3. Both **individual** operations (automatic search, paste a video URL, preview video/audio sync, adjust offset,
   automatic offset) **and full-library** operations (scan for broken videos), plus **library filters** (has video /
   no video).

## Existing app standards to follow (verified by reading)
- IPC: handlers in `app/src/main/ipc.ts` (`ipcMain.handle('lib:...')`), exposed in `app/src/preload/index.ts`,
  typed via the `Api` interface in `app/src/shared/types.ts`.
- Jobs: `app/src/main/core/jobs.ts` `JobManager` (EventEmitter, `getAll/cancel/cancelAll`, stages, `update` events) and
  `DownloadQueue.tsx`. Cancelable, progress-reporting. Video operations should be jobs here (or a sibling manager).
- Broken-chart health check is the template: `lib:findBroken` (`librarymgr.ts: libFindBroken`), the `broken` field
  in `Filters` in `LibraryView.tsx`, `LibProblem` badge on `LibEntry`, `FixBanner.tsx`, and `BulkFixModal.tsx`
  (preview a batch, checkboxes, then apply). Video health should look and behave the same way.
- Deletions must honor `getConfig().deleteMode` (trash by default, `permanent` optional): see `removePath()` in
  `librarymgr.ts`. `convert.ts`/`clean.ts` currently call `fsp.rm` directly, so this needs reconciling.
- Config/settings live in `app/src/main/core/config.ts` + `Settings.tsx`; `downloadVideos` already exists
  (jobs.ts `removeVideos` strips videos after install when false) and must stay consistent with any new feature.
- Bundled native tools: `package.json` `build.*.extraResources` + `.github/workflows/build-{linux,macos}.yml`
  (Onyx and 7-Zip are fetched per platform). ffmpeg/ffprobe/yt-dlp (and maybe fpcalc) need the same treatment.
- `LibraryView.tsx` is 3,131 lines: put new UI in separate component files, keep edits there small.
- Codebase comments are in Czech; the video module's are in English (ask the user which they want).
- User's global rules: descriptive variable names; single-line arrow functions where possible; guard clauses over
  if/else; accessibility (aria-labels at minimum, aim for current standards); no trailing whitespace.
  Playwright MCP must be used through a subagent only.

## Proposed design (agreed in discussion, not yet built)
Library-wide: "Check videos" cancelable job -> report (not auto-fix) with counts per category; each category opens a
preview-then-apply dialog (BulkFixModal style): clean leftovers, convert, remove duplicate files. Library filter
`video: any | has | none | needs-attention` plus a video badge, backed by a cached video-status index.
Per-song Video section in the song detail panel: info (codec/size/offset), auto-search with ranked candidates the
user picks from, paste URL, preview video against the real song audio with the offset applied, nudge offset in ms
with live preview, auto offset with confidence shown (never write low-confidence silently), convert/remove.

Build order proposed: (1) backend slice: progress + cancel in core, jobs, IPC, shared types, status index;
(2) health check + filter + badge + preview/apply dialogs; (3) per-song panel with info/offset/sync preview;
(4) port fingerprint and auto offset; (5) search, paste URL, download behind a cookies setting.

## Open questions the planner should resolve with the user
- Trash vs permanent vs "keep recoverable until confirmed" for destructive video operations (recommendation: reuse
  `deleteMode` plus a mandatory preview).
- Video tools inside Library vs their own sidebar entry (recommendation: inside Library until fetch exists).
- Encode quality (CRF 30 is a guess) and whether "match this OS" output is wanted.
- Whether to also fix the 3 duplicate-MP4 songs and the 118 missing offsets in the user's library now.
- The `fpcalc`/numpy question once `fingerprint-sync.py` is read.
- CI: add Windows/macOS jobs to run `npm run test:video`; I can only test on Linux, so Windows/macOS behavior is
  unverified. `ffmpeg` bundling and licensing (LGPL vs GPL build, `THIRD-PARTY.txt`).

## Caveats
- Nothing has been run inside the actual app (no `node_modules`, UI not seen). Backend is tested; UI is not written.
- Nothing is committed. `package.json` (scripts `video`, `test:video`) and `tsconfig.node.json` are modified.
