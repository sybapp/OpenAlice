import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_SIGNAL_ENGINE_RISK_TEMPLATES_PATH = 'data/signal-engine/risk-templates.jsonl'

export interface SignalEngineRiskTemplateRecord {
  id: string
  version: string
  createdAt: string
  template: Record<string, unknown>
  templateHash: string
}

export interface AppendSignalEngineRiskTemplateInput {
  id?: string
  version: string
  template: Record<string, unknown>
  now?: () => Date
}

export class SignalEngineRiskTemplateStore {
  constructor(private readonly path = DEFAULT_SIGNAL_ENGINE_RISK_TEMPLATES_PATH) {}

  async list(): Promise<{ count: number; entries: SignalEngineRiskTemplateRecord[] }> {
    const entries = await this.read()
    return {
      count: entries.length,
      entries: entries.sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version)),
    }
  }

  async append(input: AppendSignalEngineRiskTemplateInput): Promise<SignalEngineRiskTemplateRecord> {
    const entries = await this.read()
    const id = input.id ?? randomUUID()
    if (entries.some((entry) => entry.id === id && entry.version === input.version)) {
      throw new Error(`Risk template version already exists: ${id}@${input.version}`)
    }
    const record: SignalEngineRiskTemplateRecord = {
      id,
      version: input.version,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      template: input.template,
      templateHash: hashTemplate(input.template),
    }
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf-8')
    return record
  }

  private async read(): Promise<SignalEngineRiskTemplateRecord[]> {
    try {
      const raw = await readFile(this.path, 'utf-8')
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseRiskTemplate(line))
        .filter((record): record is SignalEngineRiskTemplateRecord => record !== null)
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }
}

function parseRiskTemplate(line: string): SignalEngineRiskTemplateRecord | null {
  try {
    const value = JSON.parse(line) as Partial<SignalEngineRiskTemplateRecord>
    if (!value.id || !value.version || !value.createdAt || !value.template || !value.templateHash) return null
    return {
      id: value.id,
      version: value.version,
      createdAt: value.createdAt,
      template: value.template,
      templateHash: value.templateHash,
    }
  } catch {
    return null
  }
}

function hashTemplate(template: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortJson(template))).digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
