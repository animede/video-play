export function formatTime(seconds: number, precise = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const wholeSeconds = Math.floor(seconds % 60)
  const milliseconds = Math.floor((seconds % 1) * 1000)
  const base = hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${wholeSeconds.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${wholeSeconds.toString().padStart(2, '0')}`
  return precise ? `${base}.${milliseconds.toString().padStart(3, '0')}` : base
}

export function findFrameIndex(timestamps: number[], time: number): number {
  if (timestamps.length === 0) return -1
  let low = 0
  let high = timestamps.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (timestamps[middle] <= time + 0.0005) low = middle + 1
    else high = middle - 1
  }
  return Math.max(0, Math.min(high, timestamps.length - 1))
}

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}
