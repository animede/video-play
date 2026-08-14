import { useCallback, useEffect, useRef, useState } from 'react'
import type { EncodingPreference, EncodingQuality, FrameWindow, OperationProgress, RegisteredVideo, TimeRange, VideoEncoder } from '../shared/types'
import ConcatPanel from './ConcatPanel'
import { formatTime, readableError } from './utils'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]
const FRAME_WINDOW_SECONDS = 30
const MAX_RENDERER_WINDOWS = 3
const MAX_FRAME_IMAGE_CACHE = 12
const PREFETCH_RADIUS = 2

interface ActiveJob extends OperationProgress {
  kind: 'frame' | 'extract' | 'remove'
}

interface ExactFrame {
  url: string
  time: number
}

interface TimelinePreview extends ExactFrame {
  x: number
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const loadSequence = useRef(0)
  const frameWindowsRef = useRef<FrameWindow[]>([])
  const inflightFrameWindows = useRef(new Set<string>())
  const frameDecodeSequence = useRef(0)
  const frameImageCache = useRef(new Map<string, ExactFrame>())
  const [video, setVideo] = useState<RegisteredVideo | null>(null)
  const [activeTab, setActiveTab] = useState<'player' | 'concat'>('player')
  const [videoUrl, setVideoUrl] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(0)
  const [frameWindows, setFrameWindows] = useState<FrameWindow[]>([])
  const [indexingCount, setIndexingCount] = useState(0)
  const [frameDecoding, setFrameDecoding] = useState(false)
  const [exactFrame, setExactFrame] = useState<ExactFrame | null>(null)
  const [dragging, setDragging] = useState(false)
  const [job, setJob] = useState<ActiveJob | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rangeZoom, setRangeZoom] = useState(false)
  const [timelinePreview, setTimelinePreview] = useState<TimelinePreview | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [outputDirectory, setOutputDirectory] = useState('')
  const [removalRanges, setRemovalRanges] = useState<TimeRange[]>([])
  const [encodingPreference, setEncodingPreference] = useState<EncodingPreference>(() =>
    (localStorage.getItem('encodingPreference') as EncodingPreference | null) ?? 'auto')
  const [encodingQuality, setEncodingQuality] = useState<EncodingQuality>(() =>
    (localStorage.getItem('encodingQuality') as EncodingQuality | null) ?? 'standard')
  const [availableEncoders, setAvailableEncoders] = useState<VideoEncoder[]>(['cpu'])
  const previewSequence = useRef(0)
  const previewTimeout = useRef<number | null>(null)

  const duration = video?.metadata.duration ?? 0
  const selectionValid = Boolean(video && outPoint - inPoint >= 0.001)
  const indexing = indexingCount > 0

  useEffect(() => window.videoPlay.onProgress((progress) => {
    setJob((current) => current?.jobId === progress.jobId ? { ...current, ...progress } : current)
  }), [])

  useEffect(() => { void window.videoPlay.getOutputDirectory().then(setOutputDirectory) }, [])
  useEffect(() => {
    void window.videoPlay.getEncodingCapabilities().then(({ available }) => {
      setAvailableEncoders(available)
      if (encodingPreference !== 'auto' && !available.includes(encodingPreference)) {
        setEncodingPreference('auto')
        localStorage.setItem('encodingPreference', 'auto')
      }
    })
  }, [])

  useEffect(() => () => {
    if (previewTimeout.current !== null) window.clearTimeout(previewTimeout.current)
    if (timelinePreview) URL.revokeObjectURL(timelinePreview.url)
  }, [timelinePreview])

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl)
  }, [videoUrl])

  useEffect(() => () => {
    for (const frame of frameImageCache.current.values()) URL.revokeObjectURL(frame.url)
    frameImageCache.current.clear()
  }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const clearExactFrame = useCallback(() => {
    frameDecodeSequence.current += 1
    setExactFrame(null)
    setFrameDecoding(false)
  }, [])

  const clearFrameImageCache = useCallback(() => {
    for (const frame of frameImageCache.current.values()) URL.revokeObjectURL(frame.url)
    frameImageCache.current.clear()
    setExactFrame(null)
  }, [])

  const ensureFrameWindow = useCallback(async (
    sourcePath: string,
    time: number,
    sequence: number,
  ): Promise<FrameWindow | undefined> => {
    const safeTime = Math.max(0, time)
    const windowStart = Math.floor(safeTime / FRAME_WINDOW_SECONDS) * FRAME_WINDOW_SECONDS
    const existing = frameWindowsRef.current.find((window) => window.start === windowStart)
    if (existing) return existing
    const requestKey = `${sequence}:${windowStart}`
    if (inflightFrameWindows.current.has(requestKey)) {
      // Another request is already decoding this short window. Wait for it rather
      // than falling back to an estimated frame position.
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 20))
        const loaded = frameWindowsRef.current.find((window) => window.start === windowStart)
        if (loaded) return loaded
        if (!inflightFrameWindows.current.has(requestKey) || sequence !== loadSequence.current) return undefined
      }
      return undefined
    }
    inflightFrameWindows.current.add(requestKey)
    setIndexingCount((count) => count + 1)
    try {
      const frameWindow = await window.videoPlay.getFrameWindow(sourcePath, safeTime)
      if (sequence !== loadSequence.current) return undefined
      const updated = [...frameWindowsRef.current.filter((window) => window.start !== frameWindow.start), frameWindow]
        .slice(-MAX_RENDERER_WINDOWS)
      frameWindowsRef.current = updated
      setFrameWindows(updated)
      return frameWindow
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setNotice(`周辺フレームの解析を省略しました: ${readableError(reason)}`)
      }
    } finally {
      inflightFrameWindows.current.delete(requestKey)
      if (sequence === loadSequence.current) setIndexingCount((count) => Math.max(0, count - 1))
    }
  }, [])

  const warmFrameWindows = useCallback((sourcePath: string, time: number, videoDuration: number, sequence: number) => {
    const safeTime = Math.max(0, Math.min(time, Math.max(0, videoDuration - 0.001)))
    void ensureFrameWindow(sourcePath, safeTime, sequence)
    const offset = safeTime % FRAME_WINDOW_SECONDS
    if (offset >= FRAME_WINDOW_SECONDS - 5 && safeTime + 6 < videoDuration) {
      void ensureFrameWindow(sourcePath, safeTime + 6, sequence)
    }
    if (offset <= 5 && safeTime >= 6) {
      void ensureFrameWindow(sourcePath, safeTime - 6, sequence)
    }
  }, [ensureFrameWindow])

  const openFile = useCallback(async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.mp4')) {
      setError('MP4ファイルを選択してください。')
      return
    }
    const sequence = ++loadSequence.current
    clearExactFrame()
    clearFrameImageCache()
    setError('')
    setNotice('動画を読み込んでいます…')
    setPlaying(false)
    try {
      const registered = await window.videoPlay.registerVideo(file)
      if (sequence !== loadSequence.current) return
      const url = URL.createObjectURL(file)
      setVideoUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return url
      })
      setVideo(registered)
      setCurrentTime(0)
      setInPoint(0)
      setOutPoint(registered.metadata.duration)
      setRangeZoom(false)
      setRemovalRanges([])
      frameWindowsRef.current = []
      inflightFrameWindows.current.clear()
      setFrameWindows([])
      setIndexingCount(0)
      setNotice('動画を開きました。')
      warmFrameWindows(registered.path, 0, registered.metadata.duration, sequence)
    } catch (reason) {
      setNotice('')
      setError(readableError(reason))
    }
  }, [clearExactFrame, clearFrameImageCache, warmFrameWindows])

  const togglePlay = useCallback(() => {
    const element = videoRef.current
    if (!element) return
    if (element.paused) {
      clearExactFrame()
      void element.play()
    }
    else element.pause()
  }, [clearExactFrame])

  const seek = useCallback((time: number, preserveExactFrame = false) => {
    const element = videoRef.current
    if (!element || !video) return
    if (!preserveExactFrame) clearExactFrame()
    const next = Math.max(0, Math.min(time, duration))
    element.currentTime = next
    setCurrentTime(next)
    warmFrameWindows(video.path, next, duration, loadSequence.current)
  }, [clearExactFrame, duration, video, warmFrameWindows])

  const stepFrame = useCallback(async (direction: -1 | 1) => {
    const element = videoRef.current
    if (!element || !video || frameDecoding) return
    element.pause()
    const time = element.currentTime
    const epsilon = 0.0005
    const sequence = loadSequence.current
    const decodeSequence = ++frameDecodeSequence.current
    setFrameDecoding(true)
    setError('')
    try {
      const currentWindow = await ensureFrameWindow(video.path, time, sequence)
      if (!currentWindow || sequence !== loadSequence.current) throw new Error('現在位置のフレームを解析できません。')
      const searchWindows = [currentWindow]
      const findTarget = (): number | undefined => {
        const timestamps = searchWindows.flatMap((window) => window.timestamps).sort((a, b) => a - b)
        if (direction > 0) return timestamps.find((timestamp) => timestamp > time + epsilon)
        for (let index = timestamps.length - 1; index >= 0; index -= 1) {
          if (timestamps[index] < time - epsilon) return timestamps[index]
        }
        return undefined
      }

      let target = findTarget()
      if (target === undefined) {
        const adjacentTime = direction > 0 ? currentWindow.end + epsilon : currentWindow.start - epsilon
        if (adjacentTime >= 0 && adjacentTime < duration) {
          const adjacentWindow = await ensureFrameWindow(video.path, adjacentTime, sequence)
          if (adjacentWindow) searchWindows.push(adjacentWindow)
          target = findTarget()
        }
      }
      if (target === undefined) {
        setNotice(direction > 0 ? '最後のフレームです。' : '最初のフレームです。')
        return
      }

      const targetKey = target.toFixed(6)
      const cached = frameImageCache.current.get(targetKey)
      if (cached) {
        frameImageCache.current.delete(targetKey)
        frameImageCache.current.set(targetKey, cached)
        seek(target, true)
        setExactFrame(cached)
        return
      }

      const adjacentWindows = frameWindowsRef.current.filter(
        (window) => Math.abs(window.start - currentWindow.start) <= FRAME_WINDOW_SECONDS,
      )
      for (const window of searchWindows) {
        if (!adjacentWindows.some((candidate) => candidate.start === window.start)) adjacentWindows.push(window)
      }
      const availableTimes = [...new Set(adjacentWindows.flatMap((window) => window.timestamps))].sort((a, b) => a - b)
      const targetIndex = availableTimes.findIndex((timestamp) => Math.abs(timestamp - target!) < 0.000001)
      const batchTimes = targetIndex >= 0
        ? availableTimes.slice(Math.max(0, targetIndex - PREFETCH_RADIUS), targetIndex + PREFETCH_RADIUS + 1)
        : [target]
      const decodedFrames = await window.videoPlay.decodeFrames(video.path, batchTimes)
      if (decodeSequence !== frameDecodeSequence.current || sequence !== loadSequence.current) return

      for (const decoded of decodedFrames) {
        const bytes = new Uint8Array(decoded.data.byteLength)
        bytes.set(decoded.data)
        const frame: ExactFrame = {
          time: decoded.time,
          url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
        }
        const key = decoded.time.toFixed(6)
        const previous = frameImageCache.current.get(key)
        if (previous) URL.revokeObjectURL(previous.url)
        frameImageCache.current.delete(key)
        frameImageCache.current.set(key, frame)
      }
      while (frameImageCache.current.size > MAX_FRAME_IMAGE_CACHE) {
        const oldestKey = frameImageCache.current.keys().next().value as string | undefined
        if (!oldestKey) break
        const oldest = frameImageCache.current.get(oldestKey)
        if (oldest) URL.revokeObjectURL(oldest.url)
        frameImageCache.current.delete(oldestKey)
      }
      const decodedTarget = frameImageCache.current.get(targetKey)
      if (!decodedTarget) throw new Error('対象フレームをデコードできませんでした。')
      seek(target, true)
      setExactFrame(decodedTarget)
    } catch (reason) {
      if (decodeSequence === frameDecodeSequence.current) setError(readableError(reason))
    } finally {
      if (decodeSequence === frameDecodeSequence.current) setFrameDecoding(false)
    }
  }, [duration, ensureFrameWindow, frameDecoding, seek, video])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!video || job || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlay()
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault()
        void stepFrame(-1)
      } else if (event.code === 'ArrowRight') {
        event.preventDefault()
        void stepFrame(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [job, stepFrame, togglePlay, video])

  const runOperation = async (kind: ActiveJob['kind']) => {
    if (!video) return
    videoRef.current?.pause()
    setError('')
    setNotice('')
    const jobId = crypto.randomUUID()
    const labels = { frame: '静止画を保存', extract: '区間を抽出', remove: '区間を削除' }
    setJob({ jobId, kind, progress: 0, message: `${labels[kind]}しています…` })
    try {
      const result = kind === 'frame'
        ? await window.videoPlay.saveFrame({ jobId, sourcePath: video.path, time: currentTime })
        : kind === 'extract'
          ? await window.videoPlay.extractRange({ jobId, sourcePath: video.path, start: inPoint, end: outPoint, encoder: encodingPreference, quality: encodingQuality })
          : await window.videoPlay.removeRanges({ jobId, sourcePath: video.path, ranges: removalRanges, encoder: encodingPreference, quality: encodingQuality })
      if (!result.cancelled && result.outputPath) setNotice(`保存しました: ${result.outputPath}`)
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setJob(null)
    }
  }

  const changeSpeed = (next: number) => {
    setSpeed(next)
    if (videoRef.current) videoRef.current.playbackRate = next
  }

  const jump = (seconds: number) => seek(currentTime + seconds)

  const previewTimeline = (event: React.MouseEvent<HTMLInputElement>) => {
    if (!video) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const min = rangeZoom ? inPoint : 0
    const max = rangeZoom ? outPoint : duration
    const time = min + ratio * (max - min)
    const x = event.clientX - rect.left
    if (previewTimeout.current !== null) window.clearTimeout(previewTimeout.current)
    const sequence = ++previewSequence.current
    previewTimeout.current = window.setTimeout(async () => {
      try {
        const [decoded] = await window.videoPlay.decodeFrames(video.path, [time])
        if (!decoded || sequence !== previewSequence.current) return
        const bytes = new Uint8Array(decoded.data.byteLength)
        bytes.set(decoded.data)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
        setTimelinePreview((previous) => {
          if (previous) URL.revokeObjectURL(previous.url)
          return { url, time, x }
        })
      } catch { /* Preview failures should not interrupt playback. */ }
    }, 120)
  }

  const hideTimelinePreview = () => {
    previewSequence.current += 1
    if (previewTimeout.current !== null) window.clearTimeout(previewTimeout.current)
    previewTimeout.current = null
    setTimelinePreview((previous) => {
      if (previous) URL.revokeObjectURL(previous.url)
      return null
    })
  }

  const addRemovalRange = () => {
    if (!selectionValid) return
    const sorted = [...removalRanges, { start: inPoint, end: outPoint }].sort((left, right) => left.start - right.start)
    const merged: TimeRange[] = []
    for (const range of sorted) {
      const previous = merged.at(-1)
      if (previous && range.start <= previous.end + 0.001) previous.end = Math.max(previous.end, range.end)
      else merged.push({ ...range })
    }
    setRemovalRanges(merged)
    setNotice(merged.length < sorted.length ? '重複または隣接する削除区間を統合しました。' : '削除区間へ追加しました。')
  }

  const estimatedFrameIndex = Math.floor(currentTime * (video?.metadata.averageFps ?? 0))
  const indexedFrameCount = frameWindows.reduce((count, window) => count + window.timestamps.length, 0)
  const selectionLeft = duration ? inPoint / duration * 100 : 0
  const selectionWidth = duration ? (outPoint - inPoint) / duration * 100 : 0
  const timelineMin = rangeZoom ? inPoint : 0
  const timelineMax = rangeZoom ? outPoint : (duration || 1)
  const removedDuration = removalRanges.reduce((sum, range) => sum + range.end - range.start, 0)

  const switchTab = (tab: 'player' | 'concat') => {
    if (tab === 'concat') videoRef.current?.pause()
    setActiveTab(tab)
  }

  return (
    <main
      className={`app ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => { if (activeTab === 'player') { event.preventDefault(); setDragging(true) } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
      onDrop={(event) => {
        if (activeTab !== 'player') return
        event.preventDefault()
        setDragging(false)
        void openFile(event.dataTransfer.files[0])
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▶</span>
          <span>Video-player</span>
        </div>
        <nav className="app-tabs" aria-label="機能">
          <button className={activeTab === 'player' ? 'active' : ''} onClick={() => switchTab('player')} aria-selected={activeTab === 'player'}>再生・編集</button>
          <button className={activeTab === 'concat' ? 'active' : ''} onClick={() => switchTab('concat')} aria-selected={activeTab === 'concat'}>動画連結</button>
        </nav>
        <div className="file-title" title={activeTab === 'player' ? video?.path : undefined}>
          {activeTab === 'player' ? video?.name : 'ドロップ順にMP4を連結'}
        </div>
        {activeTab === 'player' && <button className="button primary" onClick={() => inputRef.current?.click()} disabled={Boolean(job)}>
          動画を開く
        </button>}
        <button className="button" onClick={() => setSettingsOpen(true)}>設定</button>
        <input ref={inputRef} className="hidden" type="file" accept="video/mp4,.mp4" onChange={(e) => {
          void openFile(e.target.files?.[0])
          e.target.value = ''
        }} />
      </header>

      <div className="tab-page player-page" hidden={activeTab !== 'player'}>
        <section className="viewer-shell">
        {videoUrl ? (
          <div className="media-stage">
            <video
              ref={videoRef}
              className="video"
              src={videoUrl}
              onClick={togglePlay}
              onTimeUpdate={(event) => {
                const time = event.currentTarget.currentTime
                setCurrentTime(time)
                if (video) warmFrameWindows(video.path, time, duration, loadSequence.current)
              }}
              onPlay={() => { clearExactFrame(); setPlaying(true) }}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setError('動画を再生できません。対応するMP4コーデックか確認してください。')}
            />
            {exactFrame && <img className="exact-frame" src={exactFrame.url} alt={`PTS ${exactFrame.time.toFixed(6)} 秒のフレーム`} onClick={togglePlay} />}
            {frameDecoding && <div className="frame-decoding">FFmpegでフレームをデコード中…</div>}
          </div>
        ) : (
          <button className="empty-state" onClick={() => inputRef.current?.click()}>
            <span className="empty-icon">＋</span>
            <strong>MP4動画を開く</strong>
            <span>ここにファイルをドラッグ＆ドロップできます</span>
          </button>
        )}
        {dragging && <div className="drop-overlay">MP4ファイルをドロップ</div>}
        </section>

        <section className="control-panel" aria-disabled={!video}>
        <div className="timeline-wrap">
          {timelinePreview && (
            <div className="timeline-preview" style={{ left: `${timelinePreview.x}px` }}>
              <img src={timelinePreview.url} alt="タイムラインのプレビュー" />
              <span>{formatTime(timelinePreview.time, true)}</span>
            </div>
          )}
          <div className="selection-track" aria-hidden="true">
            <span style={{ left: `${rangeZoom ? 0 : selectionLeft}%`, width: `${rangeZoom ? 100 : selectionWidth}%` }} />
          </div>
          <div className="removal-track" aria-hidden="true">
            {removalRanges.map((range) => {
              const visibleStart = Math.max(range.start, timelineMin)
              const visibleEnd = Math.min(range.end, timelineMax)
              if (visibleEnd <= visibleStart) return null
              return <span key={`${range.start}-${range.end}`} style={{
                left: `${(visibleStart - timelineMin) / (timelineMax - timelineMin) * 100}%`,
                width: `${(visibleEnd - visibleStart) / (timelineMax - timelineMin) * 100}%`,
              }} />
            })}
          </div>
          <input
            className="timeline"
            type="range"
            min={timelineMin}
            max={timelineMax}
            step="any"
            value={currentTime}
            onChange={(event) => seek(Number(event.target.value))}
            onMouseMove={previewTimeline}
            onMouseLeave={hideTimelinePreview}
            disabled={!video}
            aria-label="再生位置"
          />
          <div className="time-row">
            <span>{formatTime(currentTime, true)} / {formatTime(duration, true)}</span>
            <span className="frame-status">
              {video && `推定フレーム ${Math.max(0, estimatedFrameIndex)}`}
              {frameDecoding && ' · FFmpegデコード中…'}
              {!frameDecoding && exactFrame && ` · 正確なPTS ${formatTime(exactFrame.time, true)}`}
              {!frameDecoding && !exactFrame && indexing && ' · 周辺フレームを解析中…'}
              {!frameDecoding && !exactFrame && !indexing && indexedFrameCount > 0 && ` · 周辺${indexedFrameCount}フレーム解析済み`}
            </span>
          </div>
        </div>

        <div className="transport">
          <button className="jump-button" onClick={() => jump(-60)} disabled={!video || Boolean(job)} title="1分戻る">−1分</button>
          <button className="jump-button" onClick={() => jump(-10)} disabled={!video || Boolean(job)} title="10秒戻る">−10秒</button>
          <button className="icon-button" onClick={() => void stepFrame(-1)} disabled={!video || Boolean(job) || frameDecoding} title="前のフレーム (←)">|◀</button>
          <button className="play-button" onClick={togglePlay} disabled={!video || Boolean(job)} title="再生・一時停止 (Space)">
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <button className="icon-button" onClick={() => void stepFrame(1)} disabled={!video || Boolean(job) || frameDecoding} title="次のフレーム (→)">▶|</button>
          <button className="jump-button" onClick={() => jump(10)} disabled={!video || Boolean(job)} title="10秒進む">+10秒</button>
          <button className="jump-button" onClick={() => jump(60)} disabled={!video || Boolean(job)} title="1分進む">+1分</button>
          <label className="speed-control">
            <span>速度</span>
            <select value={speed} onChange={(event) => changeSpeed(Number(event.target.value))} disabled={!video || Boolean(job)}>
              {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
          {video && (
            <span className="media-info">
              {video.metadata.width}×{video.metadata.height} · {video.metadata.averageFps.toFixed(3)} fps · {video.metadata.codec}
              {video.metadata.isVariableFrameRate && ' · VFR'}
            </span>
          )}
        </div>

        <div className="edit-row">
          <div className="point-group">
            <button className="button marker" onClick={() => setInPoint(currentTime)} disabled={!video || Boolean(job)}>IN点に設定</button>
            <button className="time-chip" onClick={() => seek(inPoint)} disabled={!video}>{formatTime(inPoint, true)}</button>
          </div>
          <span className="range-arrow">→</span>
          <div className="point-group">
            <button className="button marker" onClick={() => setOutPoint(currentTime)} disabled={!video || Boolean(job)}>OUT点に設定</button>
            <button className="time-chip" onClick={() => seek(outPoint)} disabled={!video}>{formatTime(outPoint, true)}</button>
          </div>
          <span className="range-duration">選択: {formatTime(Math.max(0, outPoint - inPoint), true)}</span>
          <button
            className={`button ${rangeZoom ? 'active-toggle' : ''}`}
            onClick={() => { setRangeZoom((value) => !value); if (!rangeZoom && (currentTime < inPoint || currentTime > outPoint)) seek(inPoint) }}
            disabled={!selectionValid || Boolean(job)}
          >{rangeZoom ? '全体表示に戻す' : '選択区間を拡大表示'}</button>
          <button className="button danger" onClick={addRemovalRange} disabled={!selectionValid || Boolean(job)}>削除区間へ追加</button>
          <div className="edit-actions">
            <button className="button" onClick={() => void runOperation('frame')} disabled={!video || Boolean(job)}>静止画を保存</button>
            <button className="button" onClick={() => void runOperation('extract')} disabled={!selectionValid || Boolean(job)}>区間を抽出</button>
          </div>
        </div>
        {removalRanges.length > 0 && (
          <div className="removal-panel">
            <div className="removal-heading">
              <strong>削除する区間</strong>
              <span>{removalRanges.length}件 · 合計 {formatTime(removedDuration, true)} · 出力 {formatTime(Math.max(0, duration - removedDuration), true)}</span>
              <button className="button" onClick={() => setRemovalRanges([])} disabled={Boolean(job)}>すべて解除</button>
              <button className="button danger" onClick={() => void runOperation('remove')} disabled={Boolean(job)}>指定区間を一括削除</button>
            </div>
            <div className="removal-list">
              {removalRanges.map((range, index) => (
                <div className="removal-item" key={`${range.start}-${range.end}`}>
                  <button onClick={() => seek(range.start)} title="区間の先頭へ移動">{index + 1}. {formatTime(range.start, true)} → {formatTime(range.end, true)}</button>
                  <span>{formatTime(range.end - range.start, true)}</span>
                  <button className="remove-range" onClick={() => setRemovalRanges((current) => current.filter((_item, itemIndex) => itemIndex !== index))} aria-label={`${index + 1}番目の削除区間を解除`}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        </section>
      </div>

      <ConcatPanel hidden={activeTab !== 'concat'} encodingPreference={encodingPreference} encodingQuality={encodingQuality} />

      {(error || notice) && (
        <div className={`toast ${error ? 'error' : ''}`} role="status">
          <span>{error || notice}</span>
          <button onClick={() => { setError(''); setNotice('') }}>×</button>
        </div>
      )}

      {job && (
        <div className="modal-backdrop">
          <div className="progress-dialog" role="dialog" aria-modal="true" aria-label="処理の進捗">
            <h2>{job.kind === 'frame' ? '静止画を保存' : job.kind === 'extract' ? '区間を抽出' : '区間を削除'}</h2>
            <p>{job.message}</p>
            <progress max="1" value={job.progress} />
            <div className="progress-value">{Math.round(job.progress * 100)}%</div>
            <button className="button" onClick={() => void window.videoPlay.cancelJob(job.jobId)}>キャンセル</button>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false) }}>
          <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="設定">
            <h2>設定</h2>
            <label>ファイル保存先</label>
            <div className="directory-value" title={outputDirectory}>{outputDirectory || '保存時に毎回選択'}</div>
            <div className="settings-actions">
              <button className="button" onClick={async () => { const value = await window.videoPlay.chooseOutputDirectory(); if (value) setOutputDirectory(value) }}>フォルダーを選択</button>
              <button className="button" disabled={!outputDirectory} onClick={async () => { await window.videoPlay.clearOutputDirectory(); setOutputDirectory('') }}>毎回選択に戻す</button>
            </div>
            <div className="encoding-settings">
              <label>
                <span>エンコード方式</span>
                <select value={encodingPreference} onChange={(event) => {
                  const value = event.target.value as EncodingPreference
                  setEncodingPreference(value)
                  localStorage.setItem('encodingPreference', value)
                }}>
                  <option value="auto">自動（GPU優先）</option>
                  <option value="cpu">CPU（libx264）</option>
                  {availableEncoders.includes('nvenc') && <option value="nvenc">NVIDIA NVENC</option>}
                  {availableEncoders.includes('qsv') && <option value="qsv">Intel Quick Sync</option>}
                  {availableEncoders.includes('amf') && <option value="amf">AMD AMF</option>}
                </select>
              </label>
              <label>
                <span>品質</span>
                <select value={encodingQuality} onChange={(event) => {
                  const value = event.target.value as EncodingQuality
                  setEncodingQuality(value)
                  localStorage.setItem('encodingQuality', value)
                }}>
                  <option value="fast">高速</option>
                  <option value="standard">標準（推奨）</option>
                  <option value="quality">高画質</option>
                </select>
              </label>
              <p>利用可能: {availableEncoders.map((encoder) => ({ cpu: 'CPU', nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF' })[encoder]).join(' / ')}</p>
            </div>
            <div className="settings-actions"><button className="button primary" onClick={() => setSettingsOpen(false)}>閉じる</button></div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
