import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { ANALYSIS_REPORT_NAME } from './analysis-report.js'

const USER_SKILLS_DIR = resolve('data/skills')
const DEFAULT_SKILLS_DIR = resolve('data/default/skills')

const skillFrontmatterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  preferredTools: z.array(z.string()).default([]),
  toolAllow: z.array(z.string()).optional(),
  toolDeny: z.array(z.string()).optional(),
  outputSchema: z.literal(ANALYSIS_REPORT_NAME).default(ANALYSIS_REPORT_NAME),
})

export type SkillPack = z.infer<typeof skillFrontmatterSchema> & {
  whenToUse: string
  instructions: string
  safetyNotes: string
  examples: string
  body: string
  sourcePath: string
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n')) {
    throw new Error('Skill markdown must start with frontmatter')
  }
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new Error('Skill markdown frontmatter is not closed')
  }
  const rawFrontmatter = normalized.slice(4, end)
  const body = normalized.slice(end + 5)
  const frontmatter: Record<string, unknown> = {}
  let currentKey: string | null = null

  for (const rawLine of rawFrontmatter.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    if (/^\s*#/.test(line)) continue
    const listMatch = line.match(/^\s*[-*]\s+(.*)$/)
    if (listMatch && currentKey) {
      const current = frontmatter[currentKey]
      const arr = Array.isArray(current) ? current : []
      arr.push(listMatch[1].trim())
      frontmatter[currentKey] = arr
      continue
    }
    const kvMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!kvMatch) continue
    const [, key, rawValue] = kvMatch
    currentKey = key
    const value = rawValue.trim()
    if (!value) {
      frontmatter[key] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      frontmatter[key] = inner
        ? inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
        : []
      continue
    }
    frontmatter[key] = value.replace(/^['"]|['"]$/g, '')
  }

  return { frontmatter, body }
}

function extractSection(body: string, heading: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`)
  if (start === -1) return ''
  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line.trim())) break
    collected.push(line)
  }
  return collected.join('\n').trim()
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => resolve(dir, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

async function readSkillFile(filePath: string): Promise<SkillPack> {
  const markdown = await readFile(filePath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(markdown)
  const parsed = skillFrontmatterSchema.parse(frontmatter)
  return {
    ...parsed,
    whenToUse: extractSection(body, 'whenToUse'),
    instructions: extractSection(body, 'instructions'),
    safetyNotes: extractSection(body, 'safetyNotes'),
    examples: extractSection(body, 'examples'),
    body,
    sourcePath: filePath,
  }
}

export async function listSkillPacks(): Promise<SkillPack[]> {
  const [defaultFiles, userFiles] = await Promise.all([
    listMarkdownFiles(DEFAULT_SKILLS_DIR),
    listMarkdownFiles(USER_SKILLS_DIR),
  ])

  const packs = new Map<string, SkillPack>()
  for (const filePath of defaultFiles) {
    const pack = await readSkillFile(filePath)
    packs.set(pack.id, pack)
  }
  for (const filePath of userFiles) {
    const pack = await readSkillFile(filePath)
    packs.set(pack.id, pack)
  }
  return [...packs.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function getSkillPack(id: string): Promise<SkillPack | null> {
  const packs = await listSkillPacks()
  return packs.find((pack) => pack.id === id) ?? null
}

const DEFAULT_SKILL_TEMPLATES: Array<{ fileName: string; content: string }> = [
  {
    fileName: 'ta-brooks.md',
    content: `---
id: ta-brooks
label: Brooks Price Action
preferredTools:
  - marketSearchForResearch
  - brooksPaAnalyze
  - calculateIndicator
toolDeny:
  - trading*
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
outputSchema: AnalysisReport
---
## whenToUse
Use for discretionary price action analysis with Brooks-style terminology, trend strength, breakout follow-through, trading range context, and bar-by-bar structure.

## instructions
Use Brooks-style language. Prefer deterministic structure tools before broad commentary. Start by resolving the instrument if needed, then read price action structure, then add supporting indicators only if they improve clarity. Final answer must map cleanly to AnalysisReport.

## safetyNotes
Do not place trades or modify cron jobs. Analysis only.

## examples
- Assess whether the market is in trend, trading range, or breakout mode.
- Describe whether a setup is first-entry, second-entry, wedge, channel, or failed breakout.
`,
  },
  {
    fileName: 'ta-ict-smc.md',
    content: `---
id: ta-ict-smc
label: ICT / SMC
preferredTools:
  - marketSearchForResearch
  - calculateIndicator
  - brooksPaAnalyze
toolDeny:
  - trading*
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
outputSchema: AnalysisReport
---
## whenToUse
Use for ICT/SMC-style market structure, liquidity, displacement, imbalance, premium/discount, and execution narrative.

## instructions
Frame the analysis with ICT/SMC terminology. Focus on market structure shifts, liquidity pools, inefficiencies, and invalidation logic. Use deterministic tools first and make the final answer map cleanly to AnalysisReport.

## safetyNotes
Do not place trades or modify cron jobs. Analysis only.

## examples
- Identify likely liquidity targets above or below current price.
- Explain displacement, imbalance, mitigation, and invalidation zones.
`,
  },
  {
    fileName: 'research-news-fundamental.md',
    content: `---
id: research-news-fundamental
label: News & Fundamental Research
preferredTools:
  - marketSearchForResearch
  - newsGetCompany
  - newsGetWorld
  - equityGetProfile
  - equityGetFinancials
  - equityGetRatios
  - equityGetEstimates
toolDeny:
  - trading*
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
outputSchema: AnalysisReport
---
## whenToUse
Use for event-driven, macro, company-news, and fundamental research workflows.

## instructions
Prioritize symbol resolution, then relevant news, then company or macro fundamentals. Focus on catalysts, narrative, revisions, valuation context, and evidence quality. Final answer must map cleanly to AnalysisReport.

## safetyNotes
Do not place trades or modify cron jobs. Analysis only.

## examples
- Summarize the latest catalysts affecting a stock or sector.
- Explain whether recent news strengthens or weakens the investment thesis.
`,
  },
]

export async function ensureDefaultSkillPacks(): Promise<void> {
  await mkdir(DEFAULT_SKILLS_DIR, { recursive: true })
  await Promise.all(DEFAULT_SKILL_TEMPLATES.map(async ({ fileName, content }) => {
    const filePath = resolve(DEFAULT_SKILLS_DIR, fileName)
    try {
      await readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if (!(err instanceof Error) || !('code' in err) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
    }
  }))
}

