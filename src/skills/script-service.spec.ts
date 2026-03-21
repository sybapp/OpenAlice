import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSkillScript: vi.fn(),
}))

vi.mock('./script-registry.js', async () => {
  const actual = await vi.importActual<typeof import('./script-registry.js')>('./script-registry.js')
  return {
    ...actual,
    getSkillScript: mocks.getSkillScript,
  }
})

const { executeSkillScript, requireSkillScript } = await import('./script-service.js')

describe('skill script service', () => {
  it('loads, validates, and executes a named script', async () => {
    const run = vi.fn(async (_ctx, input) => ({ ok: true, input }))
    mocks.getSkillScript.mockReturnValue({
      id: 'demo-script',
      description: 'Demo script',
      inputSchema: { parse: vi.fn((value) => ({ parsed: value })) },
      run,
    })

    const result = await executeSkillScript({
      scriptId: 'demo-script',
      context: { invocation: {} } as any,
      input: { raw: true },
    })

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ invocation: {} }), { parsed: { raw: true } })
    expect(result).toEqual({
      script: expect.objectContaining({ id: 'demo-script' }),
      parsedInput: { parsed: { raw: true } },
      output: { ok: true, input: { parsed: { raw: true } } },
    })
  })

  it('throws a clear error when a named script is missing', () => {
    mocks.getSkillScript.mockReturnValue(null)
    expect(() => requireSkillScript('missing-script')).toThrow('Missing skill script: missing-script')
  })
})
