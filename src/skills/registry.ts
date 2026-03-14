import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { z } from 'zod'
import { ANALYSIS_REPORT_NAME } from './analysis-report.js'

const SKILL_FILE_NAME = 'SKILL.md'

type FrontmatterValue = string | number | boolean | FrontmatterObject | FrontmatterValue[]
type FrontmatterObject = Record<string, FrontmatterValue>

function getUserSkillsDir(): string {
  return resolve('runtime/skills')
}

function getDefaultSkillsDir(): string {
  return resolve('defaults/skills')
}

const normalizedSkillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  runtime: z.enum(['tool-loop', 'script-loop']).default('tool-loop'),
  userInvocable: z.boolean().default(true),
  stage: z.string().optional(),
  preferredTools: z.array(z.string()).default([]),
  toolAllow: z.array(z.string()).optional(),
  toolDeny: z.array(z.string()).optional(),
  allowedScripts: z.array(z.string()).default([]),
  outputSchema: z.string().default(ANALYSIS_REPORT_NAME),
  decisionWindowBars: z.number().int().positive().default(10),
  analysisMode: z.enum(['tool-first']).default('tool-first'),
  whenToUse: z.string().default(''),
  instructions: z.string().default(''),
  safetyNotes: z.string().default(''),
  examples: z.string().default(''),
  resources: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
  })).default([]),
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

function asBoolean(value: FrontmatterValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

async function listSkillResources(filePath: string) {
  const skillDir = dirname(filePath)
  const entries = await readdir(skillDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== SKILL_FILE_NAME)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const resources = await Promise.all(files.map(async (name) => {
    const path = resolve(skillDir, name)
    const content = await readFile(path, 'utf-8')
    return {
      id: basename(name, '.md'),
      path,
      content,
    }
  }))

  return resources
}

async function normalizePluginSkill(frontmatter: FrontmatterObject, body: string, filePath: string): Promise<SkillPack> {
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
  const runtime = asNonEmptyString(frontmatter.runtime) === 'script-loop' ? 'script-loop' : 'tool-loop'
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
  const resources = await listSkillResources(filePath)
  return normalizedSkillSchema.parse({
    id: slugifySkillName(name),
    label: asNonEmptyString(frontmatter.label) ?? title ?? name,
    description,
    runtime,
    userInvocable: asBoolean(frontmatter['user-invocable'], true),
    stage: asNonEmptyString(frontmatter.stage),
    preferredTools: [...new Set(preferredTools)],
    toolAllow: toolAllow.length ? [...new Set(toolAllow)] : undefined,
    toolDeny: toolDeny.length ? [...new Set(toolDeny)] : undefined,
    allowedScripts: [...new Set(asStringArray(frontmatter.scripts))],
    outputSchema: asNonEmptyString(frontmatter.outputSchema) ?? ANALYSIS_REPORT_NAME,
    decisionWindowBars: typeof frontmatter.decisionWindowBars === 'number' ? frontmatter.decisionWindowBars : 10,
    analysisMode: 'tool-first',
    whenToUse,
    instructions,
    safetyNotes,
    examples,
    resources,
    body,
    sourcePath: filePath,
  })
}

async function normalizeLegacySkill(frontmatter: FrontmatterObject, body: string, filePath: string): Promise<SkillPack> {
  const toolAllow = asStringArray(frontmatter.toolAllow)
  const toolDeny = asStringArray(frontmatter.toolDeny)
  const resources = await listSkillResources(filePath)

  return normalizedSkillSchema.parse({
    id: frontmatter.id,
    label: frontmatter.label,
    description: frontmatter.description,
    runtime: asNonEmptyString(frontmatter.runtime) === 'script-loop' ? 'script-loop' : 'tool-loop',
    userInvocable: asBoolean(frontmatter['user-invocable'], true),
    stage: asNonEmptyString(frontmatter.stage),
    preferredTools: asStringArray(frontmatter.preferredTools),
    toolAllow: toolAllow.length ? toolAllow : undefined,
    toolDeny: toolDeny.length ? toolDeny : undefined,
    allowedScripts: [...new Set(asStringArray(frontmatter.scripts))],
    outputSchema: asNonEmptyString(frontmatter.outputSchema) ?? ANALYSIS_REPORT_NAME,
    decisionWindowBars: typeof frontmatter.decisionWindowBars === 'number' ? frontmatter.decisionWindowBars : 10,
    analysisMode: 'tool-first',
    whenToUse: extractSection(body, 'whenToUse'),
    instructions: extractSection(body, 'instructions'),
    safetyNotes: extractSection(body, 'safetyNotes'),
    examples: extractSection(body, 'examples'),
    resources,
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
      return await normalizePluginSkill(frontmatter, body, filePath)
    }
    return await normalizeLegacySkill(frontmatter, body, filePath)
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

function buildScriptSkillTemplate(params: {
  id: string
  label: string
  description: string
  scripts: string[]
  stage?: string
  userInvocable?: boolean
  outputSchema: string
  whenToUse: string
  instructions: string
  safetyNotes: string
}): string {
  const frontmatter = [
    '---',
    `name: ${params.id}`,
    `description: ${params.description}`,
    'runtime: script-loop',
    ...(params.stage ? [`stage: ${params.stage}`] : []),
    `user-invocable: ${params.userInvocable ?? true}`,
    'scripts:',
    ...params.scripts.map((script) => `  - ${script}`),
    `outputSchema: ${params.outputSchema}`,
    'decisionWindowBars: 10',
    'analysisMode: tool-first',
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
  ].join('\n')
}

const DEFAULT_SKILL_TEMPLATES: Array<{ dirName: string; content: string }> = [
  {
    dirName: 'ta-brooks',
    content: buildScriptSkillTemplate({
      id: 'ta-brooks',
      label: 'Brooks Price Action',
      description: 'Use this skill for Brooks-style price action reading. It should request deterministic scripts for market structure, then explain trend, range, breakout, and invalidation in plain language.',
      scripts: ['analysis-brooks', 'analysis-indicator', 'research-market-search'],
      outputSchema: 'ChatResponse',
      whenToUse: 'Use for price action, candle structure, trend-versus-range judgment, breakout follow-through, and Brooks-style trade narrative. This skill is for reading the market, not for placing orders.',
      instructions: [
        'Treat this skill as a script-guided workflow. Request scripts when you need market structure or confirmation data, then synthesize the returned structure into a concise human answer.',
        'Start with analysis-brooks unless the symbol is unclear. Use research-market-search first when you need to resolve the correct symbol. Use analysis-indicator only for a narrow confirmation question.',
      ].join('\n\n'),
      safetyNotes: 'Analysis only. Do not place trades or mutate unrelated system state.',
    }),
  },
  {
    dirName: 'ta-ict-smc',
    content: buildScriptSkillTemplate({
      id: 'ta-ict-smc',
      label: 'ICT / SMC Structure',
      description: 'Use this skill for ICT/SMC framing. It should request deterministic scripts for swings, liquidity, imbalance, and invalidation context before explaining the setup.',
      scripts: ['analysis-ict-smc', 'analysis-indicator', 'research-market-search'],
      outputSchema: 'ChatResponse',
      whenToUse: 'Use for ICT/SMC structure analysis, liquidity targeting, imbalance reading, displacement quality, and narrative framing around swing structure.',
      instructions: [
        'Request analysis-ict-smc first once the symbol is known. Use research-market-search only to resolve the symbol and analysis-indicator only for a narrow confirmation question.',
        'Explain the returned structure in ICT/SMC terms and keep the answer grounded in the script output.',
      ].join('\n\n'),
      safetyNotes: 'Analysis only. Do not place trades or mutate unrelated system state.',
    }),
  },
  {
    dirName: 'ta-brooks-ict-smc',
    content: buildScriptSkillTemplate({
      id: 'ta-brooks-ict-smc',
      label: 'Brooks + ICT / SMC Confluence',
      description: 'Use this skill when the user wants Brooks and ICT/SMC confluence. It should request the aggregate structure scripts and explain where they agree or disagree.',
      scripts: ['analysis-brooks', 'analysis-ict-smc', 'analysis-indicator', 'research-market-search'],
      outputSchema: 'ChatResponse',
      whenToUse: 'Use for multi-framework market reading where price action context and liquidity-structure context both matter. This skill is for confluence analysis, not execution.',
      instructions: [
        'Request the Brooks and ICT/SMC scripts, then synthesize one narrative that highlights agreement, disagreement, and invalidation.',
        'Use analysis-indicator only for targeted confirmation and research-market-search only when the symbol must be resolved first.',
      ].join('\n\n'),
      safetyNotes: 'Analysis only. Do not place trades or mutate unrelated system state.',
    }),
  },
  {
    dirName: 'research-news-fundamental',
    content: buildScriptSkillTemplate({
      id: 'research-news-fundamental',
      label: 'News & Fundamental Research',
      description: 'Use this skill for news, catalyst, and fundamentals-driven research. It should request only the relevant research scripts, then synthesize them into a concise thesis.',
      scripts: [
        'research-market-search',
        'research-news-company',
        'research-news-world',
        'research-equity-profile',
        'research-equity-financials',
        'research-equity-ratios',
        'research-equity-estimates',
      ],
      outputSchema: 'ChatResponse',
      whenToUse: 'Use for event-driven, news-led, and fundamental research workflows where deterministic retrieval matters more than free-form speculation.',
      instructions: [
        'Request only the scripts you need. Use company news for symbol-specific questions, world news for macro context, and the equity scripts for profile, financials, ratios, or estimates.',
        'If the symbol is unclear, resolve it first. Synthesize script results into a grounded answer and do not speculate beyond the returned evidence.',
      ].join('\n\n'),
      safetyNotes: 'Research only. Do not place trades or mutate unrelated system state.',
    }),
  },
  {
    dirName: 'trader-market-scan',
    content: buildScriptSkillTemplate({
      id: 'trader-market-scan',
      label: 'Trader Market Scan',
      description: 'Use this stage skill to scan the configured universe, request deterministic structure or research scripts, and nominate the best candidate symbols for the current run.',
      stage: 'market-scan',
      scripts: ['trader-account-state', 'analysis-brooks', 'analysis-ict-smc', 'research-news-company', 'research-news-world', 'research-equity-profile'],
      userInvocable: false,
      outputSchema: 'TraderMarketScan',
      whenToUse: 'Use only as the first stage of the trader pipeline.',
      instructions: 'Scan the configured universe, request only the scripts needed to rank candidates, and return a small list of the best symbols to study next.',
      safetyNotes: 'Do not build orders or execute trades in this stage.',
    }),
  },
  {
    dirName: 'trader-trade-thesis',
    content: buildScriptSkillTemplate({
      id: 'trader-trade-thesis',
      label: 'Trader Trade Thesis',
      description: 'Use this stage skill to request analysis or research scripts for one candidate symbol, then produce a structured trade thesis with scenario, bias, rationale, and invalidation.',
      stage: 'trade-thesis',
      scripts: ['trader-account-state', 'analysis-brooks', 'analysis-ict-smc', 'analysis-indicator', 'research-news-company', 'research-news-world', 'research-equity-profile', 'research-equity-financials', 'research-equity-ratios', 'research-equity-estimates'],
      userInvocable: false,
      outputSchema: 'TraderTradeThesis',
      whenToUse: 'Use only after market scan has selected a candidate symbol.',
      instructions: 'Request only the scripts required to explain the setup. Produce one thesis for one symbol and prefer no-trade when structure or catalyst context is mixed.',
      safetyNotes: 'Do not propose orders in this stage.',
    }),
  },
  {
    dirName: 'trader-risk-check',
    content: buildScriptSkillTemplate({
      id: 'trader-risk-check',
      label: 'Trader Risk Check',
      description: 'Use this stage skill to decide whether a thesis can proceed under the strategy risk budget and current account exposure.',
      stage: 'risk-check',
      scripts: ['trader-account-state'],
      userInvocable: false,
      outputSchema: 'TraderRiskCheck',
      whenToUse: 'Use only after a trade thesis exists.',
      instructions: 'Use fresh account state and the strategy risk card to decide pass, fail, or reduce. Be conservative when exposure is already stretched.',
      safetyNotes: 'Do not create or execute orders in this stage.',
    }),
  },
  {
    dirName: 'trader-trade-plan',
    content: buildScriptSkillTemplate({
      id: 'trader-trade-plan',
      label: 'Trader Trade Plan',
      description: 'Use this stage skill to convert an approved thesis into a deterministic order plan and explicit commit message.',
      stage: 'trade-plan',
      scripts: ['trader-account-state'],
      userInvocable: false,
      outputSchema: 'TraderTradePlan',
      whenToUse: 'Use only after risk-check passes.',
      instructions: 'Translate the thesis into a precise plan. Respect execution policy exactly. If no valid order plan fits the strategy, return skip.',
      safetyNotes: 'Do not execute the plan in this stage.',
    }),
  },
  {
    dirName: 'trader-trade-execute',
    content: buildScriptSkillTemplate({
      id: 'trader-trade-execute',
      label: 'Trader Trade Execute',
      description: 'Use this stage skill to confirm or abort an already-built deterministic trade plan. The actual execution is performed by a separate script after confirmation.',
      stage: 'trade-execute',
      scripts: [],
      userInvocable: false,
      outputSchema: 'TraderTradeExecute',
      whenToUse: 'Use only after a trade plan exists.',
      instructions: 'Read the plan and decide whether to execute it exactly as written or abort it. Do not redesign the plan here.',
      safetyNotes: 'You do not execute trades directly. You only confirm or abort.',
    }),
  },
  {
    dirName: 'trader-trade-review',
    content: buildScriptSkillTemplate({
      id: 'trader-trade-review',
      label: 'Trader Trade Review',
      description: 'Use this stage skill to summarize recent trading outcomes and produce a Brain update for the next run.',
      stage: 'trade-review',
      scripts: ['trader-review-summaries'],
      userInvocable: false,
      outputSchema: 'TraderTradeReview',
      whenToUse: 'Use for scheduled or manual post-trade review.',
      instructions: 'Read the structured summaries, identify what mattered, and produce a concise review plus a Brain update that will be useful next time.',
      safetyNotes: 'Review only. Do not create or execute trades in this stage.',
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
