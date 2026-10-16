// Minimal song.ini key access for the video tools. Edits a single key in place and
// preserves everything else (key order, unknown keys, line endings, text encoding).
//
// The file is handled as latin1 so every byte survives a read/write round trip whatever
// encoding the song author used (UTF-8, Windows-1252 ...). Only ASCII keys and numeric
// values are ever written, so nothing is lost by that.

import { promises as fsp } from 'fs'
import { join } from 'path'

const SECTION_HEADER = /^\s*\[song\]\s*$/i
const ANY_SECTION_HEADER = /^\s*\[.*\]\s*$/
// Byte order marks as seen through latin1 decoding. UTF-8 is carried through edits as is;
// UTF-16 files are never edited because latin1 would see a NUL between every character.
const UTF8_BOM_AS_LATIN1 = '\u00EF\u00BB\u00BF'
const UTF16_BOMS_AS_LATIN1 = ['\u00FF\u00FE', '\u00FE\u00FF']

const keyPattern = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'i')

interface SongIni {
  isUtf16: boolean
  bom: string
  eol: string
  lines: string[]
}

const readSongIni = async (folderAbs: string): Promise<SongIni | null> => {
  let text: string
  try {
    text = await fsp.readFile(join(folderAbs, 'song.ini'), 'latin1')
  } catch (error) {
    // Only a missing file means "no song.ini". Any other failure (permissions, a sharing
    // violation, a network error) must not be mistaken for it, or the writer would replace the real file.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const isUtf16 = UTF16_BOMS_AS_LATIN1.some((utf16Bom) => text.startsWith(utf16Bom))
  const bom = text.startsWith(UTF8_BOM_AS_LATIN1) ? UTF8_BOM_AS_LATIN1 : ''
  const body = text.slice(bom.length)
  return { isUtf16, bom, eol: body.includes('\r\n') ? '\r\n' : '\n', lines: body.split(/\r?\n/) }
}

/**
 * Line range holding the song's keys: after the [song] header up to the next section.
 * A file with no [song] header at all is treated as one implicit section from the top.
 */
const songSectionRange = (lines: string[]) => {
  const headerIndex = lines.findIndex((line) => SECTION_HEADER.test(line))
  const start = headerIndex + 1
  const nextSection = lines.findIndex((line, index) => index >= start && ANY_SECTION_HEADER.test(line))
  return { headerIndex, start, end: nextSection < 0 ? lines.length : nextSection }
}

// Written to a sibling file and renamed so a crash never leaves a half-written song.ini.
const writeSongIni = async (folderAbs: string, { bom, eol, lines }: SongIni) => {
  const iniPath = join(folderAbs, 'song.ini')
  const tempPath = `${iniPath}.chm-tmp`
  await fsp.writeFile(tempPath, bom + lines.join(eol), 'latin1')
  await fsp.rename(tempPath, iniPath)
}

export const readIniValue = async (folderAbs: string, key: string): Promise<string | null> => {
  const ini = await readSongIni(folderAbs)
  if (ini === null) return null
  const { start, end } = songSectionRange(ini.lines)
  const pattern = keyPattern(key)
  const match = ini.lines.slice(start, end).map((line) => pattern.exec(line)).find(Boolean)
  return match ? match[1].trim() : null
}

/** `video_start_time` in milliseconds, or null when missing / not a number. */
export const readVideoStartTime = async (folderAbs: string): Promise<number | null> => {
  const raw = await readIniValue(folderAbs, 'video_start_time')
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/** Sets `key = value` in the [song] section; creates the file or section when absent. */
export const writeIniValue = async (folderAbs: string, key: string, value: string): Promise<void> => {
  const ini = (await readSongIni(folderAbs)) ?? { isUtf16: false, bom: '', eol: '\n', lines: ['[song]', ''] }
  if (ini.isUtf16) throw new Error(`${join(folderAbs, 'song.ini')} is UTF-16; not editing it`)
  const { lines } = ini
  const { headerIndex, start, end } = songSectionRange(lines)
  const pattern = keyPattern(key)
  const newLine = `${key} = ${value}`

  const existingIndex = lines.findIndex((line, index) => index >= start && index < end && pattern.test(line))
  if (existingIndex >= 0) {
    lines[existingIndex] = newLine
    return writeSongIni(folderAbs, ini)
  }

  if (headerIndex < 0) {
    lines.unshift('[song]', newLine)
    return writeSongIni(folderAbs, ini)
  }

  let insertAt = end
  while (insertAt > start && lines[insertAt - 1].trim() === '') insertAt--
  lines.splice(insertAt, 0, newLine)
  await writeSongIni(folderAbs, ini)
}

export const writeVideoStartTime = (folderAbs: string, milliseconds: number) =>
  writeIniValue(folderAbs, 'video_start_time', String(Math.trunc(milliseconds)))
