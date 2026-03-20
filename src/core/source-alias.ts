export const HIDDEN_SOURCE_ALIAS_KEY = '__sourceAliases' as const

export interface SourceAliasState {
  aliasToReal: Record<string, string>
  realToAlias: Record<string, string>
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function createSourceAliasState(sources: string[]): SourceAliasState {
  const uniqueSources = uniqueNonEmpty(sources)
  const reserved = new Set(uniqueSources)
  const aliasToReal: Record<string, string> = {}
  const realToAlias: Record<string, string> = {}

  let index = 1
  for (const source of uniqueSources) {
    let alias = `source-${index}`
    while (reserved.has(alias) || aliasToReal[alias]) {
      index += 1
      alias = `source-${index}`
    }
    aliasToReal[alias] = source
    realToAlias[source] = alias
    index += 1
  }

  return { aliasToReal, realToAlias }
}

export function resolveSourceAlias(
  aliases: SourceAliasState | null | undefined,
  source: string,
): string {
  return aliases?.aliasToReal[source] ?? source
}

export function presentSourceAlias(
  aliases: SourceAliasState | null | undefined,
  source: string,
): string {
  return aliases?.realToAlias[source] ?? source
}

export function readHiddenSourceAliases(invocation: unknown): SourceAliasState | null {
  if (!invocation || typeof invocation !== 'object') return null
  const candidate = (invocation as Record<string, unknown>)[HIDDEN_SOURCE_ALIAS_KEY]
  if (!candidate || typeof candidate !== 'object') return null

  const aliasToReal = (candidate as Record<string, unknown>).aliasToReal
  const realToAlias = (candidate as Record<string, unknown>).realToAlias
  if (!aliasToReal || typeof aliasToReal !== 'object' || !realToAlias || typeof realToAlias !== 'object') {
    return null
  }

  return {
    aliasToReal: Object.fromEntries(
      Object.entries(aliasToReal).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    realToAlias: Object.fromEntries(
      Object.entries(realToAlias).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  }
}

export function omitHiddenInvocationFields(
  invocation: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(invocation).filter(([key]) => !key.startsWith('__')),
  )
}
