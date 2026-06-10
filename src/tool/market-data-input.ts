import { z } from 'zod'

export const jsonRecordInput = z.union([
  z.record(z.string(), z.unknown()),
  z.string(),
])

export const credentialsInput = z.union([
  z.record(z.string(), z.string()),
  z.string(),
])

export const stringArrayInput = z.union([
  z.array(z.string()),
  z.string(),
])

export function parseJsonRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (error) {
      throw new Error(`${field} must be a JSON object string: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`${field} must be a JSON object string.`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${field} must be an object.`)
}

export function parseCredentials(value: unknown): Record<string, string> | undefined {
  const parsed = parseJsonRecord(value, 'credentials')
  if (!parsed) {
    return undefined
  }
  const credentials: Record<string, string> = {}
  for (const [key, credential] of Object.entries(parsed)) {
    if (typeof credential !== 'string') {
      throw new Error(`credentials.${key} must be a string.`)
    }
    credentials[key] = credential
  }
  return credentials
}

export function parsePrimitiveRecord(value: unknown, field: string): Record<string, string | number | boolean> | undefined {
  const parsed = parseJsonRecord(value, field)
  if (!parsed) {
    return undefined
  }
  const result: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${field}.${key} must be a string, number, or boolean.`)
    }
    result[key] = item
  }
  return result
}

export function parseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (Array.isArray(value)) {
    const result = value.filter((item): item is string => typeof item === 'string')
    if (result.length !== value.length) {
      throw new Error(`${field} must contain only strings.`)
    }
    return result
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as unknown
      return parseStringArray(parsed, field)
    }
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
  }
  throw new Error(`${field} must be a string array, JSON array string, or comma-separated string.`)
}

export function parseTradingViewIndicatorRef(value: unknown): { id: string; version?: string } | undefined {
  const parsed = parseJsonRecord(value, 'indicator')
  if (!parsed) {
    return undefined
  }
  if (typeof parsed['id'] !== 'string') {
    throw new Error('indicator.id must be a string.')
  }
  if (parsed['version'] !== undefined && typeof parsed['version'] !== 'string') {
    throw new Error('indicator.version must be a string.')
  }
  return {
    id: parsed['id'],
    version: parsed['version'],
  }
}
