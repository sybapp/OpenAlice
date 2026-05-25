import { createHash } from 'node:crypto'

export function canonicalize(value: unknown, path = '$'): unknown {
  if (value === undefined) {
    throw new Error(`canonical JSON cannot encode undefined at ${path}`)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical JSON cannot encode non-finite number at ${path}`)
    }
    return value
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`canonical JSON cannot encode ${typeof value} at ${path}`)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`))
  }
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    return sorted
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + '\n'
}

export function canonicalJsonLine(value: unknown): string {
  return JSON.stringify(canonicalize(value)) + '\n'
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function canonicalId(prefix: string, value: unknown, length = 24): string {
  return `${prefix}_${canonicalSha256(value).slice(0, length)}`
}
