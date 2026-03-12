export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

export function toSecretPresenceMap<T extends Record<string, unknown>>(record: T): {
  [K in keyof T]: boolean
} {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, !!value]),
  ) as { [K in keyof T]: boolean }
}

export function mergeSecretRecord(
  current: Record<string, string>,
  input: unknown,
): Record<string, string> {
  const next = { ...current }
  if (!isRecord(input)) return next

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      if (value) next[key] = value
      else delete next[key]
    } else if (value === null) {
      delete next[key]
    }
  }

  return next
}

interface MergeSecretFieldOptions {
  clearKey?: string
  preserveMaskedPrefix?: string
}

export function mergeSecretField(
  current: string | undefined,
  input: Record<string, unknown>,
  key: string,
  options?: MergeSecretFieldOptions,
): string | undefined {
  if (options?.clearKey && input[options.clearKey] === true) {
    return undefined
  }

  const value = input[key]
  if (value === null) return undefined
  if (typeof value !== 'string') return current
  if (options?.preserveMaskedPrefix && value.startsWith(options.preserveMaskedPrefix)) {
    return current
  }

  return value || undefined
}

export function withSecretPresence<
  TBase extends Record<string, unknown>,
  TSpec extends Record<string, string>,
>(base: TBase, secretFields: TSpec) {
  const next: Record<string, unknown> = { ...base }

  for (const [secretKey, statusKey] of Object.entries(secretFields)) {
    next[statusKey] = !!base[secretKey]
    delete next[secretKey]
  }

  return next as Omit<TBase, keyof TSpec> & Record<TSpec[keyof TSpec], boolean>
}
