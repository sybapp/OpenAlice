/**
 * Materialize one exact Binance Signal Satellite release as an OpenAlice
 * Workspace, install its dependencies, and leave the collector for the
 * launcher-owned background process manager.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { git, setupGitExcludes } from '../_common.mjs'

const tag = process.argv[2]
const outDir = process.argv[3]
if (!tag || !outDir) {
  console.error('usage: bootstrap.mjs <tag> <outDir>')
  process.exit(1)
}

const repository = process.env.OPENALICE_TEMPLATE_SOURCE_REPOSITORY
const version = process.env.OPENALICE_TEMPLATE_SOURCE_VERSION
const commit = process.env.OPENALICE_TEMPLATE_SOURCE_COMMIT?.toLowerCase()
if (!repository || !version || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error('Binance Signal Satellite requires an approved repository, version, and full commit')
  process.exit(3)
}

const launcherRoot = process.env.AQ_LAUNCHER_ROOT
  || join(homedir(), '.openalice', 'workspaces')
const mirror = join(launcherRoot, 'binance-signal-satellite-mirror')
const override = process.env.AQ_TEMPLATE_DIR
let source

if (override && existsSync(join(override, '.git'))) {
  source = override
} else {
  if (!existsSync(join(mirror, '.git'))) {
    console.error(`[binance-signal-satellite] cloning ${repository} at ${mirror}`)
    mkdirSync(dirname(mirror), { recursive: true })
    await git(['clone', '--quiet', repository, mirror], dirname(mirror))
  } else {
    console.error('[binance-signal-satellite] refreshing approved release refs')
    await git(['fetch', '--quiet', '--tags', '--prune', 'origin'], mirror)
  }
  source = mirror
}

const resolved = (await git(['rev-parse', `${version}^{commit}`], source)).stdout.trim().toLowerCase()
if (resolved !== commit) {
  console.error(`[binance-signal-satellite] ${version} resolved to ${resolved || 'nothing'}, expected ${commit}`)
  process.exit(4)
}

await git(['clone', '--quiet', '--no-local', '--no-checkout', source, outDir], dirname(outDir))
await git(['remote', 'set-url', 'origin', repository], outDir)
await git(['checkout', '--quiet', '-b', `research/${tag}`, commit], outDir)
setupGitExcludes(outDir)

await runPackageInstall(outDir)

const receiptDir = join(outDir, '.alice')
mkdirSync(receiptDir, { recursive: true })
writeFileSync(
  join(receiptDir, 'harness-source.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    template: 'binance-signal-satellite',
    repository,
    version,
    commit,
  }, null, 2)}\n`,
)

console.log(`bootstrapped Binance Signal Satellite ${version} (${commit.slice(0, 12)}) at ${outDir}`)

function runPackageInstall(cwd) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['install', '--frozen-lockfile'], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm install exited with code ${code ?? 'unknown'}`))
    })
  })
}
