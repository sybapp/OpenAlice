import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceBackgroundProcessManager } from './workspace-background-process.js'
import type { Logger } from './logger.js'
import type { TemplateMeta } from './template-registry.js'
import type { WorkspaceMeta } from './workspace-registry.js'

const logger = {
  info() {},
  warn() {},
  error() {},
} as unknown as Logger

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkspaceBackgroundProcessManager', () => {
  it('starts a template process, captures output, and stops it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-background-'))
    roots.push(root)
    const workspace: WorkspaceMeta = {
      id: 'binance-satellite-test',
      tag: 'binance-test',
      dir: root,
      createdAt: new Date().toISOString(),
      template: 'binance-signal-satellite',
    }
    const template = {
      name: 'binance-signal-satellite',
      bootstrapScript: join(root, 'bootstrap.mjs'),
      filesDir: root,
      templateDir: root,
      version: '1.0.0',
      defaultAgents: ['codex'],
      injectTools: true,
      injectInstructions: false,
      bundledSkills: [],
      backgroundProcess: {
        command: [process.execPath, '-e', 'console.log("collector-started")'],
        logPath: 'data/collector.log',
      },
    } satisfies TemplateMeta
    const manager = new WorkspaceBackgroundProcessManager({ webPort: 47333, logger })

    await manager.start(workspace, template)
    const logPath = join(root, 'data/collector.log')
    await waitFor(async () => {
      try {
        return (await readFile(logPath, 'utf8')).includes('collector-started')
      } catch {
        return false
      }
    })
    await manager.stop(workspace.id)
    await manager.stopAll()

    expect(await readFile(logPath, 'utf8')).toContain('collector-started')
  })
})

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for background process')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
