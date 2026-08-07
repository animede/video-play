export interface VideoMetadata {
  duration: number
  width: number
  height: number
  fps: number
  averageFps: number
  isVariableFrameRate: boolean
  hasAudio: boolean
  codec: string
}

export interface RegisteredVideo {
  path: string
  name: string
  metadata: VideoMetadata
}

export interface FrameWindow {
  start: number
  end: number
  timestamps: number[]
}

export interface DecodedFrame {
  time: number
  data: Uint8Array
}

export interface OperationProgress {
  jobId: string
  progress: number
  message: string
}

export interface OperationResult {
  cancelled?: boolean
  outputPath?: string
}

export interface EditRequest {
  jobId: string
  sourcePath: string
  start: number
  end: number
}

export interface FrameRequest {
  jobId: string
  sourcePath: string
  time: number
}

export interface VideoPlayApi {
  registerVideo(file: File): Promise<RegisteredVideo>
  getFrameWindow(sourcePath: string, time: number): Promise<FrameWindow>
  decodeFrames(sourcePath: string, times: number[]): Promise<DecodedFrame[]>
  saveFrame(request: FrameRequest): Promise<OperationResult>
  extractRange(request: EditRequest): Promise<OperationResult>
  removeRange(request: EditRequest): Promise<OperationResult>
  cancelJob(jobId: string): Promise<void>
  onProgress(callback: (progress: OperationProgress) => void): () => void
}
