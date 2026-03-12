/**
 * Bootstrap: Trading Accounts
 *
 * Platform registration, account initialization, git persistence, and reconnect logic.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { loadTradingConfig } from '../core/config.js'
import type { ReconnectResult } from '../core/types.js'
import {
  AccountManager,
  CcxtAccount,
  createCcxtProviderTools,
  wireAccountTrading,
  createPlatformFromConfig,
  createAccountFromConfig,
  validatePlatformRefs,
} from '../extension/trading/index.js'
import type { AccountSetup, GitExportState, IPlatform } from '../extension/trading/index.js'
import type { ToolCenter } from '../core/tool-center.js'

// ==================== Persistence paths ====================

export function gitFilePath(accountId: string): string {
  return resolve(`data/trading/${accountId}/commit.json`)
}

export function gitArchivePath(accountId: string): string {
  return resolve(`data/trading/${accountId}/archive.jsonl`)
}

export const LEGACY_GIT_PATHS: Record<string, string> = {
  'bybit-main': resolve('data/crypto-trading/commit.json'),
  'alpaca-paper': resolve('data/securities-trading/commit.json'),
  'alpaca-live': resolve('data/securities-trading/commit.json'),
}

export function createGitPersister(filePath: string) {
  return async (state: GitExportState) => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(state, null, 2))
  }
}

export async function loadGitState(accountId: string): Promise<GitExportState | undefined> {
  const primary = gitFilePath(accountId)
  try {
    return JSON.parse(await readFile(primary, 'utf-8')) as GitExportState
  } catch { /* try legacy */ }
  const legacy = LEGACY_GIT_PATHS[accountId]
  if (legacy) {
    try {
      return JSON.parse(await readFile(legacy, 'utf-8')) as GitExportState
    } catch { /* no saved state */ }
  }
  return undefined
}
