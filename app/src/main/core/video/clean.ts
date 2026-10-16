// Removes the fragments yt-dlp / ffmpeg leave next to a song's video (video.f137.mp4,
// video.temp.mp4, *.part ...). A `.bak` file may be the only copy of an original, so it
// is kept unless the caller opts in.

import { promises as fsp } from 'fs'
import { join } from 'path'
import { findSongFolders, isLeftoverDownloadFile } from './audit.ts'

export interface CleanOptions {
  dryRun?: boolean
  includeBackups?: boolean
  signal?: AbortSignal
}

export interface CleanedFile {
  path: string
  bytes: number
}

export interface CleanResult {
  removed: CleanedFile[]
  keptBackups: string[]
}

const isBackup = (fileName: string) => /\.bak$/i.test(fileName)

export const cleanLeftovers = async (songsRoot: string, options: CleanOptions = {}): Promise<CleanResult> => {
  const result: CleanResult = { removed: [], keptBackups: [] }
  for await (const { folder, files } of findSongFolders(songsRoot)) {
    if (options.signal?.aborted) throw new Error('aborted')
    for (const fileName of files.filter(isLeftoverDownloadFile)) {
      const path = join(folder, fileName)
      if (isBackup(fileName) && !options.includeBackups) {
        result.keptBackups.push(path)
        continue
      }
      const { size } = await fsp.stat(path)
      if (!options.dryRun) await fsp.rm(path, { force: true })
      result.removed.push({ path, bytes: size })
    }
  }
  return result
}
