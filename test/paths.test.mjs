import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, '..', 'lib', 'bridge.mjs')
const PORT = 39035
const REAL = 'D:\\实验室竞赛\\物流小车\\2026-Engineering-Training\\Code\\Stm32\\2026-Logistics - Back\\MDK-ARM'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const source = readFileSync(BRIDGE, 'utf8')
check('the folder dialog hands the path over as a UTF-8 file',
  source.includes('WriteAllText') && source.includes('UTF8Encoding') && source.includes("readFileSync(outFile, 'utf8')"))
check('a console-mangled path is repaired before scanning',
  source.includes('function repairPath') && source.includes('const target = repairPath(raw)'))
check('the bridge imports tmpdir', source.includes("from 'node:os'"))
check('the fallback dialog is the modern IFileOpenDialog, not the XP tree',
  source.includes('IFileOpenDialog') && source.includes('DshFolderPicker') && source.includes('0x20u | 0x40u | 0x800u'))
check('a compile failure falls back to FolderBrowserDialog',
  source.includes('FolderBrowserDialog') && source.includes('Add-Type -AssemblyName System.Windows.Forms'))

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_STM32_HTTP_PORT: String(PORT), DSH_STM32_STATE_FILE: join(os.tmpdir(), 'dsh-stm32-path-' + Date.now() + '.json'), DSH_STM32_PROJECT: '' },
})
child.stderr.on('data', () => undefined)
await new Promise((r) => setTimeout(r, 900))

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
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'paths', version: '0' } })

if (existsSync(REAL)) {
  const found = await rpc('tools/call', { name: 'stm32_checkout', arguments: { folder: REAL } })
  const text = found.result?.content?.[0]?.text ?? ''
  check('a Chinese project folder resolves', found.result?.isError !== true && /\.uvprojx/i.test(text), text.slice(0, 120))
  check('and the device is read from it', /STM32/i.test(text), text.slice(0, 160))
} else {
  console.log('SKIP chinese folder: ' + REAL + ' not present')
}

const scanAll = await (await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'projects', params: {} }),
})).json()
check('scanning reports its scope, not just a list',
  scanAll.ok === true && Array.isArray(scanAll.result.items) && Array.isArray(scanAll.result.roots) &&
  typeof scanAll.result.scannedDirs === 'number' && typeof scanAll.result.truncated === 'boolean',
  JSON.stringify({ roots: scanAll.result && scanAll.result.roots && scanAll.result.roots.length, dirs: scanAll.result && scanAll.result.scannedDirs }))

if (existsSync(REAL)) {
  const root = REAL.replace(/\\MDK-ARM$/, '')
  const scanned = await (await fetch('http://127.0.0.1:' + PORT + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'projects', params: { roots: [root] } }),
  })).json()
  const items = (scanned.result && scanned.result.items) || []
  check('a given root is actually walked', scanned.result.roots[0] === root && items.some((item) => /2026-Logistics\.uvprojx$/i.test(item.file)), JSON.stringify({ n: items.length, root: scanned.result.roots[0] }))
}

const toolsSet = await (await fetch('http://127.0.0.1:' + PORT + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'set-tools', params: { uv4Path: 'D:\\Keli_v5\\UV4\\UV4.exe', pythonPath: 'D:\\Python\\Python312\\python.exe', project: REAL + '\\2026-Logistics.uvprojx' } }),
})).json()
check('tool paths reach the bridge on save', toolsSet.ok === true, JSON.stringify(toolsSet.result).slice(0, 80))
const afterTools = await (await fetch('http://127.0.0.1:' + PORT + '/state')).json()
check('and are visible in the live state',
  afterTools.settings.uv4 === 'D:\\Keli_v5\\UV4\\UV4.exe' && /python\.exe$/i.test(afterTools.settings.python || ''),
  JSON.stringify({ uv4: afterTools.settings.uv4, py: afterTools.settings.python }))

const missing = await rpc('tools/call', { name: 'stm32_checkout', arguments: { folder: 'D:\\no-such-dir-xyz' } })
const missingText = missing.result?.content?.[0]?.text ?? ''
check('a missing folder says so', missing.result?.isError === true && /目录不存在/.test(missingText), missingText.slice(0, 100))

const empty = await rpc('tools/call', { name: 'stm32_checkout', arguments: { folder: join(HERE, '..') } })
const emptyText = empty.result?.content?.[0]?.text ?? ''
check('a folder without a project explains the miss', empty.result?.isError !== true || /没有 \.uvprojx|\.uvprojx/i.test(emptyText), emptyText.slice(0, 120))

child.kill()
console.log('done, exit code', process.exitCode ?? 0)
