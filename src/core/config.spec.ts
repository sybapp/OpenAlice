import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function writeJson(root: string, filename: string, value: unknown) {
  const configDir = join(root, 'data', 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, filename), JSON.stringify(value, null, 2) + '\n')
}

describe('core config', () => {
  let repoRoot: string
  let tempRoot: string

  beforeEach(async () => {
    repoRoot = process.cwd()
    tempRoot = await mkdtemp(join(tmpdir(), 'openalice-config-'))
    process.chdir(tempRoot)
    vi.resetModules()
  })

  afterEach(async () => {
    process.chdir(repoRoot)
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('migrates legacy ai provider, model, api key, telegram, and engine port config into unified files', async () => {
    await writeJson(tempRoot, 'engine.json', {
      port: 3000,
      interval: 5000,
      pairs: ['BTC/USD'],
      webPort: 3100,
      mcpPort: 3200,
      askMcpPort: 3300,
    })
    await writeJson(tempRoot, 'ai-provider.json', { provider: 'codex-cli' })
    await writeJson(tempRoot, 'model.json', {
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
    })
    await writeJson(tempRoot, 'api-keys.json', {
      openai: 'openai-secret',
    })
    await writeJson(tempRoot, 'telegram.json', {
      botToken: 'telegram-secret',
      botUsername: 'alice_bot',
      chatIds: [123],
    })

    const config = await import('./config.js')
    const result = await config.loadConfig()

    expect(result.aiProvider).toEqual({
      backend: 'codex-cli',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      apiKeys: {
        openai: 'openai-secret',
      },
    })
    expect(result.connectors).toMatchObject({
      web: { port: 3100 },
      mcp: { port: 3200 },
      mcpAsk: { enabled: true, port: 3300 },
      telegram: {
        enabled: true,
        botToken: 'telegram-secret',
        botUsername: 'alice_bot',
        chatIds: [123],
      },
    })

    const aiProviderFile = JSON.parse(await readFile(join(tempRoot, 'data/config/ai-provider.json'), 'utf-8'))
    const engineFile = JSON.parse(await readFile(join(tempRoot, 'data/config/engine.json'), 'utf-8'))

    expect(aiProviderFile.backend).toBe('codex-cli')
    expect(engineFile.webPort).toBeUndefined()
    expect(engineFile.mcpPort).toBeUndefined()
    expect(engineFile.askMcpPort).toBeUndefined()
  })

  it('writes AI backend changes without dropping other provider settings', async () => {
    await writeJson(tempRoot, 'ai-provider.json', {
      backend: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKeys: {
        anthropic: 'anthropic-secret',
      },
      baseUrl: 'https://claude.example.test',
    })

    const config = await import('./config.js')

    await config.writeAIConfig('codex-cli')

    const persisted = JSON.parse(await readFile(join(tempRoot, 'data/config/ai-provider.json'), 'utf-8'))
    expect(persisted).toEqual({
      backend: 'codex-cli',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKeys: {
        anthropic: 'anthropic-secret',
      },
      baseUrl: 'https://claude.example.test',
    })

    const hotRead = await config.readAIConfig()
    expect(hotRead).toEqual({ backend: 'codex-cli' })
  })
})
