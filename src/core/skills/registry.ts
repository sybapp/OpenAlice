import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { z } from 'zod'
import { ANALYSIS_REPORT_NAME } from './analysis-report.js'

const SKILL_FILE_NAME = 'SKILL.md'

type FrontmatterValue = string | number | boolean | FrontmatterObject | FrontmatterValue[]
type FrontmatterObject = Record<string, FrontmatterValue>

function getUserSkillsDir(): string {
  return resolve('data/skills')
}

function getDefaultSkillsDir(): string {
  return resolve('data/default/skills')
}

const normalizedSkillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  preferredTools: z.array(z.string()).default([]),
  toolAllow: z.array(z.string()).optional(),
  toolDeny: z.array(z.string()).optional(),
  outputSchema: z.string().default(ANALYSIS_REPORT_NAME),
  decisionWindowBars: z.number().int().positive().default(10),
  analysisMode: z.enum(['tool-first']).default('tool-first'),
  whenToUse: z.string().default(''),
  instructions: z.string().default(''),
  safetyNotes: z.string().default(''),
  examples: z.string().default(''),
  body: z.string(),
  sourcePath: z.string().min(1),
})

export type SkillPack = z.infer<typeof normalizedSkillSchema>

function parseScalar(rawValue: string): FrontmatterValue {
  const value = rawValue.trim()
  if (!value) return ''
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value)
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner
      ? inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      : []
  }
  return value.replace(/^['"]|['"]$/g, '')
}

function nextMeaningfulLine(lines: string[], start: number): { indent: number; trimmed: string } | null {
  for (let i = start; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return {
      indent: rawLine.match(/^\s*/)![0].length,
      trimmed,
    }
  }
  return null
}

function parseArray(lines: string[], startIndex: number, indent: number): { value: FrontmatterValue[]; nextIndex: number } {
  const value: FrontmatterValue[] = []
  let index = startIndex

  while (index < lines.length) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      index += 1
      continue
    }

    const currentIndent = rawLine.match(/^\s*/)![0].length
    if (currentIndent < indent) break
    if (currentIndent !== indent || !trimmed.startsWith('- ')) break

    value.push(parseScalar(trimmed.slice(2)))
    index += 1
  }

  return { value, nextIndex: index }
}

function parseObject(lines: string[], startIndex: number, indent: number): { value: FrontmatterObject; nextIndex: number } {
  const value: FrontmatterObject = {}
  let index = startIndex

  while (index < lines.length) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      index += 1
      continue
    }

    const currentIndent = rawLine.match(/^\s*/)![0].length
    if (currentIndent < indent) break
    if (currentIndent !== indent) {
      throw new Error(`Invalid frontmatter indentation near: ${trimmed}`)
    }

    const kvMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kvMatch) {
      throw new Error(`Invalid frontmatter entry: ${trimmed}`)
    }

    const [, key, rawValue] = kvMatch
    if (rawValue) {
      value[key] = parseScalar(rawValue)
      index += 1
      continue
    }

    const next = nextMeaningfulLine(lines, index + 1)
    if (!next || next.indent <= currentIndent) {
      value[key] = []
      index += 1
      continue
    }

    if (next.trimmed.startsWith('- ')) {
      const parsed = parseArray(lines, index + 1, next.indent)
      value[key] = parsed.value
      index = parsed.nextIndex
      continue
    }

    const parsed = parseObject(lines, index + 1, next.indent)
    value[key] = parsed.value
    index = parsed.nextIndex
  }

  return { value, nextIndex: index }
}

function parseFrontmatter(markdown: string): { frontmatter: FrontmatterObject; body: string } {
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
  const parsed = parseObject(rawFrontmatter.split('\n'), 0, 0)
  return { frontmatter: parsed.value, body }
}

function extractSection(body: string, heading: string): string {
  const normalizedHeading = heading.trim().toLowerCase()
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${normalizedHeading}`)
  if (start === -1) return ''
  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line.trim())) break
    collected.push(line)
  }
  return collected.join('\n').trim()
}

function extractFirstHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim() ?? ''
}

function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function asStringArray(value: FrontmatterValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function asObject(value: FrontmatterValue | undefined): FrontmatterObject | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  return value
}

function asNonEmptyString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizePluginSkill(frontmatter: FrontmatterObject, body: string, filePath: string): SkillPack {
  const name = asNonEmptyString(frontmatter.name)
  const description = asNonEmptyString(frontmatter.description)

  if (!name) {
    throw new Error('Plugin-style skill frontmatter must include a non-empty "name" field')
  }
  if (!description) {
    throw new Error('Plugin-style skill frontmatter must include a non-empty "description" field')
  }

  const compatibility = asObject(frontmatter.compatibility)
  const compatibilityTools = compatibility ? compatibility.tools : undefined
  const compatibilityToolObject = asObject(compatibilityTools)
  const whenToUse = extractSection(body, 'whenToUse') || extractSection(body, 'when to use')
  const instructions = extractSection(body, 'instructions') || extractSection(body, 'instruction') || body.trim()
  const safetyNotes = extractSection(body, 'safetyNotes') || extractSection(body, 'safety notes')
  const examples = extractSection(body, 'examples')

  const preferredTools = [
    ...asStringArray(frontmatter.preferredTools),
    ...asStringArray(compatibilityToolObject?.preferred),
  ]
  const toolAllow = [
    ...asStringArray(frontmatter.toolAllow),
    ...asStringArray(Array.isArray(compatibilityTools) ? compatibilityTools : undefined),
    ...asStringArray(compatibilityToolObject?.allow),
  ]
  const toolDeny = [
    ...asStringArray(frontmatter.toolDeny),
    ...asStringArray(compatibilityToolObject?.deny),
  ]

  const title = extractFirstHeading(body)
  return normalizedSkillSchema.parse({
    id: slugifySkillName(name),
    label: asNonEmptyString(frontmatter.label) ?? title ?? name,
    description,
    preferredTools: [...new Set(preferredTools)],
    toolAllow: toolAllow.length ? [...new Set(toolAllow)] : undefined,
    toolDeny: toolDeny.length ? [...new Set(toolDeny)] : undefined,
    outputSchema: asNonEmptyString(frontmatter.outputSchema) ?? ANALYSIS_REPORT_NAME,
    decisionWindowBars: typeof frontmatter.decisionWindowBars === 'number' ? frontmatter.decisionWindowBars : 10,
    analysisMode: 'tool-first',
    whenToUse,
    instructions,
    safetyNotes,
    examples,
    body,
    sourcePath: filePath,
  })
}

function normalizeLegacySkill(frontmatter: FrontmatterObject, body: string, filePath: string): SkillPack {
  const toolAllow = asStringArray(frontmatter.toolAllow)
  const toolDeny = asStringArray(frontmatter.toolDeny)

  return normalizedSkillSchema.parse({
    id: frontmatter.id,
    label: frontmatter.label,
    description: frontmatter.description,
    preferredTools: asStringArray(frontmatter.preferredTools),
    toolAllow: toolAllow.length ? toolAllow : undefined,
    toolDeny: toolDeny.length ? toolDeny : undefined,
    outputSchema: asNonEmptyString(frontmatter.outputSchema) ?? ANALYSIS_REPORT_NAME,
    decisionWindowBars: typeof frontmatter.decisionWindowBars === 'number' ? frontmatter.decisionWindowBars : 10,
    analysisMode: 'tool-first',
    whenToUse: extractSection(body, 'whenToUse'),
    instructions: extractSection(body, 'instructions'),
    safetyNotes: extractSection(body, 'safetyNotes'),
    examples: extractSection(body, 'examples'),
    body,
    sourcePath: filePath,
  })
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
  try {
    const markdown = await readFile(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(markdown)
    if ('name' in frontmatter) {
      return normalizePluginSkill(frontmatter, body, filePath)
    }
    return normalizeLegacySkill(frontmatter, body, filePath)
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load skill at ${filePath}: ${error.message}`)
    }
    throw error
  }
}

export async function listSkillPacks(): Promise<SkillPack[]> {
  const [defaultFiles, userFiles] = await Promise.all([
    listSkillFiles(getDefaultSkillsDir()),
    listSkillFiles(getUserSkillsDir()),
  ])
  const [defaultPacks, userPacks] = await Promise.all([
    Promise.all(defaultFiles.map((filePath) => readSkillFile(filePath))),
    Promise.all(userFiles.map((filePath) => readSkillFile(filePath))),
  ])

  const packs = new Map<string, SkillPack>()
  for (const pack of defaultPacks) {
    packs.set(pack.id, pack)
  }
  for (const pack of userPacks) {
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
    `name: ${params.id}`,
    `description: ${params.description}`,
    'compatibility:',
    '  tools:',
    ...(params.preferredTools.length ? ['    preferred:', ...params.preferredTools.map((tool) => `      - ${tool}`)] : []),
    ...(params.toolAllow?.length ? ['    allow:', ...params.toolAllow.map((tool) => `      - ${tool}`)] : []),
    ...(params.toolDeny?.length ? ['    deny:', ...params.toolDeny.map((tool) => `      - ${tool}`)] : []),
    `outputSchema: ${params.outputSchema}`,
    `decisionWindowBars: ${params.decisionWindowBars ?? 10}`,
    `analysisMode: ${params.analysisMode ?? 'tool-first'}`,
    '---',
  ].join('\n')

  return [
    frontmatter,
    `# ${params.label}`,
    '',
    '## When to use',
    params.whenToUse,
    '',
    '## Instructions',
    params.instructions,
    '',
    '## Safety notes',
    params.safetyNotes,
    '',
    '## Examples',
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
