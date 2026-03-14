/**
 * Default calendar-days window for indicator calculations.
 * Mirrors the previous analysis-kit adapter behavior, with a safety cap
 * to avoid pathological fetches on large intervals (e.g. "52w").
 */
export function getCalendarDaysForInterval(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 90 // fallback: 3 months

  const n = parseInt(match[1])
  const unit = match[2]

  let days: number
  switch (unit) {
    case 'd': days = n * 400   // 日线：~400 trading days ≈ 1.5 years
      break
    case 'w': days = n * 1400  // 周线：~1400 days ≈ 4 years
      break
    case 'h': days = n * 14    // 小时线：14 天 (enough for ~200+ bars)
      break
    case 'm': days = n * 7     // 分钟线：7 天 (15m × 7d ≈ 672 bars, plenty)
      break
    default: days = 90
  }

  // Safety cap: prevents massive API payloads and cache blow-ups.
  return Math.min(days, 5000)
}
