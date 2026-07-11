/**
 * Bootstrap a Market Research Lab workspace from its satellite repository.
 * Runs on Electron's bundled Node and routes git through dugite.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { git, setupGitExcludes } from '../_common.mjs'

const tag = process.argv[2]
const outDir = process.argv[3]
if (!tag || !outDir) {
  console.error('usage: bootstrap.mjs <tag> <outDir>')
  process.exit(1)
}
if (existsSync(outDir)) {
  console.error(`outDir already exists: ${outDir}`)
  process.exit(2)
}

const UPSTREAM = 'https://github.com/sybapp/Market-Research-Lab.git'
const launcherRoot = process.env.AQ_LAUNCHER_ROOT || join(homedir(), '.openalice', 'workspaces')
const mirror = join(launcherRoot, 'market-research-lab-mirror')
const override = process.env.MARKET_RESEARCH_LAB_DIR

let source
if (override && existsSync(join(override, '.git'))) {
  source = override
} else {
  if (!existsSync(join(mirror, '.git'))) {
    console.error(`[market-research] cloning ${UPSTREAM} ...`)
    mkdirSync(dirname(mirror), { recursive: true })
    await git(['clone', '--quiet', UPSTREAM, mirror], dirname(mirror))
  }
  source = mirror
}

if (!existsSync(join(source, '.git'))) {
  console.error(`[market-research] no satellite repository available at ${source}`)
  process.exit(3)
}

await git(['clone', '--local', source, outDir], dirname(outDir))
rmSync(join(outDir, '.git'), { recursive: true, force: true })
await git(['init', '-q'], outDir)
await git(['checkout', '-b', `research/${tag}`], outDir)
setupGitExcludes(outDir, 'artifacts/', '.env')

console.log(`bootstrapped Market Research Lab '${tag}' at ${outDir}`)
