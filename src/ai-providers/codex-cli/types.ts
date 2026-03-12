export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

export interface CodexCliConfig {
  /** Model id (e.g. gpt-5.3-codex). */
  model?: string
  /** Working directory for codex exec. */
  cwd?: string
  /** Codex sandbox mode. */
  sandbox?: CodexSandboxMode
  /** Codex approval policy via -c approval_policy=... */
  approvalPolicy?: CodexApprovalPolicy
  /** Allow codex runs outside git repos. */
  skipGitRepoCheck?: boolean
  /** Optional codex profile name. */
  profile?: string
  /** Extra codex config overrides passed via repeated -c key=value. */
  configOverrides?: string[]
  /** Custom system prompt preamble (prepended to user prompt). */
  systemPrompt?: string
  /** Extra system prompt content (prepended after systemPrompt). */
  appendSystemPrompt?: string
  /** Called when Codex emits an assistant message item. */
  onText?: (text: string) => void
  /** Called when Codex starts a command execution item. */
  onCommandStart?: (command: { id: string; command: string }) => void
  /** Called when Codex completes a command execution item. */
  onCommandFinish?: (command: { id: string; command: string; output: string; exitCode: number | null }) => void
}

export interface CodexCliMessage {
  role: 'assistant'
  text: string
}

export interface CodexCliResult {
  /** Final text response from Codex (last assistant message). */
  text: string
  /** Whether codex exec exited successfully. */
  ok: boolean
  /** Assistant messages observed in the JSONL stream. */
  messages: CodexCliMessage[]
}
