export const AI_BACKENDS = ['claude-code', 'codex-cli', 'vercel-ai-sdk'] as const

export type AIBackendId = (typeof AI_BACKENDS)[number]

export interface AIBackendOption {
  id: AIBackendId
  label: string
}

export const AI_BACKEND_OPTIONS: AIBackendOption[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex-cli', label: 'Codex CLI' },
  { id: 'vercel-ai-sdk', label: 'Vercel AI SDK' },
]

export const AI_BACKEND_LABELS: Record<AIBackendId, string> = Object.fromEntries(
  AI_BACKEND_OPTIONS.map((option) => [option.id, option.label]),
) as Record<AIBackendId, string>

export function isAIBackend(value: unknown): value is AIBackendId {
  return typeof value === 'string' && AI_BACKENDS.includes(value as AIBackendId)
}

export function getAIBackendErrorMessage(): string {
  const quoted = AI_BACKEND_OPTIONS.map((option) => `"${option.id}"`)
  const choices = quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`
    : quoted[0] ?? ''
  return `Invalid backend. Must be ${choices}.`
}
