import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  TraderStrategyChangeReport,
  TraderStrategy,
  TraderStrategyPatch,
  TraderStrategySummary,
  TraderStrategyTemplate,
  TraderStrategyUpdateResult,
} from './types.js'

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

const traderStrategyPatchSchema = z.object({
  behaviorRules: z.object({
    preferences: z.array(z.string()).optional(),
    prohibitions: z.array(z.string()).optional(),
  }).optional(),
})

function ensureYamlFilename(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml')
}

function normalizeTextItems(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
}

function normalizeSymbols(symbols: string[]): string[] {
  return normalizeTextItems(symbols)
}

function normalizeStrategyId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'strategy'
}

function normalizeStrategy(input: TraderStrategy): TraderStrategy {
  const parsed = traderStrategySchema.parse(input)
  return {
    ...parsed,
    id: normalizeStrategyId(parsed.id),
    label: parsed.label.trim(),
    universe: {
      ...parsed.universe,
      symbols: normalizeSymbols(parsed.universe.symbols),
    },
    sources: normalizeTextItems(parsed.sources),
    behaviorRules: {
      preferences: normalizeTextItems(parsed.behaviorRules.preferences),
      prohibitions: normalizeTextItems(parsed.behaviorRules.prohibitions),
    },
  } satisfies TraderStrategy
}

function strategyFilePath(strategyId: string): string {
  return join(getStrategiesDir(), `${strategyId}.yml`)
}

function buildChangedFields(before: TraderStrategy, after: TraderStrategy): string[] {
  const changed: string[] = []
  if (before.label !== after.label) changed.push('label')
  if (before.enabled !== after.enabled) changed.push('enabled')
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) changed.push('sources')
  if (JSON.stringify(before.universe.symbols) !== JSON.stringify(after.universe.symbols)) changed.push('symbols')
  if (before.timeframes.context !== after.timeframes.context) changed.push('context timeframe')
  if (before.timeframes.structure !== after.timeframes.structure) changed.push('structure timeframe')
  if (before.timeframes.execution !== after.timeframes.execution) changed.push('execution timeframe')
  if (before.riskBudget.perTradeRiskPercent !== after.riskBudget.perTradeRiskPercent) changed.push('per-trade risk')
  if (before.riskBudget.maxGrossExposurePercent !== after.riskBudget.maxGrossExposurePercent) changed.push('gross exposure')
  if (before.riskBudget.maxPositions !== after.riskBudget.maxPositions) changed.push('max positions')
  if ((before.riskBudget.maxDailyLossPercent ?? null) !== (after.riskBudget.maxDailyLossPercent ?? null)) changed.push('daily loss')
  if (JSON.stringify(before.behaviorRules.preferences) !== JSON.stringify(after.behaviorRules.preferences)) changed.push('preferences')
  if (JSON.stringify(before.behaviorRules.prohibitions) !== JSON.stringify(after.behaviorRules.prohibitions)) changed.push('prohibitions')
  if (JSON.stringify(before.executionPolicy.allowedOrderTypes) !== JSON.stringify(after.executionPolicy.allowedOrderTypes)) changed.push('order types')
  if (before.executionPolicy.requireProtection !== after.executionPolicy.requireProtection) changed.push('require protection')
  if (before.executionPolicy.allowMarketOrders !== after.executionPolicy.allowMarketOrders) changed.push('market orders')
  if (before.executionPolicy.allowOvernight !== after.executionPolicy.allowOvernight) changed.push('overnight permission')
  return changed
}

function buildYamlDiff(beforeYaml: string, afterYaml: string): string {
  const beforeLines = beforeYaml.trimEnd().split('\n')
  const afterLines = afterYaml.trimEnd().split('\n')
  const rows = beforeLines.length
  const cols = afterLines.length
  const dp = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0))

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = beforeLines[i] === afterLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const diff: string[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (beforeLines[i] === afterLines[j]) {
      i += 1
      j += 1
      continue
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push(`- ${beforeLines[i]}`)
      i += 1
    } else {
      diff.push(`+ ${afterLines[j]}`)
      j += 1
    }
  }
  while (i < rows) {
    diff.push(`- ${beforeLines[i]}`)
    i += 1
  }
  while (j < cols) {
    diff.push(`+ ${afterLines[j]}`)
    j += 1
  }

  return diff.length > 0 ? diff.join('\n') : '(no YAML changes)'
}

function buildChangeReport(before: TraderStrategy, after: TraderStrategy, fallbackPrefix: string): TraderStrategyChangeReport {
  const changedFields = buildChangedFields(before, after)
  const summary = changedFields.length > 0
    ? `${fallbackPrefix} ${changedFields.join(', ')}.`
    : `${fallbackPrefix} found no effective YAML changes.`
  return {
    changedFields,
    summary,
    yamlDiff: buildYamlDiff(renderTraderStrategyYaml(before), renderTraderStrategyYaml(after)),
  }
}

async function writeStrategyFile(strategy: TraderStrategy): Promise<void> {
  const target = strategyFilePath(strategy.id)
  const tmp = `${target}.tmp`
  await writeFile(tmp, stringifyYaml(strategy, { lineWidth: 0 }), 'utf-8')
  await rename(tmp, target)
}

function buildTemplateStrategy(input: {
  id: string
  label: string
  description: string
  preferences: string[]
  prohibitions: string[]
  allowedOrderTypes: TraderStrategy['executionPolicy']['allowedOrderTypes']
}): TraderStrategyTemplate {
  return {
    id: input.id as TraderStrategyTemplate['id'],
    label: input.label,
    description: input.description,
    defaults: normalizeStrategy({
      id: input.id,
      label: input.label,
      enabled: true,
      sources: ['binance-main'],
      universe: {
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT'],
      },
      timeframes: {
        context: '1h',
        structure: '15m',
        execution: '5m',
      },
      riskBudget: {
        perTradeRiskPercent: 0.75,
        maxGrossExposurePercent: 5,
        maxPositions: 1,
      },
      behaviorRules: {
        preferences: input.preferences,
        prohibitions: input.prohibitions,
      },
      executionPolicy: {
        allowedOrderTypes: input.allowedOrderTypes,
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    }),
  }
}

const STRATEGY_TEMPLATES: TraderStrategyTemplate[] = [
  buildTemplateStrategy({
    id: 'breakout',
    label: 'Breakout',
    description: 'Momentum breakout template for clean trigger-and-go structures.',
    preferences: [
      'Only trade BTC/USDT:USDT on binance-main.',
      'Trade confirmed breakouts after a candle close beyond the trigger level and a hold on the next execution candle.',
      'Define a breakout decision zone and invalidate the idea if price falls back into it after trigger.',
      'Cancel the opposite-side idea immediately once one side triggers.',
    ],
    prohibitions: [
      'Do not trade the middle of the range before a trigger confirms.',
      'Do not keep a triggered breakout if price returns to the decision zone within 30 minutes.',
      'Do not open more than one BTC position at a time.',
    ],
    allowedOrderTypes: ['stop', 'stop_limit', 'take_profit'],
  }),
  buildTemplateStrategy({
    id: 'trend-follow',
    label: 'Trend Follow',
    description: 'Trend continuation template biased toward pullback entries inside a prevailing move.',
    preferences: [
      'Only trade BTC/USDT:USDT on binance-main.',
      'Trade in the direction of the 1h and 15m trend after a structured 5m pullback confirms.',
      'Prefer continuation entries above reclaimed structure levels with nearby invalidation.',
      'Scale targets around the next obvious liquidity or prior impulse extension.',
    ],
    prohibitions: [
      'Do not fade the higher-timeframe trend.',
      'Do not chase an overextended 5m candle far from invalidation.',
      'Do not hold overnight.',
    ],
    allowedOrderTypes: ['limit', 'stop', 'stop_limit', 'take_profit'],
  }),
  buildTemplateStrategy({
    id: 'mean-revert',
    label: 'Mean Revert',
    description: 'Range reversion template for failed breakouts and returns to value.',
    preferences: [
      'Only trade BTC/USDT:USDT on binance-main.',
      'Trade failed breaks back into range only after a rejection candle confirms on 5m.',
      'Define the value zone, trigger extremes, and target the opposing side of the range in stages.',
      'Require clear invalidation beyond the failed auction extreme.',
    ],
    prohibitions: [
      'Do not average into a loser.',
      'Do not keep a mean-reversion idea once price accepts outside the range.',
      'Do not open more than one BTC position at a time.',
    ],
    allowedOrderTypes: ['limit', 'stop_limit', 'take_profit'],
  }),
]

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
    return normalizeStrategy(traderStrategySchema.parse(parseYaml(raw)))
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

export function listTraderStrategyTemplates(): TraderStrategyTemplate[] {
  return STRATEGY_TEMPLATES.map((template) => ({
    ...template,
    defaults: normalizeStrategy(template.defaults),
  }))
}

export function parseTraderStrategy(input: unknown): TraderStrategy {
  return normalizeStrategy(traderStrategySchema.parse(input))
}

export function renderTraderStrategyYaml(strategy: TraderStrategy): string {
  return stringifyYaml(normalizeStrategy(strategy), { lineWidth: 0 })
}

export async function createTraderStrategy(input: unknown): Promise<TraderStrategy> {
  await ensureStrategiesDir()
  const existing = await loadTraderStrategies()
  const existingIds = new Set(existing.map((strategy) => strategy.id))
  const parsed = parseTraderStrategy(input)

  let nextId = parsed.id
  let suffix = 2
  while (existingIds.has(nextId)) {
    nextId = `${parsed.id}-${suffix}`
    suffix += 1
  }

  const strategy = normalizeStrategy({
    ...parsed,
    id: nextId,
  })
  await writeStrategyFile(strategy)
  return strategy
}

export async function updateTraderStrategy(strategyId: string, input: unknown): Promise<TraderStrategyUpdateResult> {
  await ensureStrategiesDir()
  const current = await getTraderStrategy(strategyId)
  if (!current) {
    throw new Error(`Unknown strategy: ${strategyId}`)
  }

  const parsed = parseTraderStrategy(input)
  const strategy = normalizeStrategy({
    ...parsed,
    id: strategyId,
  })
  await writeStrategyFile(strategy)
  return {
    strategy,
    changeReport: buildChangeReport(current, strategy, 'Manual edit updated'),
  }
}

export async function applyTraderStrategyPatch(strategyId: string, patch: unknown): Promise<{
  strategy: TraderStrategy
  patchApplied: boolean
  changeReport: TraderStrategyChangeReport
}> {
  const current = await getTraderStrategy(strategyId)
  if (!current) {
    throw new Error(`Unknown strategy: ${strategyId}`)
  }

  const parsedPatch = traderStrategyPatchSchema.parse(patch) as TraderStrategyPatch
  const next = normalizeStrategy({
    ...current,
    behaviorRules: {
      ...current.behaviorRules,
      ...(parsedPatch.behaviorRules?.preferences
        ? { preferences: parsedPatch.behaviorRules.preferences }
        : {}),
      ...(parsedPatch.behaviorRules?.prohibitions
        ? { prohibitions: parsedPatch.behaviorRules.prohibitions }
        : {}),
    },
  })

  const patchApplied = JSON.stringify(current.behaviorRules) !== JSON.stringify(next.behaviorRules)
  if (patchApplied) {
    await writeStrategyFile(next)
  }

  return {
    strategy: next,
    patchApplied,
    changeReport: buildChangeReport(current, next, 'Review updated'),
  }
}

export function strategyIdFromFilename(filename: string): string {
  return basename(filename, filename.endsWith('.yaml') ? '.yaml' : '.yml')
}
