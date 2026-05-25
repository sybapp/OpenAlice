import type { SignalEngineConfig } from '../../core/config.js'
import type { EventLogEntry } from '../../core/event-log.js'
import type { Listener } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import { createPump, type Pump } from '../../core/pump.js'
import type { CronFirePayload, CronEngine } from '../../task/cron/engine.js'
import type { SignalEngineService } from './runtime-service.js'

export const SIGNAL_ENGINE_JOB_NAME = '__signal_engine__'

export interface SignalEngineScheduler {
  start(): Promise<void>
  stop(): void
  readonly listener: Listener<'cron.fire'>
}

export function createSignalEngineScheduler(deps: {
  config: SignalEngineConfig
  readConfig?: () => Promise<SignalEngineConfig>
  cronEngine: CronEngine
  registry: ListenerRegistry
  service: SignalEngineService
}): SignalEngineScheduler {
  const readConfig = deps.readConfig ?? (async () => deps.config)
  let registered = false
  let pump: Pump | null = null

  async function handleFire(entry: EventLogEntry<CronFirePayload>): Promise<void> {
    if (entry.payload.jobName !== SIGNAL_ENGINE_JOB_NAME) return
    try {
      await deps.service.runOnce()
    } catch (error) {
      console.warn('signal-engine: scheduled run failed:', error instanceof Error ? error.message : error)
    }
  }

  const listener: Listener<'cron.fire'> = {
    name: 'signal-engine',
    subscribes: 'cron.fire',
    handle: handleFire,
  }

  return {
    listener,
    async start() {
      const config = await readConfig()
      pump = createPump({
        name: 'signal-engine',
        every: config.every,
        enabled: config.enabled,
        onTick: async () => { await deps.service.runOnce() },
      })
      pump.start()
    },
    stop() {
      pump?.stop()
      pump = null
      if (registered) {
        deps.registry.unregister(listener.name)
        registered = false
      }
    },
  }
}
