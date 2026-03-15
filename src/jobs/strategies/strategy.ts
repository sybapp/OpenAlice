import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import type { TraderStrategy, TraderStrategySummary } from './types.js'

function getStrategiesDir(): string {
  return resolve('runtime/strategies')
}

const traderStrategySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  sources: z.array(z.string().min(1)).min(1),
  universe: z.object({
    asset: z.literal('crypto'),
    symbols: z.array(z.string().min(1)).min(1),
  }),
  timeframes: z.object({
    context: z.string().min(1),
    structure: z.string().min(1),
    execution: z.string().min(1),
  }),
  riskBudget: z.object({
    perTradeRiskPercent: z.number().positive(),
    maxGrossExposurePercent: z.number().positive(),
    maxPositions: z.number().int().positive(),
    maxDailyLossPercent: z.number().positive().optional(),
  }),
  behaviorRules: z.object({
    preferences: z.array(z.string()).default([]),
    prohibitions: z.array(z.string()).default([]),
  }).default({ preferences: [], prohibitions: [] }),
  executionPolicy: z.object({
    allowedOrderTypes: z.array(z.enum(['market', 'limit', 'stop', 'stop_limit', 'take_profit'])).min(1),
    requireProtection: z.boolean().default(true),
    allowMarketOrders: z.boolean().default(false),
    allowOvernight: z.boolean().default(false),
  }),
})

function ensureYamlFilename(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml')
}

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))]
}

export async function ensureStrategiesDir(): Promise<void> {
  await mkdir(getStrategiesDir(), { recursive: true })
}

export async function loadTraderStrategies(): Promise<TraderStrategy[]> {
  const strategyDir = getStrategiesDir()
  await ensureStrategiesDir()
  const entries = await readdir(strategyDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && ensureYamlFilename(entry.name))
    .map((entry) => entry.name)
    .sort()

  const strategies = await Promise.all(files.map(async (filename) => {
    const filePath = join(strategyDir, filename)
    const raw = await readFile(filePath, 'utf-8')
    const parsed = traderStrategySchema.parse(parseYaml(raw))
    return {
      ...parsed,
      universe: {
        ...parsed.universe,
        symbols: normalizeSymbols(parsed.universe.symbols),
      },
      sources: [...new Set(parsed.sources.map((source) => source.trim()).filter(Boolean))],
    } satisfies TraderStrategy
  }))

  return strategies
}

export async function getTraderStrategy(strategyId: string): Promise<TraderStrategy | null> {
  const strategies = await loadTraderStrategies()
  return strategies.find((strategy) => strategy.id === strategyId) ?? null
}

export async function listTraderStrategySummaries(): Promise<TraderStrategySummary[]> {
  const strategies = await loadTraderStrategies()
  return strategies.map((strategy) => ({
    id: strategy.id,
    label: strategy.label,
    enabled: strategy.enabled,
    sources: strategy.sources,
    asset: strategy.universe.asset,
    symbols: strategy.universe.symbols,
  }))
}

export function strategyIdFromFilename(filename: string): string {
  return basename(filename, filename.endsWith('.yaml') ? '.yaml' : '.yml')
}
