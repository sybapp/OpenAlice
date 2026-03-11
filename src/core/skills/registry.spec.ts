import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
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
      'docx-writer',
      'ops-cron-maintainer',
      'research-news-fundamental',
      'ta-brooks',
      'ta-ict-smc',
    ])
    expect(skills.every((skill) => skill.sourcePath.endsWith('/SKILL.md'))).toBe(true)
    expect(skills.find((skill) => skill.id === 'ta-brooks')).toMatchObject({
      preferredTools: expect.arrayContaining(['brooksPaAnalyze']),
      toolAllow: expect.arrayContaining(['brooksPaAnalyze', 'brooksPa*']),
      outputSchema: 'AnalysisReport',
      analysisMode: 'tool-first',
      decisionWindowBars: 10,
    })
    expect(skills.find((skill) => skill.id === 'ta-ict-smc')).toMatchObject({
      preferredTools: expect.arrayContaining(['ictSmcAnalyze', 'ictSmc*']),
      toolAllow: expect.arrayContaining(['ictSmcAnalyze', 'ictSmc*']),
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

  it('parses frontmatter and sections from SKILL.md', async () => {
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

  it('exposes SKILL.md helpers', () => {
    expect(getSkillFileName()).toBe('SKILL.md')
    expect(inferSkillIdFromPath('/tmp/foo/bar/SKILL.md')).toBe('bar')
    expect(inferSkillIdFromPath('/tmp/foo/bar.md')).toBe('bar')
  })
})
