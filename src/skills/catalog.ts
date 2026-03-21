import { listSkillPacks, type SkillRuntime } from './registry.js'
import { listSkillScripts } from './script-registry.js'

export interface SkillCatalogSkill {
  id: string
  label: string
  description: string
  runtime: SkillRuntime
  userInvocable: boolean
  stage?: string
  resources: string[]
  allowedScripts: string[]
}

export interface SkillCatalogScript {
  id: string
  description: string
  inputGuide?: string
  usedBy: string[]
}

export interface SkillCatalog {
  skills: SkillCatalogSkill[]
  scripts: SkillCatalogScript[]
  userInvocableSkills: SkillCatalogSkill[]
  mcpExposedSkills: SkillCatalogSkill[]
}

function toSkillCatalogSkill(skill: Awaited<ReturnType<typeof listSkillPacks>>[number]): SkillCatalogSkill {
  const resources = Array.isArray(skill.resources) ? skill.resources.map((resource) => resource.id) : []
  const allowedScripts = Array.isArray(skill.allowedScripts) ? [...skill.allowedScripts] : []

  return {
    id: skill.id,
    label: skill.label,
    description: skill.description,
    runtime: skill.runtime,
    userInvocable: skill.userInvocable !== false,
    ...(skill.stage ? { stage: skill.stage } : {}),
    resources,
    allowedScripts,
  }
}

function buildScriptUsageMap(skills: SkillCatalogSkill[]) {
  const scriptToSkills = new Map<string, string[]>()

  for (const skill of skills) {
    for (const scriptId of skill.allowedScripts) {
      const usedBy = scriptToSkills.get(scriptId) ?? []
      usedBy.push(skill.id)
      scriptToSkills.set(scriptId, usedBy)
    }
  }

  return scriptToSkills
}

export async function buildSkillCatalog(): Promise<SkillCatalog> {
  const skills = (await listSkillPacks()).map(toSkillCatalogSkill)
  const scriptUsage = buildScriptUsageMap(skills)
  const scripts = listSkillScripts().map((script) => ({
    id: script.id,
    description: script.description,
    ...(script.inputGuide ? { inputGuide: script.inputGuide } : {}),
    usedBy: scriptUsage.get(script.id) ?? [],
  }))
  const userInvocableSkills = skills.filter((skill) => skill.userInvocable)
  const mcpExposedSkills = userInvocableSkills.filter((skill) => skill.runtime === 'agent-skill')

  return {
    skills,
    scripts,
    userInvocableSkills,
    mcpExposedSkills,
  }
}

export async function getUserInvocableSkill(id: string): Promise<SkillCatalogSkill | null> {
  const catalog = await buildSkillCatalog()
  return catalog.userInvocableSkills.find((skill) => skill.id === id) ?? null
}
