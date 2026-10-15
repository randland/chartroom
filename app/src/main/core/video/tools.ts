// Locates and runs ffmpeg / ffprobe. Has no Electron dependency so the same code
// backs the app and the standalone CLI.
//
// Lookup order: CHM_FFMPEG_DIR env var, the bundled directory registered by the app
// via setBundledToolDir(), then the system PATH.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export type ToolName = 'ffmpeg' | 'ffprobe'

export interface ToolResult {
  code: number
  stdout: string
  stderr: string
}

let bundledToolDir: string | null = null

export const setBundledToolDir = (dir: string | null) => {
  bundledToolDir = dir
}

const executableName = (tool: ToolName) => (process.platform === 'win32' ? `${tool}.exe` : tool)

export const resolveTool = (tool: ToolName): string => {
  const candidateDirs = [process.env.CHM_FFMPEG_DIR, bundledToolDir].filter((dir): dir is string => Boolean(dir))
  const found = candidateDirs.map((dir) => join(dir, executableName(tool))).find((path) => existsSync(path))
  return found ?? tool
}

export const runTool = (
  tool: ToolName,
  args: string[],
  signal?: AbortSignal
): Promise<ToolResult> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const child = spawn(resolveTool(tool), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Could not run ${tool}: ${error.message}. Install ffmpeg or set CHM_FFMPEG_DIR.`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('aborted'))
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
