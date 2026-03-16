import { describe, expect, it, vi } from 'vitest'
import { startPlugins, stopPlugins } from './plugin-lifecycle.js'

describe('plugin lifecycle helpers', () => {
  it('rolls back already-started plugins in reverse order when a later start fails', async () => {
    const calls: string[] = []
    const first = {
      name: 'first',
      start: vi.fn(async () => { calls.push('start:first') }),
      stop: vi.fn(async () => { calls.push('stop:first') }),
    }
    const second = {
      name: 'second',
      start: vi.fn(async () => { calls.push('start:second') }),
      stop: vi.fn(async () => { calls.push('stop:second') }),
    }
    const failing = {
      name: 'failing',
      start: vi.fn(async () => {
        calls.push('start:failing')
        throw new Error('port busy')
      }),
      stop: vi.fn(async () => { calls.push('stop:failing') }),
    }

    await expect(startPlugins([first, second, failing] as never, {} as never)).rejects.toThrow('port busy')

    expect(calls).toEqual([
      'start:first',
      'start:second',
      'start:failing',
      'stop:second',
      'stop:first',
    ])
    expect(failing.stop).not.toHaveBeenCalled()
  })

  it('surfaces rollback stop failures alongside the startup error', async () => {
    const first = {
      name: 'first',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => { throw new Error('socket hung') }),
    }
    const failing = {
      name: 'failing',
      start: vi.fn(async () => { throw new Error('bind failed') }),
      stop: vi.fn(async () => undefined),
    }

    await expect(startPlugins([first, failing] as never, {} as never)).rejects.toThrow(
      'bind failed; startup rollback failed: first stop failed: socket hung',
    )
  })

  it('stops plugins in reverse order during shutdown', async () => {
    const calls: string[] = []
    const first = { name: 'first', stop: vi.fn(async () => { calls.push('stop:first') }) }
    const second = { name: 'second', stop: vi.fn(async () => { calls.push('stop:second') }) }

    await stopPlugins([first, second] as never)

    expect(calls).toEqual(['stop:second', 'stop:first'])
  })
})
