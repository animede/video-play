import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { FrameWindow, OperationProgress, VideoMetadata } from '../shared/types'

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
    avg_frame_rate?: string
    duration?: string
  }>
  format?: { duration?: string }
  frames?: Array<{ best_effort_timestamp_time?: string }>
}

interface RunningJob {
  process: ChildProcessWithoutNullStreams
  cancelled: boolean
}

const runningJobs = new Map<string, RunningJob>()
const FRAME_WINDOW_SECONDS = 30
const MAX_CACHED_WINDOWS = 12
const timestampCache = new Map<string, FrameWindow>()

function unpackedExecutable(executable: string): string {
  return executable.replace('app.asar', 'app.asar.unpacked')
}

function resolveFfmpeg(): string {
  const configured = process.env.VIDEO_PLAY_FFMPEG
  if (configured) return configured
  // ffmpeg-static resolves the binary for the OS used to package the application.
  return unpackedExecutable(require('ffmpeg-static') as string)
}

function resolveFfprobe(): string {
  const configured = process.env.VIDEO_PLAY_FFPROBE
  if (configured) return configured
  const module = require('ffprobe-static') as { path: string }
  return unpackedExecutable(module.path)
}

function ratio(value?: string): number {
  if (!value) return 0
  const parts = value.split('/')
  const numerator = Number(parts[0])
  const denominator = Number(parts[1] ?? 1)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0
  return numerator / denominator
}

function exec(executable: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

function execBuffer(executable: string, args: string[], maxBuffer = 128 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'buffer', maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.toString().trim() || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  const stdout = await exec(resolveFfprobe(), [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ])
  const data = JSON.parse(stdout) as FfprobeOutput
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error('映像ストリームが見つかりません。')

  const fps = ratio(video.r_frame_rate)
  const averageFps = ratio(video.avg_frame_rate) || fps
  const duration = Number(video.duration ?? data.format?.duration ?? 0)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('動画の長さを取得できません。')

  return {
    duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: fps || averageFps || 30,
    averageFps: averageFps || fps || 30,
    isVariableFrameRate: Math.abs(fps - averageFps) > 0.01,
    hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === 'audio')),
    codec: video.codec_name ?? 'unknown',
  }
}

export async function getFrameWindow(filePath: string, time: number): Promise<FrameWindow> {
  const stat = await fs.promises.stat(filePath)
  const start = Math.floor(Math.max(0, time) / FRAME_WINDOW_SECONDS) * FRAME_WINDOW_SECONDS
  const end = start + FRAME_WINDOW_SECONDS
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}:${start}`
  const cached = timestampCache.get(key)
  if (cached) {
    // Reinsert so Map insertion order acts as a small LRU cache.
    timestampCache.delete(key)
    timestampCache.set(key, cached)
    return cached
  }

  // Start slightly before the requested chunk so inter-frame codecs can seek to
  // an earlier keyframe. Only timestamps inside the exact chunk are returned.
  const probeStart = Math.max(0, start - 2)
  const probeEnd = end + 2

  const stdout = await exec(resolveFfprobe(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', `${probeStart.toFixed(6)}%${probeEnd.toFixed(6)}`,
    '-show_entries', 'frame=best_effort_timestamp_time',
    '-of', 'json',
    filePath,
  ], 16 * 1024 * 1024)
  const data = JSON.parse(stdout) as FfprobeOutput
  const timestamps = (data.frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((frameTime) => Number.isFinite(frameTime) && frameTime >= start && frameTime < end)
  const frameWindow = { start, end, timestamps }
  timestampCache.set(key, frameWindow)
  while (timestampCache.size > MAX_CACHED_WINDOWS) {
    const oldestKey = timestampCache.keys().next().value as string | undefined
    if (oldestKey) timestampCache.delete(oldestKey)
    else break
  }
  return frameWindow
}

function splitJpegStream(stream: Buffer): Buffer[] {
  const images: Buffer[] = []
  let offset = 0
  while (offset < stream.length) {
    const start = stream.indexOf(Buffer.from([0xff, 0xd8]), offset)
    if (start < 0) break
    const end = stream.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
    if (end < 0) break
    images.push(stream.subarray(start, end + 2))
    offset = end + 2
  }
  return images
}

export async function decodeFramesJpeg(filePath: string, times: number[]): Promise<Buffer[]> {
  if (times.length === 0) return []
  // The caller supplies adjacent presentation timestamps. Seek once and decode
  // the target plus nearby frames in one FFmpeg process for smooth frame stepping.
  const seekTime = Math.max(0, times[0] - 0.000001)
  const stream = await execBuffer(resolveFfmpeg(), [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-ss', seekTime.toFixed(6),
    '-i', filePath,
    '-map', '0:v:0',
    '-frames:v', String(times.length),
    '-fps_mode', 'passthrough',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-q:v', '2',
    'pipe:1',
  ])
  const images = splitJpegStream(stream)
  if (images.length !== times.length) {
    throw new Error(`要求した${times.length}フレームのうち${images.length}フレームしかデコードできませんでした。`)
  }
  return images
}

function sendProgress(sender: WebContents, progress: OperationProgress): void {
  if (!sender.isDestroyed()) sender.send('video:progress', progress)
}

export function runFfmpeg(
  jobId: string,
  args: string[],
  expectedDuration: number,
  sender: WebContents,
): Promise<{ cancelled: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpeg(), ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], {
      windowsHide: true,
    })
    const job: RunningJob = { process: child, cancelled: false }
    runningJobs.set(jobId, job)
    let stderr = ''
    let stdoutRemainder = ''

    sendProgress(sender, { jobId, progress: 0, message: '処理を開始しています…' })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutRemainder += chunk.toString()
      const lines = stdoutRemainder.split(/\r?\n/)
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) {
        const separator = line.indexOf('=')
        if (separator < 0) continue
        const key = line.slice(0, separator)
        const value = line.slice(separator + 1)
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const elapsed = Number(value) / 1_000_000
          const progress = Math.min(0.99, Math.max(0, elapsed / expectedDuration))
          sendProgress(sender, { jobId, progress, message: '動画を処理しています…' })
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-32_000)
    })
    child.on('error', (error) => {
      runningJobs.delete(jobId)
      reject(error)
    })
    child.on('close', (code) => {
      runningJobs.delete(jobId)
      if (job.cancelled) {
        resolve({ cancelled: true })
      } else if (code === 0) {
        sendProgress(sender, { jobId, progress: 1, message: '完了しました。' })
        resolve({ cancelled: false })
      } else {
        reject(new Error(stderr.trim() || `FFmpegが終了コード ${code} で停止しました。`))
      }
    })
  })
}

export function cancelJob(jobId: string): void {
  const job = runningJobs.get(jobId)
  if (!job) return
  job.cancelled = true
  job.process.kill('SIGTERM')
}

export function frameArgs(source: string, time: number, output: string): string[] {
  return ['-ss', time.toFixed(6), '-i', source, '-map', '0:v:0', '-frames:v', '1', '-y', output]
}

const videoEncoding = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']
const audioEncoding = ['-c:a', 'aac', '-b:a', '192k']

export function extractArgs(source: string, start: number, end: number, hasAudio: boolean, output: string): string[] {
  const args = [
    '-ss', start.toFixed(6),
    '-i', source,
    '-t', (end - start).toFixed(6),
    '-map', '0:v:0',
  ]
  if (hasAudio) args.push('-map', '0:a:0?')
  // Preserve presentation timestamps when the input has a variable frame rate.
  args.push('-fps_mode', 'vfr', ...videoEncoding)
  if (hasAudio) args.push(...audioEncoding)
  args.push('-movflags', '+faststart', '-y', output)
  return args
}

export function removeArgs(
  source: string,
  start: number,
  end: number,
  duration: number,
  hasAudio: boolean,
  output: string,
): string[] {
  if (start <= 0.000001) return extractArgs(source, end, duration, hasAudio, output)
  if (end >= duration - 0.000001) return extractArgs(source, 0, start, hasAudio, output)

  const videoFilter =
    `[0:v:0]trim=start=0:end=${start.toFixed(6)},setpts=PTS-STARTPTS[v0];` +
    `[0:v:0]trim=start=${end.toFixed(6)}:end=${duration.toFixed(6)},setpts=PTS-STARTPTS[v1];`
  const audioFilter = hasAudio
    ? `[0:a:0]atrim=start=0:end=${start.toFixed(6)},asetpts=PTS-STARTPTS[a0];` +
      `[0:a:0]atrim=start=${end.toFixed(6)}:end=${duration.toFixed(6)},asetpts=PTS-STARTPTS[a1];` +
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]'
    : '[v0][v1]concat=n=2:v=1:a=0[v]'

  const args = ['-i', source, '-filter_complex', videoFilter + audioFilter, '-map', '[v]']
  if (hasAudio) args.push('-map', '[a]')
  // concat filters do not expose a fixed input rate; without this option FFmpeg
  // can silently coerce the result to its 25 fps fallback.
  args.push('-fps_mode', 'vfr', ...videoEncoding)
  if (hasAudio) args.push(...audioEncoding)
  args.push('-movflags', '+faststart', '-y', output)
  return args
}

export function defaultOutputPath(source: string, suffix: string, extension = '.mp4'): string {
  const parsed = path.parse(source)
  return path.join(parsed.dir, `${parsed.name}${suffix}${extension}`)
}
