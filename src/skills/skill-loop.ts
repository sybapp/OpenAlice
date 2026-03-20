import { randomUUID } from 'node:crypto'
import type { MediaAttachment } from '../core/types.js'
import type { AgentCenter } from '../core/agent-center.js'
import type { EngineAskOptions, EngineResult } from '../core/engine.js'
import type { SessionEntry, SessionStore } from '../core/session.js'
import { getCompletionSchema } from './completion-schemas.js'
import type { SkillPack } from './registry.js'
import { getSkillPack } from './registry.js'
import { getSessionSkillId } from './session-skill.js'
import { getSkillScript, listSkillScripts, type SkillScriptContext } from './script-registry.js'
import { omitHiddenInvocationFields } from '../core/source-alias.js'

const skillLoopEnvelope = {
  requestScripts: {
    type: 'request_scripts',
    calls: [{ id: 'script-id', input: { key: 'value' } }],
  },
  requestResources: {
    type: 'request_resources',
    ids: ['workflow'],
  },
  complete: {
    type: 'complete',
    output: { text: 'final answer or schema object' },
  },
}

class MemorySessionStore {
  private lastUuid: string | null

  constructor(
    readonly id: string,
    private readonly entries: SessionEntry[],
  ) {
    this.lastUuid = entries[entries.length - 1]?.uuid ?? null
  }

  async appendUser(content: string | SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'human', metadata?: Record<string, unknown>) {
    const entry: SessionEntry = {
      type: 'user',
      message: { role: 'user', content },
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      provider,
      ...(metadata ? { metadata } : {}),
    }
    this.entries.push(entry)
    this.lastUuid = entry.uuid
    return entry
  }

  async appendAssistant(content: string | SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'engine', metadata?: Record<string, unknown>) {
    const entry: SessionEntry = {
      type: 'assistant',
      message: { role: 'assistant', content },
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      provider,
      ...(metadata ? { metadata } : {}),
    }
    this.entries.push(entry)
    this.lastUuid = entry.uuid
    return entry
  }

  async appendSystem(content: string | SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'engine', metadata?: Record<string, unknown>) {
    const entry: SessionEntry = {
      type: 'system',
      message: { role: 'system', content },
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      provider,
      ...(metadata ? { metadata } : {}),
    }
    this.entries.push(entry)
    this.lastUuid = entry.uuid
    return entry
  }

  async appendRaw(entry: SessionEntry) {
    this.entries.push(entry)
    this.lastUuid = entry.uuid
  }

  async readAll() { return [...this.entries] }
  async readActive() { return [...this.entries] }
  async restore() {}
  async exists() { return this.entries.length > 0 }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function parseLoopResponse(text: string): unknown {
  const candidate = extractJsonObject(text)
  if (!candidate) {
    throw new Error('Skill loop response must contain JSON')
  }
  return JSON.parse(candidate)
}

function normalizeLoopResponse(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unsupported skill loop response: ${JSON.stringify(parsed)}`)
  }

  const record = parsed as Record<string, unknown>
  if (typeof record.type === 'string') {
    return record
  }

  const wrappedKeys = [
    'requestScripts',
    'request_scripts',
    'requestResources',
    'request_resources',
    'complete',
  ] as const

  for (const key of wrappedKeys) {
    const value = record[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }

  throw new Error(`Unsupported skill loop response: ${JSON.stringify(parsed)}`)
}

function buildSkillLoopPrompt(params: {
  skill: SkillPack
  task: string
  invocation: Record<string, unknown>
  allowedScripts: string[]
  loadedResources: Array<{ id: string; content: string }>
  scriptResults: Array<{ id: string; input: unknown; output: unknown }>
}): string {
  const publicInvocation = omitHiddenInvocationFields(params.invocation)
  const availableScripts = listSkillScripts(params.allowedScripts).map((script) => ({
    id: script.id,
    description: script.description,
    ...(script.inputGuide ? { inputGuide: script.inputGuide } : {}),
  }))
  const availableResources = params.skill.resources.map((resource) => resource.id)

  return [
    `Task:\n${params.task}`,
    '',
    params.skill.stage ? `Stage: ${params.skill.stage}` : '',
    Object.keys(publicInvocation).length > 0 ? `Invocation context:\n${JSON.stringify(publicInvocation, null, 2)}` : '',
    availableResources.length > 0
      ? `Supporting resources available on request:\n${availableResources.join(', ')}`
      : 'No supporting resources are available for this skill.',
    availableScripts.length > 0
      ? `Scripts available on request:\n${JSON.stringify(availableScripts, null, 2)}`
      : 'No scripts are available; complete the task directly.',
    params.loadedResources.length > 0
      ? `Loaded supporting resources:\n${params.loadedResources.map((resource) => `## ${resource.id}\n${resource.content}`).join('\n\n')}`
      : '',
    params.scriptResults.length > 0
      ? `Script results so far:\n${params.scriptResults.map((result, index) => `#${index + 1} ${result.id}\nInput:\n${JSON.stringify(result.input, null, 2)}\nOutput:\n${JSON.stringify(result.output, null, 2)}`).join('\n\n')}`
      : '',
    'Script input rules:\n- Every script call input must be a JSON object that matches the script schema exactly.\n- Never use positional arrays as a shortcut for named objects.\n- For timeframe-style inputs, always send named keys (for example: {"context":"1h","structure":"15m","execution":"5m"}), never ["1h","15m","5m"].\n- If the task already fixes a literal field such as asset=crypto, reuse that exact literal value.',
    'Respond with JSON only. Use exactly one of these envelopes:',
    JSON.stringify(skillLoopEnvelope, null, 2),
  ].filter(Boolean).join('\n\n')
}

function renderCompletion(skill: SkillPack, output: unknown): EngineResult {
  if (skill.outputSchema === 'ChatResponse' && output && typeof output === 'object' && 'text' in (output as Record<string, unknown>)) {
    return { text: String((output as Record<string, unknown>).text ?? ''), media: [] }
  }
  if (typeof output === 'string') {
    return { text: output, media: [] }
  }
  return { text: JSON.stringify(output, null, 2), media: [] }
}

export class SkillLoopRunner {
  constructor(
    private agentCenter: AgentCenter,
    private baseContext: Omit<SkillScriptContext, 'invocation'>,
  ) {}

  async getActiveScriptSkill(session: SessionStore): Promise<SkillPack | null> {
    const skillId = await getSessionSkillId(session)
    if (!skillId) return null
    const skill = await getSkillPack(skillId)
    return skill?.runtime === 'script-loop' ? skill : null
  }

  async run(prompt: string, session: SessionStore, opts?: EngineAskOptions): Promise<EngineResult> {
    const skill = await this.getActiveScriptSkill(session)
    if (!skill) {
      throw new Error('No active script-loop skill')
    }

    const completionSchema = getCompletionSchema(skill.outputSchema)
    const baseEntries = await session.readActive()
    const workingSession = new MemorySessionStore(session.id, [...baseEntries])
    const loadedResources: Array<{ id: string; content: string }> = []
    const scriptResults: Array<{ id: string; input: unknown; output: unknown }> = []
    const invocation = (opts?.skillContext ?? {}) as Record<string, unknown>
    const requestedScriptIds = Array.isArray(invocation.allowedScripts)
      ? invocation.allowedScripts.filter((value): value is string => typeof value === 'string')
      : null
    const allowedScripts = requestedScriptIds
      ? skill.allowedScripts.filter((id) => requestedScriptIds.includes(id))
      : skill.allowedScripts
    const maxIterations = 8

    await session.appendUser(prompt, 'human')

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const result = await this.agentCenter.askWithSession(
        buildSkillLoopPrompt({ skill, task: prompt, invocation, allowedScripts, loadedResources, scriptResults }),
        workingSession as unknown as SessionStore,
        {
          appendSystemPrompt: opts?.appendSystemPrompt,
          historyPreamble: opts?.historyPreamble,
          maxHistoryEntries: opts?.maxHistoryEntries,
          systemPrompt: opts?.systemPrompt,
        },
      )

      const parsed = normalizeLoopResponse(parseLoopResponse(result.text))
      if (parsed.type === 'request_resources') {
        const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String) : []
        for (const id of ids) {
          const resource = skill.resources.find((entry) => entry.id === id)
          if (!resource) {
            throw new Error(`Unknown skill resource requested: ${id}`)
          }
          if (!loadedResources.some((entry) => entry.id === id)) {
            loadedResources.push({ id, content: resource.content })
          }
        }
        continue
      }

      if (parsed.type === 'request_scripts') {
        const calls = Array.isArray(parsed.calls) ? parsed.calls : []
        for (const call of calls) {
          const id = typeof call === 'object' && call && 'id' in call ? String((call as Record<string, unknown>).id) : ''
          const input = typeof call === 'object' && call && 'input' in call ? (call as Record<string, unknown>).input : {}
          if (!allowedScripts.includes(id)) {
            throw new Error(`Skill ${skill.id} cannot execute script: ${id}`)
          }
          const script = getSkillScript(id)
          if (!script) {
            throw new Error(`Unknown script requested: ${id}`)
          }
          const parsedInput = script.inputSchema.parse(input)
          const output = await script.run({ ...this.baseContext, invocation }, parsedInput)
          scriptResults.push({ id, input: parsedInput, output })
        }
        continue
      }

      if (parsed.type === 'complete') {
        const output = completionSchema ? completionSchema.parse(parsed.output) : parsed.output
        const finalResult = renderCompletion(skill, output)
        await session.appendAssistant(finalResult.text, 'engine', {
          kind: 'skill_loop',
          skillId: skill.id,
        })
        return finalResult
      }

      throw new Error(`Unsupported skill loop response: ${JSON.stringify(parsed)}`)
    }

    throw new Error(`Skill loop exceeded ${maxIterations} iterations for ${skill.id}`)
  }
}
