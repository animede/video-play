import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ConcatRequest, EditRequest, EncodingPreference, EncodingQuality, FrameRequest, RegisteredVideo, RemoveRangesRequest, TimeRange, VideoEncoder, VideoMetadata } from '../shared/types'
import {
  cancelJob,
  concatenateArgs,
  decodeFramesJpeg,
  defaultOutputPath,
  detectVideoEncoders,
  extractArgs,
  frameArgs,
  getFrameWindow,
  probeVideo,
  removeRangesArgs,
  runFfmpeg,
} from './ffmpeg'

const registeredVideos = new Map<string, VideoMetadata>()
let outputDirectory = ''

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): void {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { outputDirectory?: unknown }
    if (typeof settings.outputDirectory === 'string' && fs.statSync(settings.outputDirectory).isDirectory()) {
      outputDirectory = settings.outputDirectory
    }
  } catch { /* Missing or stale settings use the save dialog. */ }
}

async function saveSettings(): Promise<void> {
  await fs.promises.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.promises.writeFile(settingsPath(), JSON.stringify({ outputDirectory }, null, 2), 'utf8')
}

function normalizeVideoPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (path.extname(resolved).toLowerCase() !== '.mp4') throw new Error('MP4ファイルを選択してください。')
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('動画ファイルを読み込めません。')
  return resolved
}

async function registerVideo(filePath: string): Promise<RegisteredVideo> {
  const resolved = normalizeVideoPath(filePath)
  const metadata = await probeVideo(resolved)
  registeredVideos.set(resolved, metadata)
  return { path: resolved, name: path.basename(resolved), metadata }
}

function assertAllowed(sourcePath: string): string {
  const resolved = path.resolve(sourcePath)
  if (!registeredVideos.has(resolved)) throw new Error('先にアプリから動画を開いてください。')
  return resolved
}

function registeredMetadata(sourcePath: string): VideoMetadata {
  const metadata = registeredVideos.get(sourcePath)
  if (!metadata) throw new Error('先にアプリから動画を開いてください。')
  return metadata
}

function validateRange(start: number, end: number, duration: number): void {
  if (![start, end, duration].every(Number.isFinite)) throw new Error('区間指定が正しくありません。')
  if (start < 0 || end > duration + 0.001 || end - start < 0.001) {
    throw new Error('IN点はOUT点より前になるように指定してください。')
  }
}

function normalizeRanges(ranges: TimeRange[], duration: number): TimeRange[] {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 100) {
    throw new Error('削除区間を1件以上100件以下で指定してください。')
  }
  const sorted = ranges.map(({ start, end }) => {
    validateRange(start, end, duration)
    return { start, end }
  }).sort((left, right) => left.start - right.start)
  const merged: TimeRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end + 0.001) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

async function chooseOutput(defaultPath: string, filters: Electron.FileFilter[]): Promise<string | null> {
  if (outputDirectory) {
    const parsed = path.parse(path.join(outputDirectory, path.basename(defaultPath)))
    let candidate = path.join(parsed.dir, `${parsed.name}${parsed.ext}`)
    for (let suffix = 2; fs.existsSync(candidate); suffix += 1) {
      candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`)
    }
    return candidate
  }
  const result = await dialog.showSaveDialog({ defaultPath, filters, properties: ['showOverwriteConfirmation'] })
  return result.canceled ? null : result.filePath
}

async function executeJob(
  jobId: string,
  args: string[],
  expectedDuration: number,
  sender: Electron.WebContents,
  output: string,
  fallbackArgs?: string[],
): Promise<{ cancelled: boolean; outputPath?: string }> {
  try {
    let result
    try {
      result = await runFfmpeg(jobId, args, expectedDuration, sender)
    } catch (error) {
      if (!fallbackArgs) throw error
      await fs.promises.rm(output, { force: true })
      if (!sender.isDestroyed()) sender.send('video:progress', {
        jobId,
        progress: 0,
        message: 'GPU処理に失敗したためCPUへ切り替えています…',
      })
      result = await runFfmpeg(jobId, fallbackArgs, expectedDuration, sender)
    }
    if (result.cancelled) await fs.promises.rm(output, { force: true })
    return { cancelled: result.cancelled, outputPath: result.cancelled ? undefined : output }
  } catch (error) {
    await fs.promises.rm(output, { force: true })
    throw error
  }
}

async function resolveEncoding(preference: EncodingPreference = 'auto'): Promise<VideoEncoder> {
  const available = await detectVideoEncoders()
  if (preference === 'auto') return available[0] ?? 'cpu'
  if (preference === 'cpu' || preference === 'nvenc' || preference === 'qsv' || preference === 'amf') {
    return available.includes(preference) ? preference : 'cpu'
  }
  return 'cpu'
}

function resolveQuality(quality?: EncodingQuality): EncodingQuality {
  return quality === 'fast' || quality === 'quality' ? quality : 'standard'
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../build/icon.png')
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#111318',
    title: 'Video-player',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const devServer = process.env.VITE_DEV_SERVER_URL
  if (devServer) void window.loadURL(devServer)
  else void window.loadFile(path.join(__dirname, '../../dist/index.html'))

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const expectedOrigin = devServer ? new URL(devServer).origin : 'file://'
    if ((devServer && new URL(url).origin !== expectedOrigin) || (!devServer && !url.startsWith(expectedOrigin))) {
      event.preventDefault()
    }
  })
}

app.whenReady().then(() => {
  loadSettings()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('video:register', (_event, filePath: string) => registerVideo(filePath))
ipcMain.handle('video:frame-window', (_event, sourcePath: string, time: number) => {
  if (!Number.isFinite(time) || time < 0) throw new Error('フレーム解析位置が正しくありません。')
  return getFrameWindow(assertAllowed(sourcePath), time)
})
ipcMain.handle('video:decode-frames', async (_event, sourcePath: string, times: number[]) => {
  if (!Array.isArray(times) || times.length < 1 || times.length > 5 || times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new Error('フレーム位置が正しくありません。')
  }
  const source = assertAllowed(sourcePath)
  const metadata = registeredMetadata(source)
  const exactTimes = [...new Set(times)]
    .sort((a, b) => a - b)
    .map((time) => Math.min(time, Math.max(0, metadata.duration - 0.000001)))
  if (exactTimes.at(-1)! - exactTimes[0] > 5) throw new Error('一度にデコードできる範囲を超えています。')
  const images = await decodeFramesJpeg(source, exactTimes)
  return images.map((data, index) => ({ time: exactTimes[index], data: new Uint8Array(data) }))
})

ipcMain.handle('video:save-frame', async (event, request: FrameRequest) => {
  const source = assertAllowed(request.sourcePath)
  const metadata = registeredMetadata(source)
  const time = Math.min(metadata.duration, Math.max(0, request.time))
  const output = await chooseOutput(defaultOutputPath(source, `-frame-${time.toFixed(3)}s`, '.png'), [
    { name: 'PNG画像', extensions: ['png'] },
    { name: 'JPEG画像', extensions: ['jpg', 'jpeg'] },
  ])
  if (!output) return { cancelled: true }
  return executeJob(request.jobId, frameArgs(source, time, output), 1, event.sender, output)
})

ipcMain.handle('video:extract', async (event, request: EditRequest) => {
  const source = assertAllowed(request.sourcePath)
  const metadata = registeredMetadata(source)
  validateRange(request.start, request.end, metadata.duration)
  const output = await chooseOutput(defaultOutputPath(source, '-clip'), [{ name: 'MP4動画', extensions: ['mp4'] }])
  if (!output) return { cancelled: true }
  if (path.resolve(output) === source) throw new Error('元動画とは別のファイル名を指定してください。')
  const encoder = await resolveEncoding(request.encoder)
  const quality = resolveQuality(request.quality)
  const cpuArgs = encoder === 'cpu' ? undefined : extractArgs(source, request.start, request.end, metadata.hasAudio, output, 'cpu', quality)
  return executeJob(
    request.jobId,
    extractArgs(source, request.start, request.end, metadata.hasAudio, output, encoder, quality),
    request.end - request.start,
    event.sender,
    output,
    cpuArgs,
  )
})

ipcMain.handle('video:remove', async (event, request: RemoveRangesRequest) => {
  const source = assertAllowed(request.sourcePath)
  const metadata = registeredMetadata(source)
  const ranges = normalizeRanges(request.ranges, metadata.duration)
  const removedDuration = ranges.reduce((sum, range) => sum + range.end - range.start, 0)
  if (removedDuration >= metadata.duration - 0.001) throw new Error('動画全体を削除することはできません。')
  const output = await chooseOutput(defaultOutputPath(source, '-removed'), [{ name: 'MP4動画', extensions: ['mp4'] }])
  if (!output) return { cancelled: true }
  if (path.resolve(output) === source) throw new Error('元動画とは別のファイル名を指定してください。')
  const encoder = await resolveEncoding(request.encoder)
  const quality = resolveQuality(request.quality)
  const cpuArgs = encoder === 'cpu' ? undefined : removeRangesArgs(source, ranges, metadata.duration, metadata.hasAudio, output, 'cpu', quality)
  return executeJob(
    request.jobId,
    removeRangesArgs(source, ranges, metadata.duration, metadata.hasAudio, output, encoder, quality),
    metadata.duration - removedDuration,
    event.sender,
    output,
    cpuArgs,
  )
})

ipcMain.handle('video:concatenate', async (event, request: ConcatRequest) => {
  if (!Array.isArray(request.sourcePaths) || request.sourcePaths.length < 2 || request.sourcePaths.length > 100) {
    throw new Error('連結する動画を2本以上100本以下で指定してください。')
  }
  const sources = request.sourcePaths.map(assertAllowed)
  const inputs = sources.map((source) => ({ path: source, metadata: registeredMetadata(source) }))
  const output = await chooseOutput(defaultOutputPath(sources[0], '-concatenated'), [
    { name: 'MP4動画', extensions: ['mp4'] },
  ])
  if (!output) return { cancelled: true }
  if (sources.includes(path.resolve(output))) throw new Error('入力動画とは別のファイル名を指定してください。')
  const totalDuration = inputs.reduce((sum, input) => sum + input.metadata.duration, 0)
  const encoder = await resolveEncoding(request.encoder)
  const quality = resolveQuality(request.quality)
  const cpuArgs = encoder === 'cpu' ? undefined : concatenateArgs(inputs, output, 'cpu', quality)
  return executeJob(
    request.jobId,
    concatenateArgs(inputs, output, encoder, quality),
    totalDuration,
    event.sender,
    output,
    cpuArgs,
  )
})

ipcMain.handle('video:cancel', (_event, jobId: string) => cancelJob(jobId))
ipcMain.handle('settings:get-output-directory', () => outputDirectory)
ipcMain.handle('settings:choose-output-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'ファイル保存先を選択',
    defaultPath: outputDirectory || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  outputDirectory = path.resolve(result.filePaths[0])
  await saveSettings()
  return outputDirectory
})
ipcMain.handle('settings:clear-output-directory', async () => {
  outputDirectory = ''
  await saveSettings()
})
ipcMain.handle('settings:get-encoding-capabilities', async () => ({ available: await detectVideoEncoders() }))
