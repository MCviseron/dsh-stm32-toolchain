import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bridge = readFileSync(join(root, 'lib/bridge.mjs'), 'utf8')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

check('the bridge can check the environment', bridge.includes("case 'env-check'"))
check('the check covers every toolchain piece',
  ['keil', 'license', 'cube', 'python', 'ports', 'esp', 'arduino', 'project'].every((id) => bridge.includes("id: '" + id + "'")))
check('the ESP is probed on its control port', bridge.includes('function espPing('))
check('every failing item carries a fix hint', (bridge.match(/need: '/g) || []).length >= 8)
check('the panel renders the checklist', client.includes('"环境" + (state.env'))
check('the panel can re-run the check', client.includes('run("env-check")'))
