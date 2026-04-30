import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { HookEngine, mergeHookContext } from './hook-engine.js'

describe('HookEngine', () => {
  it('runs matching hooks by priority and accumulates additional context', async () => {
    const engine = new HookEngine({ config: { audit: false } })
    engine.register({
      id: 'late',
      event: 'UserPromptSubmit',
      priority: 10,
      handler: () => ({ additionalContext: 'late' }),
    })
    engine.register({
      id: 'early',
      event: 'UserPromptSubmit',
      priority: 1,
      handler: () => ({ additionalContext: 'early' }),
    })

    const report = await engine.run('UserPromptSubmit', { sessionId: 's1', prompt: 'hi' })

    expect(report.results.map((r) => r.id)).toEqual(['early', 'late'])
    expect(report.additionalContext).toEqual(['early', 'late'])
  })

  it('supports wildcard, pipe, and regex matchers', async () => {
    const engine = new HookEngine({ config: { audit: false } })
    engine.register({ id: 'wild', event: 'PreToolUse', matcher: '*', handler: () => ({ additionalContext: 'wild' }) })
    engine.register({ id: 'pipe', event: 'PreToolUse', matcher: 'placeOrder|readSession', handler: () => ({ additionalContext: 'pipe' }) })
    engine.register({ id: 'regex', event: 'PreToolUse', matcher: '/^place/', handler: () => ({ additionalContext: 'regex' }) })

    const report = await engine.run('PreToolUse', {
      tool: 'placeOrder',
      group: 'trading',
      input: {},
    })

    expect(report.results.map((r) => r.id)).toEqual(['wild', 'pipe', 'regex'])
  })

  it('blocks only blockable events', async () => {
    const engine = new HookEngine({ config: { audit: false } })
    engine.register({ id: 'block-tool', event: 'PreToolUse', handler: () => ({ block: true, reason: 'no' }) })
    engine.register({ id: 'block-post', event: 'PostToolUse', handler: () => ({ block: true, reason: 'ignored' }) })

    const pre = await engine.run('PreToolUse', { tool: 'a', group: 'g', input: {} })
    const post = await engine.run('PostToolUse', { tool: 'a', group: 'g', input: {}, output: {} })

    expect(pre.blocked).toBe(true)
    expect(pre.reason).toBe('no')
    expect(post.blocked).toBe(false)
  })

  it('continues after hook errors and audits redacted payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-hooks-'))
    const logPath = join(dir, 'hooks.jsonl')
    const engine = new HookEngine({ auditLogPath: logPath })
    engine.register({
      id: 'bad',
      event: 'PreToolUse',
      handler: () => { throw new Error('boom') },
    })
    engine.register({
      id: 'good',
      event: 'PreToolUse',
      handler: () => ({ additionalContext: 'ok' }),
    })

    const report = await engine.run('PreToolUse', {
      tool: 'browser',
      group: 'browser',
      input: { apiKey: 'secret-value' },
    })

    expect(report.results).toHaveLength(2)
    expect(report.results[0]).toMatchObject({ id: 'bad', errored: true })
    expect(report.additionalContext).toEqual(['ok'])

    const log = await readFile(logPath, 'utf-8')
    expect(log).toContain('[redacted]')
    expect(log).not.toContain('secret-value')
  })

  it('builds configured prompt hooks', async () => {
    const engine = new HookEngine({
      config: {
        audit: false,
        promptHooks: [{
          id: 'ctx',
          event: 'UserPromptSubmit',
          enabled: true,
          matcher: '*',
          content: 'remember context',
          priority: 0,
        }],
      },
    })

    const report = await engine.run('UserPromptSubmit', { sessionId: 's1', prompt: 'anything' })

    expect(report.additionalContext).toEqual(['remember context'])
  })

  it('merges hook context into channel context', () => {
    expect(mergeHookContext('Channel: web', ['A', 'B'])).toBe('Channel: web\n\nHook Context:\nA\n\nB')
  })
})
