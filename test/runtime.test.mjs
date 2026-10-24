import { dirname, join } from 'node:path'
import { resolveBridgeRuntime } from '../lib/runtime.mjs'

/* The resolver joins path segments, so the fixtures have to look native on every OS. */
const WIN = process.platform === 'win32'
const appBinary = WIN ? 'C:\\App\\App.exe' : '/App/App'
const nodeInApp = WIN ? 'C:\\nodejs\\node.exe' : '/usr/bin/node'
const bundledNode = join(dirname(appBinary), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', WIN ? 'node.exe' : 'node')

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const nodeHost = resolveBridgeRuntime({ execPath: nodeInApp, versions: {}, env: { PATH: '' }, exists: (p) => p === nodeInApp })
check('node host uses execPath', nodeHost.command === nodeInApp, nodeHost.source)

const electron = resolveBridgeRuntime({
  execPath: appBinary,
  versions: { electron: '33.0.0' },
  env: { PATH: '' },
  exists: (p) => p === bundledNode,
})
check('electron prefers the bundled node', electron.command === bundledNode, electron.source)

const override = resolveBridgeRuntime({ execPath: 'X', versions: { electron: '33' }, env: { DSH_STM32_NODE: 'D:\\n\\node.exe' }, exists: (p) => p === 'D:\\n\\node.exe' })
check('DSH_STM32_NODE wins', override.command === 'D:\\n\\node.exe', override.source)

const fallback = resolveBridgeRuntime({ execPath: appBinary, versions: { electron: '33' }, env: { PATH: '' }, exists: () => false })
check('last resort is ELECTRON_RUN_AS_NODE', fallback.extraEnv.ELECTRON_RUN_AS_NODE === '1', fallback.source)
