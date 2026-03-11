import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CodexCliProvider } from './codex-cli-provider.js'
import { readAgentConfig, readAIProviderConfig } from '../../core/config.js'
import { askCodexCliWithSession } from './session.js'

vi.mock('../../core/config.js', () => ({
  readAgentConfig: vi.fn(),
  readAIProviderConfig: vi.fn(),
}))

vi.mock('./session.js', () => ({
  askCodexCliWithSession: vi.fn(async () => ({ text: 'ok', media: [] })),
}))

vi.mock('../../core/skills/session-skill.js', () => ({
  getSessionSkillId: vi.fn(async () => 'ta-brooks'),
}))

vi.mock('../../core/skills/registry.js', () => ({
  getSkillPack: vi.fn(async () => ({
    id: 'ta-brooks',
    label: 'Brooks',
    description: 'Brooks mode',
    preferredTools: ['brooksPaAnalyze', 'calculateIndicator'],
    toolAllow: undefined,
    toolDeny: ['trading*', 'cronAdd'],
    outputSchema: 'AnalysisReport',
    decisionWindowBars: 10,
    analysisMode: 'tool-first',
    whenToUse: 'Use for Brooks analysis',
    instructions: '# Brooks\n\n## Instructions\nUse Brooks terminology',
    safetyNotes: 'No trades',
    examples: '- example',
    body: '# Brooks\n\n## Instructions\nUse Brooks terminology',
    sourcePath: '/tmp/ta-brooks/SKILL.md',
  })),
}))

describe('CodexCliProvider skill integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readAgentConfig).mockResolvedValue({
      evolutionMode: false,
      codexCli: {
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        configOverrides: ['sandbox_workspace_write.network_access=false'],
      },
    } as never)
    vi.mocked(readAIProviderConfig).mockResolvedValue({
      model: 'gpt-5-codex',
    } as never)
  })

  it('appends skill prompt and merges deny rules into config overrides', async () => {
    const provider = new CodexCliProvider({
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      autoCompactBuffer: 50,
      microcompactKeepRecent: 2,
    }, 'base system prompt')

    await provider.askWithSession('analyze btc', { id: 's1' } as never, {
      appendSystemPrompt: 'caller prompt',
    })

    expect(askCodexCliWithSession).toHaveBeenCalledWith(
      'analyze btc',
      expect.anything(),
      expect.objectContaining({
        codexCli: expect.objectContaining({
          appendSystemPrompt: expect.stringContaining('Active skill: ta-brooks (Brooks)'),
          configOverrides: expect.arrayContaining([
            'sandbox_workspace_write.network_access=false',
            'tools.exclude="trading*"',
            'tools.exclude="cronAdd"',
          ]),
        }),
        systemPrompt: 'base system prompt',
      }),
    )

    const config = vi.mocked(askCodexCliWithSession).mock.calls[0][2]
    expect(config.codexCli.appendSystemPrompt).toContain('caller prompt')
    expect(config.codexCli.appendSystemPrompt).toContain('Use Brooks terminology')
    expect(config.codexCli.appendSystemPrompt).toContain('most recent decision window of 10 bars')
  })
})
