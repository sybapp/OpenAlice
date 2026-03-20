import type { Engine } from '../../core/engine.js'
import {
  listTraderStrategyTemplates,
  parseTraderStrategy,
  renderTraderStrategyYaml,
} from './strategy.js'
import type {
  TraderStrategyGenerateInput,
  TraderStrategyGenerateResult,
  TraderStrategyTemplate,
} from './types.js'

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1]) return fence[1].trim()

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function getTemplateOrThrow(templateId: TraderStrategyGenerateInput['templateId']): TraderStrategyTemplate {
  const template = listTraderStrategyTemplates().find((entry) => entry.id === templateId)
  if (!template) {
    throw new Error(`Unknown strategy template: ${templateId}`)
  }
  return template
}

function buildGeneratePrompt(template: TraderStrategyTemplate, request: string): string {
  return [
    'You generate YAML-backed trader strategy drafts for OpenAlice.',
    'Return JSON only. Do not wrap the answer in markdown fences.',
    'The output must be a complete strategy object with exactly these top-level keys:',
    'id, label, enabled, sources, universe, timeframes, riskBudget, behaviorRules, executionPolicy',
    '',
    `Template: ${template.id} (${template.label})`,
    `Template description: ${template.description}`,
    '',
    'Base template draft:',
    JSON.stringify(template.defaults, null, 2),
    '',
    'User request:',
    request.trim() || '(none provided)',
    '',
    'Rules:',
    '- Preserve the overall structure of the template unless the user explicitly requests a different but still valid value.',
    '- Keep riskBudget and executionPolicy realistic and conservative.',
    '- Keep behaviorRules.preferences and behaviorRules.prohibitions concrete, concise, and actionable.',
    '- Use only supported order types: market, limit, stop, stop_limit, take_profit.',
    '- If the request includes concrete trigger or target levels, place them inside behaviorRules text items.',
    '- Do not invent unsupported fields.',
    '',
    'Return a single JSON object representing the final strategy draft.',
  ].join('\n')
}

export async function generateTraderStrategyDraft(
  engine: Engine,
  input: TraderStrategyGenerateInput,
): Promise<TraderStrategyGenerateResult> {
  const template = getTemplateOrThrow(input.templateId)
  const result = await engine.ask(buildGeneratePrompt(template, input.request))
  const candidate = extractJsonObject(result.text)
  if (!candidate) {
    throw new Error('AI did not return a valid strategy JSON object')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new Error('AI returned invalid JSON for the strategy draft')
  }

  const draft = parseTraderStrategy(parsed)
  return {
    draft,
    yamlPreview: renderTraderStrategyYaml(draft),
  }
}
