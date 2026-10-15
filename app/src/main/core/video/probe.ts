// ffprobe wrapper: the facts about a video file that the audit and convert steps need.

import { runTool } from './tools.ts'

export interface VideoProbe {
  /** Codec of the first video stream, e.g. "h264", "vp8", "vp9". */
  videoCodec: string
  width: number
  height: number
  /** Duration of the video stream itself, in seconds (falls back to the container's). */
  videoDurationSeconds: number
  hasAudio: boolean
  /** Comma-separated container names as reported by ffprobe, e.g. "matroska,webm". */
  formatName: string
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { format_name?: string; duration?: string }
}

const toSeconds = (raw: string | undefined) => {
  const parsed = Number.parseFloat(raw ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

// Containers like mkv often report no per-stream duration. The container's duration is then
// the longest stream, which is the audio when that outlasts the video, so read the video
// packets instead: slower, but only used in that case.
const videoDurationFromPackets = async (filePath: string, signal?: AbortSignal) => {
  const { code, stdout } = await runTool(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filePath],
    signal
  )
  if (code !== 0) return 0
  const packetEnds = stdout.split(/\r?\n/).map((line) => {
    const [startSeconds, durationSeconds] = line.split(',')
    return toSeconds(startSeconds) + toSeconds(durationSeconds)
  })
  return Math.max(0, ...packetEnds)
}

export const probeVideo = async (filePath: string, signal?: AbortSignal): Promise<VideoProbe | null> => {
  const { code, stdout } = await runTool(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    signal
  )
  if (code !== 0) return null
  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput
  } catch {
    return null
  }
  const streams = parsed.streams ?? []
  const videoStream = streams.find((stream) => stream.codec_type === 'video')
  if (!videoStream) return null
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio')
  const streamDuration = toSeconds(videoStream.duration)
  const containerDuration = toSeconds(parsed.format?.duration)
  const needsPacketScan = streamDuration <= 0 && hasAudio
  const videoDurationSeconds = needsPacketScan
    ? (await videoDurationFromPackets(filePath, signal)) || containerDuration
    : streamDuration || containerDuration
  return {
    videoCodec: videoStream.codec_name ?? 'unknown',
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    videoDurationSeconds,
    hasAudio,
    formatName: parsed.format?.format_name ?? ''
  }
}

export const isVp8Webm = (probe: VideoProbe) => probe.videoCodec === 'vp8' && probe.formatName.split(',').includes('webm')
