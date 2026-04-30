import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Brain } from '../domain/brain/index.js'
import { BrainMemoryStore } from './brain-memory-store.js'
import { ContextAssembler, buildStaleWarning } from './context-assembler.js'
import type { SessionEntry } from './session.js'

async function setupAssembler() {
  const dir = await mkdtemp(join(tmpdir(), 'openalice-context-'))
  const personaFile = join(dir, 'persona.md')
  const memoryDir = join(dir, 'memory')
  await writeFile(personaFile, 'You are Alice.')
  const brain = new Brain({})
  const memoryStore = new BrainMemoryStore({ memoryDir })
  return { brain, memoryStore, personaFile, memoryDir }
}

function userEntry(content: string): SessionEntry {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: new Date().toISOString(),
  }
}

describe('ContextAssembler', () => {
  it('injects persona, frontal-lobe, runtime, channel, and history sections', async () => {
    const { brain, memoryStore, personaFile } = await setupAssembler()
    brain.updateFrontalLobe('Keep focus on the current implementation.')

    const assembler = new ContextAssembler({ brain, memoryStore, personaFile })
    const bundle = await assembler.assemble({
      activeEntries: [userEntry('hello')],
      prompt: 'continue',
      channelContext: 'Connector: Web UI',
    })

    expect(bundle.systemPrompt).toContain('## Persona')
    expect(bundle.systemPrompt).toContain('You are Alice.')
    expect(bundle.systemPrompt).toContain('## Frontal Lobe')
    expect(bundle.systemPrompt).toContain('Keep focus')
    expect(bundle.systemPrompt).toContain('## Runtime Context')
    expect(bundle.systemPrompt).toContain('## Channel Context')
    expect(bundle.systemPrompt).toContain('## History Context')
    expect(bundle.activeEntries).toHaveLength(1)
  })

  it('uses system prompt override as the persona section', async () => {
    const { brain, memoryStore, personaFile } = await setupAssembler()
    const assembler = new ContextAssembler({ brain, memoryStore, personaFile })
    const bundle = await assembler.assemble({
      activeEntries: [],
      prompt: 'hi',
      systemPromptOverride: 'Custom channel persona.',
    })

    expect(bundle.systemPrompt).toContain('Custom channel persona.')
    expect(bundle.systemPrompt).not.toContain('You are Alice.')
  })

  it('recalls matching memory entries', async () => {
    const { brain, personaFile, memoryDir } = await setupAssembler()
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'project_context.md'), [
      '---',
      'title: Local Context',
      'keywords: compaction',
      '---',
      'Do not use provider-native sessions.',
    ].join('\n'))

    const memoryStore = new BrainMemoryStore({ memoryDir })
    const assembler = new ContextAssembler({ brain, memoryStore, personaFile })
    const bundle = await assembler.assemble({
      activeEntries: [],
      prompt: 'how should compaction work?',
    })

    expect(bundle.recalledMemory).toHaveLength(1)
    expect(bundle.systemPrompt).toContain('## Recalled Long-Term Memory')
    expect(bundle.systemPrompt).toContain('Do not use provider-native sessions.')
  })

  it('emits stale and critical stale warnings', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-04T00:00:00Z'))
    try {
      expect(buildStaleWarning('2026-01-02T23:00:00Z')).toContain('STALE NOTICE')
      expect(buildStaleWarning('2026-01-01T00:00:00Z')).toContain('STALE WARNING')
      expect(buildStaleWarning('2026-01-03T12:00:00Z')).toBe('')
      expect(buildStaleWarning(null)).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
