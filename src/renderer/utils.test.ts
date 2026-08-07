import { describe, expect, it } from 'vitest'
import { findFrameIndex, formatTime } from './utils'

describe('formatTime', () => {
  it('formats minutes and seconds', () => expect(formatTime(65.25)).toBe('01:05'))
  it('formats precise time', () => expect(formatTime(3661.125, true)).toBe('01:01:01.125'))
  it('handles invalid values', () => expect(formatTime(Number.NaN)).toBe('00:00'))
})

describe('findFrameIndex', () => {
  const frames = [0, 0.04, 0.08, 0.12]
  it('finds the current frame', () => expect(findFrameIndex(frames, 0.081)).toBe(2))
  it('clamps before the beginning', () => expect(findFrameIndex(frames, -1)).toBe(0))
  it('clamps after the end', () => expect(findFrameIndex(frames, 10)).toBe(3))
  it('handles an empty list', () => expect(findFrameIndex([], 1)).toBe(-1))
})
