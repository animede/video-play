import { describe, expect, it } from 'vitest'
import { extractArgs, frameArgs, removeArgs } from './ffmpeg'

describe('FFmpeg argument construction', () => {
  it('does not invoke a shell for file paths', () => {
    const args = frameArgs('/tmp/日本語 video.mp4', 1.25, '/tmp/frame.png')
    expect(args).toContain('/tmp/日本語 video.mp4')
    expect(args).toContain('1.250000')
  })

  it('maps audio optionally when extracting', () => {
    expect(extractArgs('in.mp4', 1, 3, true, 'out.mp4')).toContain('0:a:0?')
    expect(extractArgs('in.mp4', 1, 3, false, 'out.mp4')).not.toContain('0:a:0?')
  })

  it('concatenates both sides for a middle removal', () => {
    const args = removeArgs('in.mp4', 2, 4, 10, true, 'out.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('trim=start=0:end=2.000000')
    expect(filter).toContain('trim=start=4.000000:end=10.000000')
    expect(filter).toContain('concat=n=2:v=1:a=1')
    expect(args).toContain('vfr')
  })

  it('uses a single extraction when removing from the beginning', () => {
    const args = removeArgs('in.mp4', 0, 4, 10, false, 'out.mp4')
    expect(args).toEqual(extractArgs('in.mp4', 4, 10, false, 'out.mp4'))
  })
})
