import { describe, expect, it, vi } from 'vitest'

vi.mock('./registry.js', () => ({
  listSkillPacks: vi.fn(async () => [
    {
      id: 'ta-brooks',
      label: 'Brooks Price Action',
      description: 'Brooks analysis',
      runtime: 'agent-skill',
      userInvocable: true,
      resources: [{ id: 'references/checklist' }],
      allowedScripts: ['analysis-brooks'],
    },
    {
      id: 'trader-risk-check',
      label: 'Trader Risk Check',
      description: 'Pipeline-only trader risk check',
      runtime: 'agent-skill',
      userInvocable: false,
      stage: 'risk-check',
      resources: [{ id: 'references/contract' }],
      allowedScripts: ['trader-account-state'],
    },
    {
      id: 'news-ops',
      label: 'News Ops',
      description: 'Tool loop helper',
      runtime: 'tool-loop',
      userInvocable: true,
      resources: [],
      allowedScripts: [],
    },
  ]),
}))

vi.mock('./script-registry.js', () => ({
  listSkillScripts: vi.fn(() => [
    { id: 'analysis-brooks', description: 'Brooks script', inputGuide: 'Use named timeframes.' },
    { id: 'trader-account-state', description: 'Account snapshot script' },
  ]),
}))

const { buildSkillCatalog, getUserInvocableSkill } = await import('./catalog.js')

describe('skill catalog', () => {
  it('builds product-facing skill and script views from package ownership', async () => {
    const catalog = await buildSkillCatalog()

    expect(catalog.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'ta-brooks',
        resources: ['references/checklist'],
        allowedScripts: ['analysis-brooks'],
      }),
      expect.objectContaining({
        id: 'trader-risk-check',
        stage: 'risk-check',
        resources: ['references/contract'],
      }),
    ]))
    expect(catalog.scripts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'analysis-brooks', usedBy: ['ta-brooks'], inputGuide: 'Use named timeframes.' }),
      expect.objectContaining({ id: 'trader-account-state', usedBy: ['trader-risk-check'] }),
    ]))
    expect(catalog.userInvocableSkills.map((skill) => skill.id)).toEqual(['ta-brooks', 'news-ops'])
    expect(catalog.mcpExposedSkills.map((skill) => skill.id)).toEqual(['ta-brooks'])
  })


  it('normalizes sparse skill pack doubles without requiring resource or script arrays', async () => {
    const { buildSkillCatalog } = await import('./catalog.js')
    const registry = await import('./registry.js') as { listSkillPacks: ReturnType<typeof vi.fn> }
    registry.listSkillPacks.mockResolvedValueOnce([
      {
        id: 'minimal-skill',
        label: 'Minimal Skill',
        description: 'Minimal',
        runtime: 'agent-skill',
        userInvocable: true,
      },
    ])

    const catalog = await buildSkillCatalog()

    expect(catalog.skills).toEqual([
      expect.objectContaining({
        id: 'minimal-skill',
        resources: [],
        allowedScripts: [],
      }),
    ])
  })

  it('returns only user-invocable skills for manual activation', async () => {
    await expect(getUserInvocableSkill('ta-brooks')).resolves.toEqual(expect.objectContaining({ id: 'ta-brooks' }))
    await expect(getUserInvocableSkill('trader-risk-check')).resolves.toBeNull()
  })
})
