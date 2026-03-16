import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.fn()
const writeFile = vi.fn()
const appendFile = vi.fn()
const mkdir = vi.fn()
const createEventLog = vi.fn().mockResolvedValue({})
const createCronEngine = vi.fn().mockReturnValue({})
const createOhlcvStore = vi.fn(({ cryptoClient }) => ({ cryptoClient }))

class BrainStub {
  static restore() {
    return new BrainStub()
  }

  getFrontalLobe() {
    return ''
  }

  getEmotion() {
    return { current: 'neutral' }
  }
}

class NewsCollectorStoreStub {
  async init() {}
}

vi.mock('fs/promises', () => ({
  readFile,
  writeFile,
  appendFile,
  mkdir,
}))

vi.mock('../core/event-log.js', () => ({
  createEventLog,
}))

vi.mock('../jobs/cron/index.js', () => ({
  createCronEngine,
}))

vi.mock('../domains/cognition/brain/index.js', () => ({
  Brain: BrainStub,
}))

vi.mock('../domains/research/news-collector/index.js', () => ({
  NewsCollectorStore: NewsCollectorStoreStub,
}))

vi.mock('../domains/technical-analysis/indicator-kit/index.js', () => ({
  createOhlcvStore,
}))

const { initServices } = await import('./services.js')

describe('initServices', () => {
  beforeEach(() => {
    readFile.mockReset()
    writeFile.mockReset()
    appendFile.mockReset()
    mkdir.mockReset()
    createEventLog.mockClear()
    createCronEngine.mockClear()
    createOhlcvStore.mockClear()

    readFile.mockImplementation(async (path: string) => {
      const normalized = String(path)
      if (normalized.includes('persona')) return 'persona instructions'
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    })
  })

  it('does not crash at bootstrap when crypto provider is disabled', async () => {
    const services = await initServices({
      crypto: { provider: { type: 'none' }, guards: [] },
      newsCollector: { maxInMemory: 100, retentionDays: 7 },
    } as never)

    expect(createEventLog).toHaveBeenCalledOnce()
    expect(createCronEngine).toHaveBeenCalledOnce()
    expect(createOhlcvStore).toHaveBeenCalledOnce()
    await expect(services.marketData.getBacktestBars({
      assetType: 'crypto',
      symbol: 'BTC/USDT',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
    })).rejects.toThrow('Crypto CCXT provider is disabled')
  })
})
