import { existsSync } from 'node:fs'
import { join } from 'node:path'

/* 需要一个本地工程副本和 Keil 才能驱动真实构建；在没有这些前提的机器（CI）上跳过，而不是把环境缺失当成失败。 */
const SKIP_FIXTURES = !existsSync(join(process.cwd(), '.tmp', 'code-copy', 'Clock.uvprojx'))
if (process.env.DSH_STM32_CI === '1' || SKIP_FIXTURES) {
  console.log('SKIP ' + 'bridge.test.mjs' + ' :: 需要一个本地工程副本和 Keil 才能驱动真实构建')
  process.exit(0)
}
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const COPY = join(HERE, '..', '.tmp', 'code-copy', 'Clock.uvprojx')

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_STM32_HTTP_PORT: '39031',
    // Never let a test write the panel's real persisted choices.
    DSH_STM32_STATE_FILE: join(os.tmpdir(), 'dsh-stm32-test-state.json'),
  },
})
let buffer = ''
const pending = new Map()
let nextId = 0

child.stdout.on('data', (data) => {
  buffer += data
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); entry(message) }
  }
})
child.stderr.on('data', (data) => process.stdout.write('[bridge] ' + data))

function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 240000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

await new Promise((r) => setTimeout(r, 800))

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
check('initialize', init.result?.serverInfo?.name === 'dsh-stm32-toolchain', JSON.stringify(init.result?.serverInfo))

const list = await rpc('tools/list', {})
const tools = list.result?.tools ?? []
check('tools/list has 15 tools', tools.length === 15, tools.map((t) => t.name).join(','))

const doctor = await rpc('tools/call', { name: 'stm32_doctor', arguments: {} })
const doctorText = doctor.result?.content?.[0]?.text ?? ''
check('doctor reports keil', doctorText.includes('"path": "D:\\\\Keli_v5') || doctorText.includes('Keli_v5'), doctorText.slice(0, 120))

const ports = await rpc('tools/call', { name: 'stm32_ports', arguments: {} })
check('ports tool answers', typeof ports.result?.content?.[0]?.text === 'string')

const chips = await rpc('tools/call', { name: 'stm32_chips', arguments: { device: 'STM32F407VETx' } })
const chipText = chips.result?.content?.[0]?.text ?? ''
check('chip resolves F407VE -> STM32F4', chipText.includes('STM32F4'), chipText.slice(0, 160))

if (existsSync(COPY)) {
  const project = await rpc('tools/call', { name: 'stm32_project', arguments: { file: COPY } })
  check('project info', (project.result?.content?.[0]?.text ?? '').includes('Clock.uvprojx'))

  const build = await rpc('tools/call', { name: 'stm32_build', arguments: {} })
  const buildText = build.result?.content?.[0]?.text ?? ''
  check('build runs headless', buildText.includes('"ok": true'), buildText.slice(0, 200))
} else {
  console.log('SKIP build: no copied project at ' + COPY)
}

async function action(name, params) {
  const response = await fetch('http://127.0.0.1:39031/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name, params: params || {} }),
  })
  return await response.json()
}

const transports = await action('set-transport', { transport: 'uart' })
check('action set-transport', transports.ok === true && transports.result.transport === 'uart', JSON.stringify(transports.result))

const portsSet = await action('set-port', { port: 'COM99', baud: 115200 })
check('action set-port', portsSet.ok === true && portsSet.result.port === 'COM99', JSON.stringify(portsSet.result))

const scan = await action('projects')
check('action projects scans the disk',
  scan.ok === true && scan.result && Array.isArray(scan.result.items) && Array.isArray(scan.result.roots),
  JSON.stringify({ roots: scan.result && scan.result.roots && scan.result.roots.length, items: scan.result && scan.result.items && scan.result.items.length, dirs: scan.result && scan.result.scannedDirs }))

if (existsSync(COPY)) {
  const setProject = await action('set-project', { file: COPY })
  check('action set-project updates state', setProject.ok === true && setProject.result.device.length > 0, JSON.stringify(setProject.result))
}

const logsBefore = await (await fetch('http://127.0.0.1:39031/logs?limit=5')).json()
check('http /logs before clear', Array.isArray(logsBefore.logs) && logsBefore.logs.length > 0, 'seq=' + logsBefore.seq)

const cleared = await action('clear-logs')
check('action clear-logs', cleared.ok === true, JSON.stringify(cleared.result))

const stateRes = await fetch('http://127.0.0.1:39031/state')
const stateBody = await stateRes.json()
check('http /state', typeof stateBody.phase === 'string', JSON.stringify(stateBody.chip))

const logsAfter = await (await fetch('http://127.0.0.1:39031/logs?limit=5')).json()
check('http /logs empty after clear', Array.isArray(logsAfter.logs) && logsAfter.logs.length === 0, 'seq=' + logsAfter.seq)

const health = await (await fetch('http://127.0.0.1:39031/health')).json()
check('http /health', health.ok === true, JSON.stringify(health))

// --- exclusivity: a second owner must be refused while the lease is held -----
const releasedAll = await action('release', { force: true })
check('action release force', releasedAll.ok === true, JSON.stringify(releasedAll.result))

const repeatOne = await rpc('tools/call', { name: 'stm32_build', arguments: {} })
const repeatTwo = await rpc('tools/call', { name: 'stm32_build', arguments: {} })
check('two token-less builds in a row both run',
  repeatOne.result?.isError !== true && repeatTwo.result?.isError !== true,
  String(repeatTwo.result?.content?.[0]?.text ?? '').slice(0, 60))

const claimed = await action('claim', { owner: 'session-A' })
check('claim hands out a token', claimed.ok === true && typeof claimed.result.token === 'string', JSON.stringify(claimed.result.owner))

const defaultsState = await (await fetch('http://127.0.0.1:39031/state')).json()
check('state carries a bridge instance id', typeof defaultsState.instance === 'string' && defaultsState.instance.length > 0, String(defaultsState.instance))
const ring = await (await fetch('http://127.0.0.1:39031/logs?limit=50')).json()
check('log entries are tagged with that instance',
  Array.isArray(ring.logs) && ring.logs.length > 0 && ring.logs.every((entry) => entry.instance === defaultsState.instance),
  JSON.stringify(ring.logs && ring.logs[0] && ring.logs[0].instance))
check('state exposes the card order', String(defaultsState.settings?.cardOrder || '').split(',').length === 8, JSON.stringify(defaultsState.settings?.cardOrder))
check('state exposes the log text prefs', defaultsState.settings?.logFontSize > 0 && typeof defaultsState.settings?.logWrap === 'boolean', JSON.stringify({ size: defaultsState.settings?.logFontSize, wrap: defaultsState.settings?.logWrap }))

const claimedState = await (await fetch('http://127.0.0.1:39031/state')).json()
check('state names the current holder', claimedState.lease?.owner === 'session-A', JSON.stringify(claimedState.lease))
check('state reports how long it has been held', typeof claimedState.lease?.heldSeconds === 'number', String(claimedState.lease?.heldSeconds))

const blocked = await rpc('tools/call', { name: 'stm32_build', arguments: {} })
const blockedText = blocked.result?.content?.[0]?.text ?? ''
check('second owner is refused with BOARD_BUSY', blocked.result?.isError === true && /busy/i.test(blockedText), blockedText.slice(0, 120))

const withToken = await rpc('tools/call', { name: 'stm32_build', arguments: { token: claimed.result.token } })
check('the lease holder can build', withToken.result?.isError !== true, (withToken.result?.content?.[0]?.text ?? '').slice(0, 80))

await action('release', { force: true })
const afterRelease = await rpc('tools/call', { name: 'stm32_build', arguments: {} })
check('board is usable again after release', afterRelease.result?.isError !== true, (afterRelease.result?.content?.[0]?.text ?? '').slice(0, 80))

if (existsSync(COPY)) {
  const checkout = await action('checkout', { folder: join(HERE, '..', '.tmp', 'code-copy') })
  check('checkout resolves a folder to a project', checkout.ok === true && /.uvprojx$/i.test(checkout.result.project), checkout.result.project)
}

child.kill()
console.log('done, exit code', process.exitCode ?? 0)
