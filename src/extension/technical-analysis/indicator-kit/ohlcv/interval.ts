export function parseIntervalToMinutes(interval: string): number | null {
  const m = interval.match(/^(\d+)([mhdw])$/)
  if (!m) return null

  const n = Number(m[1])
  const unit = m[2]
  if (!Number.isFinite(n) || n <= 0) return null

  switch (unit) {
    case 'm': return n
    case 'h': return n * 60
    case 'd': return n * 60 * 24
    case 'w': return n * 60 * 24 * 7
    default: return null
  }
}
