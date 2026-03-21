import {
  getSkillScript,
  type AnySkillScriptModule,
  type SkillScriptContext,
} from './script-registry.js'

export function requireSkillScript(id: string): AnySkillScriptModule {
  const script = getSkillScript(id)
  if (!script) {
    throw new Error(`Missing skill script: ${id}`)
  }
  return script
}

export async function executeSkillScript(params: {
  scriptId: string
  context: SkillScriptContext
  input: unknown
}): Promise<{ script: AnySkillScriptModule; parsedInput: unknown; output: unknown }> {
  const script = requireSkillScript(params.scriptId)
  const parsedInput = script.inputSchema.parse(params.input)
  const output = await script.run(params.context, parsedInput)
  return { script, parsedInput, output }
}
