// Read-only scan of a Songs folder for background-video problems.

import { promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import { isVp8Webm, probeVideo } from './probe.ts'
import { readVideoStartTime } from './songini.ts'

export type VideoIssue =
  | 'no-video'
  | 'multiple-video-files'
  | 'needs-vp8-webm'
  | 'unreadable-video'
  | 'no-start-time'
  | 'leftover-download-files'

export interface SongVideoAudit {
  folder: string
  videoFiles: string[]
  issues: VideoIssue[]
}

export interface AuditOptions {
  /** Run ffprobe on each video to check the real codec instead of trusting the extension. */
  probe?: boolean
  signal?: AbortSignal
  onSong?: (result: SongVideoAudit) => void
}

const SONG_MARKERS = new Set(['song.ini', 'notes.chart', 'notes.mid'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv', '.mpg', '.mpeg'])

/** True for the files the games treat as the song's background video: `video.<ext>`. */
export const isSongVideoFile = (fileName: string) =>
  basename(fileName, extname(fileName)).toLowerCase() === 'video' && VIDEO_EXTENSIONS.has(extname(fileName).toLowerCase())

/** Fragments yt-dlp / ffmpeg leave behind: video.f137.mp4, video.temp.mp4, *.part, *.ytdl, *.bak. */
export const isLeftoverDownloadFile = (fileName: string) =>
  /^video\./i.test(fileName) && !isSongVideoFile(fileName) && /\.(part|ytdl|bak|tmp)$|\.f\d+\.|\.temp\./i.test(fileName)

/**
 * Walks down to the song folders. An unreadable Songs root throws (a mistyped path must not
 * look like an empty library); an unreadable subfolder is skipped.
 */
export async function* findSongFolders(root: string, isRoot = true): AsyncGenerator<{ folder: string; files: string[] }> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isRoot) throw error
    return
  }
  const isSongFolder = entries.some((entry) => entry.isFile() && SONG_MARKERS.has(entry.name.toLowerCase()))
  if (isSongFolder) {
    yield { folder: root, files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name) }
    return
  }
  const subfolders = entries.filter((entry) => entry.isDirectory()).sort((first, second) => first.name.localeCompare(second.name))
  for (const subfolder of subfolders) yield* findSongFolders(join(root, subfolder.name), false)
}

export const auditSongFolder = async (
  folder: string,
  files: string[],
  options: AuditOptions = {}
): Promise<SongVideoAudit> => {
  const videoFiles = files.filter(isSongVideoFile).sort()
  const issues: VideoIssue[] = []
  if (files.some(isLeftoverDownloadFile)) issues.push('leftover-download-files')

  if (videoFiles.length === 0) {
    return { folder, videoFiles, issues: ['no-video', ...issues] }
  }
  if (videoFiles.length > 1) issues.push('multiple-video-files')

  const needsConversion = async (fileName: string) => {
    if (!options.probe) return extname(fileName).toLowerCase() !== '.webm'
    const probe = await probeVideo(join(folder, fileName), options.signal)
    if (!probe) return 'unreadable' as const
    return !isVp8Webm(probe)
  }
  const verdicts = []
  for (const fileName of videoFiles) verdicts.push(await needsConversion(fileName))
  if (verdicts.includes('unreadable')) issues.push('unreadable-video')
  if (verdicts.includes(true)) issues.push('needs-vp8-webm')

  if ((await readVideoStartTime(folder)) === null) issues.push('no-start-time')
  return { folder, videoFiles, issues }
}

export const auditSongsFolder = async (songsRoot: string, options: AuditOptions = {}): Promise<SongVideoAudit[]> => {
  const results: SongVideoAudit[] = []
  for await (const { folder, files } of findSongFolders(songsRoot)) {
    if (options.signal?.aborted) throw new Error('aborted')
    const result = await auditSongFolder(folder, files, options)
    results.push(result)
    options.onSong?.(result)
  }
  return results
}
