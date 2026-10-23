import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const PORT = 39032

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const stateFile = join(os.tmpdir(), 'dsh-stm32-noproject-' + Date.now() + '.json')
const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_STM32_HTTP_PORT: String(PORT),
    DSH_STM32_STATE_FILE: stateFile,
    DSH_STM32_PROJECT: '',
  },
})
child.stderr.on('data', () => undefined)

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

function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 30000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

await new Promise((r) => setTimeout(r, 800))
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'noproject', version: '0' } })

const deploy = await rpc('tools/call', { name: 'stm32_deploy', arguments: {} })
const text = deploy.result?.content?.[0]?.text ?? ''
check('deploy without a project is refused', deploy.result?.isError === true && /未选择工程/.test(text), text.slice(0, 80))

const afterTool = await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()
check('a refused deploy leaves no lease behind', afterTool.lease === null, JSON.stringify(afterTool.lease))
check('and its owner field is clear too', !afterTool.leaseOwner, String(afterTool.leaseOwner))

const res = await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'deploy', params: {} }),
})
const body = await res.json()
check('the panel route fails the same way', body.ok === false && /未选择工程/.test(body.error || ''), String(body.error).slice(0, 60))

const afterPanel = await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()
check('no lease after the panel attempt either', afterPanel.lease === null, JSON.stringify(afterPanel.lease))
check('the phase reports the error', afterPanel.phase === 'error', afterPanel.phase)

const claimRes = await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'claim', params: { owner: 'manual-test' } }),
})
check('a manual claim still works', (await claimRes.json()).result?.owner === 'manual-test')

const releaseRes = await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'release', params: { force: true } }),
})
check('release reports success', (await releaseRes.json()).ok === true)
const afterRelease = await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()
check('release clears the lease in state', afterRelease.lease === null && !afterRelease.leaseOwner, JSON.stringify(afterRelease.lease))

child.kill()
console.log('done, exit code', process.exitCode ?? 0)
