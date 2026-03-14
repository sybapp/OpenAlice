import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../api'
import type {
  CapabilityMcpInfo,
  CapabilityScriptInfo,
  CapabilitySkillInfo,
  CapabilityToolInfo,
} from '../api/tools'
import { Toggle } from '../components/Toggle'
import { SaveIndicator } from '../components/SaveIndicator'
import { useAutoSave } from '../hooks/useAutoSave'

const GROUP_LABELS: Record<string, string> = {
  thinking: 'Thinking Kit',
  brain: 'Brain',
  cron: 'Cron Scheduler',
}

interface ToolGroup {
  key: string
  label: string
  tools: CapabilityToolInfo[]
}

function sortToolsByName(tools: CapabilityToolInfo[]) {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name))
}

export function ToolsPage() {
  const [systemTools, setSystemTools] = useState<CapabilityToolInfo[]>([])
  const [skills, setSkills] = useState<CapabilitySkillInfo[]>([])
  const [scripts, setScripts] = useState<CapabilityScriptInfo[]>([])
  const [mcpExposed, setMcpExposed] = useState<CapabilityMcpInfo[]>([])
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const applyCapabilityData = useCallback((res: Awaited<ReturnType<typeof api.tools.load>>) => {
    setSystemTools(res.systemTools)
    setSkills(res.skills)
    setScripts(res.scripts)
    setMcpExposed(res.mcpExposed)
    setDisabled(new Set(res.disabledSystemTools))
    setLoaded(true)
  }, [])

  useEffect(() => {
    api.tools.load().then(applyCapabilityData).catch(() => {})
  }, [applyCapabilityData])

  const groups = useMemo<ToolGroup[]>(() => {
    const map = new Map<string, CapabilityToolInfo[]>()
    for (const tool of systemTools) {
      if (!map.has(tool.group)) map.set(tool.group, [])
      map.get(tool.group)!.push(tool)
    }
    return Array.from(map.entries()).map(([key, tools]) => ({
      key,
      label: GROUP_LABELS[key] ?? key,
      tools: sortToolsByName(tools),
    }))
  }, [systemTools])

  const summary = `${systemTools.length} system tools, ${skills.length} skills, ${scripts.length} scripts, ${mcpExposed.length} MCP entries`

  const configData = useMemo(
    () => ({ disabled: [...disabled].sort() }),
    [disabled],
  )

  const save = useCallback(async (data: { disabled: string[] }) => {
    await api.tools.update(data.disabled)
  }, [])

  const { status, retry } = useAutoSave({ data: configData, save, enabled: loaded })

  const toggleTool = useCallback((name: string) => {
    setDisabled((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleGroup = useCallback((tools: CapabilityToolInfo[], enable: boolean) => {
    setDisabled((prev) => {
      const next = new Set(prev)
      for (const tool of tools) {
        if (enable) next.delete(tool.name)
        else next.add(tool.name)
      }
      return next
    })
  }, [])

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="px-4 md:px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text">Capabilities</h2>
            <p className="text-[11px] text-text-muted mt-0.5">
              {summary}
            </p>
          </div>
          <SaveIndicator status={status} onRetry={retry} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        {!loaded ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (
          <div className="max-w-[860px] space-y-6">
            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-text">System Tools</h3>
                <p className="text-xs text-text-muted">Core runtime and admin tools that still live in ToolCenter.</p>
              </div>
              {groups.length === 0 ? (
                <p className="text-sm text-text-muted">No system tools registered.</p>
              ) : (
                groups.map((group) => (
                  <ToolGroupCard
                    key={group.key}
                    group={group}
                    disabled={disabled}
                    expanded={expanded.has(group.key)}
                    onToggleExpanded={() => toggleExpanded(group.key)}
                    onToggleTool={toggleTool}
                    onToggleGroup={toggleGroup}
                  />
                ))
              )}
            </section>

            <CapabilityListSection
              title="Script Skills"
              subtitle="Skill-loop entry points available to the runtime."
              empty="No skills registered."
              items={skills}
              getKey={(skill) => skill.id}
              renderTitle={(skill) => skill.label}
              renderDescription={(skill) => skill.description}
              renderMeta={(skill) => [skill.runtime, skill.stage, skill.userInvocable ? 'user-invocable' : 'internal'].filter(Boolean).join(' · ')}
            />

            <CapabilityListSection
              title="Scripts"
              subtitle="Deterministic scripts callable from skill loops."
              empty="No scripts registered."
              items={scripts}
              getKey={(script) => script.id}
              renderTitle={(script) => script.id}
              renderDescription={(script) => script.description}
              renderMeta={(script) => script.usedBy.length > 0 ? `Used by: ${script.usedBy.join(', ')}` : 'Not referenced by a skill'}
            />

            <CapabilityListSection
              title="MCP Exposed"
              subtitle="Capabilities available to external MCP clients."
              empty="No MCP capabilities exposed."
              items={mcpExposed}
              getKey={(entry) => entry.id}
              renderTitle={(entry) => entry.id}
              renderDescription={(entry) => entry.description}
              renderMeta={(entry) => entry.kind}
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface ToolGroupCardProps {
  group: ToolGroup
  disabled: Set<string>
  expanded: boolean
  onToggleExpanded: () => void
  onToggleTool: (name: string) => void
  onToggleGroup: (tools: CapabilityToolInfo[], enable: boolean) => void
}

function ToolGroupCard({
  group,
  disabled,
  expanded,
  onToggleExpanded,
  onToggleTool,
  onToggleGroup,
}: ToolGroupCardProps) {
  const enabledCount = group.tools.filter((tool) => !disabled.has(tool.name)).length
  const noneEnabled = enabledCount === 0

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-bg-secondary">
        <button
          onClick={onToggleExpanded}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="text-sm font-medium text-text truncate">{group.label}</span>
          <span className="text-[11px] text-text-muted shrink-0">
            {enabledCount}/{group.tools.length}
          </span>
        </button>
        <Toggle
          size="sm"
          checked={!noneEnabled}
          onChange={(value) => onToggleGroup(group.tools, value)}
        />
      </div>

      <div
        className={`transition-all duration-150 ${
          expanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        } overflow-hidden`}
      >
        <div className="divide-y divide-border">
          {group.tools.map((tool) => {
            const enabled = !disabled.has(tool.name)
            return (
              <div
                key={tool.name}
                className={`flex items-center gap-3 px-4 py-2 ${
                  enabled ? '' : 'opacity-50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-text font-mono">{tool.name}</span>
                  {tool.description && (
                    <p className="text-[11px] text-text-muted mt-0.5 line-clamp-1">
                      {tool.description}
                    </p>
                  )}
                </div>
                <Toggle
                  size="sm"
                  checked={enabled}
                  onChange={() => onToggleTool(tool.name)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface CapabilityListSectionProps<T> {
  title: string
  subtitle: string
  empty: string
  items: T[]
  getKey: (item: T) => string
  renderTitle: (item: T) => string
  renderDescription: (item: T) => string
  renderMeta: (item: T) => string
}

function CapabilityListSection<T>({
  title,
  subtitle,
  empty,
  items,
  getKey,
  renderTitle,
  renderDescription,
  renderMeta,
}: CapabilityListSectionProps<T>) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <p className="text-xs text-text-muted">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
          {items.map((item) => (
            <div key={getKey(item)} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-text font-medium">{renderTitle(item)}</span>
                <span className="text-[11px] text-text-muted shrink-0">{renderMeta(item)}</span>
              </div>
              <p className="text-[12px] text-text-muted mt-1">{renderDescription(item)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
