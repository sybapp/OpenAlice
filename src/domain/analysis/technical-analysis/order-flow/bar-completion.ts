import { intervalToMinutesOrDefault, parseBarDateUTC } from './interval-time.js'

export type BarCompletion = 'complete' | 'incomplete'

export function barCompletionFor(date: string, interval: string, now = Date.now()): BarCompletion {
  const timestamp = parseBarDateUTC(date).getTime()
  if (!Number.isFinite(timestamp)) return 'incomplete'
  const durationMs = intervalToMinutesOrDefault(interval, 60) * 60 * 1000
  return timestamp + durationMs <= now ? 'complete' : 'incomplete'
}
