import { useEffect, useRef, useState } from 'react'
import type { EncodingPreference, EncodingQuality, OperationProgress, RegisteredVideo } from '../shared/types'
import { formatTime, readableError } from './utils'

type QueueStatus = 'processing' | 'ready' | 'error'

interface QueueItem {
  id: string
  name: string
  size: number
  status: QueueStatus
  video?: RegisteredVideo
  thumbnailUrl?: string
  error?: string
}

interface ConcatPanelProps {
  hidden: boolean
  encodingPreference: EncodingPreference
  encodingQuality: EncodingQuality
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function ConcatPanel({ hidden, encodingPreference, encodingQuality }: ConcatPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const processingChain = useRef(Promise.resolve())
  const thumbnailUrls = useRef(new Set<string>())
  const itemsRef = useRef<QueueItem[]>([])
  const mounted = useRef(true)
  const [items, setItems] = useState<QueueItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<OperationProgress | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const url of thumbnailUrls.current) URL.revokeObjectURL(url)
      thumbnailUrls.current.clear()
    }
  }, [])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => window.videoPlay.onProgress((next) => {
    setProgress((current) => current?.jobId === next.jobId ? next : current)
  }), [])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    const mp4Files = files.filter((file) => file.name.toLowerCase().endsWith('.mp4'))
    if (mp4Files.length !== files.length) setError('MP4以外のファイルは追加できません。')
    if (mp4Files.length === 0) return

    const available = Math.max(0, 100 - itemsRef.current.length)
    const accepted = mp4Files.slice(0, available)
    if (accepted.length < mp4Files.length) setError('連結できる動画は最大100本です。')
    const queued = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      status: 'processing' as const,
      file,
    }))
    setItems((current) => {
      const updated = [...current, ...queued.map(({ file: _file, ...item }) => item)]
      itemsRef.current = updated
      return updated
    })

    processingChain.current = processingChain.current.then(async () => {
      for (const queuedItem of queued) {
        try {
          const registered = await window.videoPlay.registerVideo(queuedItem.file)
          const thumbnailTime = Math.min(0.5, Math.max(0, registered.metadata.duration / 2))
          const [decoded] = await window.videoPlay.decodeFrames(registered.path, [thumbnailTime])
          const bytes = new Uint8Array(decoded.data.byteLength)
          bytes.set(decoded.data)
          const thumbnailUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
          if (!mounted.current) {
            URL.revokeObjectURL(thumbnailUrl)
            return
          }
          if (!itemsRef.current.some((item) => item.id === queuedItem.id)) {
            URL.revokeObjectURL(thumbnailUrl)
            continue
          }
          thumbnailUrls.current.add(thumbnailUrl)
          setItems((current) => current.map((item) => item.id === queuedItem.id
            ? { ...item, status: 'ready', video: registered, thumbnailUrl }
            : item))
        } catch (reason) {
          if (!mounted.current) return
          setItems((current) => current.map((item) => item.id === queuedItem.id
            ? { ...item, status: 'error', error: readableError(reason) }
            : item))
        }
      }
    })
  }

  const removeItem = (id: string) => {
    setItems((current) => {
      const removed = current.find((item) => item.id === id)
      if (removed?.thumbnailUrl) {
        URL.revokeObjectURL(removed.thumbnailUrl)
        thumbnailUrls.current.delete(removed.thumbnailUrl)
      }
      const updated = current.filter((item) => item.id !== id)
      itemsRef.current = updated
      return updated
    })
  }

  const clearItems = () => {
    for (const url of thumbnailUrls.current) URL.revokeObjectURL(url)
    thumbnailUrls.current.clear()
    itemsRef.current = []
    setItems([])
  }

  const concatenate = async () => {
    const videos = items.flatMap((item) => item.video ? [item.video] : [])
    if (videos.length < 2 || videos.length !== items.length) return
    const jobId = crypto.randomUUID()
    setError('')
    setNotice('')
    setProgress({ jobId, progress: 0, message: '動画を連結しています…' })
    try {
      const result = await window.videoPlay.concatenateVideos({
        jobId,
        sourcePaths: videos.map((video) => video.path),
        encoder: encodingPreference,
        quality: encodingQuality,
      })
      if (!result.cancelled && result.outputPath) setNotice(`保存しました: ${result.outputPath}`)
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setProgress(null)
    }
  }

  const ready = items.length >= 2 && items.every((item) => item.status === 'ready')
  const totalDuration = items.reduce((sum, item) => sum + (item.video?.metadata.duration ?? 0), 0)

  return (
    <section className="concat-page" hidden={hidden}>
      <div className="concat-heading">
        <div>
          <h1>動画を連結</h1>
          <p>MP4をドロップした順番で、1本の動画として保存します。</p>
        </div>
        {items.length > 0 && <button className="button" onClick={clearItems} disabled={Boolean(progress)}>すべて削除</button>}
      </div>

      <button
        className={`concat-drop-zone ${dragging ? 'is-dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
        disabled={Boolean(progress)}
      >
        <span className="concat-drop-icon">＋</span>
        <strong>連結するMP4動画をドロップ</strong>
        <span>クリックして複数ファイルを選択することもできます</span>
      </button>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept="video/mp4,.mp4"
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files)
          event.target.value = ''
        }}
      />

      <div className="concat-list" aria-live="polite">
        {items.length === 0 ? (
          <div className="concat-empty">追加した動画のサムネイルがここに表示されます。</div>
        ) : items.map((item, index) => (
          <article className={`concat-item ${item.status}`} key={item.id}>
            <div className="concat-order">{index + 1}</div>
            <div className="concat-thumbnail">
              {item.thumbnailUrl
                ? <img src={item.thumbnailUrl} alt={`${item.name}のサムネイル`} />
                : <span>{item.status === 'error' ? '!' : '解析中…'}</span>}
            </div>
            <div className="concat-item-info">
              <strong title={item.name}>{item.name}</strong>
              {item.video ? (
                <span>
                  {formatTime(item.video.metadata.duration, true)} · {item.video.metadata.width}×{item.video.metadata.height}
                  {' · '}{item.video.metadata.averageFps.toFixed(3)} fps · {fileSize(item.size)}
                </span>
              ) : item.error ? <span className="concat-error">{item.error}</span> : <span>メタデータとサムネイルを準備しています…</span>}
            </div>
            <button className="concat-remove" onClick={() => removeItem(item.id)} disabled={Boolean(progress)} aria-label={`${item.name}を削除`}>×</button>
          </article>
        ))}
      </div>

      <footer className="concat-footer">
        <div>
          <strong>{items.length}本</strong>
          <span>合計 {formatTime(totalDuration, true)}</span>
        </div>
        <button className="button primary concat-action" onClick={() => void concatenate()} disabled={!ready || Boolean(progress)}>
          すべての動画を連結
        </button>
      </footer>

      {(error || notice) && (
        <div className={`toast ${error ? 'error' : ''}`} role="status">
          <span>{error || notice}</span>
          <button onClick={() => { setError(''); setNotice('') }}>×</button>
        </div>
      )}

      {progress && (
        <div className="modal-backdrop">
          <div className="progress-dialog" role="dialog" aria-modal="true" aria-label="連結の進捗">
            <h2>動画を連結</h2>
            <p>{progress.message}</p>
            <progress max="1" value={progress.progress} />
            <div className="progress-value">{Math.round(progress.progress * 100)}%</div>
            <button className="button" onClick={() => void window.videoPlay.cancelJob(progress.jobId)}>キャンセル</button>
          </div>
        </div>
      )}
    </section>
  )
}

export default ConcatPanel
