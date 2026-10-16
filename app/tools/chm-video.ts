// Standalone CLI for the video tools: `node tools/chm-video.ts <command> --songs <folder>`.
// Uses the same core modules as the app, so behavior is identical on Windows, macOS and Linux.

import { resolve } from 'path'
import { parseArgs } from 'util'
import { auditSongsFolder, findSongFolders, isSongVideoFile, type SongVideoAudit } from '../src/main/core/video/audit.ts'
import { cleanLeftovers } from '../src/main/core/video/clean.ts'
import { convertSongVideo, validateConvertOptions } from '../src/main/core/video/convert.ts'

const USAGE = `Usage:
  chm-video audit   --songs <folder> [--fast] [--json]
  chm-video clean   --songs <folder> [--dry-run] [--include-backups]
  chm-video convert --songs <folder> [--dry-run] [--limit N] [--max-height 720] [--quality 30]

audit    Read-only report of missing, duplicate, non-VP8 or unsynced background videos.
         Checks the real codec with ffprobe; --fast trusts file extensions instead.
clean    Delete yt-dlp/ffmpeg leftovers (.part, .fNNN, .temp). Keeps .bak unless --include-backups.
         Supports --dry-run.
convert  Re-encode videos to VP8 WebM (video.webm), deleting originals only after verification.
         Pass --dry-run first to see what would change.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    songs: { type: 'string' },
    fast: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
    'max-height': { type: 'string' },
    quality: { type: 'string' },
    'include-backups': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})

const [command] = positionals
if (values.help || !command || !values.songs) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 2)
}
// Resolved so a relative path starting with '-' can never be read as an ffmpeg/ffprobe option.
const songsFolder = resolve(values.songs as string)

const exitWithUsageError = (message: string): never => {
  console.error(`${message}\n`)
  console.error(USAGE)
  return process.exit(2)
}

// Whole numbers only: Number('') is 0 and Number('1e3') / Number('0x10') are accepted by accident.
const toWholeNumber = (flag: string, raw: string | undefined) => {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) exitWithUsageError(`--${flag} needs a whole number, got "${raw}"`)
  return Number(raw)
}

const runAudit = async () => {
  const results = await auditSongsFolder(songsFolder, { probe: !values.fast })
  if (values.json) return console.log(JSON.stringify(results, null, 2))
  const countOf = (issue: SongVideoAudit['issues'][number]) => results.filter((result) => result.issues.includes(issue)).length
  results
    .filter((result) => result.issues.length > 0)
    .forEach((result) => console.log(`${result.issues.join(',').padEnd(40)} ${result.folder}`))
  console.log(`\n${results.length} songs`)
  for (const issue of ['no-video', 'multiple-video-files', 'needs-vp8-webm', 'unreadable-video', 'no-start-time', 'leftover-download-files'] as const) {
    console.log(`  ${issue.padEnd(24)} ${countOf(issue)}`)
  }
}

const runClean = async () => {
  const result = await cleanLeftovers(songsFolder, {
    dryRun: values['dry-run'],
    includeBackups: values['include-backups']
  })
  const verb = values['dry-run'] ? 'would remove' : 'removed'
  result.removed.forEach((file) => console.log(`${verb} ${(file.bytes / 1048576).toFixed(1).padStart(7)} MB  ${file.path}`))
  result.keptBackups.forEach((path) => console.log(`kept backup           ${path}`))
  const totalBytes = result.removed.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`\n${verb} ${result.removed.length} files, ${(totalBytes / 1048576).toFixed(1)} MB`)
}

const runConvert = async () => {
  const limit = toWholeNumber('limit', values.limit)
  if (limit === 0) exitWithUsageError('--limit must be at least 1')
  const options = {
    dryRun: values['dry-run'],
    maxHeight: toWholeNumber('max-height', values['max-height']),
    quality: toWholeNumber('quality', values.quality)
  }
  const invalidOptions = validateConvertOptions(options)
  if (invalidOptions) exitWithUsageError(invalidOptions)

  let converted = 0
  let failed = 0
  let savedBytes = 0
  let attempted = 0
  for await (const { folder, files } of findSongFolders(songsFolder)) {
    if (!files.some(isSongVideoFile)) continue
    if (limit !== undefined && attempted >= limit) break
    const result = await convertSongVideo(folder, options)
    if (result.status === 'already-ok') continue
    attempted++
    console.log(`${result.status.padEnd(18)} ${folder}${result.error ? `  (${result.error})` : ''}`)
    if (result.status === 'failed') failed++
    if (result.status === 'converted') {
      converted++
      savedBytes += (result.inputBytes ?? 0) - (result.outputBytes ?? 0)
    }
  }
  console.log(`\nconverted ${converted}, failed ${failed}, saved ${(savedBytes / 1048576).toFixed(1)} MB`)
  if (failed > 0) process.exitCode = 1
}

const commands: Record<string, () => Promise<void>> = { audit: runAudit, clean: runClean, convert: runConvert }
const runCommand = commands[command]
if (!runCommand) exitWithUsageError(`Unknown command "${command}"`)

try {
  await runCommand()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
