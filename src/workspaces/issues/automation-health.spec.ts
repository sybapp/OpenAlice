import { describe, expect, it } from 'vitest'

import {
  issueAutomationHealth,
  issueAutomationOwnerState,
  issueAutomationRuntime,
  type IssueAutomationHealthInput,
} from './automation-health.js'

const base: IssueAutomationHealthInput = {
  status: 'todo',
  nowMs: 1_000,
  nextDueAtMs: 2_000,
  ownerState: 'workspace',
}

describe('issueAutomationHealth', () => {
  it('resolves effective runtime from Session, Issue, then default precedence', () => {
    const availability = {
      pi: { installed: true },
      codex: { installed: false },
      grok: { installed: false },
    }
    const displayNameFor = (agent: string) => agent.toUpperCase()
    expect(issueAutomationRuntime({
      sessionAgent: 'grok',
      issueAgent: 'codex',
      defaultAgent: 'pi',
      availability,
      displayNameFor,
    })).toEqual({ agent: 'grok', displayName: 'GROK', installed: false })
    expect(issueAutomationRuntime({
      issueAgent: 'codex',
      defaultAgent: 'pi',
      availability,
      displayNameFor,
    })?.agent).toBe('codex')
    expect(issueAutomationRuntime({
      defaultAgent: 'pi',
      availability,
      displayNameFor,
    })?.agent).toBe('pi')
  })

  it('distinguishes an untouched schedule from one that is due', () => {
    expect(issueAutomationHealth(base).state).toBe('not_started')
    expect(issueAutomationHealth({ ...base, nextDueAtMs: base.nowMs }).state).toBe('due')
  })

  it('blocks a live Issue whose schedule cannot produce another fire', () => {
    expect(issueAutomationHealth({ ...base, nextDueAtMs: null })).toMatchObject({
      state: 'blocked',
      message: expect.stringMatching(/no future fire/),
    })
  })

  it('projects the latest scheduled execution', () => {
    expect(issueAutomationHealth({ ...base, latestRun: { taskId: 'run-a', status: 'running' } })).toMatchObject({
      state: 'running', latestTaskId: 'run-a',
    })
    expect(issueAutomationHealth({ ...base, latestRun: { taskId: 'run-b', status: 'done' } })).toMatchObject({
      state: 'healthy', latestTaskId: 'run-b',
    })
    expect(issueAutomationHealth({ ...base, latestRun: { taskId: 'run-c', status: 'interrupted' } })).toMatchObject({
      state: 'interrupted', latestTaskId: 'run-c',
    })
    expect(issueAutomationHealth({
      ...base,
      latestRun: {
        taskId: 'run-sleep',
        status: 'failed',
        failure: {
          kind: 'system_paused',
          title: 'Computer or launcher was paused',
          message: 'watchdog ran late',
          retryable: true,
        },
      },
    })).toMatchObject({ state: 'interrupted', message: 'watchdog ran late' })
  })

  it('blocks a future dispatch when an exact Session cannot resume', () => {
    expect(issueAutomationHealth({ ...base, ownerState: 'missing' }).state).toBe('blocked')
    expect(issueAutomationHealth({ ...base, ownerState: 'retired' }).message).toMatch(/retired/)
    expect(issueAutomationHealth({ ...base, ownerState: 'unbound' }).message).toMatch(/resumable/)
    expect(issueAutomationHealth({ ...base, ownerState: 'workspace_missing' })).toMatchObject({
      state: 'blocked',
      message: expect.stringMatching(/Workspace is unavailable/),
    })
  })

  it('uses the authoritative assignee projection for exact Session health', () => {
    expect(issueAutomationOwnerState('@new-each-run')).toBe('workspace')
    expect(issueAutomationOwnerState('@resume-1', { state: 'workspace_missing' }))
      .toBe('workspace_missing')
    expect(issueAutomationOwnerState('@resume-missing')).toBe('missing')
  })

  it('lets an in-flight run finish before surfacing a newly blocked owner', () => {
    expect(issueAutomationHealth({
      ...base,
      ownerState: 'retired',
      latestRun: { taskId: 'run-live', status: 'running' },
    }).state).toBe('running')
  })

  it('projects a missing effective runtime as a structured blocker', () => {
    expect(issueAutomationHealth({
      ...base,
      runtime: { agent: 'grok', displayName: 'Grok', installed: false },
    })).toMatchObject({
      state: 'blocked',
      blocker: {
        kind: 'agent_runtime_missing',
        agent: 'grok',
        displayName: 'Grok',
      },
      message: expect.stringMatching(/Grok.*not installed/),
    })
  })

  it('does not let a missing runtime hide an in-flight run or terminal Issue', () => {
    const runtime = { agent: 'grok', displayName: 'Grok', installed: false }
    expect(issueAutomationHealth({
      ...base,
      runtime,
      latestRun: { taskId: 'run-live', status: 'running' },
    }).state).toBe('running')
    expect(issueAutomationHealth({ ...base, status: 'done', runtime }).state).toBe('inactive')
  })

  it('makes terminal Issue status the schedule switch', () => {
    expect(issueAutomationHealth({ ...base, status: 'done', nextDueAtMs: base.nowMs }).state).toBe('inactive')
  })

  it('reads a due-but-gated watch as monitoring progress, never failure', () => {
    const due = { ...base, nextDueAtMs: base.nowMs }
    // Never checked: standing by.
    expect(issueAutomationHealth({ ...due, watch: { armed: true } })).toMatchObject({
      state: 'healthy',
      message: expect.stringMatching(/not met yet/),
    })
    // Miss: standing by.
    expect(issueAutomationHealth({ ...due, watch: { armed: true, lastStatus: 'miss' } })).toMatchObject({
      state: 'healthy',
      message: expect.stringMatching(/not met yet/),
    })
    // Unavailable: standing by with the cause, not failed/blocked.
    expect(issueAutomationHealth({
      ...due,
      watch: { armed: true, lastStatus: 'unavailable', lastReason: 'bars are 3 trading day(s) behind' },
    })).toMatchObject({
      state: 'healthy',
      message: expect.stringMatching(/unavailable.*3 trading day/),
    })
    // Triggered: dispatched, waiting for the harness verdict.
    expect(issueAutomationHealth({
      ...due,
      watch: { armed: true, lastStatus: 'hit', lastTriggeredAt: base.nowMs },
    })).toMatchObject({
      state: 'healthy',
      message: expect.stringMatching(/dispatched/),
    })
    // Unwatched issues keep the legacy due reading.
    expect(issueAutomationHealth(due)).toMatchObject({ state: 'due' })
  })
})
