import { fetchJson, headers } from './client'
import type {
  CapabilityResponse,
  McpCapabilityInfo,
  ScriptCapabilityInfo,
  SkillCapabilityInfo,
  SystemToolInfo,
} from './types'

export type ToolInfo = SystemToolInfo
export type ToolsResponse = CapabilityResponse
export type CapabilityToolInfo = SystemToolInfo
export type CapabilitySkillInfo = SkillCapabilityInfo
export type CapabilityScriptInfo = ScriptCapabilityInfo
export type CapabilityMcpInfo = McpCapabilityInfo

export const toolsApi = {
  async load(): Promise<ToolsResponse> {
    return fetchJson('/api/tools')
  },

  async update(disabled: string[]): Promise<{ disabledSystemTools: string[] }> {
    return fetchJson('/api/tools', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ disabled }),
    })
  },
}
