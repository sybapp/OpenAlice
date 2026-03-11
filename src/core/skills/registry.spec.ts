import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureDefaultSkillPacks,
  getSkillFileName,
  getSkillPack,
  inferSkillIdFromPath,
  listSkillPacks,
} from './registry.js'

describe('skill registry', () => {
  let cwdBefore = process.cwd()
  let tempDir = ''

  beforeEach(async () => {
    cwdBefore = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'oa-skill-registry-'))
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(cwdBefore)
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loads bundled concrete skills from SKILL.md directories', async () => {
    await ensureDefaultSkillPacks()

    const skills = await listSkillPacks()
    expect(skills.map((skill) => skill.id)).toEqual([
      'ops-cron-maintainer',
      'research-news-fundamental',
      'ta-brooks',
      'ta-ict-smc',
    ])
    expect(skills.every((skill) => skill.sourcePath.endsWith('/SKILL.md'))).toBe(true)
    expect(skills.find((skill) => skill.id === 'ta-brooks')).toMatchObject({
      label: 'Brooks Price Action',
      preferredTools: expect.arrayContaining(['brooksPaAnalyze']),
      toolAllow: expect.arrayContaining(['brooksPaAnalyze', 'brooksPa*']),
      outputSchema: 'AnalysisReport',
      analysisMode: 'tool-first',
      decisionWindowBars: 10,
      instructions: expect.stringContaining('Start with deterministic analysis tools'),
      safetyNotes: expect.stringContaining('Do not place trades'),
    })
    expect(skills.find((skill) => skill.id === 'ta-ict-smc')).toMatchObject({
      preferredTools: expect.arrayContaining(['ictSmcAnalyze', 'ictSmc*']),
      toolAllow: expect.arrayContaining(['ictSmcAnalyze', 'ictSmc*']),
      instructions: expect.stringContaining('Run deterministic ICT/SMC structure tools first'),
    })
  })

  it('lets user skills override bundled defaults', async () => {
    await ensureDefaultSkillPacks()
    await mkdir(join(tempDir, 'data/skills/ta-brooks'), { recursive: true })
    await writeFile(join(tempDir, 'data/skills/ta-brooks/SKILL.md'), `---
id: ta-brooks
label: Custom Brooks
description: Override
preferredTools:
  - brooksPaAnalyze
outputSchema: AnalysisReport
decisionWindowBars: 10
analysisMode: tool-first
---
## whenToUse
custom

## instructions
custom instructions

## safetyNotes
safe

## examples
- custom
`)

    const skill = await getSkillPack('ta-brooks')
    expect(skill).toMatchObject({
      label: 'Custom Brooks',
      instructions: 'custom instructions',
    })
  })

  it('parses legacy frontmatter and sections from SKILL.md', async () => {
    await mkdir(join(tempDir, 'data/skills/custom-skill'), { recursive: true })
    await writeFile(join(tempDir, 'data/skills/custom-skill/SKILL.md'), `---
id: custom-skill
label: Custom Skill
description: Demo skill
preferredTools:
  - toolA
toolAllow:
  - tool*
toolDeny:
  - trading*
outputSchema: CustomReport
decisionWindowBars: 12
analysisMode: tool-first
---
## whenToUse
when section

## instructions
instruction section

## safetyNotes
safety section

## examples
- example one
`)

    const skill = await getSkillPack('custom-skill')
    expect(skill).toMatchObject({
      id: 'custom-skill',
      label: 'Custom Skill',
      description: 'Demo skill',
      preferredTools: ['toolA'],
      toolAllow: ['tool*'],
      toolDeny: ['trading*'],
      outputSchema: 'CustomReport',
      decisionWindowBars: 12,
      analysisMode: 'tool-first',
      whenToUse: 'when section',
      instructions: 'instruction section',
      safetyNotes: 'safety section',
      examples: '- example one',
    })
  })

  it('parses plugin-style frontmatter and body from SKILL.md', async () => {
    await mkdir(join(tempDir, 'data/skills/plugin-skill'), { recursive: true })
    await writeFile(join(tempDir, 'data/skills/plugin-skill/SKILL.md'), `---
name: plugin-skill
description: Plugin style skill
compatibility:
  tools:
    preferred:
      - toolA
      - toolB
    allow:
      - tool*
    deny:
      - trading*
outputSchema: CustomReport
decisionWindowBars: 8
analysisMode: tool-first
---
# Plugin Skill

## When to use
plugin when

## Instructions
plugin instructions

## Safety notes
plugin safe

## Examples
- plugin example
`)

    const skill = await getSkillPack('plugin-skill')
    expect(skill).toMatchObject({
      id: 'plugin-skill',
      label: 'Plugin Skill',
      description: 'Plugin style skill',
      preferredTools: ['toolA', 'toolB'],
      toolAllow: ['tool*'],
      toolDeny: ['trading*'],
      outputSchema: 'CustomReport',
      decisionWindowBars: 8,
      analysisMode: 'tool-first',
      whenToUse: 'plugin when',
      instructions: 'plugin instructions',
      safetyNotes: 'plugin safe',
      examples: '- plugin example',
    })
  })

  it('writes plugin-style default skills for new installs', async () => {
    await ensureDefaultSkillPacks()

    const content = await readFile(join(tempDir, 'data/default/skills/ta-brooks/SKILL.md'), 'utf-8')
    expect(content).toContain('name: ta-brooks')
    expect(content).toContain('compatibility:')
    expect(content).toContain('# Brooks Price Action')
    expect(content).not.toContain('id: ta-brooks')
  })

  it('fails with actionable errors for invalid plugin-style frontmatter', async () => {
    await mkdir(join(tempDir, 'data/skills/bad-skill'), { recursive: true })
    await writeFile(join(tempDir, 'data/skills/bad-skill/SKILL.md'), `---
name: bad-skill
---
# Bad Skill
`)

    await expect(getSkillPack('bad-skill')).rejects.toThrow(/Failed to load skill at .*bad-skill\/SKILL\.md: Plugin-style skill frontmatter must include a non-empty "description" field/)
  })

  it('exposes SKILL.md helpers', () => {
    expect(getSkillFileName()).toBe('SKILL.md')
    expect(inferSkillIdFromPath('/tmp/foo/bar/SKILL.md')).toBe('bar')
    expect(inferSkillIdFromPath('/tmp/foo/bar.md')).toBe('bar')
  })
})
