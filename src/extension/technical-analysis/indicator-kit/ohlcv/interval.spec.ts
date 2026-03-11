import { describe, it, expect } from 'vitest'
import { parseIntervalToMinutes } from './interval'

describe('parseIntervalToMinutes', () => {
  it('parses minutes', () => {
    expect(parseIntervalToMinutes('5m')).toBe(5)
  })

  it('parses hours', () => {
    expect(parseIntervalToMinutes('1h')).toBe(60)
  })

  it('parses days', () => {
    expect(parseIntervalToMinutes('1d')).toBe(1440)
  })

  it('parses weeks', () => {
    expect(parseIntervalToMinutes('2w')).toBe(20160)
  })

  it('returns null for invalid', () => {
    expect(parseIntervalToMinutes('bad')).toBeNull()
    expect(parseIntervalToMinutes('0m')).toBeNull()
  })
})
