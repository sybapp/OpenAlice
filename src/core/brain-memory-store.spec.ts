import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BrainMemoryStore } from './brain-memory-store.js'

async function tempMemoryDir() {
  return mkdtemp(join(tmpdir(), 'openalice-memory-'))
}

describe('BrainMemoryStore', () => {
  it('returns empty when memory directory is missing', async () => {
    const store = new BrainMemoryStore({ memoryDir: join(tmpdir(), 'missing-openalice-memory') })
    await expect(store.list()).resolves.toEqual([])
    await expect(store.recall({ query: 'anything' })).resolves.toEqual([])
  })

  it('parses manifest, frontmatter, and markdown body', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'MEMORY.md'), '- [Project Rules](project_rules.md)\n')
    await writeFile(join(dir, 'project_rules.md'), [
      '---',
      'type: project',
      'title: OpenAlice Rules',
      'description: local context policy',
      'keywords: [context, compaction, memory]',
      'updatedAt: 2026-01-01T00:00:00Z',
      '---',
      '# Body Heading',
      'Keep provider sessions stateless.',
    ].join('\n'))

    const store = new BrainMemoryStore({ memoryDir: dir })
    const entries = await store.list()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'project_rules',
      type: 'project',
      title: 'OpenAlice Rules',
      description: 'local context policy',
      keywords: ['context', 'compaction', 'memory'],
      content: '# Body Heading\nKeep provider sessions stateless.',
    })
  })

  it('falls back to scanning typed memory files when manifest is absent', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'user_preferences.md'), '# Preferences\nUse concise replies.')
    await writeFile(join(dir, 'notes.md'), 'ignored')

    const store = new BrainMemoryStore({ memoryDir: dir })
    const entries = await store.list()

    expect(entries.map((entry) => entry.id)).toEqual(['user_preferences'])
    expect(entries[0].type).toBe('user')
  })

  it('recalls by keywords, limit, type, and length cap', async () => {
    const dir = await tempMemoryDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'trading_risk.md'), [
      '---',
      'title: Trading Risk',
      'keywords: risk, sizing',
      '---',
      'Never increase position size without explicit confirmation. '.repeat(20),
    ].join('\n'))
    await writeFile(join(dir, 'project_docs.md'), [
      '---',
      'keywords: docs',
      '---',
      'Documentation memory.',
    ].join('\n'))

    const store = new BrainMemoryStore({ memoryDir: dir, recallLimit: 5, entryMaxChars: 60 })
    const recalled = await store.recall({
      query: 'risk',
      recentToolNames: ['trading.placeOrder'],
      limit: 1,
      entryMaxChars: 80,
    })

    expect(recalled).toHaveLength(1)
    expect(recalled[0].id).toBe('trading_risk')
    expect(recalled[0].content.length).toBeLessThanOrEqual(92)
    expect(recalled[0].content).toContain('[truncated]')
  })

  it('excludes already surfaced memory ids', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'project_a.md'), 'context alpha')
    await writeFile(join(dir, 'project_b.md'), 'context beta')

    const store = new BrainMemoryStore({ memoryDir: dir })
    const recalled = await store.recall({ query: 'context', excludedIds: ['project_a'] })

    expect(recalled.map((entry) => entry.id)).toEqual(['project_b'])
  })

  it('ignores oversized manifest and falls back to scanning files', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'MEMORY.md'), 'x'.repeat(64))
    await writeFile(join(dir, 'project_scanned.md'), 'scanned memory')

    const store = new BrainMemoryStore({ memoryDir: dir, manifestMaxBytes: 16 })
    const entries = await store.list()

    expect(entries.map((entry) => entry.id)).toEqual(['project_scanned'])
  })
})
