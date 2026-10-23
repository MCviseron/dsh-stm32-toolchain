#!/usr/bin/env node
/**
 * Is this plugin still compatible with the DSH installed here?
 *
 *   node scripts/check-dsh-version.mjs [--json] [--feed <url>]
 *
 * Exit codes (the scheduled task branches on them):
 *   0  compatible - no change needed
 *   2  a newer DSH exists but only declaration ranges need widening
 *   3  the host API surface we rely on changed - a human must review
 *   1  the check itself failed (offline, unreadable runtime.json, ...)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const feedIndex = args.indexOf('--feed')
const FEED = feedIndex >= 0 ? args[feedIndex + 1] : 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'

/**
 * Host entry points this plugin actually calls (see lib/index.js). Only `tracked` packages
 * share the DSH version numbering; schemastery is an independent 3.x library.
 */
const CONTRACT = [
  { name: '@deepseek-ai/dsh-mcp-client', tracked: true },
  { name: '@deepseek-ai/schemastery', tracked: false },
]
const TRACKED = CONTRACT.filter((entry) => entry.tracked).map((entry) => entry.name)

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || '').trim())
  if (!match) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] }
}

function compare(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (!left.pre.length && !right.pre.length) return 0
  if (!left.pre.length) return 1
  if (!right.pre.length) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) { if (+l !== +r) return +l < +r ? -1 : 1; continue }
    if (ln !== rn) return ln ? -1 : 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** 1.0.0 || ^1.1.0 -> does it accept version? */
function rangeAccepts(range, version) {
  const v = parse(version)
  if (!v) return false
  return String(range).split('||').map((part) => part.trim()).some((part) => {
    if (!part) return false
    if (part === '*' || part === 'latest') return true
    const caret = /^\^(.+)$/.exec(part)
    if (caret) {
      const base = parse(caret[1])
      if (!base) return false
      if (compare(version, caret[1]) < 0) return false
      if (base.major > 0) return v.major === base.major
      if (base.minor > 0) return v.major === 0 && v.minor === base.minor
      return v.major === 0 && v.minor === 0 && v.patch === base.patch
    }
    return part === version
  })
}

function installedVersion() {
  const base = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-runtimes')
  if (!existsSync(base)) throw new Error('no ~/.dsh/dsh-runtimes')
  for (const entry of readdirSync(base)) {
    const file = join(base, entry, 'runtime.json')
    if (!existsSync(file)) continue
    const info = JSON.parse(readFileSync(file, 'utf8'))
    if (info.desktopVersion) return { version: info.desktopVersion, runtime: entry, node: info.node }
  }
  throw new Error('runtime.json without desktopVersion')
}

async function latestFromFeed() {
  const response = await fetch(FEED, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('feed HTTP ' + response.status)
  const text = await response.text()
  const match = /version:\s*([0-9A-Za-z.-]+)/.exec(text)
  if (!match) throw new Error('feed has no version')
  return match[1]
}

async function latestFromNpm(name) {
  const response = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2F'), { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('registry HTTP ' + response.status)
  const packument = await response.json()
  const tags = packument['dist-tags'] || {}
  const candidates = Object.values(tags)
  return candidates.filter(Boolean).sort((a, b) => compare(b, a))[0] || null
}

const result = { at: new Date().toISOString(), exit: 0, verdict: 'compatible', installed: null, latest: null, source: null, ranges: [], contract: [] }

try {
  const installed = installedVersion()
  result.installed = installed
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  try {
    result.latest = await latestFromFeed()
    result.source = 'feed'
  } catch (error) {
    result.latest = await latestFromNpm(TRACKED[0])
    result.source = 'npm (' + error.message + ')'
  }

  result.ranges = Object.entries(pkg.dependencies || {}).filter(([name]) => TRACKED.includes(name)).map(([name, range]) => ({
    name,
    range,
    acceptsLatest: result.latest ? rangeAccepts(range, result.latest) : null,
  }))

  result.contract = CONTRACT.map(({ name }) => ({
    name,
    imported: readFileSync(join(root, 'lib/index.js'), 'utf8').includes("'" + name + "'"),
  }))

  if (!result.latest) {
    result.verdict = 'unknown-latest'
  } else if (compare(result.latest, installed.version) <= 0) {
    result.verdict = 'compatible'
  } else if (result.ranges.every((entry) => entry.acceptsLatest)) {
    result.verdict = 'range-ok-but-untested'
    result.exit = 2
  } else {
    result.verdict = 'widen-ranges'
    result.exit = 2
  }
} catch (error) {
  result.exit = 1
  result.verdict = 'check-failed'
  result.error = error.message
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('installed :', result.installed ? result.installed.version + ' (' + result.installed.runtime + ', node ' + result.installed.node + ')' : '?')
  console.log('latest    :', result.latest || '?', result.source ? '(' + result.source + ')' : '')
  for (const entry of result.ranges) console.log('range     :', entry.name, entry.range, '->', entry.acceptsLatest ? 'accepts latest' : 'does NOT accept latest')
  console.log('verdict   :', result.verdict, '(exit ' + result.exit + ')')
  if (result.error) console.log('error     :', result.error)
}
process.exit(result.exit)
