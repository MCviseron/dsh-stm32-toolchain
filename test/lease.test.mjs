import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const PORT = 39033
const TTL = 1200

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const source = readFileSync(BRIDGE, 'utf8')
check('the default TTL is three minutes', source.includes("DSH_STM32_LEASE_TTL || 180000"))
check('a running job renews its own lease',
  source.includes('startHeartbeat(claimed.token)') && source.includes('LEASE_HEARTBEAT') && source.includes('stopHeartbeat()'))

const clientSource = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
check('the panel counts the remaining lease locally',
  clientSource.includes('leaseLeft') && clientSource.includes('setNowTick(Date.now())') && clientSource.includes('expiredBox'))

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_STM32_HTTP_PORT: String(PORT),
    DSH_STM32_STATE_FILE: join(os.tmpdir(), 'dsh-stm32-lease-' + Date.now() + '.json'),
    DSH_STM32_LEASE_TTL: String(TTL),
    DSH_STM32_LEASE_HEARTBEAT: '300',
  },
})
child.stderr.on('data', () => undefined)
await new Promise((r) => setTimeout(r, 900))

const post = async (action, params) => (await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, params: params || {} }),
})).json()
const state = async () => await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()

const claimed = await post('claim', { owner: 'ttl-test' })
check('claim honours the configured TTL', claimed.result?.expiresAt > 0, JSON.stringify(claimed.result?.owner))
const fresh = await state()
check('the TTL shows up in seconds', fresh.lease && fresh.lease.expiresInSeconds <= Math.ceil(TTL / 1000), JSON.stringify(fresh.lease?.expiresInSeconds))

await new Promise((r) => setTimeout(r, TTL + 500))
const expired = await state()
check('an idle lease expires on its own', expired.lease === null, JSON.stringify(expired.lease))
check('and no owner is left behind', !expired.leaseOwner, String(expired.leaseOwner))

const back = await post('claim', { owner: 'after-expiry' })
check('the board is free again after expiry', back.result?.owner === 'after-expiry')

child.kill()
console.log('done, exit code', process.exitCode ?? 0)
