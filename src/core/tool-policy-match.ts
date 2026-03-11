function normalize(value: string): string {
  return value.trim().toLowerCase()
}

type CompiledGlobPattern =
  | { kind: 'all' }
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; value: RegExp }

export type GlobPolicyMatcher = (values: string[]) => boolean

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileGlobPatterns(patterns?: string[]): CompiledGlobPattern[] {
  if (!Array.isArray(patterns)) return []

  return patterns
    .map((rawPattern) => {
      const normalized = normalize(rawPattern)
      if (!normalized) return { kind: 'exact', value: '' } as const
      if (normalized === '*') return { kind: 'all' } as const
      if (!normalized.includes('*')) return { kind: 'exact', value: normalized } as const
      const regexSource = '^' + escapeRegex(normalized).replaceAll('\\*', '.*') + '$'
      return {
        kind: 'regex',
        value: new RegExp(regexSource),
      } as const
    })
    .filter((pattern) => pattern.kind !== 'exact' || pattern.value)
}

function matchesAnyGlobPattern(value: string, patterns: CompiledGlobPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === 'all') return true
    if (pattern.kind === 'exact' && value === pattern.value) return true
    if (pattern.kind === 'regex' && pattern.value.test(value)) return true
  }
  return false
}

export function createGlobPolicyMatcher(patterns?: string[]): GlobPolicyMatcher {
  const compiled = compileGlobPatterns(patterns)
  if (compiled.length === 0) {
    return () => false
  }
  return (values: string[]) => values.map(normalize).some((value) => matchesAnyGlobPattern(value, compiled))
}
