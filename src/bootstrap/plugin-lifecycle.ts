import type { EngineContext, Plugin } from '../core/types.js'

export async function startPlugins(plugins: Iterable<Plugin>, ctx: EngineContext) {
  const ordered = [...plugins]
  const started: Plugin[] = []

  try {
    for (const plugin of ordered) {
      await plugin.start(ctx)
      started.push(plugin)
      console.log(`plugin started: ${plugin.name}`)
    }
  } catch (err) {
    const rollbackErrors: string[] = []
    for (const plugin of [...started].reverse()) {
      try {
        await plugin.stop()
      } catch (stopErr) {
        rollbackErrors.push(`${plugin.name} stop failed: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`)
      }
    }

    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${message}; startup rollback failed: ${rollbackErrors.join('; ')}`)
    }

    throw err
  }
}

export async function stopPlugins(plugins: Iterable<Plugin>) {
  for (const plugin of [...plugins].reverse()) {
    await plugin.stop()
  }
}
