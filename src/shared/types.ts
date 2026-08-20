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

export type VideoEncoder = 'cpu' | 'nvenc' | 'qsv' | 'amf'
export type EncodingPreference = 'auto' | VideoEncoder
export type EncodingQuality = 'fast' | 'standard' | 'quality'

export interface EncodingOptions {
  encoder?: EncodingPreference
  quality?: EncodingQuality
}

export interface EncodingCapabilities {
  available: VideoEncoder[]
}

export interface EditRequest extends EncodingOptions {
  jobId: string
  sourcePath: string
  start: number
  end: number
}

export interface TimeRange {
  start: number
  end: number
}

export interface RemoveRangesRequest extends EncodingOptions {
  jobId: string
  sourcePath: string
  ranges: TimeRange[]
}

export interface FrameRequest {
  jobId: string
  sourcePath: string
  time: number
}

export interface RangeFramesRequest {
  jobId: string
  sourcePath: string
  start: number
  end: number
}

export interface ConcatRequest extends EncodingOptions {
  jobId: string
  sourcePaths: string[]
}

export interface VideoPlayApi {
  registerVideo(file: File): Promise<RegisteredVideo>
  getFrameWindow(sourcePath: string, time: number): Promise<FrameWindow>
  decodeFrames(sourcePath: string, times: number[]): Promise<DecodedFrame[]>
  saveFrame(request: FrameRequest): Promise<OperationResult>
  extractRangeFrames(request: RangeFramesRequest): Promise<OperationResult>
  extractRange(request: EditRequest): Promise<OperationResult>
  removeRanges(request: RemoveRangesRequest): Promise<OperationResult>
  concatenateVideos(request: ConcatRequest): Promise<OperationResult>
  getOutputDirectory(): Promise<string>
  chooseOutputDirectory(): Promise<string | null>
  clearOutputDirectory(): Promise<void>
  getFrameInterval(): Promise<number>
  setFrameInterval(value: number): Promise<number>
  getEncodingCapabilities(): Promise<EncodingCapabilities>
  cancelJob(jobId: string): Promise<void>
  onProgress(callback: (progress: OperationProgress) => void): () => void
}
