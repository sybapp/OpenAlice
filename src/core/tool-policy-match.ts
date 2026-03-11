import { compileGlobPatterns, matchesAnyGlobPattern } from '../openclaw/agents/glob-pattern.js'

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export type GlobPolicyMatcher = (values: string[]) => boolean

export function createGlobPolicyMatcher(patterns?: string[]): GlobPolicyMatcher {
  const compiled = compileGlobPatterns({ raw: patterns, normalize })
  if (compiled.length === 0) {
    return () => false
  }
  return (values: string[]) => values.map(normalize).some((value) => matchesAnyGlobPattern(value, compiled))
}
