/**
 * Default calendar-days window for indicator calculations.
 * Mirrors the previous analysis-kit adapter behavior.
 */
export function getCalendarDaysForInterval(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 90 // fallback: 3 months

  const n = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case 'd': return n * 400   // 日线：~400 trading days ≈ 1.5 years
    case 'w': return n * 1400  // 周线：~1400 days ≈ 4 years
    case 'h': return n * 14    // 小时线：14 天 (enough for ~200+ bars)
    case 'm': return n * 7     // 分钟线：7 天 (15m × 7d ≈ 672 bars, plenty)
    default:  return 90
  }
}
