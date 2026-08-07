import type { VideoPlayApi } from '../shared/types'

declare global {
  interface Window {
    videoPlay: VideoPlayApi
  }
}

export {}
