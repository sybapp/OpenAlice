import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  ToolPermissionAuditLog,
  ToolPermissionEngine,
  DEFAULT_TOOL_PERMISSION_CONFIG,
  makeAuditRecord,
  permissionDeniedResult,
  shouldAudit,
} from './tool-permission.js'

describe('ToolPermissionEngine', () => {
  it('denies default high-risk trading mutation tools', () => {
    const engine = new ToolPermissionEngine(DEFAULT_TOOL_PERMISSION_CONFIG)
    const decision = engine.decide({ tool: 'placeOrder', group: 'trading', input: {} })
    expect(decision.action).toBe('ask')
    expect(decision.risk).toBe('high')
  })

  it('allows read-only trading tools by default', () => {
    const engine = new ToolPermissionEngine(DEFAULT_TOOL_PERMISSION_CONFIG)
    const decision = engine.decide({ tool: 'getPortfolio', group: 'trading', input: {} })
    expect(decision.action).toBe('allow')
    expect(decision.risk).toBe('medium')
  })

  it('asks for browser host and high-risk browser actions by default', () => {
    const engine = new ToolPermissionEngine(DEFAULT_TOOL_PERMISSION_CONFIG)
    expect(engine.decide({ tool: 'browser', group: 'browser', input: { target: 'host', action: 'snapshot' } }).action).toBe('ask')
    expect(engine.decide({ tool: 'browser', group: 'browser', input: { target: 'sandbox', action: 'evaluate' } }).action).toBe('ask')
  })

  it('lets custom allow rules override high-risk default', () => {
    const engine = new ToolPermissionEngine({
      ...DEFAULT_TOOL_PERMISSION_CONFIG,
      rules: [{ action: 'allow', tools: ['readSession'], reason: 'trusted local test' }],
    })
    const decision = engine.decide({ tool: 'readSession', group: 'session', input: {} })
    expect(decision.action).toBe('allow')
    expect(decision.reason).toBe('trusted local test')
  })

  it('lets custom deny rules block otherwise allowed tools', () => {
    const engine = new ToolPermissionEngine({
      ...DEFAULT_TOOL_PERMISSION_CONFIG,
      rules: [{ action: 'deny', tools: ['getPortfolio'] }],
    })
    expect(engine.decide({ tool: 'getPortfolio', group: 'trading', input: {} }).action).toBe('deny')
  })

  it('lets custom ask rules request approval for otherwise allowed tools', () => {
    const engine = new ToolPermissionEngine({
      ...DEFAULT_TOOL_PERMISSION_CONFIG,
      rules: [{ action: 'ask', tools: ['getPortfolio'] }],
    })
    expect(engine.decide({ tool: 'getPortfolio', group: 'trading', input: {} }).action).toBe('ask')
  })

  it('matches input conditions', () => {
    const engine = new ToolPermissionEngine({
      ...DEFAULT_TOOL_PERMISSION_CONFIG,
      rules: [{ action: 'allow', tools: ['browser'], input: { target: 'host', action: ['snapshot'] } }],
    })
    expect(engine.decide({ tool: 'browser', group: 'browser', input: { target: 'host', action: 'snapshot' } }).action).toBe('allow')
  })

  it('builds denied result and audits redacted input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-permission-'))
    const logPath = join(dir, 'tool-permissions.jsonl')
    const audit = new ToolPermissionAuditLog(logPath)
    const request = { tool: 'readSession', group: 'session', input: { token: 'secret', sessionId: 'web/default' } }
    const decision = new ToolPermissionEngine({ ...DEFAULT_TOOL_PERMISSION_CONFIG, highRiskDefaultAction: 'deny' }).decide(request)

    expect(permissionDeniedResult(request, decision)).toMatchObject({
      code: 'TOOL_PERMISSION_DENIED',
      tool: 'readSession',
    })
    expect(shouldAudit(decision, DEFAULT_TOOL_PERMISSION_CONFIG)).toBe(true)

    await audit.append(makeAuditRecord(request, decision))
    const raw = await readFile(logPath, 'utf-8')
    expect(raw).toContain('[redacted]')
    expect(raw).not.toContain('secret')
  })
})
