import { canonicalId, canonicalJson, canonicalSha256 } from './canonical-json.js'
import { SIGNAL_ENGINE_VERSION, type ReplayBar, type RunSignalEngineInput, type SignalEngineRun, type SignalEngineSignal } from './types.js'

export function runSignalEngine(input: RunSignalEngineInput): SignalEngineRun {
  const bars = assertClosedBars(input.bars)
  const startedAt = input.startedAt ?? bars.at(-1)?.time ?? new Date(0).toISOString()
  const events: unknown[] = []
  const signals = []
  for (let index = 0; index < bars.length; index += 1) {
    const history = bars.slice(0, index + 1)
    const now = history.at(-1)?.time ?? startedAt
    const stepSignals = input.strategy.evaluate(history, {
      now,
      asset: input.asset,
      symbol: input.symbol,
      interval: input.interval,
      provider: input.provider,
      riskTemplate: input.riskTemplate,
    })
    for (const rawSignal of stepSignals) {
      const signal = finalizeSignal(rawSignal, {
        input,
        bar: history[index],
        inputBars: bars,
      })
      signals.push(signal)
      events.push({
        type: 'signal',
        index,
        time: now,
        signalId: signal.id,
        payloadHash: signal.canonicalPayloadHash,
      })
    }
  }

  const inputSnapshot = {
    engineVersion: SIGNAL_ENGINE_VERSION,
    asset: input.asset,
    symbol: input.symbol,
    interval: input.interval,
    provider: input.provider,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    riskTemplate: input.riskTemplate,
    bars,
  }
  const outputSnapshot = {
    signals,
    events,
  }
  const dataFingerprint = canonicalSha256(bars)
  const inputHash = canonicalSha256(inputSnapshot)
  const outputHash = canonicalSha256(outputSnapshot)
  const runId = `sr_${canonicalSha256({ inputHash, outputHash }).slice(0, 24)}`

  return {
    runId,
    engineVersion: SIGNAL_ENGINE_VERSION,
    status: 'completed',
    startedAt,
    finishedAt: bars.at(-1)?.time ?? startedAt,
    asset: input.asset,
    symbol: input.symbol,
    interval: input.interval,
    provider: input.provider,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    riskTemplateId: input.riskTemplate.id,
    riskTemplateVersion: input.riskTemplate.version,
    closedBarsOnly: true,
    dataFingerprint,
    inputHash,
    outputHash,
    signals,
    summary: signals.length > 0
      ? `${signals.length} signal(s) from ${input.strategy.id}@${input.strategy.version}`
      : `No signals from ${input.strategy.id}@${input.strategy.version}`,
  }
}

export function buildSignalEngineArtifactPayload(input: RunSignalEngineInput, output: SignalEngineRun) {
  return {
    input: {
      engineVersion: SIGNAL_ENGINE_VERSION,
      asset: input.asset,
      symbol: input.symbol,
      interval: input.interval,
      provider: input.provider,
      strategyId: input.strategy.id,
      strategyVersion: input.strategy.version,
      riskTemplate: input.riskTemplate,
      bars: input.bars,
    },
    output,
    events: output.signals.map((signal) => ({
      type: 'signal',
      signalId: signal.id,
      closedBarTime: signal.closedBarTime,
      canonicalPayloadHash: signal.canonicalPayloadHash,
    })),
  }
}

export function assertReplayDeterministic(input: RunSignalEngineInput): boolean {
  return canonicalJson(runSignalEngine(input)) === canonicalJson(runSignalEngine(input))
}

function assertClosedBars(bars: ReplayBar[]): ReplayBar[] {
  if (bars.length === 0) throw new Error('signal engine requires at least one closed bar')
  for (const [index, bar] of bars.entries()) {
    if (bar.closed !== true) throw new Error(`bar ${index} is not closed`)
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (typeof bar[field] !== 'string' || bar[field].trim() === '') {
        throw new Error(`bar ${index} ${field} must be a decimal string`)
      }
    }
  }
  return bars
}

function finalizeSignal(
  signal: SignalEngineSignal,
  context: {
    input: RunSignalEngineInput
    inputBars: ReplayBar[]
    bar: ReplayBar
  },
): SignalEngineSignal {
  const signalBase = stripSignalHashes(signal)
  const sourcePayload = {
    engineVersion: SIGNAL_ENGINE_VERSION,
    asset: context.input.asset,
    symbol: context.input.symbol,
    interval: context.input.interval,
    provider: context.input.provider,
    strategyId: context.input.strategy.id,
    strategyVersion: context.input.strategy.version,
    riskTemplateId: context.input.riskTemplate.id,
    riskTemplateVersion: context.input.riskTemplate.version,
    dataFingerprint: canonicalSha256(context.inputBars),
    closedBar: context.bar,
    signal: signalBase,
  }
  const canonicalPayloadHash = canonicalSha256(sourcePayload)
  return {
    ...signalBase,
    id: canonicalId('sig', sourcePayload),
    sourceHash: canonicalSha256({
      asset: context.input.asset,
      symbol: context.input.symbol,
      interval: context.input.interval,
      provider: context.input.provider,
      strategyId: context.input.strategy.id,
      strategyVersion: context.input.strategy.version,
      closedBar: context.bar,
    }),
    canonicalPayloadHash,
  }
}

function stripSignalHashes(signal: SignalEngineSignal): SignalEngineSignal {
  return {
    ...signal,
    id: '',
    sourceHash: '',
    canonicalPayloadHash: '',
  }
}
