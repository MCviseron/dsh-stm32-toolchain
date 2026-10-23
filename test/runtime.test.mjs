import { resolveBridgeRuntime } from '../lib/runtime.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const nodeHost = resolveBridgeRuntime({ execPath: 'C:\\nodejs\\node.exe', versions: {}, env: { PATH: '' }, exists: (p) => p === 'C:\\nodejs\\node.exe' })
check('node host uses execPath', nodeHost.command === 'C:\\nodejs\\node.exe', nodeHost.source)

const desktopNode = 'C:\\App\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe'
const electron = resolveBridgeRuntime({
  execPath: 'C:\\App\\App.exe',
  versions: { electron: '33.0.0' },
  env: { PATH: '' },
  exists: (p) => p === desktopNode,
})
check('electron prefers the bundled node', electron.command === desktopNode, electron.source)

const override = resolveBridgeRuntime({ execPath: 'X', versions: { electron: '33' }, env: { DSH_STM32_NODE: 'D:\\n\\node.exe' }, exists: (p) => p === 'D:\\n\\node.exe' })
check('DSH_STM32_NODE wins', override.command === 'D:\\n\\node.exe', override.source)

const fallback = resolveBridgeRuntime({ execPath: 'C:\\App\\App.exe', versions: { electron: '33' }, env: { PATH: '' }, exists: () => false })
check('last resort is ELECTRON_RUN_AS_NODE', fallback.extraEnv.ELECTRON_RUN_AS_NODE === '1', fallback.source)
