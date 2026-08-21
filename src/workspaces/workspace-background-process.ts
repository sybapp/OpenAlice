import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { buildSpawnEnv } from './spawn-env.js'
import { resolveLaunchCommand } from './win-command.js'
import type { Logger } from './logger.js'
import type { TemplateMeta } from './template-registry.js'
import type { WorkspaceMeta } from './workspace-registry.js'

interface BackgroundEntry {
  readonly workspace: WorkspaceMeta
  readonly template: TemplateMeta
  child: ChildProcess | null
  output: ReturnType<typeof createWriteStream> | null
  timer: ReturnType<typeof setTimeout> | null
  stopping: boolean
}

/** Keeps template-declared, non-Agent processes tied to the OpenAlice runtime. */
export class WorkspaceBackgroundProcessManager {
  private readonly entries = new Map<string, BackgroundEntry>()
  private stopping = false

  constructor(
    private readonly options: {
      webPort: number
      logger: Logger
    },
  ) {}

  async start(workspace: WorkspaceMeta, template: TemplateMeta | undefined): Promise<void> {
    if (this.stopping || !template?.backgroundProcess || this.entries.has(workspace.id)) return
    const entry: BackgroundEntry = {
      workspace,
      template,
      child: null,
      output: null,
      timer: null,
      stopping: false,
    }
    this.entries.set(workspace.id, entry)
    await this.launch(entry)
  }

  async stop(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    entry.stopping = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    const child = entry.child
    if (!child) {
      this.entries.delete(workspaceId)
      return
    }
    await new Promise<void>((resolveStop) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolveStop()
      }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish()
      }, 2_000)
      child.once('close', () => {
        clearTimeout(killTimer)
        finish()
      })
      try { child.kill('SIGTERM') } catch { finish() }
    })
    if (this.entries.get(workspaceId) === entry) this.entries.delete(workspaceId)
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.entries.keys()].map((workspaceId) => this.stop(workspaceId)))
  }

  private async launch(entry: BackgroundEntry): Promise<void> {
    const spec = entry.template.backgroundProcess
    if (!spec || entry.stopping || this.entries.get(entry.workspace.id) !== entry) return
    try {
      const logPath = resolveInsideWorkspace(
        entry.workspace.dir,
        spec.logPath ?? '.alice/background-process.log',
      )
      await mkdir(dirname(logPath), { recursive: true })
      const output = createWriteStream(logPath, { flags: 'a' })
      output.on('error', (error) => this.options.logger.warn('workspace.background_log_failed', {
        wsId: entry.workspace.id,
        path: logPath,
        error,
      }))
      entry.output = output
      if (entry.stopping || this.entries.get(entry.workspace.id) !== entry) {
        output.end()
        entry.output = null
        return
      }

      const env = buildSpawnEnv(process.env, {
        OPENALICE_BASE_URL: process.env['OPENALICE_BASE_URL'] ?? `http://127.0.0.1:${this.options.webPort}`,
        OPENALICE_WORKSPACE_ID: entry.workspace.id,
        SATELLITE_DATA_DIR: join(entry.workspace.dir, 'data'),
      }, entry.workspace.dir)
      const resolved = resolveLaunchCommand(spec.command, {
        cwd: entry.workspace.dir,
        env,
        nodeExecPath: process.execPath,
      })
      if (resolved.mode === 'node-shim' && process.versions.electron) env['ELECTRON_RUN_AS_NODE'] = '1'
      const [command, ...args] = resolved.argv
      if (!command) throw new Error('background process has an empty command')
      const child = spawn(command, args, {
        cwd: entry.workspace.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      entry.child = child
      child.stdout?.pipe(output, { end: false })
      child.stderr?.pipe(output, { end: false })
      child.once('error', (error) => this.options.logger.error('workspace.background_failed', {
        wsId: entry.workspace.id,
        command: spec.command,
        error,
      }))
      child.once('close', (code, signal) => {
        child.stdout?.unpipe(output)
        child.stderr?.unpipe(output)
        output.end()
        entry.child = null
        entry.output = null
        this.options.logger.info('workspace.background_stopped', {
          wsId: entry.workspace.id,
          code,
          signal,
          restarting: !entry.stopping && !this.stopping,
        })
        if (!entry.stopping && !this.stopping) this.scheduleRestart(entry)
      })
      this.options.logger.info('workspace.background_started', {
        wsId: entry.workspace.id,
        command: resolved.argv,
        logPath,
      })
    } catch (error) {
      entry.output?.end()
      entry.output = null
      this.options.logger.error('workspace.background_start_failed', {
        wsId: entry.workspace.id,
        command: spec.command,
        error,
      })
      if (!entry.stopping && !this.stopping) this.scheduleRestart(entry)
    }
  }

  private scheduleRestart(entry: BackgroundEntry): void {
    if (entry.timer || entry.stopping || this.stopping) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.launch(entry)
    }, 5_000)
  }
}

function resolveInsideWorkspace(workspaceDir: string, relativePath: string): string {
  const workspace = resolve(workspaceDir)
  const target = resolve(workspace, relativePath)
  const rel = relative(workspace, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || (target !== workspace && !target.startsWith(workspace + sep))) {
    throw new Error(`background log path escapes Workspace: ${relativePath}`)
  }
  return target
}
