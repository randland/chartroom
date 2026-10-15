import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { auditSongsFolder } from '../src/main/core/video/audit.ts'
import { cleanLeftovers } from '../src/main/core/video/clean.ts'
import { convertSongVideo, filesToRemoveAfterWrite } from '../src/main/core/video/convert.ts'
import { isVp8Webm, probeVideo } from '../src/main/core/video/probe.ts'
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

describe('convert', () => {
  it('converts mp4 to VP8 webm, downscales, drops audio, keeps song.ini, removes mp4', async () => {
    const folder = makeSong('convert/ok', '[song]\nvideo_start_time = -1200\n')
    makeVideo(join(folder, 'video.mp4'), H264)
    const result = await convertSongVideo(folder)
    assert.equal(result.status, 'converted', result.error)
    assert.equal(existsSync(join(folder, 'video.mp4')), false)
    const probe = await probeVideo(join(folder, 'video.webm'))
    assert.ok(probe && isVp8Webm(probe))
    assert.equal(probe.hasAudio, false)
    assert.equal(probe.height, 720)
    assert.equal(await readVideoStartTime(folder), -1200)
    assert.equal(existsSync(join(folder, 'video.webm.part')), false)
  })

  it('does not upscale small videos', async () => {
    const folder = makeSong('convert/small')
    makeVideo(join(folder, 'video.mp4'), H264, 1, '320x240')
    await convertSongVideo(folder)
    assert.equal((await probeVideo(join(folder, 'video.webm')))?.height, 240)
  })

  it('leaves everything alone on dry run and when already OK', async () => {
    const folder = makeSong('convert/dry')
    makeVideo(join(folder, 'video.mp4'), H264)
    assert.equal((await convertSongVideo(folder, { dryRun: true })).status, 'dry-run')
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
    await convertSongVideo(folder)
    assert.equal((await convertSongVideo(folder)).status, 'already-ok')
  })

  it('removes a leftover mp4 when a valid video.webm exists', async () => {
    const folder = makeSong('convert/dupe')
    makeVideo(join(folder, 'video.mp4'), H264)
    makeVideo(join(folder, 'video.webm'), ['-c:v', 'libvpx', '-an'])
    const result = await convertSongVideo(folder)
    assert.equal(result.status, 'cleaned-duplicates', result.error)
    assert.equal(existsSync(join(folder, 'video.mp4')), false)
  })

  it('keeps an unreadable duplicate instead of deleting it next to a valid video.webm', async () => {
    const folder = makeSong('convert/dupe-unreadable')
    makeVideo(join(folder, 'video.webm'), ['-c:v', 'libvpx', '-an'])
    writeFileSync(join(folder, 'video.mp4'), 'truncated')
    const result = await convertSongVideo(folder)
    assert.equal(result.status, 'failed')
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
    assert.equal(existsSync(join(folder, 'video.webm')), true)
  })

  it('reports a failed result instead of throwing on I/O errors', async () => {
    assert.equal((await convertSongVideo(join(root, 'convert/does-not-exist'))).status, 'failed')

    const folder = makeSong('convert/no-ffmpeg')
    writeFileSync(join(folder, 'video.mp4'), 'x')
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = await convertSongVideo(folder)
      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /ffprobe/)
    } finally {
      process.env.PATH = originalPath
    }
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
  })

  it('never lists the written output for deletion, whatever its case on disk', () => {
    const videoFilesBefore = ['Video.MP4', 'Video.WEBM']
    const caseInsensitiveListing = ['Video.MP4', 'song.ini', 'video.webm']
    assert.deepEqual(filesToRemoveAfterWrite(videoFilesBefore, caseInsensitiveListing), ['Video.MP4'])
    const caseSensitiveListing = ['Video.MP4', 'Video.WEBM', 'song.ini', 'video.webm']
    assert.deepEqual(filesToRemoveAfterWrite(videoFilesBefore, caseSensitiveListing), ['Video.MP4', 'Video.WEBM'])
    const filesystemKeptOldCasing = ['Video.MP4', 'Video.WEBM', 'song.ini']
    assert.deepEqual(filesToRemoveAfterWrite(videoFilesBefore, filesystemKeptOldCasing), ['Video.MP4'])
  })

  it('does not delete a second video it never verified', async () => {
    const folder = makeSong('convert/extra-differs')
    makeVideo(join(folder, 'video.avi'), ['-c:v', 'mpeg4', '-c:a', 'mp2'], 6, '320x240')
    makeVideo(join(folder, 'video.mp4'), H264, 2, '320x240')
    const result = await convertSongVideo(folder)
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /differs from video\.avi/)
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
    assert.equal(existsSync(join(folder, 'video.webm')), false)

    const unreadableFolder = makeSong('convert/extra-unreadable')
    makeVideo(join(unreadableFolder, 'video.avi'), ['-c:v', 'mpeg4', '-c:a', 'mp2'], 2, '320x240')
    writeFileSync(join(unreadableFolder, 'video.mp4'), 'truncated')
    assert.equal((await convertSongVideo(unreadableFolder)).status, 'failed')
    assert.equal(existsSync(join(unreadableFolder, 'video.mp4')), true)
  })

  it('measures video length from the video stream when the audio is longer and durations are unlabelled', async () => {
    const folder = makeSong('convert/long-audio')
    const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(folder, 'video.mkv')])
    assert.equal(result.status, 0, result.stderr?.toString())
    const probe = await probeVideo(join(folder, 'video.mkv'))
    assert.ok(probe && Math.abs(probe.videoDurationSeconds - 2) < 0.5, `got ${probe?.videoDurationSeconds}`)
    assert.equal((await convertSongVideo(folder)).status, 'converted')
  })

  it('keeps the original when the source is unreadable', async () => {
    const folder = makeSong('convert/corrupt')
    writeFileSync(join(folder, 'video.mp4'), 'not a video')
    const result = await convertSongVideo(folder)
    assert.equal(result.status, 'failed')
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
    assert.equal(existsSync(join(folder, 'video.webm')), false)
  })
})

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'tools/chm-video.ts', ...args], { encoding: 'utf-8' })

describe('cli', () => {
  it('rejects non-numeric, out-of-range and zero flag values before touching anything', () => {
    const folder = makeSong('cli/flags')
    makeVideo(join(folder, 'video.mp4'), H264, 1, '320x240')
    for (const flags of [['--max-height', 'abc'], ['--quality', '999'], ['--quality', ''], ['--limit', '0'], ['--limit', '1e3']]) {
      const result = runCli('convert', '--songs', join(root, 'cli/flags'), ...flags)
      assert.equal(result.status, 2, flags.join(' '))
    }
    assert.equal(existsSync(join(folder, 'video.mp4')), true)
    assert.equal(existsSync(join(folder, 'video.webm')), false)
  })

  it('counts --limit against songs it converts, not songs that are already OK', () => {
    const okRoot = join(root, 'cli/limit')
    for (const name of ['a-ok', 'b-ok']) {
      const folder = makeSong(`cli/limit/${name}`)
      makeVideo(join(folder, 'video.webm'), ['-c:v', 'libvpx', '-an'], 1, '320x240')
    }
    const pending = makeSong('cli/limit/z-pending')
    makeVideo(join(pending, 'video.mp4'), H264, 1, '320x240')
    const result = runCli('convert', '--songs', okRoot, '--limit', '1')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(pending, 'video.mp4')), false)
    assert.equal(existsSync(join(pending, 'video.webm')), true)
  })

  it('fails loudly when the Songs folder cannot be read', () => {
    const result = runCli('audit', '--songs', join(root, 'cli/not-a-folder'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ENOENT/)
  })

  it('flags a VP9 .webm in a default audit but not with --fast', () => {
    const folder = makeSong('cli/vp9', '[song]\nvideo_start_time = 0\n')
    makeVideo(join(folder, 'video.webm'), ['-c:v', 'libvpx-vp9', '-an'], 1, '320x240')
    const songsRoot = join(root, 'cli/vp9')
    assert.match(runCli('audit', '--songs', songsRoot).stdout, /needs-vp8-webm {1,}\S*cli\/vp9/)
    assert.doesNotMatch(runCli('audit', '--songs', songsRoot, '--fast').stdout, /needs-vp8-webm {1,}\S*cli\/vp9/)
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
