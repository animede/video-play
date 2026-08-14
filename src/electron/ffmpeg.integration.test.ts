import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { concatenateArgs, decodeFramesJpeg, detectVideoEncoders, extractArgs, getFrameWindow, probeVideo, removeArgs, removeRangesArgs } from './ffmpeg'

const ffmpeg = require('ffmpeg-static') as string
let directory: string
let source: string
let longSource: string
let secondSource: string

describe('FFmpeg integration', () => {
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'video-play-test-'))
    source = path.join(directory, 'input.mp4')
    longSource = path.join(directory, 'long-input.mp4')
    secondSource = path.join(directory, 'second-input.mp4')
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source,
    ])
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=2',
      '-t', '70', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', longSource,
    ])
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15',
      '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', secondSource,
    ])
  }, 15_000)

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it('always exposes the tested CPU encoder', async () => {
    const encoders = await detectVideoEncoders()
    expect(encoders).toContain('cpu')
    expect(encoders.at(-1)).toBe('cpu')
  })

  it('probes metadata and only the requested frame window', async () => {
    const metadata = await probeVideo(source)
    const frameWindow = await getFrameWindow(source, 0)
    expect(metadata).toMatchObject({ width: 320, height: 180, averageFps: 30, hasAudio: true })
    expect(metadata.duration).toBeCloseTo(3, 2)
    expect(frameWindow).toMatchObject({ start: 0, end: 30 })
    expect(frameWindow.timestamps).toHaveLength(90)
  })

  it('extracts an exact one-second range', async () => {
    const output = path.join(directory, 'clip.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...extractArgs(source, 0.5, 1.5, true, output)])
    const metadata = await probeVideo(output)
    expect(metadata.duration).toBeCloseTo(1, 1)
    expect(metadata.hasAudio).toBe(true)
  })

  it('decodes adjacent frames as in-memory JPEGs in one process', async () => {
    const images = await decodeFramesJpeg(source, [1, 1 + 1 / 30, 1 + 2 / 30, 1 + 3 / 30, 1 + 4 / 30])
    expect(images).toHaveLength(5)
    for (const image of images) {
      expect([...image.subarray(0, 2)]).toEqual([0xff, 0xd8])
      expect([...image.subarray(-2)]).toEqual([0xff, 0xd9])
      expect(image.byteLength).toBeGreaterThan(1_000)
    }
    expect(images[0].equals(images[1])).toBe(false)
  })

  it('indexes only one 30-second chunk around a distant seek position', async () => {
    const frameWindow = await getFrameWindow(longSource, 45)
    expect(frameWindow).toMatchObject({ start: 30, end: 60 })
    expect(frameWindow.timestamps).toHaveLength(60)
    expect(frameWindow.timestamps[0]).toBeGreaterThanOrEqual(30)
    expect(frameWindow.timestamps.at(-1)).toBeLessThan(60)
  })

  it('removes a middle range without forcing 25 fps', async () => {
    const output = path.join(directory, 'removed.mp4')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...removeArgs(source, 1, 2, 3, true, output)])
    const metadata = await probeVideo(output)
    const frameWindow = await getFrameWindow(output, 0)
    expect(metadata.duration).toBeCloseTo(2, 1)
    expect(frameWindow.timestamps).toHaveLength(60)
  })

  it('removes multiple ranges in one encode', async () => {
    const output = path.join(directory, 'multi-removed.mp4')
    const args = removeRangesArgs(source, [
      { start: 0.5, end: 1 },
      { start: 2, end: 2.5 },
    ], 3, true, output)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args])
    const metadata = await probeVideo(output)
    expect(metadata.duration).toBeCloseTo(2, 1)
    expect(metadata.hasAudio).toBe(true)
  })

  it('concatenates different sizes and supplies missing audio', async () => {
    const output = path.join(directory, 'concatenated.mp4')
    const firstMetadata = await probeVideo(source)
    const secondMetadata = await probeVideo(secondSource)
    const args = concatenateArgs([
      { path: source, metadata: firstMetadata },
      { path: secondSource, metadata: secondMetadata },
    ], output)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args])
    const metadata = await probeVideo(output)
    const frameWindow = await getFrameWindow(output, 0)
    expect(metadata).toMatchObject({ width: 320, height: 180, averageFps: 30, hasAudio: true })
    expect(metadata.duration).toBeCloseTo(4.5, 1)
    expect(frameWindow.timestamps.length).toBeGreaterThanOrEqual(134)
    expect(frameWindow.timestamps.length).toBeLessThanOrEqual(136)
  })
})
