import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const STATE = join(os.tmpdir(), 'dsh-stm32-startup-state.json')

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/* A saved state that already carries a generated firmware used to crash the daemon at
 * import time ("Cannot access 'state' before initialization"), so the panel showed
 * "bridge unreachable" for anyone who had generated firmware once. */
writeFileSync(STATE, JSON.stringify({
  project: 'D:\\none\\Project.uvprojx',
  espFirmware: { bin: 'D:\\none\\esp01s.bin', bytes: 315264, at: Date.now(), ssid: 'W14917' },
  binding: { sessionId: 'session-test', label: 'test', at: Date.now() },
}), 'utf8')

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_STM32_HTTP_PORT: '39041', DSH_STM32_STATE_FILE: STATE },
})
let log = ''
child.stdout.on('data', (data) => { log += data })
child.stderr.on('data', (data) => { log += data })

const deadline = Date.now() + 12000
let health = null
while (Date.now() < deadline && !health) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    health = await fetch('http://127.0.0.1:39041/health', { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
  } catch { /* not listening yet */ }
}

check('the bridge survives a state file with a saved ESP firmware', health !== null && health.ok === true,
  health ? JSON.stringify(health) : log.split(/\r?\n/).slice(-3).join(' | ').slice(0, 200))

const state = await fetch('http://127.0.0.1:39041/state', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null)
check('the saved firmware is restored into the snapshot',
  Boolean(state && state.wifi && state.wifi.firmware && state.wifi.firmware.bytes === 315264),
  state && state.wifi ? JSON.stringify(state.wifi).slice(0, 120) : 'no state')

child.kill()
try { rmSync(STATE, { force: true }) } catch { /* best effort */ }
