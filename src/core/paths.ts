import { join, resolve } from 'node:path'

export const CONFIG_DIR = resolve('config')
export const DEFAULTS_DIR = resolve('defaults')
export const DEFAULT_PROMPTS_DIR = join(DEFAULTS_DIR, 'prompts')
export const DEFAULT_SKILLS_DIR = join(DEFAULTS_DIR, 'skills')

export const RUNTIME_DIR = resolve('runtime')
export const RUNTIME_BRAIN_DIR = join(RUNTIME_DIR, 'brain')
export const RUNTIME_SESSIONS_DIR = join(RUNTIME_DIR, 'sessions')
export const RUNTIME_EVENT_LOG_DIR = join(RUNTIME_DIR, 'event-log')
export const RUNTIME_CRON_DIR = join(RUNTIME_DIR, 'cron')
export const RUNTIME_STRATEGIES_DIR = join(RUNTIME_DIR, 'strategies')
export const RUNTIME_TRADING_DIR = join(RUNTIME_DIR, 'trading')
export const RUNTIME_NEWS_ARCHIVE_DIR = join(RUNTIME_DIR, 'news-archive')
export const RUNTIME_SKILLS_DIR = join(RUNTIME_DIR, 'skills')
export const RUNTIME_MEDIA_DIR = join(RUNTIME_DIR, 'media')
export const RUNTIME_CACHE_DIR = join(RUNTIME_DIR, 'cache')
export const RUNTIME_BACKTEST_DIR = join(RUNTIME_DIR, 'backtest')

export const PERSONA_DEFAULT_FILE = join(DEFAULT_PROMPTS_DIR, 'persona.md')
export const HEARTBEAT_DEFAULT_FILE = join(DEFAULT_PROMPTS_DIR, 'heartbeat.md')
export const PERSONA_FILE = join(RUNTIME_BRAIN_DIR, 'persona.md')
export const HEARTBEAT_FILE = join(RUNTIME_BRAIN_DIR, 'heartbeat.md')
export const BRAIN_STATE_FILE = join(RUNTIME_BRAIN_DIR, 'commit.json')
export const FRONTAL_LOBE_FILE = join(RUNTIME_BRAIN_DIR, 'frontal-lobe.md')
export const EMOTION_LOG_FILE = join(RUNTIME_BRAIN_DIR, 'emotion-log.md')

export function resolveRuntimePath(...parts: string[]): string {
  return join(RUNTIME_DIR, ...parts)
}
