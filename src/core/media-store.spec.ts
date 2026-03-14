import { describe, it, expect } from 'vitest'
import { resolveMediaPath } from './media-store.js'

describe('resolveMediaPath', () => {
  it('resolves a valid date/name path', () => {
    const result = resolveMediaPath('2026-01-15/ace-aim-air.png')
    expect(result).toContain('runtime/media/2026-01-15/ace-aim-air.png')
  })

  it('throws on path traversal with ../', () => {
    expect(() => resolveMediaPath('../../etc/passwd')).toThrow('path traversal')
  })

  it('throws on path traversal embedded in date segment', () => {
    expect(() => resolveMediaPath('2026-01-01/../../etc/passwd')).toThrow('path traversal')
  })

  it('throws on path traversal with encoded segments', () => {
    expect(() => resolveMediaPath('../../../etc/shadow')).toThrow('path traversal')
  })

  it('allows simple nested paths without traversal', () => {
    const result = resolveMediaPath('2026-03-12/ace-aim-air.png')
    expect(result).toContain('2026-03-12/ace-aim-air.png')
  })
})
