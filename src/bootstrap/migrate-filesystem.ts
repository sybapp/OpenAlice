import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  CONFIG_DIR,
  DEFAULT_PROMPTS_DIR,
  DEFAULT_SKILLS_DIR,
  HEARTBEAT_DEFAULT_FILE,
  PERSONA_DEFAULT_FILE,
  RUNTIME_BACKTEST_DIR,
  RUNTIME_BRAIN_DIR,
  RUNTIME_CACHE_DIR,
  RUNTIME_CRON_DIR,
  RUNTIME_EVENT_LOG_DIR,
  RUNTIME_NEWS_ARCHIVE_DIR,
  RUNTIME_SESSIONS_DIR,
  RUNTIME_SKILLS_DIR,
  RUNTIME_STRATEGIES_DIR,
  RUNTIME_TRADING_DIR,
} from '../core/paths.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

async function movePath(source: string, target: string): Promise<void> {
  const sourceExists = await pathExists(source)
  if (!sourceExists) return

  const targetExists = await pathExists(target)
  if (targetExists) {
    throw new Error(`Filesystem migration conflict: both "${source}" and "${target}" exist`)
  }

  await ensureParent(target)
  await rename(source, target)
}

async function moveFile(source: string, target: string): Promise<void> {
  await movePath(source, target)
}

async function moveDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await pathExists(sourceDir))) return

  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    await movePath(join(sourceDir, entry.name), join(targetDir, entry.name))
  }
  await rm(sourceDir, { recursive: true, force: true })
}

async function copyFileIfMissing(source: string, target: string): Promise<void> {
  if (!(await pathExists(source)) || (await pathExists(target))) return
  await ensureParent(target)
  await copyFile(source, target)
}

export async function migrateFilesystemLayout(): Promise<void> {
  await movePath(resolve('data/config'), CONFIG_DIR)

  await moveFile(resolve('data/default/persona.default.md'), PERSONA_DEFAULT_FILE)
  await moveFile(resolve('data/default/heartbeat.default.md'), HEARTBEAT_DEFAULT_FILE)
  await moveDirectoryContents(resolve('data/default/skills'), DEFAULT_SKILLS_DIR)

  await movePath(resolve('data/brain'), RUNTIME_BRAIN_DIR)
  await movePath(resolve('data/sessions'), RUNTIME_SESSIONS_DIR)
  await movePath(resolve('data/event-log'), RUNTIME_EVENT_LOG_DIR)
  await movePath(resolve('data/cron'), RUNTIME_CRON_DIR)
  await movePath(resolve('data/news-collector'), RUNTIME_NEWS_ARCHIVE_DIR)
  await movePath(resolve('data/skills'), RUNTIME_SKILLS_DIR)
  await movePath(resolve('data/cache'), RUNTIME_CACHE_DIR)
  await movePath(resolve('data/backtest'), RUNTIME_BACKTEST_DIR)
  await movePath(resolve('data/trading'), RUNTIME_TRADING_DIR)

  await moveDirectoryContents(resolve('data/strategies'), RUNTIME_STRATEGIES_DIR)
  await moveFile(resolve('data/trader/jobs.json'), join(RUNTIME_STRATEGIES_DIR, 'jobs.json'))
  await moveFile(resolve('data/trader/review-jobs.json'), join(RUNTIME_STRATEGIES_DIR, 'review-jobs.json'))

  await copyFileIfMissing(
    resolve('data/crypto-trading/commit.json'),
    join(RUNTIME_TRADING_DIR, 'bybit-main', 'commit.json'),
  )
  await copyFileIfMissing(
    resolve('data/securities-trading/commit.json'),
    join(RUNTIME_TRADING_DIR, 'alpaca-paper', 'commit.json'),
  )
}
