import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const PORT = 39034
const stateFile = join(os.tmpdir(), 'dsh-stm32-pres-' + Date.now() + '.json')

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const clientSource = readFileSync(CLIENT, 'utf8')
check('the panel applies through a client store, like the official theme plugin',
  clientSource.includes('var lookStore = (function () {') && clientSource.includes('lookStore.set(presentationFromForm(merged))'))
check('the panel no longer pushes a presentation overlay', !clientSource.includes('set-presentation'))
check('the host config wins over the bridge snapshot',
  clientSource.includes('function resolveLook(hostConfig, bridgeSettings)') && clientSource.includes('var look = resolveLook(liveLook || presentation, state.settings)'))

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_STM32_HTTP_PORT: String(PORT), DSH_STM32_STATE_FILE: stateFile, DSH_STM32_PROJECT: '' },
})
child.stderr.on('data', () => undefined)
await new Promise((r) => setTimeout(r, 900))

const post = async (action, params) => (await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, params: params || {} }),
})).json()
const state = async () => await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()

const rejected = await post('set-presentation', { config: { logFontSize: 18 } })
check('the bridge refuses to store a presentation overlay any more', rejected.ok === false, String(rejected.error).slice(0, 60))

const snap = await state()
check('state.settings reports the env value only', snap.settings.logFontSize === 12, String(snap.settings.logFontSize))
check('and no overlay keys leak in', snap.settings.logColorSerial === '', JSON.stringify(snap.settings.logColorSerial))

const logsNow = async () => (await (await fetch('http://127.0.0.1:' + PORT + '/logs?limit=50')).json()).logs || []

const bootRing = await logsNow()
check('the ring starts with the boot lines', bootRing.length > 0 && bootRing.every((entry) => entry.channel === 'sys'), 'n=' + bootRing.length)

const keepOther = await post('clear-logs', { channel: 'build' })
check('clearing an empty channel keeps the rest', keepOther.ok === true && (await logsNow()).length === bootRing.length, JSON.stringify(keepOther.result))

const dropSys = await post('clear-logs', { channel: 'sys' })
check('clearing one channel drops only its rows', dropSys.ok === true && dropSys.result.cleared === 'sys' && (await logsNow()).length === 0, JSON.stringify(dropSys.result))

const clearedAll = await post('clear-logs', {})
check('clearing without a channel empties everything', clearedAll.ok === true && clearedAll.result.cleared === 'all' && (await logsNow()).length === 0, JSON.stringify(clearedAll.result))

child.kill()
console.log('done, exit code', process.exitCode ?? 0)
