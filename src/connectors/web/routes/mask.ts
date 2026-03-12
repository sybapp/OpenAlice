/** Mask a secret string: show last 4 chars, prefix with "****" */
export function mask(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}
