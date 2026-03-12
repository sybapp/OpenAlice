import { spawn } from 'node:child_process'
import { pino } from 'pino'
import type { CodexCliConfig, CodexCliMessage, CodexCliResult } from './types.js'

const logger = pino({
  transport: { target: 'pino/file', options: { destination: 'logs/codex-cli.log', mkdir: true } },
})

const DEFAULT_SANDBOX = 'workspace-write' as const
const DEFAULT_APPROVAL = 'never' as const

export async function askCodexCli(
  prompt: string,
  config: CodexCliConfig = {},
): Promise<CodexCliResult> {
  const {
    model,
    cwd = process.cwd(),
    sandbox = DEFAULT_SANDBOX,
    approvalPolicy = DEFAULT_APPROVAL,
    skipGitRepoCheck = true,
    profile,
    configOverrides = [],
    systemPrompt,
    appendSystemPrompt,
    onText,
    onCommandStart,
    onCommandFinish,
  } = config

  const fullPrompt = buildPrompt(prompt, systemPrompt, appendSystemPrompt)

  const args = ['exec', '--json', '--sandbox', sandbox]

  if (skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (model?.trim()) args.push('--model', model.trim())
  if (profile?.trim()) args.push('--profile', profile.trim())

  // Non-interactive cron/heartbeat flow: never block on approval prompts.
  args.push('-c', `approval_policy=${toTomlString(approvalPolicy)}`)

  for (const override of configOverrides) {
    const trimmed = override.trim()
    if (trimmed) args.push('-c', trimmed)
  }

  // Read prompt from stdin so very large prompts don't hit argv limits.
  args.push('-')

  return new Promise<CodexCliResult>((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let buffer = ''
    let stderr = ''
    let resultText = ''
    const messages: CodexCliMessage[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue

        try {
          const event = JSON.parse(line) as Record<string, unknown>
          const item = event.item as Record<string, unknown> | undefined
          if (!item || typeof item.type !== 'string') continue

          if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
            const text = item.text
            onText?.(text)
            messages.push({ role: 'assistant', text })
            resultText = text
          } else if (item.type === 'command_execution') {
            const id = typeof item.id === 'string' ? item.id : `command-${messages.length}`
            const command = typeof item.command === 'string' ? item.command : '(unknown)'
            const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
            const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null

            if (event.type === 'item.started') {
              onCommandStart?.({ id, command })
              continue
            }
            if (event.type !== 'item.completed') continue

            onCommandFinish?.({ id, command, output, exitCode })
            logger.info(
              {
                command,
                exitCode,
              },
              'command_execution',
            )
          }
        } catch (err) {
          logger.warn({ line: line.slice(0, 200), error: String(err) }, 'jsonl_parse_error')
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      logger.error({ error: err.message }, 'spawn_error')
      reject(new Error(`Failed to spawn codex CLI: ${err.message}`))
    })

    child.on('close', (code) => {
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(0, 800) }, 'exit_error')
        return resolve({
          text: `Codex CLI exited with code ${code}:\n${stderr || resultText}`,
          ok: false,
          messages,
        })
      }

      if (!resultText) {
        const last = messages[messages.length - 1]
        resultText = last?.text ?? ''
      }

      resolve({
        text: resultText || '(no output)',
        ok: true,
        messages,
      })
    })

    child.stdin.end(fullPrompt)
  })
}

function buildPrompt(prompt: string, systemPrompt?: string, appendSystemPrompt?: string): string {
  const parts: string[] = []

  if (systemPrompt?.trim()) {
    parts.push('<system_prompt>', systemPrompt.trim(), '</system_prompt>')
  }
  if (appendSystemPrompt?.trim()) {
    parts.push('<append_system_prompt>', appendSystemPrompt.trim(), '</append_system_prompt>')
  }

  parts.push(prompt)
  return parts.join('\n\n')
}

function toTomlString(value: string): string {
  return JSON.stringify(value)
}
