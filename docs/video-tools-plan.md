# Video tools: implementation plan

Branch `feature/video-tools`. Written 2026-10-14 (planning session on Opus 5.5). Supersedes the "Proposed design"
section of `docs/video-tools-handoff.md`; read that file for background (library findings, YARG requirements).

> **Superseded in part by `docs/vue-port-plan.md`** (2026-10-14): the app is being ported to Vue 3 + JavaScript.
> Backend tickets here still apply (written in JS); UI tickets are rebuilt in Vue (port plan Phase 6); T0.1b is replaced
> by port plan Phase 0.
>
> **Clone Hero and YARG** (2026-10-15, port plan §5a): the VP8 requirement exists only because of YARG on Linux, so
> `needs-conversion` and convert-on-install apply only when the "Games I play" setting includes YARG
> (`targetsYarg()` from `src/shared/games.js`). `.sng` files are inspected for their video (T2.7). Rock Band
> containers (CON files, extracted CON folders) are skipped and counted. If port-plan check G3 finds other files
> YARG uses as a song background, songs with those don't count as "No video".

This plan is written to be executed ticket by ticket by cheaper models. Each ticket names its files, the exact
shapes to add, acceptance criteria and a suggested model tier. Do tickets in order unless "Depends on" says
otherwise. One ticket = one commit.

---

## 1. Decisions (settled with the user)

| Topic | Decision |
|---|---|
| Destination | **Personal fork.** English comments in new code are fine. Don't spend effort on upstream-friendliness. |
| Deleting files | Reuse `getConfig().deleteMode` (trash by default) through `removePath()`, always behind a preview-then-apply step. |
| UI placement | Inside Library: a third Library tool **"Videos"** (next to Setlists / Duplicates), a library filter + row badge, and a **Video** section in the song detail panel. No new top-level screen. |
| ffmpeg / ffprobe / yt-dlp | **Downloaded on first use** into `userData/tools/`, pinned versions + SHA-256. Lookup order: `CHM_FFMPEG_DIR` env, managed dir, system PATH. Nothing added to the installers. |
| Output format | Always **VP8 in WebM**, named `video.webm`, the only `video.*` file in the folder. Settings: max height (480/720/1080, default 720) and quality preset (default CRF 30). No "match this OS" option. Conversion is suggested only when the games setting includes YARG; with Clone Hero only, videos are left as they are. |
| Audio in converted videos | **Keep the audio track** so auto-offset can run any time. The user confirmed the games don't play video audio. WebM can't carry AAC, so audio is re-encoded to Opus 48 kbps mono (Vorbis if spike T0.2 shows Unity/YARG won't load VP8+Opus). The existing converted webms were stripped (39 of 40 sampled have no audio), but the original MP4s with audio still exist on the old share `~/mnt/mamecade/Songs` (at least 828 found): T4.3 restores their audio into the webms by remuxing, without re-encoding the video. |
| Finding videos | yt-dlp search → **ranked candidate list**; an **Auto-try** button walks candidates (download → album-art check → fingerprint) and stops at the first confident match; also manual pick and paste-a-URL. Results are **staged**: nothing is written to the song folder until the user previews and clicks Apply. No library-wide download batch. |
| Search backends | yt-dlp `ytsearch` only. The old DuckDuckGo round (Python `ddgs`) is dropped. |
| Auto offset | Port `fingerprint-sync.py` to TypeScript (no `fpcalc`, no numpy, no native deps). Only write offsets that pass the confidence gate; per-song results always need an explicit Apply. |
| Health check vs auto-fix | Health check that reports; each category is fixed through a preview-then-apply dialog. |

### Facts the plan depends on

- `fingerprint-sync.py` needs only ffmpeg + numpy; the port is pure TypeScript (FFT included) run in a `worker_threads` worker.
- Offset sign: **`video_start_time = round(lead_seconds * 1000)`** where `lead_seconds = video_time - chart_time` of
  the matched audio. Positive = skip into the video; negative = video starts after the song starts. The Python docstring
  claiming `-L*1000` is wrong; the code and the library data (e.g. AC/DC High Voltage = -2183) agree with the positive form.
- The old wave matched ~59% of songs (1860 deployed / 1306 exhausted), so manual pick, paste URL and manual nudge
  are first-class, not fallbacks.
- YouTube bot-blocks this host without cookies (`Sign in to confirm you're not a bot`). The downloader must support
  cookies and must **stop at the first bot-block**, never retry in a loop (the old wave burned 2,916 attempts).
- yt-dlp now needs a JavaScript runtime for YouTube (`--js-runtimes`). Resolved by spike T5.0.

---

## 2. Rules for every ticket

1. **Style** (user's global rules): descriptive variable names; single-line arrow functions where possible
   (`const isFoo = () => props.isFoo`); ternaries of medium size or larger split over 3 lines; guard clauses instead of
   if/else; no trailing whitespace; English comments, matching the comment density of the surrounding file.
2. **`src/main/core/video/*` stays Electron-free.** It is run directly by Node 24 (type stripping) for tests and the CLI:
   - import with `.ts` extensions (`import { x } from './probe.ts'`);
   - no TS-only runtime syntax (no `enum`, no `namespace`, no constructor parameter properties);
   - Electron-dependent behaviour (`removePath`, `cleanChildEnv`, `userData` paths) is **injected** by callers.
3. Electron-side glue lives in `src/main/core/video*.ts` (outside the `video/` folder), may import Electron, and follows the
   existing extension-less import style.
4. **Adding an IPC call touches four places:** the type in `src/shared/types.ts`, a member of `RendererApi`
   (`types.ts` ~553), the preload entry in `src/preload/index.ts` (+ type import at the top), and `ipcMain.handle` in
   `src/main/ipc.ts`. Events: `getOverlay()?.webContents.send('video:<event>', payload)` + preload `onX(cb)` returning an
   unsubscribe function (copy `onJobUpdate`).
5. **Paths:** the renderer only ever sends library-relative `rel` strings (`''` = Songs root, `::<id>/...` = extra
   folder). Convert with `resolveRel(rel).abs` / `toRel(abs)` from `roots.ts`; never accept absolute paths over IPC.
6. **Deleting:** always through the injected remover, which in the app is `removePath()` from `librarymgr.ts`
   (exported in T1.4). Call `closeAudioUnder(abs)` (`localaudio.ts`) before deleting or renaming a file that may be
   playing. After any mutation: `invalidateLibraryIndex()`, `invalidateOwnedIndex()`, and `videoIndex.invalidate(rel)`.
7. **Writes into song folders** (often exFAT over SMB): write to a sibling temp name, then `rename`. Never hard-link
   (exFAT has none). Large files are produced in a local temp dir first, then copied in via `<name>.part` + rename.
8. **Accessibility** (user rule, minimum bar): every icon-only button has `aria-label`; toggles use `aria-pressed`;
   live progress uses `role="status"` (or `role="progressbar"` with `aria-valuenow/min/max`); new dialogs use
   `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, a focus trap, Escape to close, and focus restore (the
   `useDialogA11y` hook from T2.1). Don't rely on colour alone for status: badges carry text or an `aria-label`.
   New dialog overlays must use the `.modal-overlay` or `.lib__dialog-overlay` class so `screenhistory.ts`
   `overlayOpen()` suppresses back/forward.
9. **Portability** (the app ships for Windows x64, macOS arm64 and Linux x64; the library is shared over exFAT/SMB):
   - Rename and replace through `renameWithRetry(from, to)` (new, `video/fsutil.ts`): retries `EPERM`/`EBUSY`/`EACCES`
     up to 10 times, 150 ms apart (Windows antivirus and open media handles). On Windows, `rename` over an existing file
     fails while anything holds it open: call `closeAudioUnder` and stop renderer playback (`releaseFiles`) first.
   - Trash can fail on network or removable volumes (no Recycle Bin on Windows network shares; `gio trash` often fails
     on CIFS). When `removePath` throws in trash mode, the job fails that song with "Couldn't move to the Trash on this
     drive" and the dialog offers **Delete permanently instead** for the failed items. Never fall back to permanent
     deletion silently.
   - Executables come from `toolExecutableName(tool)` (`.exe` on Windows). Never build paths with `/`; use `path.join`.
   - On Windows, if a song folder path is longer than 240 characters, copy the input video to the local temp dir before
     running ffmpeg/ffprobe on it (long-path support in third-party binaries isn't reliable).
   - Case: compare file names case-insensitively (`video.WEBM` is a video file). When renaming only the case on macOS or
     Windows, rename through a temporary name.
   - Tests that touch paths must pass on all three OSes (T6.1 runs them).
10. **Definition of done for every ticket:** `npm run typecheck` passes, `npm run test:video` passes, new pure logic has
   `node:test` coverage in `app/tests/`, no trailing whitespace (`git diff --check`), and a manual check in
   `npm run dev` for UI tickets (Playwright, if used, only through a subagent).

### Model tiers

- **Haiku**: mechanical wiring with exact shapes given (IPC plumbing, config keys, icons, CSS).
- **Sonnet**: most tickets (new modules, React components following an existing pattern).
- **Opus**: only where flagged (numeric parity of the fingerprint port, sync-preview timing), or when a Sonnet attempt
  fails its acceptance tests twice.

---

## 3. Architecture

```
renderer                                  main                                         core/video (Electron-free)
─────────────────────────────────────     ─────────────────────────────────────────     ───────────────────────────────
LibraryView  ── filter/badge ──────────►  video:status ─► videoindex.ts ─────────────►  status.ts (quick status)
  └ VideosTool (Library tool)             video:scan / video:fix ─► videojobs.ts ─────►  audit.ts, probe.ts, staticcheck.ts
       └ VideoFixDialog                     (VideoJobManager, runners in               clean.ts, convert.ts, songini.ts
  └ DetailPanel                              videorunners.ts)                           fingerprint.ts (+ worker)
       └ VideoSection                     video:songInfo / setOffset / remove           ytdlp.ts, ranking.ts
            ├ VideoSyncDialog             video:fetch / applyStaged / discardStaged     tools.ts (ffmpeg/ffprobe/yt-dlp)
            └ VideoFindDialog             videotools.ts (download/verify binaries)
store.ts: videoJobs slice ◄── video:jobUpdate, video:statusChanged
chm-audio:// scheme also serves video files from library roots and the staging dir
```

### Shared types (add to `src/shared/types.ts` in T1.5; other tickets reference these names)

```ts
export type VideoIssue =
  | 'no-video'               // informational: no video.* file
  | 'multiple-video-files'   // more than one video.* file (YARG may pick the wrong one)
  | 'needs-conversion'       // not VP8-in-WebM (quick mode: extension is not .webm); dropped when !targetsYarg(games)
  | 'unreadable-video'       // ffprobe failed (deep mode only)
  | 'album-art-only'         // frames at 20% and 80% nearly identical (deep mode only)
  | 'no-start-time'          // song.ini has no video_start_time
  | 'leftover-download-files'// video.f137.mp4, video.temp.mp4, *.part, *.ytdl, *.tmp (.bak listed but kept by default)
  | 'no-audio-track'         // informational, deep mode only: auto-sync impossible until audio is restored (T4.3)

/** Issues that make a song match the "Needs attention" filter. 'no-video' and 'no-start-time' are excluded. */
export const VIDEO_ATTENTION_ISSUES: VideoIssue[] = ['multiple-video-files', 'needs-conversion', 'unreadable-video', 'album-art-only', 'leftover-download-files']

export interface VideoFileInfo { name: string; size: number; mtimeMs: number }

export interface VideoProbeInfo {
  codec: string; container: string; width: number; height: number
  durationSeconds: number; hasAudio: boolean
}

export interface VideoStatus {
  rel: string
  files: VideoFileInfo[]          // video.* files, sorted by name
  leftovers: VideoFileInfo[]
  startTimeMs: number | null
  probe: VideoProbeInfo | null    // null until a deep scan or songInfo probed the primary file
  albumArtOnly: boolean | null    // null = not checked
  issues: VideoIssue[]
  deep: boolean                   // true when probe/static results are current for these files
}

export type VideoFilter = 'any' | 'has' | 'none' | 'attention'

export type VideoJobKind = 'install-tools' | 'scan' | 'clean' | 'dedupe' | 'convert' | 'remove-album-art' | 'auto-offset' | 'restore-audio' | 'fetch' | 'apply-staged'
export type VideoJobStage = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface VideoJob {
  id: string
  kind: VideoJobKind
  label: string                   // "Converting 12 videos", "Finding video: Artist - Title"
  rel?: string                    // set for single-song jobs
  stage: VideoJobStage
  progress: number                // 0..1, or -1 = indeterminate
  step?: string                   // "Downloading candidate 2 of 6", "Encoding", ...
  done?: number; total?: number   // item counters for batch jobs
  error?: string
  result?: VideoJobResult
}

export type VideoJobResult =
  | { kind: 'scan'; report: VideoScanReport }
  | { kind: 'batch'; succeeded: string[]; failed: { rel: string; error: string }[]; bytesFreed?: number }
  | { kind: 'offset'; rel: string; match: OffsetMatch | null; reason?: string }
  | { kind: 'staged'; staged: StagedVideo }

export interface VideoScanReport {
  scannedAt: number
  scope: string[]                 // rels scanned
  deep: boolean
  songCount: number
  sng: SngVideoSummary            // loose .sng files (T2.7)
  rockBandSkipped: number         // CON files and extracted CON folders (YARG only; not inspected)
  byIssue: Record<VideoIssue, string[]>   // issue -> rels
  leftoverBytes: number
}

export interface SngVideoSummary {
  checked: number                 // .sng files whose index was read
  unreadable: string[]            // rels whose index could not be read
  withVideo: string[]             // rels that contain a video.* entry
  needsConversion: string[]       // subset of withVideo whose video isn't .webm (empty when !targetsYarg(games))
}

export interface OffsetMatch {
  offsetMs: number
  votes: number                   // matches in winning bin
  score: number                   // winning bin height / mean bin height
  concentration: number           // share of votes near the winning offset
}

export interface VideoCandidate {
  id: string                      // YouTube video id
  url: string
  title: string
  channel: string
  durationSeconds: number | null
  viewCount: number | null
  thumbnailUrl: string            // https://i.ytimg.com/vi/<id>/mqdefault.jpg
  rank: number                    // higher is better (ranking.ts)
  rejectedReason?: string         // set when filtered by REJECT_TITLE
}

export interface StagedVideo {
  stagingId: string
  rel: string
  sourceUrl: string
  candidate?: VideoCandidate
  mediaUrl: string                // chm-audio:// URL of the staged file for preview
  match: OffsetMatch | null       // null = no confident match (user may still apply with a manual offset)
  albumArtOnly: boolean
  probe: VideoProbeInfo
}

export interface SongVideoInfo {
  status: VideoStatus             // always deep for the primary file
  mediaUrl: string | null         // chm-audio:// URL of video.* for playback
  isSng: boolean                  // loose .sng: video tools need unpacking first
  songLengthSeconds: number | null
}

export interface VideoToolState { name: 'ffmpeg' | 'ffprobe' | 'yt-dlp'; source: 'env' | 'managed' | 'path' | 'missing'; version: string | null; path: string | null }
```

---

## 4. Phases and tickets

### Phase 0: groundwork

#### T0.1 Install, typecheck, commit the existing backend (Haiku)
- `cd app && npm ci`, then `npm run typecheck` and `npm run test:video`. Fix any type errors in the uncommitted
  `src/main/core/video/*`, `tools/chm-video.ts`, `tests/video.test.ts` (the full typecheck has never run).
- Commit the existing work plus `docs/video-tools-handoff.md` and this plan as "Video tools: backend core, CLI, tests".
- **Accept:** clean typecheck, 10 tests pass, working tree clean.

#### T0.1b Release setup for the fork (Haiku for the code, user for the GitHub steps)
Without this, a fork build offers upstream's next release through its updater, and installing it removes the video tools.
- **User:** fork `xlzipx/clone-hero-chart-manager` on GitHub, add it as a remote (`git remote add fork ...`), and decide
  the version scheme. Recommended: keep normal semver and stay ahead of upstream (next fork release `1.7.0`), because
  electron-updater compares versions and only reads your fork's releases once repointed.
- **Code:** add `app/src/shared/repo.ts` exporting `GITHUB_REPO = '<user>/clone-hero-chart-manager'` and
  `RELEASES_PAGE`, `REPO_URL` derived from it. Replace the hard-coded repo in `src/main/core/update.ts:12`,
  `WhatsNew.tsx:5`, `UpdateNotes.tsx:6` and `AboutModal.tsx:10`. Change `package.json` `build.publish[0].owner`.
  Grep afterwards: `grep -rn xlzipx app/src app/package.json .github` must return nothing.
- **Windows builds:** add `.github/workflows/build-windows.yml` modelled on `build-linux.yml`: `runs-on: windows-latest`,
  Node 20, `npm ci`, catalog seed, fetch the Windows Onyx zip and `7z.exe`/`7z.dll` into `native/` (URLs and layout from
  `docs/building.md` § Windows and the `win.extraResources` paths in `package.json`), `npm run dist -- --publish never`,
  upload the installer + `latest.yml` + `.blockmap`, attach to the release on tags. Check that the release assets of
  all three workflows land on the same tag (electron-updater needs `latest.yml` / `latest-linux.yml` / `latest-mac.yml`).
- **Accept:** a `v1.7.0-test` tag on the fork produces Windows, macOS and Linux artifacts; an installed build checks
  your fork's releases (watch the network log or the "What's new" link), not upstream's.

#### T0.2 Spike: does YARG still load a VP8 WebM that carries Opus audio? (Haiku generates, user tests, ~10 min)
The user confirmed the games don't play a video's audio, so this only checks **decoder compatibility**: Unity's
video player is documented with VP8 + Vorbis; Opus is not documented.
- Add `app/tools/make-audio-spike.ts`: builds a throwaway song folder (copy of any existing song with notes + stems)
  three times, each with a different `video.webm` made from one source clip: 1. VP8 + Opus 48 kbps mono,
  2. VP8 + Vorbis `-q:a 0`, 3. VP8 with no audio (control).
- The user loads each in **YARG on Linux** and **Clone Hero** and records whether the video shows.
- **Outcome table** goes in this file under §6. Default codec = Opus if it shows in both games, else Vorbis (one
  library file already has VP8 + Vorbis).
- **Accept:** decision recorded; `DEFAULT_AUDIO_CODEC` constant in `convert.ts` set accordingly (T0.3 reads it).

#### T0.3 Refactor the video core for the app (Sonnet)
Depends on T0.1. All changes inside `src/main/core/video/` plus tests.
1. **`tools.ts`**
   - `ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp'`.
   - Replace the single bundled dir with `setToolDirs({ managedDir, env })`: `managedDir` holds the downloaded binaries,
     `env` is the child environment (the app passes `cleanChildEnv()`; CLI/tests pass `process.env`).
   - `runTool(tool, args, options?: { signal?, onLine?: (line: string, stream: 'stdout' | 'stderr') => void, binaryStdout?: boolean, timeoutMs? })`
     returns `{ code, stdout: string, stdoutBuffer?: Buffer, stderr }`. Keep rejecting with `Error('aborted')` on abort
     (callers rely on it). `binaryStdout` collects stdout as a Buffer (needed for PCM and raw frames).
   - `toolVersion(tool): Promise<string | null>` (`-version` / `--version`, first line).
2. **`walk.ts`** (new): move `findSongFolders` out of `audit.ts` and rename it `walkSongFolders(root, { signal })`
   (name clash with `library.ts`). Skip junk entries (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`), count loose
   `.sng` files via an `onSng(path)` callback, stop at song folders like today. Add `countSongFolders(root)` for
   determinate progress.
3. **`files.ts`** (new): the single source of truth for `VIDEO_EXTENSIONS`, `isSongVideoFile`, `isLeftoverDownloadFile`,
   `isBackupFile`. Re-export from `audit.ts` for compatibility; later tickets import from `files.ts`.
4. **Removal injection:** `export type RemoveFile = (absPath: string) => Promise<void>`. `ConvertOptions`, `CleanOptions`
   and new helpers accept `removeFile?: RemoveFile` (default: `fsp.rm(path, { force: true })`). No direct `fsp.rm` on
   user files anywhere else in `video/`.
5. **`songini.ts`:** write through `song.ini.chm-tmp` + `rename` (CIFS flush issue seen by the old pipeline). If the
   file lacks a trailing newline, don't glue the new key onto the last line (test exists in the old pipeline notes).
6. **`convert.ts`:**
   - Options gain `keepAudio?: boolean` (default from T0.2), `audioCodec?: 'opus' | 'vorbis'`, `onProgress?: (fraction: number) => void`,
     `removeFile?`, `threads?` (default `Math.min(os.cpus().length, 8)`).
   - Audio args when kept and the source has audio: `-map 0:a:0? -ac 1 -c:a libopus -b:a 48k` (or
     `-c:a libvorbis -q:a 0`). Otherwise `-an`.
   - Progress: add `-progress pipe:1 -nostats`, parse `out_time_us=` lines via `onLine`, divide by source duration.
   - Accept `inputPath?: string` (a file outside the folder, used by the fetch flow): when set, encode that file and
     replace all `video.*` in the folder after verification.
7. **`staticcheck.ts`** (new, port of `classify-static.py`): `checkAlbumArtOnly(filePath, { signal })` →
   `{ albumArtOnly: boolean | null, difference: number | null }`. Duration via `probeVideo`; skip (null) under 10 s;
   two frames at 20% / 80%: `ffmpeg -ss <t> -i <file> -frames:v 1 -vf scale=160:90 -f rawvideo -pix_fmt gray -`
   (binary stdout); mean absolute difference / 255 < `0.02` → album art. Frame extraction failure → `null` (unknown),
   never `true`.
8. **`status.ts`** (new): `quickStatus(folderAbs, files)` → `Omit<VideoStatus, 'rel'>` with `deep: false` (no ffprobe;
   `needs-conversion` = any video whose extension isn't `.webm`, or more than one file). `deepenStatus(folderAbs, status, { signal })`
   probes the primary file (prefer `video.webm`, else first), runs `checkAlbumArtOnly`, recomputes issues, sets `deep: true`.
9. Update `tools/chm-video.ts` for the renamed APIs; add `--keep-audio/--no-audio` and `static` subcommand.
- **Tests** (`tests/video.test.ts`, extend): keepAudio produces an audio stream with the chosen codec; `-an` path has
  none; progress callback is called with increasing fractions ending ≥ 0.95; `removeFile` injection is used for every
  deletion; atomic ini write keeps CRLF and handles a missing trailing newline; `checkAlbumArtOnly` true for a
  `color=c=red` clip, false for `testsrc`, null for a 5 s clip; `quickStatus` issue matrix.
- **Accept:** all tests pass on Linux; `grep -n "fsp.rm" src/main/core/video` shows only the default remover and temp-dir cleanup.

---

### Phase 1: backend slice (no UI yet)

#### T1.0 Pick pinned binary sources (Sonnet with web search)
- For each platform the app actually ships (`win32-x64`, `darwin-arm64`, `linux-x64`; add `darwin-x64` only if an
  Intel macOS build is ever added) choose a download URL for a static
  **ffmpeg + ffprobe** build that includes `libvpx`, `libopus` and `libvorbis`, plus the archive format. Candidates:
  BtbN/FFmpeg-Builds release builds (Linux, Windows; use a versioned `n7.x` asset, not `latest`), and for macOS a
  maintained static source (e.g. osxexperts or evermeet). GPL builds are fine (personal fork, downloaded at runtime,
  not redistributed).
- For **yt-dlp**: the official standalone binaries (`yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp_macos`, `yt-dlp.exe`)
  from a pinned release tag.
- Record URL, SHA-256, archive type and the paths of the binaries inside the archive in
  `app/src/main/core/videotools-manifest.ts` (a typed constant). Verify each SHA-256 by actually downloading.
- **Accept:** manifest complete for the three targets; each binary runs `-version` / `--version` (Linux locally,
  Windows and macOS through the T6.1 CI job, which should download from the manifest and run them).

#### T1.1 Managed tool installer (Sonnet)
Depends on T0.3, T1.0. New `src/main/core/videotools.ts`.
- `managedToolsDir() = join(app.getPath('userData'), 'tools')`; layout `tools/<tool>/<version>/<binary>`, plus
  `tools/current.json` mapping tool → version.
- `getVideoToolStates(): Promise<VideoToolState[]>`: env dir, then managed, then PATH (`which`/`where` via `resolveTool`),
  each with `toolVersion`.
- `installVideoTools(names, { signal, onProgress })`: download with the existing HTTP helper used by `download.ts`
  (follow its proxy/timeout conventions) into a temp file, verify SHA-256, extract with `extract()` from `extractor.ts`
  (7-Zip handles zip and tar.xz), copy the binaries into the versioned folder, `ensureExecutable()`, update `current.json`,
  delete the temp files. Never leave a half-installed folder: install into `<version>.partial` and rename at the end.
- **macOS:** Apple Silicon refuses to run arm64 binaries without at least an ad-hoc signature (the reason
  `build/adhoc-sign.cjs` exists). After copying, run `xattr -d com.apple.quarantine <bin>` (ignore "no such xattr")
  and `codesign --force --sign - <bin>` (`/usr/bin/codesign` ships with macOS, no Xcode needed). The yt-dlp
  self-update (`-U`) replaces the binary, so re-sign after every update.
- **Every OS:** an install is only "done" after the installed binary runs `-version` / `--version` successfully;
  otherwise delete it and report the error text.
- `updateYtDlp()`: runs `yt-dlp -U` on the managed binary (it is writable there). Used in T5.1.
- Call `setToolDirs({ managedDir: currentManagedBinDir(), env: cleanChildEnv() })` at startup in `src/main/index.ts`
  and again after an install.
- `ensureVideoTools(names)`: throws a typed `MissingToolsError(names)` that IPC turns into a message the renderer
  recognises (prefix `MISSING_TOOLS:` + comma list) so it can show the install prompt (T2.6).
- **Accept:** on Linux, deleting `userData/tools` then calling install yields working ffmpeg/ffprobe; a corrupted
  download (wrong hash) fails cleanly and leaves nothing behind; `CHM_FFMPEG_DIR` still wins.

#### T1.2 Video status index (Sonnet)
Depends on T0.3. New `src/main/core/videoindex.ts`. Template: `chartlevels.ts` `levels-index-v4.json` (debounced
atomic save, versioned filename).
- Persisted file `userData/video-index-v1.json`: `Record<rel, { sig: string; status: VideoStatus }>`. `sig` =
  `video files name:size:mtime | leftovers | song.ini mtime`. A cached entry is valid only if the current sig matches.
- API:
  - `getVideoStatuses(rels: string[]): Promise<Record<string, VideoStatus>>`: readdir each folder (batches of 32, like
    `librarymgr`), compute sig, return cached status if sig matches else `quickStatus` (and store it). Loose `.sng` rels
    return `null` entries (omitted).
  - `deepenVideoStatus(rel, { signal })`: runs `deepenStatus`, stores, returns.
  - `invalidateVideoStatus(rel)`, `clearVideoIndex()`.
  - Emits `statusChanged(rel)` on an exported EventEmitter after any store; IPC forwards it as `video:statusChanged`.
- The cache always stores statuses computed as if YARG were a target. `getVideoStatuses` and `deepenVideoStatus`
  drop `needs-conversion` from the returned `issues` when `!targetsYarg(getConfig().games)`, so changing the games
  setting needs no rescan.
- Quick statuses for 7,000 songs took ~3 s over SMB in the CLI; this is acceptable on demand, cached after.
- **Accept:** unit test with a temp dir (inject the cache path; keep Electron out by passing `cachePath` into a factory
  `createVideoIndex({ cachePath })`, which `videoindex.ts` instantiates with the userData path).

#### T1.3 VideoJobManager (Sonnet)
New `src/main/core/videojobs.ts`. Mirror `jobs.ts` `JobManager` (EventEmitter singleton, `Map<id, VideoJob>`,
queue, `AbortController` per job, `canceled` set, `update()` emits a copy, `TERMINAL` set).
- `enqueue(kind, label, runner: (context: VideoJobContext) => Promise<VideoJobResult | void>, rel?)` returns the id.
  `VideoJobContext = { signal: AbortSignal; setProgress(fraction, step?): void; setCounts(done, total): void }`
  (throttle `update` emits to 1% / 250 ms).
- Concurrency: `scan` and `install-tools` run alone (one at a time per kind); `convert`-type jobs obey
  `getConfig().videoConcurrency` (default 1); single-song jobs (`auto-offset`, `fetch`, `apply-staged`) up to 2 in parallel
  but never two jobs for the same `rel`.
- `getAll()`, `cancel(id)`, `cancelAll()`, `clearFinished()`; abort → stage `canceled`; other errors →
  `error` with `userMsg(err)` from `shared/errors.ts`. `MissingToolsError` keeps its `MISSING_TOOLS:` message.
- Finished jobs stay until cleared (the renderer hides them after a delay, like downloads).
- **Accept:** unit-testable core (inject runners) covering queue order, cancel of queued vs running, same-rel exclusion.

#### T1.4 Job runners (Sonnet)
Depends on T1.1 to T1.3. New `src/main/core/videorunners.ts`; export `removePath` from `librarymgr.ts` (currently private).
Every runner: `ensureVideoTools([...])` first; resolve rels with `resolveRel`; after each mutated song call
`closeAudioUnder` before, then `invalidateVideoStatus(rel)`, and once at the end `invalidateLibraryIndex()` +
`invalidateOwnedIndex()`.
- `runScan({ scope: string[], deep: boolean })`: `countSongFolders` per scope root for the total, then
  `walkSongFolders` → `getVideoStatuses` (quick) → if `deep`, `deepenVideoStatus` with 4 in parallel. Builds a
  `VideoScanReport`; also stored in memory as `lastVideoScan` (IPC `video:lastScan`).
- `runClean(rels, { includeBackups })`: delete leftover files via `removePath`; `bytesFreed` in the result.
- `runDedupe(rels)`: for songs with `multiple-video-files`: `convertSongVideo` handles both cases (a valid
  `video.webm` exists → removes the others after the duration check; otherwise converts).
- `runConvert(rels)`: `convertSongVideo(folderAbs, { maxHeight, quality, keepAudio, removeFile: removePath, onProgress })`.
  Job progress = `(index + fileFraction) / total`.
- `runRemoveAlbumArt(rels)`: re-verify `checkAlbumArtOnly` per song immediately before deleting (the report may be
  stale); delete only when still `true`.
- Results: `{ kind: 'batch', succeeded, failed }`. A failure on one song never stops the batch (except abort or
  `MissingToolsError`).
- **Accept:** in `npm run dev` from the devtools console, `await window.api.videoScan({ scope: [''], deep: false })`
  completes with counts matching the CLI audit for the same folder.

#### T1.5 IPC, preload and types (Haiku)
Depends on T1.2 to T1.4. Add the §3 shared types and these channels (all `ipcMain.handle` unless noted):

| Channel | RendererApi member | Returns |
|---|---|---|
| `video:toolStates` | `videoToolStates()` | `VideoToolState[]` |
| `video:installTools` | `videoInstallTools(names)` | job id |
| `video:statuses` | `videoStatuses(rels)` | `Record<string, VideoStatus>` |
| `video:scan` | `videoScan({ scope, deep })` | job id |
| `video:lastScan` | `videoLastScan()` | `VideoScanReport \| null` |
| `video:fix` | `videoFix({ kind: 'clean' \| 'dedupe' \| 'convert' \| 'remove-album-art' \| 'auto-offset' \| 'restore-audio', rels, includeBackups? })` | job id |
| `video:songInfo` | `videoSongInfo(rel)` | `SongVideoInfo` (T3.1) |
| `video:setOffset` | `videoSetOffset(rel, offsetMs)` | `void` |
| `video:remove` | `videoRemove(rel)` | `void` (removes all `video.*` via `removePath`) |
| `video:autoOffset` | `videoAutoOffset(rel)` | job id (T4.2) |
| `video:search` | `videoSearch(rel, query?)` | `VideoCandidate[]` (T5.2) |
| `video:fetch` | `videoFetch({ rel, candidates?: VideoCandidate[], url?: string })` | job id (T5.3) |
| `video:applyStaged` | `videoApplyStaged(stagingId, offsetMs)` | job id (T5.3) |
| `video:discardStaged` | `videoDiscardStaged(stagingId)` | `void` |
| `video:jobs` | `videoJobs()` | `VideoJob[]` |
| `video:cancel` / `video:cancelAll` / `video:clearFinished` | `videoCancel(id)` / `videoCancelAll()` / `videoClearFinished()` | `void` |
| event `video:jobUpdate` | `onVideoJobUpdate(cb)` | unsubscribe |
| event `video:statusChanged` | `onVideoStatusChanged(cb: (rel: string) => void)` | unsubscribe |

Stub handlers whose implementation lands in later tickets throw `Error('Not implemented yet')`.
Validate inputs lightly like the rest of `ipc.ts` (arrays are arrays, `offsetMs` is a finite integer within
±600000, `url` matches `^https?://`).
- **Accept:** typecheck passes; the devtools call from T1.4 works through `window.api`.

#### T1.6 Serve video files over `chm-audio://` (Haiku)
`src/main/core/localaudio.ts`:
- Extend the allowed extension set and MIME map with `.webm` (`video/webm`), `.mp4`/`.m4v` (`video/mp4`), `.mkv`
  (`video/x-matroska`), `.mov` (`video/quicktime`). Range/206 already works.
- `isAllowed` also accepts files under the staging root (`videoStagingRoot()` exported from `videorunners.ts`, see T5.3).
- Export a `mediaUrl(abs)` alias of `audioUrl` for readability in video code.
- CSP in `src/renderer/index.html`: `media-src` already allows `chm-audio:`; add `https://i.ytimg.com` to `img-src`
  (candidate thumbnails, T5.4).
- **Accept:** a `<video src={mediaUrl}>` in devtools plays and seeks a library `video.webm`.

#### T1.7 Config keys (Haiku)
Add to `AppConfig` (`types.ts`) with doc comments, and to `defaults()` in `config.ts`:

| Key | Type | Default |
|---|---|---|
| `videoMaxHeight` | `480 \| 720 \| 1080` | `720` |
| `videoQuality` | `number` (libvpx CRF 4..63) | `30` |
| `videoKeepAudio` | `boolean` | `true` |
| `videoOriginalsDir` | `string` | `''` (T4.3) |
| `videoConcurrency` | `number` (1..3) | `1` |
| `videoConvertOnInstall` | `boolean` | `true` |
| `ytCookiesMode` | `'none' \| 'browser' \| 'file'` | `'none'` |
| `ytCookiesBrowser` | `'firefox' \| 'chrome' \| 'chromium' \| 'edge' \| 'brave' \| 'safari'` | `'firefox'` |
| `ytCookiesFile` | `string` | `''` |

`videoConvertOnInstall` only takes effect when the games setting includes YARG; Settings hides the switch otherwise.
`settings:import` picks them up automatically once defaults exist. Add `'videos'` to `AppConfig.libraryLast.tool`'s union.
- **Accept:** typecheck; fresh config contains the keys.

---

### Phase 2: health check, filter, badge

#### T2.1 Renderer foundations (Sonnet)
- `Icon.tsx`: add `film` (video) and `wand` (auto) icons to `IconName` and `PATHS` (24×24, stroke `currentColor`,
  same stroke width as siblings).
- `src/renderer/src/useDialogA11y.ts` (new hook): `useDialogA11y(dialogRef, { onClose, initialFocusRef? })` handles
  focus trap (Tab/Shift+Tab cycle within the dialog), Escape (capture phase + `stopImmediatePropagation`, like
  `BulkFixModal`), initial focus, and focus restore to the previously focused element on unmount. Used by every new
  dialog in this plan.
- `store.ts` slice: `videoJobs: Record<string, VideoJob>`, `applyVideoJobUpdate(job)`, `cancelVideoJob(id)`,
  `cancelAllVideoJobs()`, `clearFinishedVideoJobs()`; subscribe in `App.tsx` next to `onJobUpdate` (seed from
  `videoJobs()`). Finished jobs auto-hide after 5 s **unless** they carry a `result` the UI still needs (scan, staged,
  offset); those stay until the consumer clears them.
- `videoStatusVersion: Record<string, number>` in the store, bumped by `onVideoStatusChanged(rel)`, so components can
  refetch a single song's status.
- Helper `missingToolsFrom(error)` in `src/renderer/src/utils.ts`: parses the `MISSING_TOOLS:` prefix.
- **Accept:** typecheck; jobs started from devtools appear in the store.

#### T2.2 "Videos" Library tool (Sonnet)
Depends on T2.1. New `src/renderer/src/components/VideosTool.tsx`; follow `DuplicatesView.tsx` (start screen, scope
picker, `ToolHead`, `.ltool__body`, sticky `.ltool__bar`, module-level `lastScan` cache).
- Register the tool in `LibraryView.tsx` (keep edits small): the `tool` union (`'setlists' | 'duplicates' | 'videos'`),
  history restore and the two `key.slice(5) as ...` casts, a tree button under `.lv__treelabel--tools` with the `film` icon.
- **Start screen:** scope (whole library or chosen folders, same control as Duplicates), a `Switch` "Deep check: read
  codecs and find album-art-only videos (slower, cached afterwards)", button "Check videos".
- **Running:** one progress bar (`role="progressbar"`, aria values) with "Checked 1,240 of 7,057 songs", Cancel button.
- **Report:** a list of category cards, each with icon, title, count, one-line explanation, and an action button.
  Categories and actions:

  | Category (issue) | Explanation shown | Action |
  |---|---|---|
  | Leftover download files | "Fragments yt-dlp or ffmpeg left behind (X MB). Backups (.bak) are listed but kept unless you tick them." | Review & clean → `VideoFixDialog` kind `clean` |
  | Several video files | "YARG may pick the wrong one and show a black background." | Review & fix → `dedupe` |
  | Needs conversion (only when the games setting includes YARG) | "Not VP8/WebM: YARG on Linux shows nothing." | Review & convert → `convert` |
  | Album art only (deep) | "The picture never changes; likely an audio upload." | Review & delete → `remove-album-art` |
  | Can't be read (deep) | "ffprobe could not open it." | Show in library (filter) |
  | No video offset | "No `video_start_time` in song.ini. Auto-sync works only when the video has an audio track." | Review & auto-sync → `auto-offset` (rows without an audio track are disabled with that reason) |
  | No video | "Songs without a background video." | Show in library (sets the `none` video filter) |
  | Packed .sng with a video YARG can't play (T2.7, only when the games setting includes YARG) | "The video inside this .sng isn't VP8/WebM. Unpack the song to convert it." | Review & unpack → T2.7 dialog |
  | Rock Band files not checked | "CON files and extracted Rock Band folders (YARG only)." | none |

  Zero-count categories collapse into a single "All clear" line. Deep-only categories show "Run a deep check to see
  these" in quick mode.
- **Accept:** scanning the real library shows: 3 several-files songs, 118 no-offset, ~3,897 no-video, 0 needs-conversion
  (numbers from the handoff); keyboard-only operation works end to end.

#### T2.3 `VideoFixDialog` (Sonnet)
New `src/renderer/src/components/VideoFixDialog.tsx`. Pattern: `BulkFixModal.tsx` markup (`.modal-overlay > .modal`),
plus `useDialogA11y`, `role="dialog"`, `aria-labelledby`.
- Props: `{ kind, rels, onClose }`. On open, loads `videoStatuses(rels)` and lists rows: song name (artist – title
  from `libSongInfo`), the files affected with sizes (for `clean`: each leftover; for `dedupe`: which file stays and
  which go; for `convert`: current codec/size and the target "VP8/WebM 720p"; for `auto-offset`: audio track yes/no).
- Checkboxes with shift-range (`useRangeToggle`, `rangeToggle.ts`), Select all / none, a summary line ("Delete 9
  files, free 300.6 MB. They go to the Trash." using `deleteMode` and `IS_MAC` wording from the existing delete dialogs).
- Apply → `videoFix({ kind, rels: selected })`, close the dialog, and the job appears in the Videos tool job list (T2.4).
- **Accept:** the 3 duplicate-video songs can be fixed from the UI; after the job, re-scan shows 0 in that category.

#### T2.4 Video job list + Library footer chip (Sonnet)
- `src/renderer/src/components/VideoJobList.tsx`: renders `videoJobs` with the `DownloadQueue.tsx` look (`.qjob`
  classes, stage label, bar, step text, error), per-job Cancel (with optimistic "Canceling…"), "Stop all", "Clear
  finished". Batch results show "12 converted, 1 failed" with an expandable failure list (song + error).
- Mount it at the bottom of `VideosTool` and, in compact form (one line + spinner, `role="status"`), in the Library
  footer `.lib__actions` while any video job runs (same spot as `.lv__bulkrun`).
- **Accept:** a convert batch shows smooth progress, cancel stops ffmpeg within a second and leaves originals untouched.

#### T2.5 Library filter + badge (Sonnet)
`LibraryView.tsx` (small edits) + new `src/renderer/src/components/VideoBadge.tsx`.
- `Filters` gains `video: VideoFilter` (`NO_FILTERS.video = 'any'`); counts towards `activeFilterCount` when not `any`.
- Filter UI: a new `lv__fgroup` labelled "Video" with four `lv__chip` buttons (Any / Has video / No video / Needs
  attention) as a single-choice group: wrap in `role="radiogroup"` with `aria-label="Video filter"`, chips get
  `role="radio"` + `aria-checked`.
- Data: a module cache + `videoStatuses` state keyed by rel, loaded in batches of 200 like `loadLevels`. When the video
  filter is not `any`, switch to the deep song list (`songsDeepHere`, same branch the metadata filters use) and fetch
  statuses for all of them. Refetch a single rel when `videoStatusVersion[rel]` changes.
- Filtering: `has` = `files.length > 0`; `none` = `files.length === 0`; `attention` = any issue in
  `VIDEO_ATTENTION_ISSUES`.
- Badge in card view inside `.song__meta` (must not change card height) and as a `lib__tag` in list view:
  `film` icon + text "video" (ok) or "video !" with warn colour (attention), `aria-label`/`title` listing the issues in
  words. No badge when there is no video.
- **Accept:** "No video" in the root shows ~3,897 songs; badge rendering keeps virtualized scrolling smooth (no
  per-row IPC; statuses come in batches).

#### T2.6 Settings "Videos" section + missing-tools prompt (Sonnet)
- `Settings.tsx`: add `SectionId` `'videos'` with a `film` icon. Cards:
  - **Tools:** one row per `VideoToolState` showing source ("Downloaded 7.1", "System PATH", "Not installed") and
    version; buttons "Download" / "Update" (`videoInstallTools`), progress inline via the job.
  - **Conversion:** max height `Seg` (480/720/1080), quality `Seg` presets (Smaller = 36, Balanced = 30, Sharper = 24;
    show the CRF number in the description), keep-audio `Switch` (description explains auto-sync needs it), parallel
    conversions `Seg` (1/2/3), convert-on-install `Switch`.
  - **YouTube** (lands in T5.1, leave a placeholder card hidden until then).
- `MissingToolsDialog.tsx` (small `.lib__dialog` dialog with `useDialogA11y`): shown whenever a video call fails with
  `MISSING_TOOLS:`; lists the tools, explains where they go, buttons "Download now" (starts install, then retries the
  original action) and "Open settings".
- **Accept:** with `userData/tools` removed and no ffmpeg on PATH, clicking "Check videos" (deep) shows the prompt;
  "Download now" installs and the scan then runs.

#### T2.7 Videos inside `.sng` files (Sonnet)
Encore downloads can be `.sng` packages with the video inside. If that video is H.264, YARG on Linux shows nothing.
- Main, `video/sngvideo.js`: `readSngVideoEntries(absPath)` reads only the `.sng` header and file index (reuse the
  index parsing from `sngextract` / `sngpreview`; no extraction) and returns the `video.*` entries with name and size.
  Quick mode judges by extension; deep mode extracts just the video entry to a temp file (unmasking as `sngextract`
  does), probes it, and deletes the temp file.
- The scan fills `VideoScanReport.sng` (types above). `needsConversion` stays empty when `!targetsYarg(games)`.
- Fix dialog: lists the affected `.sng` songs with the video codec and size, and one action, **Unpack and convert**:
  existing `libUnpackSng`, then a `convert` job for the unpacked folder. The `.sng` itself is removed by unpacking
  as today.
- Out of scope: repacking a `.sng` with the converted video (needs an SNG writer). Add a ticket only if you want to
  keep songs packed.
- Tests: a fixture `.sng` built in the test with an `mp4` video entry and one with a `webm` entry; index reading on a
  truncated file returns an error, not a crash.
- **Accept:** in a `yarg` or `both` profile, a `.sng` with an H.264 video appears in the category and ends up as a
  folder with `video.webm` after the action; in a `clone-hero` profile the category is absent.

---

### Phase 3: per-song video panel

#### T3.1 `VideoSection` in the detail panel (Sonnet)
- Main: implement `video:songInfo(rel)`: `getVideoStatuses([rel])` then `deepenVideoStatus` (cached), `mediaUrl` of the
  primary file, `isSng`, `songLengthSeconds` (song.ini `song_length` ms, else longest stem duration via ffprobe, cached).
- Implement `video:setOffset` (atomic ini write + invalidate) and `video:remove` (all `video.*` through `removePath`,
  `closeAudioUnder` first; the renderer stops any playback first via `releaseFiles`).
- New `src/renderer/src/components/VideoSection.tsx`, inserted in `DetailPanel` (song branch) after `PanelActions`
  with its own `<div className="lv__dlabel">Video</div>`. Loads with a cancelled-flag `useEffect` keyed on `rel` and
  `videoStatusVersion[rel]`.
- Content:
  - No video: "No background video." + buttons **Find video** (T5.4; hidden until then) and **Paste URL** (T5.4).
  - Has video: a `dl.lv__dkv` with File (name, size), Format ("VP8/WebM 1280×720, 3:58"), Audio track (yes/no),
    Offset ("+1,600 ms" or "Not set"), and issue chips in words. Buttons: **Preview & sync** (T3.2), **Convert** (only
    when `needs-conversion` or several files; runs `videoFix` kind `convert` for this rel), **Find another** (T5.4),
    **Remove video** (confirm dialog in the existing `.lib__dialog` style, wording follows `deleteMode`).
  - Loose `.sng`: "This song is packed in a .sng file. Unpack it to manage its video." + **Unpack** (existing
    `libUnpackSng`). If T2.7 found a video inside, show its file name, size and (deep) format, and the
    "YARG can't play this video" warning when it applies.
  - Rock Band container (CON file or extracted CON folder): "Video tools don't work on Rock Band files." No buttons.
- **Accept:** selecting songs updates the section without flicker; Remove sends the file to the Trash and the badge
  disappears.

#### T3.2 `VideoSyncDialog`: preview with song audio and nudge the offset (Sonnet, Opus if timing tests fail)
New `src/renderer/src/components/VideoSyncDialog.tsx` (+ `videoSync.ts` for the pure timing math, unit-testable).
Large `.modal-overlay` dialog with `useDialogA11y`.
- Props: `{ rel, mediaUrl, initialOffsetMs, hasVideoAudio, onSave(offsetMs), onClose, staged?: StagedVideo }` (the
  staged variant is reused by T5.4).
- Playback: stop other audio first (`stopPreview()`, `playerPause()`), load stems via `songAudio(rel)` into
  `HTMLAudioElement`s (volume from `config.previewVolume`), master clock = first stem. A muted `<video>` follows:
  `targetVideoTime = songTime + offsetMs / 1000`. While `targetVideoTime < 0` the video is paused at 0 and dimmed
  (the game shows nothing yet). A `requestAnimationFrame` loop corrects drift: if `|video.currentTime - target| > 0.12 s`
  seek; else if > 0.03 s nudge `playbackRate` to 0.97/1.03 until back in range. Use the `seekReady` approach from
  `store.ts` to start all elements together.
- Register preview key prefix `vsync:` so `releaseFiles` can stop it before deletes.
- Controls (all keyboard reachable, labelled):
  - Play/Pause (Space), seek slider (`input type="range"`, `aria-valuetext` "1:23 of 3:58"), jump buttons
    "Start", "−5 s", "+5 s".
  - Offset field (ms, `CommitInput`-style), nudge buttons −100 / −10 / +10 / +100 ms (keys `[` `]` = ±10,
    `Shift+[` `Shift+]` = ±100), "Reset to saved".
  - **Hear video audio** toggle (only when `hasVideoAudio`): unmutes the video at 50% so a flam/echo reveals misalignment.
  - **Auto-sync** button (T4.2; hidden until then).
  - Footer: "Save offset" (writes via `videoSetOffset`, toast "Offset saved"), "Cancel". Unsaved-change guard on close.
- Tests for `videoSync.ts`: target time math incl. negative offsets, drift decisions (seek vs rate nudge vs none).
- **Accept:** on a song with a known-good offset, playback looks synced; changing the offset by +500 ms visibly shifts
  the video; saved value appears in song.ini and the panel.

---

### Phase 4: fingerprint port and auto offset

#### T4.1 Port the fingerprint matcher (Opus recommended; numeric parity matters)
New `src/main/core/video/fingerprint.ts` (pure, Electron-free) + `fft.ts`. Port `fingerprint-sync.py` exactly:

- **Decode** (`runTool('ffmpeg', ..., { binaryStdout: true })`): `-nostdin -v quiet`, inputs, for several stems
  `-filter_complex "[0:a][1:a]...amix=inputs=N:duration=longest[a]" -map [a]`, for one input `-map 0:a:0?`, then
  `-t 240 -ac 1 -ar 8000 -f s16le -`. Samples = little-endian int16 / 32768 as `Float32Array`. Fewer than 1024 samples → null.
- **Stems:** files in the folder with extension in `{.ogg, .opus, .mp3, .wav, .m4a, .flac}` whose basename (lowercase)
  is not `preview` or `crowd`, sorted by name. (`.mogg` is excluded: ffmpeg cannot read it.)
- **Constants:** `SAMPLE_RATE 8000, ANALYZE_SECONDS 240, N_FFT 1024, HOP 128, PEAK_TIME_RADIUS 5, PEAK_FREQ_RADIUS 10,
  PEAK_QUANTILE 0.97, FAN_OUT 8, DT_MIN 1, DT_MAX 120, HIST_BIN 3, MIN_MATCHES 40, MIN_SCORE 50, MIN_CONC 0.05,
  MIN_LEAD -30 s, MAX_LEAD 90 s`.
- **Spectrogram:** frames `0, HOP, 2·HOP, …` while `start + N_FFT <= length` (= `floor((len - N_FFT) / HOP) + 1` frames);
  window = numpy `hanning(N)` = `0.5 - 0.5·cos(2πn / (N - 1))` (symmetric); magnitude of the real FFT, bins `0..N/2` (513).
  Store as one `Float32Array(frames × 513)`.
- **Peaks** (numpy semantics matter):
  - Max filter is separable: first over frequency with radius 10, then over time with radius 5; **pad with 0** at the
    edges (numpy `np.pad` default constant 0).
  - `floor = globalMax × 1e-3`.
  - Per-frame cutoff = `np.quantile(row, 0.97)` with numpy's default **linear** method: sort the 513 values,
    `position = 0.97 × (513 - 1)`, interpolate between `floor(position)` and `ceil(position)`.
  - Peak where `value === localMax && value >= frameCut && value > floor`.
  - Emit in **row-major order** (time ascending, then frequency ascending) like `np.nonzero`.
- **Hashes:** for each anchor, walk following peaks: skip `dt < 1`, stop at `dt > 120`, pair up to 8;
  `hash = (anchorFreq & 0x3FF) | ((targetFreq & 0x3FF) << 10) | ((dt & 0x7F) << 20)`; `Map<number, number[]>` of anchor times.
- **Offset vote:** for every hash in the probe (video) table present in the reference (chart) table, every pair adds
  `delta = probeTime - refTime`. Fewer than 40 deltas → null. `bin = Math.round(delta / 3)` (integer deltas never hit
  .5 after /3, so rounding mode doesn't matter). Count per bin; the winner is the **highest count, ties broken by the
  smallest bin value** (numpy `argmax` over sorted unique values). `score = votes / mean(count over occupied bins)`.
  `near = |bin - winner| <= 1`; `concentration = nearCount / totalDeltas`. Reject unless all three thresholds pass.
  `leadSeconds = mean(deltas where near) × HOP / SAMPLE_RATE`; reject outside [-30, 90].
- **Result:** `computeOffset(folderAbs, videoPath, { signal })` →
  `{ ok: true, match: OffsetMatch } | { ok: false, reason: 'no-video-audio' | 'no-chart-audio' | 'decode-failed' | 'not-enough-detail' | 'no-confident-match' }`,
  `offsetMs = Math.round(leadSeconds × 1000)`.
- **Performance:** delta voting can explode on repetitive audio; use a typed-array histogram keyed by bin (offset by
  the min possible bin) instead of building a giant array; cap total pairs at 5,000,000 and report
  `no-confident-match` if exceeded.
- **Tests** (`tests/fingerprint.test.ts`, add to the `test:video` script): generate a 60 s pseudo-music reference with
  ffmpeg (`anoisesrc=seed=7` band-passed + a few `sine` chirps, mixed) as `song.ogg`:
  1. video audio = reference delayed by 3.0 s (`adelay`) → `offsetMs` ≈ +3000 ± 48;
  2. reference with 2.0 s of leading silence, video audio = original → ≈ −2000 ± 48 (**locks the sign**);
  3. unrelated noise (`seed=99`) → `no-confident-match`;
  4. video with no audio stream → `no-video-audio`.
- **Parity (dev only):** `app/tools/fingerprint-parity.ts` runs both this port and `python3 fingerprint-sync.py
  --video-path` (when python3 + numpy exist) on a list of folders and prints both offsets and confidences; differences
  over 16 ms (one hop) are a bug. Run it on 5 songs with MP4s that still have audio.
- **Accept:** all four tests pass; parity script agrees within one hop on the samples.

#### T4.2 Worker, auto-offset job and UI (Sonnet)
- `src/main/core/fingerprintworker.ts` (worker entry; add it to `electron.vite.config.ts` `main.build.rollupOptions.input`
  like `catalogworker`) receives two `Float32Array`s (transferred) and returns `OffsetMatch | reason`. Decoding stays
  in the main process (ffmpeg child); the CPU-heavy analysis runs in the worker. `fingerprintclient.ts` wraps it with a
  promise API and falls back to in-thread computation if the worker fails (same pattern as `catalogreader.ts`).
- Runner `auto-offset` (single rel or batch): requires a video with an audio track, else fails that rel with
  "This video has no audio track; set the offset by hand." For batch (from the health check), **write** only results
  that pass the gate; list the rest as failed with the reason. For single-song (from the sync dialog), **never write**:
  return the match as the job result.
- Sync dialog: **Auto-sync** button → job → shows "Found +1,240 ms (high confidence: 312 matches, 84×)" with **Use
  this** (sets the offset field, still needs Save) or "No confident match: try nudging by hand." Confidence label:
  high when `score >= 100 && concentration >= 0.1`, otherwise "ok" (anything below the gate never reaches the UI).
- **Accept:** on a test song, Auto-sync proposes an offset that looks right in the preview; the UI stays responsive
  during analysis (worker).

#### T4.3 Restore audio from original videos (Sonnet)
Most existing `video.webm` files lost their audio in conversion, but the original MP4s still exist on the old share.
Putting that audio back makes every one of them auto-syncable.
- Core `src/main/core/video/restoreaudio.ts`: `restoreAudioTrack(folderAbs, originalPath, { audioCodec, removeFile, signal })`:
  1. probe both; the original must have audio and its video duration must match the webm's within 2 s (else fail
     "Original doesn't match this video");
  2. `ffmpeg -i video.webm -i original -map 0:v:0 -map 1:a:0 -c:v copy -ac 1 -c:a libopus -b:a 48k -shortest` into a
     local temp `video.webm` (video stream copied, so timing is unchanged and it is fast);
  3. verify VP8/WebM + audio stream + duration, copy in via `.part` + rename (replaces the old webm; the old one goes
     through `removeFile` first only if the rename can't replace it on that OS).
- Finding originals: a setting `videoOriginalsDir` (string, default `''`; Settings → Videos → Conversion as a
  `PathField`, described as "Folder with the original downloaded videos, laid out like your Songs folder").
  Matching: same path relative to the Songs root (`<originalsDir>/<rel>/video.mp4` or any `video.*` with audio);
  fallback match by folder name when exactly one folder with that name exists under the originals dir (build a
  name index once per job). The user's value will be `~/mnt/mamecade/Songs`; check its layout matches before relying
  on relative paths.
- Health check: a new informational category **"No audio track"** (`VideoIssue` `'no-audio-track'`, deep mode only,
  not in `VIDEO_ATTENTION_ISSUES`) with the action **Restore from originals** (dialog lists which songs have a
  matching original and which don't), job kind `restore-audio`. Option in the same dialog: "Then auto-sync songs
  with no offset".
- Per song: in `VideoSection`, when the video has no audio, a **Restore audio from…** button: uses the matched
  original if found, otherwise a file picker (`dialog:chooseFile`, video filters).
- Tests: restored file has a copied VP8 stream (same packet count) and an Opus stream; mismatched duration fails and
  leaves the webm untouched.
- **Accept:** on the real library, restoring the 118 no-offset songs (where originals exist) followed by batch
  auto-sync writes offsets for the confident ones.

---

### Phase 5: find, paste and download videos

#### T5.0 Spike: yt-dlp JS runtime and cookies (Sonnet + user)
- Try `--js-runtimes node:<process.execPath>` with `ELECTRON_RUN_AS_NODE=1` in the child env (Electron's bundled Node).
  If yt-dlp accepts it on Linux (check that YouTube formats resolve, not just search), use it everywhere: no extra
  download. Otherwise add `deno` to the T1.0 manifest and pass `--js-runtimes deno:<path>`.
- Verify `--cookies-from-browser firefox` and `--cookies <file>` on the user's machine with a logged-in browser profile.
  Note what fails and turn it into Settings help text. Known limits to check and document: Chrome-family browsers on
  Windows encrypt cookies in a way yt-dlp often can't read (recommend Firefox or a cookies.txt there); Chrome on Linux
  needs a working keyring; Safari needs Full Disk Access for the app on macOS.
- Check `ELECTRON_RUN_AS_NODE` from a **packaged** build on each OS (AppImage mount path on Linux, the `.app` helper on
  macOS), not just `npm run dev`.
- **Accept:** a written result in §6 and one successful download through the chosen runtime with cookies.

#### T5.1 yt-dlp provisioning and YouTube settings (Haiku)
- Add yt-dlp to the managed tools (T1.1 manifest). Settings → Videos → Tools row gets "Update yt-dlp" (`updateYtDlp`).
  Auto-update check at most once per 7 days before a search (store last check time in the tools `current.json`).
- Settings → Videos → **YouTube** card: cookies `Seg` (None / From browser / cookies.txt file); browser `Seg`; file
  `PathField` with Browse (new `dialog:chooseFile` IPC accepting `filters`, modelled on `dialog:chooseExe`). Help text
  from T5.0, including "YouTube may block downloads without cookies."
- `ytCookieArgs(config)` helper in `videorunners.ts` builds the yt-dlp arguments.
- **Accept:** the settings persist and the args appear in the yt-dlp command line (log at debug level).

#### T5.2 Search, ranking and download (Sonnet)
New `src/main/core/video/ytdlp.ts` and `src/main/core/video/ranking.ts` (pure, fully unit-tested).
- **Queries** (port of `video-wave.py`): normalize artist: strip `(WaveGroup…)` and anything after ` feat.`, ` ft.`,
  ` featuring `; title from song.ini `name`. Queries in order: `"<artist> <title> official music video"`,
  `"<artist> <title> VEVO"`, `"<artist> <title>"`. Allow the user's own query from the UI.
- **Search:** `yt-dlp "ytsearch8:<query>" --flat-playlist --dump-json --no-warnings` (+ js-runtime + cookie args),
  parse one JSON per line: `id, title, channel|uploader, duration, view_count`. Merge queries, dedupe by id.
- **Ranking** (`rankCandidates(candidates, { artist, title, songLengthSeconds })`), score components:
  - reject (kept in the list, greyed, with `rejectedReason`) when the title matches the ported `REJECT_TITLE` regex
    (live, acoustic, cover, lyric video, karaoke, tribute, fan made, official audio, fan video, session, at the,
    concert, playthrough, gameplay, clone hero, guitar hero, rock band, full combo, fc, no miss, expert+, 2x bass);
  - duration: within 5 s of the song length +40, within 15 s +25, within 30 s +10, over 60 s −30, unknown 0;
  - title contains the normalized song title (case/diacritics-insensitive) +20; contains the artist +10;
  - title contains "official music video" or "official video" +15;
  - channel contains the artist, ends with "VEVO", or is "<artist> - Topic" (Topic = audio only: −20) adjust ±;
  - tie-breaker: higher `view_count`.
  Unit tests cover each rule and a realistic mixed list.
- **Download:** `downloadVideo(url, destDir, { signal, onProgress, cookieArgs })`:
  `-S "height:1080,ext:mp4" --merge-output-format mp4 --no-playlist --max-filesize 200M --newline
  --progress-template "download:%(progress.downloaded_bytes)s/%(progress.total_bytes_estimate)s" -o "<destDir>/source.%(ext)s"`;
  timeout 5 min; parse progress lines; result path = the single `source.*` file. Fewer than 100 KB → error.
- **Bot-block:** stderr containing `Sign in to confirm` or `HTTP Error 429` → throw `YouTubeBlockedError` with the
  message "YouTube is blocking downloads from this network. Set up cookies in Settings → Videos." Callers stop
  immediately (no further candidates).
- **Accept:** unit tests for ranking and normalization; a real search for a known song returns the official video in
  the top 3.

#### T5.3 Fetch and apply jobs (Sonnet)
- `videoStagingRoot() = join(app.getPath('temp'), 'chm-video-staging')`; cleaned on app start (remove folders older
  than 24 h) and on discard.
- Runner `fetch({ rel, candidates? | url })`: create `staging/<stagingId>/`; for each candidate in order (max 6;
  a pasted URL is a single candidate): download → `checkAlbumArtOnly` (album art → next candidate, unless it's a pasted
  URL: then keep with a warning) → `computeOffset` against the chart stems using the downloaded file → first confident
  match wins. If none match, the **last successfully downloaded** candidate is staged with `match: null` (the user can
  still use it with a manual offset). Step text per stage ("Candidate 2 of 6: fingerprinting"). Result
  `{ kind: 'staged', staged }`.
- Runner `apply-staged(stagingId, offsetMs)`: `convertSongVideo(folderAbs, { inputPath: stagedSource, keepAudio, ... ,
  removeFile: removePath })` (encodes locally, verifies, copies via `.part` + rename, removes old `video.*`), then
  `writeVideoStartTime`, then delete the staging folder, invalidate status. Write a line to
  `userData/video-history.jsonl` (`{ rel, sourceUrl, offsetMs, match, appliedAt }`) so a later "where did this video
  come from?" is answerable.
- Discard: delete the staging folder.
- **Accept:** end to end on one song without a video: Auto-try → staged → apply → `video.webm` with audio track,
  correct offset in song.ini, badge appears, history line written. Cancelling mid-download leaves no files in the song folder.

#### T5.4 `VideoFindDialog` (Sonnet)
New `src/renderer/src/components/VideoFindDialog.tsx` (large dialog, `useDialogA11y`), opened from `VideoSection`
("Find video", "Find another", "Paste URL").
- Top: query field prefilled with "<artist> <title>", Search button; or a URL field when opened via Paste URL.
- Candidate list (keyboard navigable `role="listbox"` or a list of buttons): thumbnail (`img` with empty `alt` since the
  title is beside it), title, channel, duration with a ±delta vs song length ("+3 s"), rank reasons as small chips,
  rejected ones greyed with the reason.
- Buttons: **Auto-try** (all non-rejected in rank order), **Try this one** (selected candidate), Cancel (cancels the job).
- While running: progress + step text, cancel.
- On a staged result: switch to the embedded `VideoSyncDialog` content (staged variant): shows the match confidence
  or "No confident match; set the offset by hand", the album-art warning if any, offset controls, and **Apply**
  (`videoApplyStaged`) / **Discard**. Closing the dialog with a staged result asks to discard.
- On `YouTubeBlockedError`: an inline message with a button to Settings → Videos.
- **Accept:** keyboard-only flow works; screen reader announces progress (`role="status"`) and the result.

#### T5.5 Convert videos of newly installed charts (Haiku)
- In `jobs.ts`, after a successful `install()` when `getConfig().downloadVideos` and `videoConvertOnInstall` are true,
  `targetsYarg(getConfig().games)` is true, and the installed folder has a `video.*` that isn't VP8/WebM (quick check by extension), enqueue a `convert`
  video job for that rel. Don't block or fail the download job on it.
- Unify `jobs.ts` `VIDEO_EXT` with `video/files.ts` `VIDEO_EXTENSIONS` (import it).
- **Accept:** downloading a chart that ships an MP4 ends with a `video.webm`.

---

### Phase 6: cross-platform checks

#### T6.1 CI for the video tests (Haiku)
- New `.github/workflows/test-video.yml` (personal fork, GitHub-hosted runners are fine): matrix `ubuntu-latest`,
  `macos-latest`, `windows-latest`; Node 24; install ffmpeg (apt / brew / choco); `npm ci` in `app`;
  `npm run typecheck:node`; `npm run test:video`. Trigger on push to `feature/**` and PRs.
- Second job in the same workflow: on each OS, download the T1.0 manifest binaries (verifying SHA-256), sign them on
  macOS like T1.1 does, and run `-version` / `--version`. This catches broken URLs, wrong archive paths and
  signing problems before a user does.
- **Accept:** green on all three OSes (fix path/quoting bugs it finds; Windows file locking during rename is the
  likely one).

#### T6.2 Manual QA checklist (user)
Add `docs/video-tools-qa.md`: per OS, install tools, deep scan, convert one, sync preview, auto-sync, find + apply,
trash vs permanent delete, exFAT/SMB library. Windows and macOS have never been run; record results there.

---

## 5. Using the new tools on the real library (after Phase 3 / 4)

Do these through the app as acceptance tests, not by script:
1. Deep check the whole library (expect ~72 s first time, cached after).
2. Several video files (3 songs: Amon Amarth / Twilight of the Thunder God; Dethklok / Laser Cannon Deth Sentence;
   Machine Head / Beautiful Mourning) → fix via the dialog.
3. No offset (118) → those webms almost certainly have no audio track: set `videoOriginalsDir` to
   `~/mnt/mamecade/Songs`, run **Restore from originals** (T4.3), then batch auto-sync; nudge the rest by hand.
   Afterwards consider restoring audio library-wide so any song can be re-synced later.
4. Leftover `.bak` (`Arcade Fire/Everything Now/video.mp4.bak`, 75 MB): decide by hand; it may be the only original
   with audio (convert it with keep-audio to gain auto-sync for that song).
5. Album-art-only results from the deep check → review and delete; they join the "No video" backlog.
6. ~9 song folders nested inside other song folders are invisible to every walker (they stop at song folders). Not in
   scope; list them once with `find` if they matter.

---

## 6. Spike results (fill in)

- **T0.2 audio track in-game:**

  | Clip | YARG (Linux): video shows? | Clone Hero: video shows? |
  |---|---|---|
  | VP8 + Opus | | |
  | VP8 + Vorbis | | |
  | VP8, no audio | | |

  Decision:
- **T1.0 binary sources:** see `videotools-manifest.ts`.
- **T5.0 yt-dlp runtime / cookies:**

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Opus in WebM not loaded by YARG/Unity | T0.2 check before any conversion keeps audio; Vorbis fallback; `videoKeepAudio` setting. |
| Fingerprint port subtly differs from Python | Exact numpy semantics spelled out in T4.1; sign-locking tests; parity script. |
| YouTube blocks or changes | Cookies settings, yt-dlp self-update, stop-at-first-block, manual paste URL. |
| Large libraries over SMB are slow | Quick mode by default, persisted index, deep results cached by file signature. |
| Deleting the wrong file | Preview-then-apply everywhere, `deleteMode` trash default, re-verify album-art before deleting, verify-then-delete in convert. |
| Windows / macOS untested | T6.1 CI matrix, T6.2 checklist. |
| Fork builds auto-update to upstream and lose the video tools | T0.1b repoints every update/release reference to the fork. |
| No Windows build path (user is on Linux) | T0.1b adds a `windows-latest` release workflow. |
| Downloaded tools won't run on Apple Silicon | T1.1 strips quarantine and ad-hoc signs; T6.1 verifies on a macOS runner. |
| Trash unsupported on the shared drive from some OSes | Rule 9: explicit "Delete permanently instead" per failed item, never silent. |
| Intel Macs | Not supported by the app today (arm64-only macOS build); out of scope unless a universal build is added. |
| `LibraryView.tsx` grows further | Only registration and filter/badge glue go there; everything else in new components. |
