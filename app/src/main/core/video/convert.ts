// Re-encodes a song's background video to VP8 in WebM, the only combination that
// Unity's video player (YARG) decodes on Linux, and that plays everywhere else too.
//
// Rules this enforces:
//  - the result is named video.webm and is the ONLY video.* file left in the folder
//  - audio is dropped (the game plays the stems), height is capped, timing is untouched
//  - source files are deleted only after the output verifies as VP8/WebM with a duration
//    matching the source's video track
//  - encoding happens in a local temp dir, then the file is copied into the song folder:
//    large direct writes to network shares (SMB) can stall

import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isSongVideoFile } from './audit.ts'
import { isVp8Webm, probeVideo } from './probe.ts'
import { runTool } from './tools.ts'

export interface ConvertOptions {
  /** Cap on output height in pixels; smaller videos are never upscaled. */
  maxHeight?: number
  /** libvpx constant-quality value, 4 (best) to 63 (smallest). */
  quality?: number
  /** Allowed difference between source and output video duration, in seconds. */
  durationToleranceSeconds?: number
  dryRun?: boolean
  signal?: AbortSignal
}

export type ConvertStatus =
  | 'converted'
  | 'cleaned-duplicates'
  | 'already-ok'
  | 'no-video'
  | 'dry-run'
  | 'failed'

export interface ConvertResult {
  folder: string
  status: ConvertStatus
  removedFiles: string[]
  inputBytes?: number
  outputBytes?: number
  error?: string
}

const OUTPUT_NAME = 'video.webm'

const DEFAULTS = { maxHeight: 720, quality: 30, durationToleranceSeconds: 2 }

/** Why these options cannot be used, or null when they are fine. Unset values use the defaults. */
export const validateConvertOptions = ({ maxHeight, quality, durationToleranceSeconds }: ConvertOptions): string | null => {
  if (maxHeight !== undefined && !(Number.isInteger(maxHeight) && maxHeight >= 16)) return 'maxHeight must be a whole number of at least 16'
  if (quality !== undefined && !(Number.isInteger(quality) && quality >= 4 && quality <= 63)) return 'quality must be a whole number from 4 to 63'
  if (durationToleranceSeconds !== undefined && !(durationToleranceSeconds >= 0)) return 'durationToleranceSeconds must be 0 or more'
  return null
}

const fail = (folder: string, error: string): ConvertResult => ({ folder, status: 'failed', removedFiles: [], error })

// Disk, network-share and missing-ffmpeg errors become a 'failed' result so one bad song
// never aborts a batch. Cancellation still propagates.
export const convertSongVideo = async (folder: string, options: ConvertOptions = {}): Promise<ConvertResult> => {
  const invalidOptions = validateConvertOptions(options)
  if (invalidOptions) return fail(folder, invalidOptions)
  try {
    return await convertFolder(folder, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    return fail(folder, error instanceof Error ? error.message : String(error))
  }
}

const convertFolder = async (folder: string, options: ConvertOptions): Promise<ConvertResult> => {
  const { maxHeight, quality, durationToleranceSeconds } = { ...DEFAULTS, ...stripUndefined(options) }
  const folderEntries = await fsp.readdir(folder)
  const videoFiles = folderEntries.filter(isSongVideoFile).sort()
  if (videoFiles.length === 0) return { folder, status: 'no-video', removedFiles: [] }

  const existingWebm = videoFiles.find((name) => name.toLowerCase() === OUTPUT_NAME)
  const otherVideos = videoFiles.filter((name) => name !== existingWebm)

  const existingWebmProbe = existingWebm ? await probeVideo(join(folder, existingWebm), options.signal) : null
  const existingIsGood = existingWebmProbe !== null && isVp8Webm(existingWebmProbe)

  if (existingIsGood && otherVideos.length === 0) return { folder, status: 'already-ok', removedFiles: [] }
  if (options.dryRun) return { folder, status: 'dry-run', removedFiles: [] }

  // A valid video.webm is already there: only the extra files need to go, after a
  // duration check against the best of them (so a truncated webm never wins silently).
  if (existingIsGood) {
    const problem = await findUnverifiedDuplicate(folder, otherVideos, existingWebm as string, existingWebmProbe.videoDurationSeconds, durationToleranceSeconds, options.signal)
    if (problem) return fail(folder, problem)
    await removeFiles(folder, otherVideos)
    return { folder, status: 'cleaned-duplicates', removedFiles: otherVideos }
  }

  const sourceName = pickSource(otherVideos, existingWebm)
  const sourcePath = join(folder, sourceName)
  const sourceProbe = await probeVideo(sourcePath, options.signal)
  if (!sourceProbe) return fail(folder, `Cannot read ${sourceName} with ffprobe`)
  // Every other video is deleted after the conversion, so each must be readable and the same length.
  const unverifiedExtra = await findUnverifiedDuplicate(folder, otherVideos.filter((name) => name !== sourceName), sourceName, sourceProbe.videoDurationSeconds, durationToleranceSeconds, options.signal)
  if (unverifiedExtra) return fail(folder, unverifiedExtra)
  // Everything this run will replace, measured before the output can overwrite a bad video.webm.
  const inputBytes = await sumFileSizes(folder, videoFiles)

  const workDir = await fsp.mkdtemp(join(tmpdir(), 'chm-video-'))
  const encodedPath = join(workDir, OUTPUT_NAME)
  const stagedPath = join(folder, `${OUTPUT_NAME}.part`)
  try {
    const encode = await runTool('ffmpeg', buildEncodeArgs(sourcePath, encodedPath, maxHeight, quality), options.signal)
    if (encode.code !== 0) return fail(folder, `ffmpeg failed: ${lastLines(encode.stderr)}`)

    const encodedProbe = await probeVideo(encodedPath, options.signal)
    if (!encodedProbe || !isVp8Webm(encodedProbe)) return fail(folder, 'Output is not VP8 in WebM; originals kept')
    const durationDrift = Math.abs(encodedProbe.videoDurationSeconds - sourceProbe.videoDurationSeconds)
    if (durationDrift > durationToleranceSeconds) {
      return fail(folder, `Duration differs by ${durationDrift.toFixed(1)}s; originals kept`)
    }

    await fsp.copyFile(encodedPath, stagedPath)
    // A short write to a network share would otherwise pass unnoticed and the originals would go.
    if ((await fsp.stat(stagedPath)).size !== (await fsp.stat(encodedPath)).size) return fail(folder, 'Copy into the song folder was incomplete; originals kept')
    await fsp.rename(stagedPath, join(folder, OUTPUT_NAME))

    const removedFiles = filesToRemoveAfterWrite(videoFiles, await fsp.readdir(folder))
    await removeFiles(folder, removedFiles)
    const outputBytes = (await fsp.stat(join(folder, OUTPUT_NAME))).size
    return { folder, status: 'converted', removedFiles, inputBytes, outputBytes }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(stagedPath, { force: true }).catch(() => {})
  }
}

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>

const sumFileSizes = async (folder: string, names: string[]) => {
  let total = 0
  for (const name of names) total += (await fsp.stat(join(folder, name))).size
  return total
}

const lastLines = (text: string) => text.trim().split(/\r?\n/).slice(-3).join(' | ')

// Prefer a non-webm source (typically the original mp4); fall back to a bad video.webm.
const pickSource = (otherVideos: string[], existingWebm: string | undefined) => otherVideos[0] ?? (existingWebm as string)

const removeFiles = async (folder: string, names: string[]) => {
  for (const name of names) await fsp.rm(join(folder, name), { force: true })
}

/**
 * Which of the videos found before encoding are still separate files once video.webm is
 * written. A name that differs from video.webm only by case is the same file on Windows
 * and macOS (the write replaced it), so it is no longer listed and must not be deleted.
 */
export const filesToRemoveAfterWrite = (videoFilesBefore: string[], folderEntriesAfter: string[]) => {
  const outputIsListed = folderEntriesAfter.includes(OUTPUT_NAME)
  const isCaseVariantOfOutput = (name: string) => name !== OUTPUT_NAME && name.toLowerCase() === OUTPUT_NAME
  return videoFilesBefore.filter((name) => {
    if (name === OUTPUT_NAME || !folderEntriesAfter.includes(name)) return false
    // A case variant is the output itself when the filesystem kept its old casing or ignores case.
    return !isCaseVariantOfOutput(name) || outputIsListed
  })
}

// Duplicates are only deleted once each is readable and agrees with video.webm; an
// unreadable one may be the only copy of the original, so it blocks the whole cleanup.
const findUnverifiedDuplicate = async (
  folder: string,
  names: string[],
  referenceName: string,
  referenceSeconds: number,
  toleranceSeconds: number,
  signal?: AbortSignal
): Promise<string | null> => {
  for (const name of names) {
    const probe = await probeVideo(join(folder, name), signal)
    if (!probe) return `Cannot read ${name} with ffprobe; nothing removed`
    const drift = Math.abs(probe.videoDurationSeconds - referenceSeconds)
    if (drift > toleranceSeconds) return `${name} differs from ${referenceName} by ${drift.toFixed(1)}s; nothing removed`
  }
  return null
}

const buildEncodeArgs = (inputPath: string, outputPath: string, maxHeight: number, quality: number) => [
  '-y',
  '-v', 'error',
  '-i', inputPath,
  '-map', '0:v:0',
  '-an',
  '-vf', `scale=-2:'min(${maxHeight},ih)'`,
  '-c:v', 'libvpx',
  '-b:v', '0',
  '-crf', String(quality),
  '-deadline', 'good',
  '-cpu-used', '4',
  '-pix_fmt', 'yuv420p',
  outputPath
]
