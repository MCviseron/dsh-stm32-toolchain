import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/**
 * Pick the executable that runs lib/bridge.mjs.
 *
 * On a Node host that is process.execPath. Under the DSH desktop app the host
 * process is Electron, so process.execPath is the app binary: spawning it starts
 * a second app instead of running the bridge. The desktop payload ships a real
 * Node, so it is probed first; Electron-as-Node is the last resort.
 *
 * @returns {{ command: string, extraEnv: Record<string, string>, source: string }}
 */
export function resolveBridgeRuntime(probe = {}) {
  const env = probe.env ?? process.env
  const execPath = probe.execPath ?? process.execPath
  const exists = probe.exists ?? existsSync
  const isElectron = (probe.versions ?? process.versions).electron !== undefined

  const override = env.DSH_STM32_NODE
  if (override && exists(override)) return { command: override, extraEnv: {}, source: 'DSH_STM32_NODE override' }

  for (const name of ['DSH_NODE_EXECUTABLE', 'DSH_DESKTOP_NODE_EXECUTABLE']) {
    const value = env[name]
    if (value && exists(value)) return { command: value, extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, source: name }
  }

  if (!isElectron) return { command: execPath, extraEnv: {}, source: 'process.execPath (Node host)' }

  const candidates = [
    ['resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'],
    ['resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'],
    ['resources', 'runtime', 'bin', 'node.exe'],
    ['resources', 'runtime', 'node', 'node.exe'],
    ['resources', 'node', 'node.exe'],
  ]
  const root = dirname(execPath)
  for (const parts of candidates) {
    const candidate = join(root, ...parts)
    if (exists(candidate)) return { command: candidate, extraEnv: {}, source: 'desktop runtime Node' }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const entry of pathValue.split(probe.pathDelimiter ?? delimiter)) {
    const dir = entry.replace(/^"|"$/g, '').trim()
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (exists(candidate)) return { command: candidate, extraEnv: {}, source: 'PATH Node' }
    }
  }

  return { command: execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, source: 'process.execPath with ELECTRON_RUN_AS_NODE' }
}
