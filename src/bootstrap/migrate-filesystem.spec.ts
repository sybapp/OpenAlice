import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('migrateFilesystemLayout', () => {
  let repoRoot: string
  let tempRoot: string

  beforeEach(async () => {
    repoRoot = process.cwd()
    tempRoot = await mkdtemp(join(tmpdir(), 'openalice-migrate-'))
    process.chdir(tempRoot)
    vi.resetModules()
  })

  afterEach(async () => {
    process.chdir(repoRoot)
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('moves legacy bundled defaults into the new layout when targets are missing', async () => {
    await mkdir(join(tempRoot, 'data/default/skills/ta-demo'), { recursive: true })
    await writeFile(join(tempRoot, 'data/default/persona.default.md'), 'legacy persona\n')
    await writeFile(join(tempRoot, 'data/default/heartbeat.default.md'), 'legacy heartbeat\n')
    await writeFile(join(tempRoot, 'data/default/skills/ta-demo/SKILL.md'), '# legacy skill\n')

    const { migrateFilesystemLayout } = await import('./migrate-filesystem.js')
    await migrateFilesystemLayout()

    await expect(readFile(join(tempRoot, 'defaults/prompts/persona.md'), 'utf-8')).resolves.toBe('legacy persona\n')
    await expect(readFile(join(tempRoot, 'defaults/prompts/heartbeat.md'), 'utf-8')).resolves.toBe('legacy heartbeat\n')
    await expect(readFile(join(tempRoot, 'defaults/skills/ta-demo/SKILL.md'), 'utf-8')).resolves.toBe('# legacy skill\n')
  })

  it('discards stale legacy bundled defaults when the new targets already exist', async () => {
    await mkdir(join(tempRoot, 'data/default/skills/ta-demo'), { recursive: true })
    await mkdir(join(tempRoot, 'defaults/prompts'), { recursive: true })
    await mkdir(join(tempRoot, 'defaults/skills/ta-demo'), { recursive: true })
    await writeFile(join(tempRoot, 'data/default/persona.default.md'), 'stale persona\n')
    await writeFile(join(tempRoot, 'data/default/heartbeat.default.md'), 'stale heartbeat\n')
    await writeFile(join(tempRoot, 'data/default/skills/ta-demo/SKILL.md'), '# stale skill\n')
    await writeFile(join(tempRoot, 'defaults/prompts/persona.md'), 'current persona\n')
    await writeFile(join(tempRoot, 'defaults/prompts/heartbeat.md'), 'current heartbeat\n')
    await writeFile(join(tempRoot, 'defaults/skills/ta-demo/SKILL.md'), '# current skill\n')

    const { migrateFilesystemLayout } = await import('./migrate-filesystem.js')
    await expect(migrateFilesystemLayout()).resolves.toBeUndefined()

    await expect(readFile(join(tempRoot, 'defaults/prompts/persona.md'), 'utf-8')).resolves.toBe('current persona\n')
    await expect(readFile(join(tempRoot, 'defaults/prompts/heartbeat.md'), 'utf-8')).resolves.toBe('current heartbeat\n')
    await expect(readFile(join(tempRoot, 'defaults/skills/ta-demo/SKILL.md'), 'utf-8')).resolves.toBe('# current skill\n')
    await expect(readFile(join(tempRoot, 'data/default/persona.default.md'), 'utf-8')).rejects.toThrow()
  })
})
