import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ConcatRequest, EditRequest, FrameRequest, OperationProgress, RangeFramesRequest, RemoveRangesRequest, VideoPlayApi } from '../shared/types'

const api: VideoPlayApi = {
  registerVideo(file: File) {
    return ipcRenderer.invoke('video:register', webUtils.getPathForFile(file))
  },
  getFrameWindow(sourcePath: string, time: number) {
    return ipcRenderer.invoke('video:frame-window', sourcePath, time)
  },
  decodeFrames(sourcePath: string, times: number[]) {
    return ipcRenderer.invoke('video:decode-frames', sourcePath, times)
  },
  saveFrame(request: FrameRequest) {
    return ipcRenderer.invoke('video:save-frame', request)
  },
  extractRangeFrames(request: RangeFramesRequest) {
    return ipcRenderer.invoke('video:extract-range-frames', request)
  },
  extractRange(request: EditRequest) {
    return ipcRenderer.invoke('video:extract', request)
  },
  removeRanges(request: RemoveRangesRequest) {
    return ipcRenderer.invoke('video:remove', request)
  },
  concatenateVideos(request: ConcatRequest) {
    return ipcRenderer.invoke('video:concatenate', request)
  },
  getOutputDirectory() {
    return ipcRenderer.invoke('settings:get-output-directory')
  },
  chooseOutputDirectory() {
    return ipcRenderer.invoke('settings:choose-output-directory')
  },
  clearOutputDirectory() {
    return ipcRenderer.invoke('settings:clear-output-directory')
  },
  getFrameInterval() {
    return ipcRenderer.invoke('settings:get-frame-interval')
  },
  setFrameInterval(value: number) {
    return ipcRenderer.invoke('settings:set-frame-interval', value)
  },
  getEncodingCapabilities() {
    return ipcRenderer.invoke('settings:get-encoding-capabilities')
  },
  cancelJob(jobId: string) {
    return ipcRenderer.invoke('video:cancel', jobId)
  },
  onProgress(callback: (progress: OperationProgress) => void) {
    const listener = (_event: Electron.IpcRendererEvent, progress: OperationProgress) => callback(progress)
    ipcRenderer.on('video:progress', listener)
    return () => ipcRenderer.removeListener('video:progress', listener)
  },
}

contextBridge.exposeInMainWorld('videoPlay', api)
