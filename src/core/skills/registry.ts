import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { z } from 'zod'
import { ANALYSIS_REPORT_NAME } from './analysis-report.js'

const SKILL_FILE_NAME = 'SKILL.md'

function getUserSkillsDir(): string {
  return resolve('data/skills')
}

function getDefaultSkillsDir(): string {
  return resolve('data/default/skills')
}

const skillFrontmatterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  preferredTools: z.array(z.string()).default([]),
  toolAllow: z.array(z.string()).optional(),
  toolDeny: z.array(z.string()).optional(),
  outputSchema: z.string().default(ANALYSIS_REPORT_NAME),
  decisionWindowBars: z.number().int().positive().default(10),
  analysisMode: z.enum(['tool-first']).default('tool-first'),
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
    if (value === 'true' || value === 'false') {
      frontmatter[key] = value === 'true'
      continue
    }
    if (/^-?\d+$/.test(value)) {
      frontmatter[key] = Number(value)
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

async function listSkillFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        const skillPath = join(fullPath, SKILL_FILE_NAME)
        try {
          const st = await stat(skillPath)
          return st.isFile() ? skillPath : null
        } catch {
          return null
        }
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        return fullPath
      }
      return null
    }))
    return files.filter((filePath): filePath is string => Boolean(filePath)).sort((a, b) => a.localeCompare(b))
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
    listSkillFiles(getDefaultSkillsDir()),
    listSkillFiles(getUserSkillsDir()),
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

function buildSkillTemplate(params: {
  id: string
  label: string
  description: string
  preferredTools: string[]
  toolAllow?: string[]
  toolDeny?: string[]
  outputSchema: string
  decisionWindowBars?: number
  analysisMode?: 'tool-first'
  whenToUse: string
  instructions: string
  safetyNotes: string
  examples: string
}): string {
  const frontmatter = [
    '---',
    `id: ${params.id}`,
    `label: ${params.label}`,
    `description: ${params.description}`,
    'preferredTools:',
    ...params.preferredTools.map((tool) => `  - ${tool}`),
    ...(params.toolAllow ? ['toolAllow:', ...params.toolAllow.map((tool) => `  - ${tool}`)] : []),
    ...(params.toolDeny ? ['toolDeny:', ...params.toolDeny.map((tool) => `  - ${tool}`)] : []),
    `outputSchema: ${params.outputSchema}`,
    `decisionWindowBars: ${params.decisionWindowBars ?? 10}`,
    `analysisMode: ${params.analysisMode ?? 'tool-first'}`,
    '---',
  ].join('\n')

  return [
    frontmatter,
    '## whenToUse',
    params.whenToUse,
    '',
    '## instructions',
    params.instructions,
    '',
    '## safetyNotes',
    params.safetyNotes,
    '',
    '## examples',
    params.examples,
    '',
  ].join('\n')
}

const DEFAULT_SKILL_TEMPLATES: Array<{ dirName: string; content: string }> = [
  {
    dirName: 'ta-brooks',
    content: buildSkillTemplate({
      id: 'ta-brooks',
      label: 'Brooks Price Action',
      description: 'Use this skill whenever the user wants discretionary price action analysis, bar-by-bar structure, breakout or trading-range context, or Brooks-style market reading. Prefer this skill over generic market commentary when the request is about interpreting price action and trade location from structured market data.',
      preferredTools: ['brooksPaAnalyze', 'brooksPa*', 'analysis*', 'market-search*', 'equity*'],
      toolAllow: ['brooksPaAnalyze', 'brooksPa*', 'analysis*', 'market-search*', 'equity*'],
      toolDeny: ['trading*', 'cronAdd', 'cronUpdate', 'cronRemove', 'cronRunNow'],
      outputSchema: ANALYSIS_REPORT_NAME,
      whenToUse: 'Use for price action, candle structure, trend-versus-range judgment, breakout follow-through, and Brooks-style trade narrative. This skill is for reading the market, not for placing orders.',
      instructions: [
        'Start with deterministic analysis tools instead of feeding long raw OHLCV sequences into the model.',
        'Prefer brooksPaAnalyze as the primary structure-reading tool. If Brooks sub-tools are available, use them to derive structure first and let the model consume only the aggregated structure plus the latest decision window.',
        'Only reason over the structured tool output and the most recent 10 bars in the current decision window.',
        'Summarize the result in Brooks-style terminology: trend, range, breakout, follow-through, failed breakout, channel, wedge, second entry, support/resistance, and invalidation.',
        'The model should make judgments and summaries, not replace the low-level structure recognizer.',
      ].join('\n\n'),
      safetyNotes: 'Do not place trades. Do not mutate cron state. If a request asks for execution, explain the analysis and note that trading tools are outside this skill policy.',
      examples: '- Analyze whether BTC is in trend resumption, trading range, or breakout mode.\n- Explain whether the latest setup looks like a failed breakout, wedge, channel, or second-entry opportunity.',
    }),
  },
  {
    dirName: 'ta-ict-smc',
    content: buildSkillTemplate({
      id: 'ta-ict-smc',
      label: 'ICT / SMC Structure',
      description: 'Use this skill whenever the user wants ICT or SMC framing: liquidity sweeps, fair value gaps, BOS, CHOCH, displacement, premium/discount, mitigation, or structure-based execution narrative. Trigger this skill even if the user asks indirectly for liquidity or imbalance analysis rather than naming ICT/SMC explicitly.',
      preferredTools: ['ictSmcAnalyze', 'ictSmc*', 'analysis*', 'market-search*'],
      toolAllow: ['ictSmcAnalyze', 'ictSmc*', 'analysis*', 'market-search*'],
      toolDeny: ['trading*', 'cronAdd', 'cronUpdate', 'cronRemove', 'cronRunNow'],
      outputSchema: ANALYSIS_REPORT_NAME,
      whenToUse: 'Use for ICT/SMC structure analysis, liquidity targeting, imbalance reading, displacement quality, and narrative framing around swing structure.',
      instructions: [
        'Run deterministic ICT/SMC structure tools first. Prefer ictSmcAnalyze as the main entry point, and use ictSmc* sub-tools when you need to inspect swings, liquidity, FVGs, or structure components directly.',
        'Focus the narrative on liquidity pools, liquidity sweeps, fair value gaps, imbalance, BOS, CHOCH, mitigation, premium/discount, and invalidation.',
        'Only consume structured signals plus the most recent 10 decision-window bars. Do not reason over long raw bar history.',
        'The model should synthesize the structured market story and propose bias, thesis, evidence, and invalidation in ICT/SMC terms rather than replacing the structure detector.',
      ].join('\n\n'),
      safetyNotes: 'Analysis only. Trading and cron mutation tools are denied in this mode.',
      examples: '- Identify likely buy-side or sell-side liquidity targets.\n- Explain whether a move is displacement into imbalance or a weak sweep likely to revert.',
    }),
  },
  {
    dirName: 'research-news-fundamental',
    content: buildSkillTemplate({
      id: 'research-news-fundamental',
      label: 'News & Fundamental Research',
      description: 'Use this skill whenever the user asks for news analysis, catalyst research, event-driven narrative, company fundamentals, theme research, or macro-to-market synthesis. Trigger it for requests about what moved a symbol, what matters this week, or what the current investment thesis should emphasize.',
      preferredTools: ['globNews', 'grepNews', 'readNews', 'market-search*', 'analysis*'],
      toolAllow: ['globNews', 'grepNews', 'readNews', 'market-search*', 'analysis*', 'equity*', 'news*'],
      toolDeny: ['trading*', 'cronAdd', 'cronUpdate', 'cronRemove', 'cronRunNow'],
      outputSchema: ANALYSIS_REPORT_NAME,
      whenToUse: 'Use for event-driven, news-led, and fundamental research workflows where deterministic retrieval matters more than free-form speculation.',
      instructions: [
        'Begin with retrieval: resolve the symbol or topic, search the news archive and/or market/news tools, then read the most relevant items.',
        'Use the model to rank, attribute, summarize, and connect retrieved evidence into a coherent thesis.',
        'Do not speculate beyond the retrieved evidence. Prefer explicit catalysts, revisions, valuation context, and source quality.',
        'If market bars are included, only reason over the latest 10 decision-window bars and keep price context secondary to the evidence set.',
      ].join('\n\n'),
      safetyNotes: 'Research only. Trading tools and cron mutation tools are denied.',
      examples: '- Summarize the latest catalysts affecting NVDA and explain whether they strengthen or weaken the thesis.\n- Pull recent macro headlines and explain which ones matter most for rates-sensitive equities.',
    }),
  },
  {
    dirName: 'ops-cron-maintainer',
    content: buildSkillTemplate({
      id: 'ops-cron-maintainer',
      label: 'Cron Maintainer',
      description: 'Use this skill whenever the user wants to inspect, debug, create, update, remove, or manually trigger scheduled jobs. This skill should win for requests mentioning cron, schedules, reminders, recurring tasks, job maintenance, or checking what automation is currently configured.',
      preferredTools: ['cronList', 'cronAdd', 'cronUpdate', 'cronRemove', 'cronRunNow'],
      toolAllow: ['cronList', 'cronAdd', 'cronUpdate', 'cronRemove', 'cronRunNow'],
      toolDeny: ['trading*'],
      outputSchema: 'CronOperationReport',
      whenToUse: 'Use for cron inventory, change review, troubleshooting, and maintenance of scheduled tasks.',
      instructions: [
        'Prefer cronList first whenever state is unclear.',
        'For any mutation request, explain the before/after state concisely and use the cron tools directly instead of describing hypothetical commands.',
        'Keep responses operational: current jobs, requested changes, results, and any follow-up checks.',
      ].join('\n\n'),
      safetyNotes: 'Trading tools are denied. News and analysis tools are not preferred in this mode and should be avoided unless the user explicitly asks for supporting context.',
      examples: '- List all cron jobs and point out which ones are disabled.\n- Update an existing job schedule and confirm the change.',
    }),
  },
  {
    dirName: 'docx-writer',
    content: buildSkillTemplate({
      id: 'docx-writer',
      label: 'DOCX Writer',
      description: 'Use this skill whenever the user wants a structured Word document, a .docx deliverable, or a polished report/memo/letter exported as DOCX. Trigger it even if the user asks for a report or template without saying DOCX explicitly, as long as the output is clearly a Word-style document.',
      preferredTools: [],
      toolDeny: ['trading*', 'cron*'],
      outputSchema: 'DocxResult',
      whenToUse: 'Use for generating structured document drafts and docx-oriented writing workflows.',
      instructions: 'Reuse the established DOCX authoring guidance from src/skills/createDocx.md. Favor structured sections, explicit document hierarchy, and docx-friendly content organization. If no dedicated docx export tool is available, produce a prompt-first structured draft that can be handed to a document generation step.',
      safetyNotes: 'Do not use trading or cron tools in this mode.',
      examples: '- Draft a board memo with headings, tables, and appendices intended for DOCX export.\n- Produce a structured proposal document that can be turned into a Word file.',
    }),
  },
]

export async function ensureDefaultSkillPacks(): Promise<void> {
  const defaultSkillsDir = getDefaultSkillsDir()
  await mkdir(defaultSkillsDir, { recursive: true })
  await Promise.all(DEFAULT_SKILL_TEMPLATES.map(async ({ dirName, content }) => {
    const skillDir = resolve(defaultSkillsDir, dirName)
    const filePath = resolve(skillDir, SKILL_FILE_NAME)
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

export function getSkillFileName(): string {
  return SKILL_FILE_NAME
}

export function inferSkillIdFromPath(filePath: string): string {
  if (basename(filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase()) {
    return basename(dirname(filePath))
  }
  return basename(filePath, '.md')
}
