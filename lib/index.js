import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import z from '@deepseek-ai/schemastery'
import { resolveBridgeRuntime } from './runtime.mjs'

export const inject = ['webServer', 'systemPrompt']

const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
const API = '/api/dsh-stm32-toolchain'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  project: z.string().default('').volatile(),
  uv4Path: z.string().default('').volatile(),
  cubeMxPath: z.string().default('').volatile(),
  transport: z.string().default('swd').volatile(),
  serialPort: z.string().default('').volatile(),
  baud: z.number().min(1200).max(4000000).default(115200).volatile(),
  espHost: z.string().default('').volatile(),
  espPort: z.number().min(1).max(65535).default(23).volatile(),
  pythonPath: z.string().default('').volatile(),
  httpPort: z.number().min(1024).max(65535).default(39021).volatile(),
  retry: z.number().min(1).max(10).default(3).volatile(),
  toolCallTimeoutMs: z.number().min(5000).max(900000).default(300000).volatile(),
  /** Extra folders the 扫描工程 button walks, separated by ';' ('' = sensible defaults). */
  searchRoots: z.string().default('').volatile(),
  /** Comma-separated card ids, position 1..8; 1-4 land on the first row. */
  cardOrder: z.string().default('chip,transport,port,firmware,build,flash,lease,logs').volatile(),
  logFontSize: z.number().min(9).max(20).default(12).volatile(),
  logLineHeight: z.number().min(1).max(2.4).default(1.5).volatile(),
  logMaxLines: z.number().min(50).max(5000).default(400).volatile(),
  logWrap: z.boolean().default(true).volatile(),
  logTimestamps: z.boolean().default(false).volatile(),
  logColorBuild: z.string().default('').volatile(),
  logColorFlash: z.string().default('').volatile(),
  logColorSerial: z.string().default('').volatile(),
  logColorSys: z.string().default('').volatile(),
  logBgGradient: z.boolean().default(false).volatile(),
  logBgFrom: z.string().default('#0d1117').volatile(),
  logBgTo: z.string().default('#161b22').volatile(),
})

const GUIDANCE = [
  '## STM32 board (dsh-stm32-toolchain)',
  '',
  'The board is reachable through the stm32_* tools. Never ask the user to open Keil, STM32CubeMX or a serial terminal by hand when a tool covers it.',
  '',
  '- Build: stm32_build (uVision UV4 -b, headless). Read the returned diagnostics, not the raw log.',
  '- Flash: stm32_flash with transport swd (project ST-Link via UV4 -f) or uart (STM32 system bootloader; the target must have BOOT0=1 and be reset first).',
  '- One-sentence path: stm32_checkout {folder} (finds the .uvprojx, resolves the chip) -> stm32_deploy {watch: 5000} (builds, flashes, returns the startup log).',
  '- Concurrency: the board is a single resource. Mutating tools auto-claim a lease, but if another session holds it they answer BOARD_BUSY with the holder. When you plan several steps, stm32_claim {owner} first, pass the token to each mutating call, then release.',
  '- Serial: stm32_serial open/close/write/tail; opened lines also stream to the panel.',
  '- Errors: stm32_logs filters the ring buffer by channel (build/flash/serial/sys) or regex; stm32_open_vscode jumps to file:line.',
  '- Environment: stm32_doctor, stm32_ports, stm32_chips.',
  '- Wireless: transport wifi drives the STM32 system bootloader through an ESP bridge (default port 3333 control, 3334 raw UART). stm32_esp_firmware {action: discover} finds the bridge when its DHCP address moved; {action: build} bakes the Wi-Fi credentials into the firmware. BOOT0 and NRST are driven by the bridge, so a Wi-Fi flash needs no button press once both wires are solid.',
  '- Wi-Fi serial: the panel can open its serial monitor on the ESP pipe instead of a COM port, so monitoring needs no USB cable. The pipe serves one client at a time, so a flash stops the monitor first.',
  '',
  'The dashboard (MCU STM32 总管) mirrors this state: cards for chip/transport/port/firmware/CubeMX/build/flash/lease, a toolbar (build, flash, one-click deploy, serial, HEX, wireless serial, .ioc open/generate, VSCode, clear log) and the log stream with channel tabs. When the user asks what to click, describe that order: pick the project, pick the transport, then 一键编译 + 烧录; for Wi-Fi press 自动探测 ESP first. Do not invent panel features - if something is missing, say so.',
  '',
  'Ground truth: the chip comes from the .uvprojx Device field, not from what the user says. UART flashing mass-erases the whole flash, so say so before starting it. A uVision exit code of 1 means warnings only; treat only >=2 as failure.',
].join('\n')

/**
 * DSH >= 0.2 hands volatile config fields over as live references
 * ({ get(), [cosmokit.volatile.write] }) instead of plain values. Reading them
 * raw yields an object, so every numeric/string field silently fell back to its
 * default - which is why saved settings never reached the panel.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export function readConfigValue(value) {
  if (value === null || typeof value !== 'object') return value
  if (!(VOLATILE_WRITE in value) || typeof value.get !== 'function') return value
  try {
    return value.get()
  } catch {
    return value
  }
}

export function unwrapConfig(source) {
  const plain = {}
  for (const [key, value] of Object.entries(source || {})) plain[key] = readConfigValue(value)
  return plain
}

function toNumber(value, fallback) {
  const plain = readConfigValue(value)
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : fallback
}

function toText(value, fallback) {
  const plain = readConfigValue(value)
  return typeof plain === 'string' ? plain : fallback
}

function launchConfig(active) {
  const runtime = resolveBridgeRuntime()
  return {
    transport: 'stdio',
    serverName: 'stm32',
    command: runtime.command,
    args: [BRIDGE_PATH],
    env: {
      ...process.env,
      ...runtime.extraEnv,
      DSH_STM32_HTTP_PORT: String(toNumber(active.httpPort, 39021)),
      DSH_STM32_PROJECT: toText(active.project, ''),
      DSH_STM32_UV4: toText(active.uv4Path, ''),
      DSH_STM32_CUBEMX: toText(active.cubeMxPath, ''),
      DSH_STM32_TRANSPORT: toText(active.transport, 'swd'),
      DSH_STM32_PORT: toText(active.serialPort, ''),
      DSH_STM32_BAUD: String(toNumber(active.baud, 115200)),
      DSH_STM32_ESP_HOST: toText(active.espHost, ''),
      DSH_STM32_ESP_PORT: String(toNumber(active.espPort, 23)),
      DSH_STM32_PYTHON: toText(active.pythonPath, ''),
      DSH_STM32_RETRY: String(toNumber(active.retry, 3)),
      DSH_STM32_SCAN_ROOTS: toText(active.searchRoots, ''),
      DSH_STM32_CARD_ORDER: toText(active.cardOrder, 'chip,transport,port,firmware,build,flash,lease,logs'),
      DSH_STM32_LOG_FONT: String(toNumber(active.logFontSize, 12)),
      DSH_STM32_LOG_LINE: String(toNumber(active.logLineHeight, 1.5)),
      DSH_STM32_LOG_MAX: String(toNumber(active.logMaxLines, 400)),
      DSH_STM32_LOG_WRAP: active.logWrap === false ? '0' : '1',
      DSH_STM32_LOG_TIME: active.logTimestamps === true ? '1' : '0',
      DSH_STM32_LOG_C_BUILD: toText(active.logColorBuild, ''),
      DSH_STM32_LOG_C_FLASH: toText(active.logColorFlash, ''),
      DSH_STM32_LOG_C_SERIAL: toText(active.logColorSerial, ''),
      DSH_STM32_LOG_C_SYS: toText(active.logColorSys, ''),
      DSH_STM32_LOG_BG_GRADIENT: active.logBgGradient === true ? '1' : '0',
      DSH_STM32_LOG_BG_FROM: toText(active.logBgFrom, '#0d1117'),
      DSH_STM32_LOG_BG_TO: toText(active.logBgTo, '#161b22'),
    },
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    toolCallTimeoutMs: toNumber(active.toolCallTimeoutMs, 300000),
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 5 },
  }
}

/** Only what the panel renders with: these must not depend on the bridge. */
/** Numeric coercion that also accepts the strings a form may hand over. */
function positiveNumber(value, fallback) {
  const num = Number(readConfigValue(value))
  return Number.isFinite(num) && num > 0 ? num : fallback
}

export function pickPresentation(active) {
  const source = active || {}
  return {
    searchRoots: toText(source.searchRoots, ''),
    cardOrder: toText(source.cardOrder, 'chip,transport,port,firmware,build,flash,lease,logs'),
    logFontSize: positiveNumber(source.logFontSize, 12),
    logLineHeight: positiveNumber(source.logLineHeight, 1.5),
    logMaxLines: positiveNumber(source.logMaxLines, 400),
    logWrap: readConfigValue(source.logWrap) !== false,
    logTimestamps: readConfigValue(source.logTimestamps) === true,
    logColorBuild: toText(source.logColorBuild, ''),
    logColorFlash: toText(source.logColorFlash, ''),
    logColorSerial: toText(source.logColorSerial, ''),
    logColorSys: toText(source.logColorSys, ''),
    logBgGradient: readConfigValue(source.logBgGradient) === true,
    logBgFrom: toText(source.logBgFrom, '#0d1117'),
    logBgTo: toText(source.logBgTo, '#161b22'),
  }
}

/** Live presentation config of the running plugin instance. */
let presentation = pickPresentation({})

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

export function makeRoutes(getPort, getConfig) {
  const upstream = (path) => 'http://127.0.0.1:' + getPort() + path
  return [
    {
      kind: 'exact', method: 'GET', path: API + '/state',
      handler: async (req, res) => {
        try {
          const response = await fetch(upstream('/state'), { signal: AbortSignal.timeout(3000) })
          json(res, 200, await response.json())
        } catch (error) {
          json(res, 200, { phase: 'offline', message: 'bridge unreachable: ' + error.message })
        }
      },
    },
    {
      kind: 'exact', method: 'GET', path: API + '/logs',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          const response = await fetch(upstream('/logs' + url.search), { signal: AbortSignal.timeout(3000) })
          json(res, 200, await response.json())
        } catch (error) {
          json(res, 200, { logs: [], seq: 0, error: error.message })
        }
      },
    },
    {
      kind: 'exact', method: 'GET', path: API + '/stream',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          const response = await fetch(upstream('/stream' + url.search))
          if (!response.ok || !response.body) throw new Error('bridge stream status ' + response.status)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          const body = Readable.fromWeb(response.body)
          req.on('close', () => body.destroy())
          body.pipe(res)
        } catch (error) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          res.write('event: state\ndata: {"phase":"offline","message":"bridge unreachable"}\n\n')
          res.end()
        }
      },
    },
    {
      kind: 'exact', method: 'POST', path: API + '/action',
      handler: async (req, res) => {
        const body = await readJson(req)
        try {
          const response = await fetch(upstream('/action'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          json(res, 200, await response.json())
        } catch (error) {
          json(res, 200, { ok: false, error: 'bridge unreachable: ' + error.message })
        }
      },
    },
    {
      kind: 'exact', method: 'GET', path: API + '/config',
      handler: async (req, res) => json(res, 200, { config: (getConfig ? getConfig() : presentation), at: Date.now() }),
    },
    {
      kind: 'exact', method: 'GET', path: API + '/health',
      handler: async (req, res) => {
        try {
          const response = await fetch(upstream('/health'), { signal: AbortSignal.timeout(2000) })
          json(res, 200, await response.json())
        } catch (error) {
          json(res, 200, { ok: false, error: error.message })
        }
      },
    },
  ]
}

const SETTINGS_NS = 'stm32-toolchain'

/**
 * Settings surface of this plugin only: one namespace (this profile entry's id),
 * describe for the form's initial values and mutate for a save. Structural on
 * purpose - 0.1.x `SettingsProvider` and 0.2 `SettingsForms` both answer these.
 */
export function makeSettingsRoutes(settings) {
  const view = (descriptor) => ({
    ns: descriptor.ns, value: descriptor.value, base: descriptor.base, user: descriptor.user,
    revision: descriptor.revision, secrets: descriptor.secrets,
  })

  const findOurs = () => {
    const all = typeof settings.describe === 'function' ? settings.describe({ redactSecrets: true }) : []
    return all.find((entry) => String(entry.ns) === SETTINGS_NS) || null
  }

  return [
    {
      kind: 'exact', method: 'GET', path: API + '/settings/describe',
      handler: async (req, res) => {
        try {
          const own = findOurs()
          json(res, 200, { namespaces: own ? [view(own)] : [], writable: settings.writable !== false })
        } catch (error) {
          json(res, 200, { namespaces: [], writable: false, error: error.message })
        }
      },
    },
    {
      kind: 'exact', method: 'POST', path: API + '/settings/mutate',
      handler: async (req, res) => {
        const body = await readJson(req)
        try {
          const ops = Array.isArray(body.ops) ? body.ops : []
          const revision = typeof body.revision === 'number' ? body.revision : undefined
          await settings.mutate(SETTINGS_NS, ops, revision)
          const own = findOurs()
          json(res, 200, { ok: true, namespace: own ? view(own) : null })
        } catch (error) {
          json(res, 200, { ok: false, code: error.code || 'ERROR', message: error.message })
        }
      },
    },
  ]
}

export function apply(ctx, config) {
  const active = unwrapConfig(config || {})
  if (active.enabled === false) return
  const port = toNumber(active.httpPort, 39021)
  // Refreshed on every apply, i.e. on every committed settings change.
  presentation = pickPresentation(active)

  /**
   * Read the settings service instead of waiting for a plugin re-apply: a saved
   * setting must reach the panel immediately, not after a restart.
   */
  let settingsFace = null
  const livePresentation = () => {
    try {
      const describe = settingsFace && settingsFace.describe
      if (typeof describe !== 'function') return presentation
      const own = (describe({ redactSecrets: true }) || []).find((entry) => String(entry.ns) === SETTINGS_NS)
      if (own && own.value && typeof own.value === 'object') return pickPresentation(unwrapConfig(own.value))
    } catch { /* fall back to the apply-time snapshot */ }
    return presentation
  }

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.plugin(mcpClient, launchConfig(active))
  })

  ctx.effect(() => {
    const disposers = makeRoutes(() => port, () => livePresentation()).map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'stm32-toolchain: host routes')


  ctx.effect(() => {
    const route = {
      kind: 'exact', method: 'POST', path: API + '/ask',
      handler: async (req, res) => {
        const body = await readJson(req)
        const sessionId = toText(body.sessionId, '')
        const text = toText(body.text, '')
        if (!sessionId || !text.trim()) return json(res, 200, { ok: false, error: '需要 sessionId 和 text' })
        /* The host has no sessions.prompt. What it does have is agents.get(id) with
         * followup(msg): that is exactly what the app uses to queue a user turn
         * (dsh-api-session-controller calls agent.followup(createUserMessage(...))). */
        let agent = null
        try {
          const agents = ctx.get('agents')
          agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error && error.message || error) })
        }
        if (!agent || typeof agent.followup !== 'function') {
          return json(res, 200, { ok: false, error: '找不到会话 ' + sessionId + '（可能已关闭）：先打开该会话再试' })
        }
        try {
          const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)
          agent.followup({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error && error.message || error) })
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'stm32-toolchain: ask route')

  ctx.inject(['settings'], (sctx) => {
    settingsFace = sctx.settings || null
    // This plugin ships its own card, so the auto-generated page stays off; the
    // card edits only this entry's Config (never another plugin's namespace).
    if (typeof sctx.settings?.configure === 'function') {
      sctx.effect(() => sctx.settings.configure({ auto: false }), 'stm32-toolchain: settings page policy')
    }
    sctx.effect(() => {
      const disposers = makeSettingsRoutes(sctx.settings).map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'stm32-toolchain: settings routes')
  })

  if (active.announceToAgent !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'plugin:stm32-toolchain',
      order: 40,
      text: GUIDANCE,
    }), 'stm32-toolchain: guidance')
  }
}
