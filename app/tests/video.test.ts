import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { auditSongsFolder } from '../src/main/core/video/audit.ts'
import { cleanLeftovers } from '../src/main/core/video/clean.ts'
import { readVideoStartTime, writeVideoStartTime } from '../src/main/core/video/songini.ts'

let root: string

const makeSong = (name: string, iniText = '[song]\nname = Test\n') => {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'song.ini'), iniText)
  return folder
}

const makeVideo = (path: string, codecArgs: string[], seconds = 2, size = '1280x1080') => {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=10`,
      '-f', 'lavfi', '-i', `sine=duration=${seconds}`, ...codecArgs, path]
  )
  assert.equal(result.status, 0, result.stderr?.toString())
}

const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']

before(() => {
  root = mkdtempSync(join(tmpdir(), 'chm-video-test-'))
})
after(() => rmSync(root, { recursive: true, force: true }))

describe('song.ini video_start_time', () => {
  it('adds the key to [song], preserving CRLF and other keys', async () => {
    const folder = makeSong('ini-add', '[Song]\r\nname = A\r\nartist = B\r\n\r\n[Other]\r\nx = 1\r\n')
    await writeVideoStartTime(folder, -2500)
    const text = readFileSync(join(folder, 'song.ini'), 'utf-8')
    assert.equal(await readVideoStartTime(folder), -2500)
    assert.match(text, /artist = B\r\nvideo_start_time = -2500\r\n\r\n\[Other\]/)
  })

  it('replaces an existing value in place', async () => {
    const folder = makeSong('ini-replace', '[song]\nvideo_start_time = 5\nname = A\n')
    await writeVideoStartTime(folder, 100)
    assert.equal(readFileSync(join(folder, 'song.ini'), 'utf-8'), '[song]\nvideo_start_time = 100\nname = A\n')
  })

  it('only reads and writes inside [song]', async () => {
    const folder = makeSong('ini-sections', '[Other]\nvideo_start_time = 9\n\n[song]\nname = A\n')
    assert.equal(await readVideoStartTime(folder), null)
    await writeVideoStartTime(folder, 40)
    assert.equal(
      readFileSync(join(folder, 'song.ini'), 'utf-8'),
      '[Other]\nvideo_start_time = 9\n\n[song]\nname = A\nvideo_start_time = 40\n'
    )
    assert.equal(await readVideoStartTime(folder), 40)
  })

  it('keeps a UTF-8 BOM and does not add a second [song] header', async () => {
    const folder = makeSong('ini-bom', '\uFEFF[song]\nname = A\n')
    await writeVideoStartTime(folder, 7)
    const bytes = readFileSync(join(folder, 'song.ini'))
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(bytes.toString('utf-8'), '\uFEFF[song]\nname = A\nvideo_start_time = 7\n')
    assert.equal(await readVideoStartTime(folder), 7)
  })

  it('preserves bytes of files that are not valid UTF-8', async () => {
    const folder = makeSong('ini-latin1')
    const original = Buffer.concat([Buffer.from('[song]\nartist = Beyonc'), Buffer.from([0xe9]), Buffer.from('\n')])
    writeFileSync(join(folder, 'song.ini'), original)
    await writeVideoStartTime(folder, 1)
    const expected = Buffer.concat([original, Buffer.from('video_start_time = 1\n')])
    assert.deepEqual(readFileSync(join(folder, 'song.ini')), expected)
    assert.equal(existsSync(join(folder, 'song.ini.chm-tmp')), false)
  })

  it('does not replace a song.ini it failed to read', async (context) => {
    if (process.getuid?.() === 0) return context.skip('root can read any file')
    const folder = makeSong('ini-unreadable', '[song]\nname = keep me\n')
    chmodSync(join(folder, 'song.ini'), 0o000)
    try {
      await assert.rejects(writeVideoStartTime(folder, 100))
    } finally {
      chmodSync(join(folder, 'song.ini'), 0o644)
    }
    assert.equal(readFileSync(join(folder, 'song.ini'), 'utf-8'), '[song]\nname = keep me\n')
  })

  it('refuses to edit a UTF-16 song.ini and leaves it byte for byte alone', async () => {
    const folder = makeSong('ini-utf16')
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[song]\nname = A\n', 'utf16le')])
    writeFileSync(join(folder, 'song.ini'), original)
    await assert.rejects(writeVideoStartTime(folder, 100), /UTF-16/)
    assert.deepEqual(readFileSync(join(folder, 'song.ini')), original)
  })

  it('returns null when missing', async () => {
    assert.equal(await readVideoStartTime(makeSong('ini-missing')), null)
  })
})

describe('audit', () => {
  it('reports each problem class', async () => {
    const none = makeSong('audit/none')
    const mp4 = makeSong('audit/mp4', '[song]\nvideo_start_time = 0\n')
    makeVideo(join(mp4, 'video.mp4'), H264)
    const both = makeSong('audit/both')
    makeVideo(join(both, 'video.mp4'), H264)
    makeVideo(join(both, 'video.webm'), ['-c:v', 'libvpx', '-an'])
    const leftovers = makeSong('audit/leftovers', '[song]\nvideo_start_time = 0\n')
    writeFileSync(join(leftovers, 'video.f137.mp4.part'), 'x')
    writeFileSync(join(leftovers, 'video.temp.mp4'), 'x')
    const results = await auditSongsFolder(join(root, 'audit'), { probe: true })
    const issuesOf = (folder: string) => results.find((result) => result.folder === folder)?.issues
    assert.deepEqual(issuesOf(none), ['no-video'])
    assert.deepEqual(issuesOf(leftovers), ['no-video', 'leftover-download-files'])
    assert.deepEqual(issuesOf(mp4), ['needs-vp8-webm'])
    assert.deepEqual(issuesOf(both), ['multiple-video-files', 'needs-vp8-webm', 'no-start-time'])
  })
})

describe('clean', () => {
  it('removes download fragments, keeps real videos and backups, honors dry run', async () => {
    const folder = makeSong('clean/song', '[song]\n')
    for (const name of ['video.webm', 'video.f137.mp4.part', 'video.temp.mp4', 'video.f140.m4a', 'video.mp4.bak']) {
      writeFileSync(join(folder, name), 'x')
    }
    const cleanRoot = join(root, 'clean')
    const dry = await cleanLeftovers(cleanRoot, { dryRun: true })
    assert.equal(dry.removed.length, 3)
    assert.equal(existsSync(join(folder, 'video.temp.mp4')), true)
    const real = await cleanLeftovers(cleanRoot)
    assert.equal(real.removed.length, 3)
    assert.deepEqual(real.keptBackups, [join(folder, 'video.mp4.bak')])
    assert.equal(existsSync(join(folder, 'video.temp.mp4')), false)
    assert.equal(existsSync(join(folder, 'video.webm')), true)
    assert.equal(existsSync(join(folder, 'video.mp4.bak')), true)
  })
})
