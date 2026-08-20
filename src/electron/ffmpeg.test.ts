import { describe, expect, it } from 'vitest'
import { concatenateArgs, extractArgs, extractRangeFramesArgs, frameArgs, removeArgs, removeRangesArgs, videoEncodingArgs } from './ffmpeg'
import type { VideoMetadata } from '../shared/types'

const metadata = (overrides: Partial<VideoMetadata> = {}): VideoMetadata => ({
  duration: 2,
  width: 320,
  height: 180,
  fps: 30,
  averageFps: 30,
  isVariableFrameRate: false,
  hasAudio: true,
  codec: 'h264',
  ...overrides,
})

describe('FFmpeg argument construction', () => {
  it('uses a faster balanced CPU profile by default', () => {
    expect(videoEncodingArgs()).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ])
  })

  it('builds hardware encoder profiles', () => {
    expect(videoEncodingArgs('nvenc', 'standard')).toContain('h264_nvenc')
    expect(videoEncodingArgs('qsv', 'fast')).toContain('h264_qsv')
    expect(videoEncodingArgs('amf', 'quality')).toContain('h264_amf')
  })
  it('does not invoke a shell for file paths', () => {
    const args = frameArgs('/tmp/日本語 video.mp4', 1.25, '/tmp/frame.png')
    expect(args).toContain('/tmp/日本語 video.mp4')
    expect(args).toContain('1.250000')
  })

  it('maps audio optionally when extracting', () => {
    expect(extractArgs('in.mp4', 1, 3, true, 'out.mp4')).toContain('0:a:0?')
    expect(extractArgs('in.mp4', 1, 3, false, 'out.mp4')).not.toContain('0:a:0?')
  })

  it('uses all frames when interval is 0 for range frame extraction', () => {
    const args = extractRangeFramesArgs('in.mp4', 1, 3, 'frames/frame-%06d.png', 0)
    expect(args).not.toContain('-vf')
    expect(args).toContain('-frames:v')
    expect(args).toContain('1000')
    expect(args).toContain('-fps_mode')
    expect(args).toContain('passthrough')
  })

  it('applies select filter when frame interval is set', () => {
    const args = extractRangeFramesArgs('in.mp4', 1, 3, 'frames/frame-%06d.png', 3)
    const vfIndex = args.indexOf('-vf')
    expect(vfIndex).toBeGreaterThanOrEqual(0)
    expect(args[vfIndex + 1]).toContain('mod(n\\,3)')
  })

  it('concatenates both sides for a middle removal', () => {
    const args = removeArgs('in.mp4', 2, 4, 10, true, 'out.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(args.filter((argument) => argument === 'in.mp4')).toHaveLength(2)
    expect(args).toContain('4.000000')
    expect(filter).toContain('concat=n=2:v=1:a=1')
    expect(args).toContain('vfr')
  })

  it('keeps and concatenates every gap around multiple removal ranges', () => {
    const args = removeRangesArgs('in.mp4', [
      { start: 2, end: 4 },
      { start: 6, end: 7 },
    ], 10, true, 'out.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(args.filter((argument) => argument === 'in.mp4')).toHaveLength(3)
    expect(filter).toContain('concat=n=3:v=1:a=1')
    expect(filter).toContain('[0:v:0]setpts=PTS-STARTPTS[v0]')
    expect(filter).toContain('[2:a:0]asetpts=PTS-STARTPTS[a2]')
  })

  it('uses a single extraction when removing from the beginning', () => {
    const args = removeArgs('in.mp4', 0, 4, 10, false, 'out.mp4')
    expect(args).toEqual(extractArgs('in.mp4', 4, 10, false, 'out.mp4'))
  })

  it('normalizes and concatenates videos with and without audio', () => {
    const args = concatenateArgs([
      { path: 'first.mp4', metadata: metadata() },
      { path: 'second.mp4', metadata: metadata({ width: 640, height: 480, hasAudio: false }) },
    ], 'joined.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(args.slice(0, 4)).toEqual(['-i', 'first.mp4', '-i', 'second.mp4'])
    expect(filter).toContain('scale=320:180')
    expect(filter).toContain('anullsrc=r=48000:cl=stereo')
    expect(filter).toContain('concat=n=2:v=1:a=1')
    expect(args[args.indexOf('-r') + 1]).toBe('30.000000')
  })
})
