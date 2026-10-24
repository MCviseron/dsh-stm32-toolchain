#!/usr/bin/env node
/**
 * dsh-stm32-toolchain bridge.
 *
 * One process owns the board: it holds the serial port, serializes build/flash
 * jobs, keeps a ring log, and exposes the same state three ways:
 *   - MCP over stdio   -> the DSH agent's tools (mcp__stm32__*)
 *   - HTTP on 127.0.0.1:39021 -> the host plugin's routes / the panel
 *   - SSE /stream      -> live log + phase push to the panel
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  buildProject, flashSwd, doctor, loadChips, resolveChip, readProject,
  findCubeMx, loadImage, openInVscode, cubeGenerate, listSerialPorts, findUV4, run, resolveOpenPath, climbBuildDir, resolveProjectRoot,
} from './core.mjs'
import { SerialPipe } from './serial.mjs'
import { flashImage } from './bootloader.mjs'
import { generateFirmware, flashEsp, firmwareToolchain, detectEsp, PIPE_BAUDS, BUILD_DIR } from './wifi-fw.mjs'
import { WifiPipe, discoverEsp } from './wifi.mjs'

const VERSION = '0.1.0'
/** Short per-process id: log entries from two bridge generations must not collide. */
const INSTANCE = Math.random().toString(36).slice(2, 8)
const PORT = Number(process.env.DSH_STM32_HTTP_PORT || 39021)
const MAX_LOGS = 2000

const env = process.env
const settings = {
  project: env.DSH_STM32_PROJECT || '',
  uv4: env.DSH_STM32_UV4 || '',
  cubeMx: env.DSH_STM32_CUBEMX || '',
  transport: env.DSH_STM32_TRANSPORT || 'swd',      // swd | uart
  portName: env.DSH_STM32_PORT || '',
  baud: Number(env.DSH_STM32_BAUD || 115200),
  espHost: env.DSH_STM32_ESP_HOST || '',
  espCtrlPort: Number(env.DSH_STM32_ESP_CTRL_PORT || 3333),
  espPipePort: Number(env.DSH_STM32_ESP_PIPE_PORT || 3334),
  espBaud: 115200,
  wifiSsid: '',
  espBoard: 'nodemcu',
  wifiPass: '',
  wifiSerial: false,
  serialHex: false,
  serialEcho: true,

  espPort: Number(env.DSH_STM32_ESP_PORT || 23),
  python: env.DSH_STM32_PYTHON || '',
  retries: Number(env.DSH_STM32_RETRY || 3),
  scanRoots: env.DSH_STM32_SCAN_ROOTS || '',
  cardOrder: env.DSH_STM32_CARD_ORDER || 'chip,transport,port,firmware,build,flash,lease,logs',
  logFontSize: Number(env.DSH_STM32_LOG_FONT || 12),
  logLineHeight: Number(env.DSH_STM32_LOG_LINE || 1.5),
  logMaxLines: Number(env.DSH_STM32_LOG_MAX || 400),
  logWrap: env.DSH_STM32_LOG_WRAP !== '0',
  logTimestamps: env.DSH_STM32_LOG_TIME === '1',
  logColorBuild: env.DSH_STM32_LOG_C_BUILD || '',
  logColorFlash: env.DSH_STM32_LOG_C_FLASH || '',
  logColorSerial: env.DSH_STM32_LOG_C_SERIAL || '',
  logColorSys: env.DSH_STM32_LOG_C_SYS || '',
  logBgGradient: env.DSH_STM32_LOG_BG_GRADIENT === '1',
  logBgFrom: env.DSH_STM32_LOG_BG_FROM || '#0d1117',
  logBgTo: env.DSH_STM32_LOG_BG_TO || '#161b22',
}

const STATE_FILE = process.env.DSH_STM32_STATE_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.state.json')

/** Panel choices survive a restart: UI state, not host settings. */
function loadSaved() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

const RECENT_LIMIT = 10

/** Newest first, no duplicates, capped - the list the panel offers as 最近工程. */
function rememberProject(file) {
  if (!file) return
  const previous = Array.isArray(saved.recentProjects) ? saved.recentProjects : []
  const rest = previous.filter((entry) => entry && entry.file && entry.file.toLowerCase() !== file.toLowerCase())
  const next = [{ file, at: now() }, ...rest].slice(0, RECENT_LIMIT)
  saved.recentProjects = next
  saveSaved({ recentProjects: next })
}

function saveSaved(patch) {
  try { writeFileSync(STATE_FILE, JSON.stringify({ ...loadSaved(), ...patch }, null, 2)) } catch { /* read-only install */ }
}

const saved = loadSaved()
if (!settings.project && saved.project) settings.project = saved.project
if (settings.project) rememberProject(settings.project)
if (!settings.espHost && saved.espHost) settings.espHost = saved.espHost
if (!settings.wifiSsid && saved.wifiSsid) settings.wifiSsid = saved.wifiSsid
if (!settings.wifiPass && saved.wifiPass) settings.wifiPass = saved.wifiPass
if (saved.espPort) settings.espPort = saved.espPort
if (saved.retry) settings.retry = saved.retry
if (!settings.portName && saved.portName) settings.portName = saved.portName
if (saved.transport) settings.transport = saved.transport
if (saved.baud) settings.baud = saved.baud

const state = {
  phase: 'idle',
  message: '',
  transport: settings.transport,
  project: settings.project,
  chip: null,
  port: settings.portName,
  firmware: null,
  lastBuild: null,
  lastFlash: null,
  serialOpen: false,
  serialLines: 0,
  leaseOwner: null,
  binding: saved.binding && typeof saved.binding === 'object' ? saved.binding : null,
  updatedAt: Date.now(),
}

/* restore the last generated firmware (state must exist first: no using it before this point) */
if (saved.espFirmware && typeof saved.espFirmware === 'object') state.espFirmware = saved.espFirmware

const logs = []
let seq = 0
const subscribers = new Set()

function now() { return Date.now() }

function log(channel, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = { instance: INSTANCE, seq: ++seq, t: now(), channel, text: line.slice(0, 2000) }
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
    for (const push of subscribers) push(entry)
  }
  if (channel !== 'serial') process.stderr.write('[' + channel + '] ' + String(text).slice(0, 400) + '\n')
}

function setPhase(phase, message) {
  state.phase = phase
  state.message = message || phase
  state.updatedAt = now()
  for (const push of subscribers) push({ state: snapshot() })
}

function snapshot() {
  // Read the lease first: leaseView() may clear state.leaseOwner when it expired,
  // and the spread below would otherwise copy the stale owner.
  const leaseInfo = leaseView()
  const lockInfo = lockView()
  const safeSettings = { ...settings, wifiPass: undefined }
  return {
    ...state,
    instance: INSTANCE,
    version: VERSION,
    logs: undefined,
    settings: safeSettings,
    wifi: {
      ssid: settings.wifiSsid || '',
      hasPass: Boolean(settings.wifiPass),
      board: settings.espBoard,
      serial: settings.wifiSerial ? 'wifi' : 'local',
      hex: Boolean(settings.serialHex),
      echo: settings.serialEcho !== false,
      firmware: state.espFirmware
        ? { name: basename(state.espFirmware.bin || ''), bytes: state.espFirmware.bytes, at: state.espFirmware.at }
        : null,
    },
    lease: leaseInfo,
    cube: cubeView(),
    pipeBaud: settings.espBaud,
    pipeBauds: PIPE_BAUDS,
    env: state.env || null,
    recent: recentView(),
    lock: lockInfo,
  }
}

// ---------------------------------------------------------------- exclusivity
const LEASE_TTL = Number(process.env.DSH_STM32_LEASE_TTL || 180000)
/** A running job keeps its own lease alive; an idle one still expires. */
const LEASE_HEARTBEAT = Number(process.env.DSH_STM32_LEASE_HEARTBEAT || 15000)
const LOCK_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.lock.json')
const LOCK_TTL = 5 * 60 * 1000
let lease = null

function leaseView() {
  // An expired lease is dropped on read, so no stale owner can linger in the UI.
  if (lease && lease.expiresAt <= Date.now()) {
    lease = null
    state.leaseOwner = null
    stopHeartbeat()
  }
  if (!lease) return null
  return {
    owner: lease.owner,
    since: lease.since,
    heldSeconds: Math.max(0, Math.round((Date.now() - lease.since) / 1000)),
    expiresInSeconds: Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000)),
    token: lease.token.slice(0, 8),
  }
}

function recentView() {
  const list = Array.isArray(saved.recentProjects) ? saved.recentProjects : []
  return list.map((entry) => ({
    file: entry.file,
    name: basename(entry.file).replace(/\.uvprojx$/i, ''),
    at: entry.at,
    exists: existsSync(entry.file),
  }))
}

function cubeView() {
  const exe = findCubeMx(settings.cubeMx || undefined)
  return { path: exe || '', found: Boolean(exe), ioc: projectIoc() }
}

function lockView() {
  try {
    const info = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    return info.expiresAt > Date.now() ? { pid: info.pid, kind: info.kind, since: info.startedAt } : null
  } catch { return null }
}

let heartbeat = null

/** Renew while a job is running, so a slow build is never mistaken for an idle board. */
function startHeartbeat(token) {
  stopHeartbeat()
  heartbeat = setInterval(() => {
    if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) { stopHeartbeat(); return }
    lease.expiresAt = Date.now() + LEASE_TTL
    state.updatedAt = Date.now()
    for (const push of subscribers) push({ state: snapshot() })
  }, LEASE_HEARTBEAT)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
}

function stopHeartbeat() {
  if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
}

function busy(kind) {
  const holder = leaseView() || { owner: 'unknown', since: Date.now() }
  const error = new Error('board busy (' + kind + '): held by ' + holder.owner + ' for ' + Math.round((Date.now() - holder.since) / 1000) + 's')
  error.code = 'BOARD_BUSY'
  error.heldBy = holder
  return error
}

/**
 * Mutating calls serialise through one lease. Without a token the first caller
 * claims implicitly (single-session convenience); a second session gets BUSY
 * with the holder instead of silently interleaving with someone else's flash.
 */
function guard(params, kind) {
  const now = Date.now()
  const token = typeof params.token === 'string' && params.token ? params.token : ''
  if (lease && lease.expiresAt > now) {
    // Explicit token: only its owner continues. No token: implicit callers (the
    // panel, or an agent that never claimed) share the implicit lease, while an
    // explicit claim stays protected from them.
    if (token && token !== lease.token) throw busy(kind)
    if (!token && !lease.implicit) throw busy(kind)
    lease.expiresAt = now + LEASE_TTL
    if (!token && params.owner) lease.owner = params.owner
    return lease
  }
  lease = { token: token || randomToken(), owner: params.owner || '面板', implicit: !token, since: now, expiresAt: now + LEASE_TTL }
  state.leaseOwner = lease.owner
  return lease
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Second line of defence: another DSH instance / bridge process on the same board. */
function takeLock(kind) {
  const now = Date.now()
  const held = lockView()
  if (held && held.pid !== process.pid && alive(held.pid)) {
    throw new Error('another DSH instance is driving the board (pid ' + held.pid + ', ' + held.kind + ', ' + Math.round((now - held.since) / 1000) + 's)')
  }
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, kind, token: lease ? lease.token.slice(0, 8) : '', startedAt: now, expiresAt: now + LOCK_TTL }))
  } catch { /* read-only install */ }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE) } catch { /* nothing to release */ }
}

/** Fail before touching the board: no project means nothing to build, flash or deploy. */
function requireProject(params) {
  if (params.file || settings.project || state.project) return
  const error = new Error('未选择工程：先在「工程」卡里选择 / 扫描工程，或传 file=<.uvprojx>')
  error.code = 'NO_PROJECT'
  throw error
}

/** guard -> lease check -> cross-process lock -> serialised job. */
async function guarded(kind, params, task) {
  if (kind === 'build' || kind === 'flash' || kind === 'deploy') requireProject(params)
  const heldBefore = lease && lease.expiresAt > Date.now() ? lease.token : null
  const claimed = guard(params, kind)
  const autoClaimed = heldBefore === null
  state.leaseOwner = claimed.owner
  claimed.busyKind = kind
  startHeartbeat(claimed.token)
  try {
    return await queue(kind, async () => {
      takeLock(kind)
      try { return await task() } finally { releaseLock() }
    })
  } catch (error) {
    // An implicit claim must not outlive the failure that caused it.
    if (autoClaimed && lease && lease.token === claimed.token) {
      lease = null
      state.leaseOwner = null
      log('sys', 'released the implicit lease of ' + kind + ' after failure')
      setPhase('error', kind + ' 失败：' + error.message)
    }
    throw error
  } finally {
    stopHeartbeat()
    delete claimed.busyKind
  }
}

function firmwareInfo(project) {
  for (const candidate of [project.hex, project.axf, project.bin]) {
    try {
      const info = statSync(candidate)
      return { path: candidate, bytes: info.size, name: basename(candidate), at: info.mtimeMs }
    } catch { /* keep looking */ }
  }
  return null
}

/** Serialize every board operation: two UV4 runs or two port owners must never overlap. */
let chain = Promise.resolve()
function queue(kind, task) {
  const run = chain.then(async () => {
    try {
      return await task()
    } catch (error) {
      setPhase('error', kind + ': ' + error.message)
      log('sys', 'ERROR ' + error.message)
      throw error
    }
  })
  chain = run.catch(() => undefined)
  return run
}

function projectOf(file) {
  const target = file || settings.project || state.project
  if (!target) throw new Error('未选择工程：先在「工程」卡里选择 / 扫描工程，或传 file=<.uvprojx>')
  const project = readProject(target)
  state.project = project.file
  state.chip = { device: project.device, family: project.chip.family, known: project.chip.known, note: project.chip.note }
  return project
}

async function doBuild(file, options = {}) {
  const project = projectOf(file)
  setPhase('building', 'building ' + project.name + ' (' + project.targetName + ')')
  log('build', 'UV4 ' + (options.rebuild ? '-r' : '-b') + ' ' + project.name)
  const result = await buildProject(project.file, { uv4: settings.uv4, project, rebuild: options.rebuild })
  for (const line of result.log.split(/\r?\n/)) if (line.trim()) log('build', line)
  state.lastBuild = {
    ok: result.ok, code: result.code, reason: result.reason, elapsedMs: result.elapsedMs,
    errors: result.errors, warnings: result.warnings, diagnostics: result.diagnostics.slice(0, 50),
    at: now(),
  }
  state.firmware = firmwareInfo(project)
  if (!result.ok) {
    const first = result.diagnostics.find((d) => d.severity !== 'warning')
    setPhase('error', 'build failed: ' + (first ? first.file + ':' + first.line + ' ' + first.message : result.reason))
    return { ok: false, ...state.lastBuild }
  }
  setPhase('running', 'build ok in ' + (result.elapsedMs / 1000).toFixed(1) + 's' + (project.chip.known ? '' : ' (unknown chip, defaults applied)'))
  return state.lastBuild
}

async function doFlash(file, options = {}) {
  const project = projectOf(file)
  const transport = options.transport || settings.transport
  state.transport = transport
  if (transport === 'swd') {
    setPhase('flashing', 'downloading via ST-Link (uVision -f)')
    log('flash', 'UV4 -f ' + project.name)
    const result = await flashSwd(project.file, { uv4: settings.uv4, project })
    for (const line of result.log.split(/\r?\n/)) if (line.trim()) log('flash', line)
    state.lastFlash = { ok: result.ok, code: result.code, elapsedMs: result.elapsedMs, transport, at: now() }
    if (!result.ok) { setPhase('error', 'ST-Link download failed (code ' + result.code + ')'); return state.lastFlash }
    setPhase('running', 'flashed via ST-Link in ' + (result.elapsedMs / 1000).toFixed(1) + 's, target running')
    return state.lastFlash
  }
  if (transport === 'wifi') {
    const host = String(options.host || settings.espHost || '').trim()
    if (!host) throw new Error('Wi-Fi 烧录需要先填「ESP 主机」（ESP 的 IP，例如 192.168.137.253）')
    const image = await loadImage(project)
    if (!image.image.length) throw new Error('empty firmware image')
    setPhase('flashing', 'flashing ' + image.image.length + ' bytes over Wi-Fi to ' + host)
    log('flash', 'wifi ' + host + ' ctrl=' + settings.espCtrlPort + ' pipe=' + settings.espPipePort + ', image ' + image.image.length + ' bytes at 0x' + image.baseAddress.toString(16))
    let useHost = host
    let pipe
    try {
      pipe = await WifiPipe.open(useHost, {
        ctrlPort: settings.espCtrlPort,
        pipePort: settings.espPipePort,
        /* Fail fast: a stale DHCP address should cost seconds, not the default eight. */
        timeoutMs: 2500,
        log: (text) => log('flash', text),
      })
    } catch (error) {
      /* DHCP moved the bridge: look for it once instead of failing on a stale address. */
      log('flash', '连接 ' + useHost + ' 失败（' + error.message + '），自动探测 ESP…')
      const found = await discoverEsp({ port: settings.espCtrlPort }).catch(() => null)
      const devices = (found && found.devices) || []
      if (devices.length !== 1) {
        throw new Error('连接 ' + useHost + ' 失败，自动探测' + (devices.length ? '找到 ' + devices.length + ' 个候选' : '也没找到 ESP') + '：' + error.message)
      }
      useHost = devices[0].host
      settings.espHost = useHost
      saveSaved({ espHost: useHost })
      setPhase(state.phase, 'ESP 在 ' + useHost + '（已自动更新）')
      log('flash', 'ESP 自动探测到 ' + useHost + '，用它重试')
      pipe = await WifiPipe.open(useHost, {
        ctrlPort: settings.espCtrlPort,
        pipePort: settings.espPipePort,
        log: (text) => log('flash', text),
      })
    }
    const started = now()
    try {
      const manualReset = Boolean(options.manualReset)
      const manualWaitMs = Number(options.manualWaitMs || 45000)
      if (manualReset) log('flash', '手动模式：BOOT0 已拉高，请在 ' + Math.round(manualWaitMs / 1000) + ' 秒内按一下板子的复位键')
      await pipe.enterBootloader(manualReset ? { pulse: false } : {})
      const result = await flashImage(pipe, image.image, {
        baseAddress: image.baseAddress,
        log: (text) => log('flash', text),
        syncWaitMs: manualReset ? manualWaitMs : 0,
        /* One reset pulse is a single coin toss: BOOT0 has to be settled when NRST rises.
         * Between handshake attempts, look at what the bridge reports and try again. */
        onHandshakeRetry: async (attempt) => {
          if (manualReset) {
            log('flash', '重试 ' + attempt + '：手动复位模式，仍在等你按复位键')
            return
          }
          const status = await pipe.status().catch(() => '')
          const boot0 = /boot0=(\d)/.exec(status)
          const nrst = /nrst=(\d)/.exec(status)
          const rx = /rx=(\d+)/.exec(status)
          const tx = /tx=(\d+)/.exec(status)
          if (boot0 || nrst) {
            /* rx counts bytes pushed towards the STM32, tx counts bytes that came back: rx growing
             * while tx stays flat means our frames left the ESP and the chip never answered. */
            log('flash', 'ESP 线路：boot0=' + (boot0 ? boot0[1] : '?') + ' nrst=' + (nrst ? nrst[1] : '?') +
              (rx ? ' rx=' + rx[1] : '') + (tx ? ' tx=' + tx[1] : ''))
            if (boot0 && boot0[1] === '0') log('flash', '⚠️ ESP 读到的 BOOT0 是低电平：D2→BOOT0 这根线多半没接好')
          }
          log('flash', '重试 ' + attempt + '：重新拉高 BOOT0 并复位')
          await pipe.enterBootloader({ pulseMs: 200 })
        },
      })
      state.lastFlash = { ok: true, bytes: result.bytes, pid: result.pid, elapsedMs: now() - started, transport: 'wifi', at: now() }
      setPhase('running', 'flashed ' + result.bytes + ' bytes over Wi-Fi in ' + ((now() - started) / 1000).toFixed(1) + 's')
      try { await pipe.run() } catch (error) { log('flash', 'RUN after flash failed: ' + error.message) }
      return state.lastFlash
    } catch (error) {
      state.lastFlash = { ok: false, error: error.message, transport: 'wifi', at: now() }
      /* never leave BOOT0 asserted: release it so the board can boot the old firmware */
      try { await pipe.run() } catch { log('flash', 'could not release BOOT0 after the failure') }
      setPhase('error', 'Wi-Fi flash failed: ' + error.message)
      throw error
    } finally {
      await pipe.close()
    }
  }
  const port = options.port || settings.portName
  if (!port) throw new Error('no serial port for the UART transport (pass port=COMx)')
  const image = await loadImage(project)
  if (!image.image.length) throw new Error('empty firmware image')
  setPhase('flashing', 'flashing ' + image.image.length + ' bytes over UART on ' + port)
  log('flash', 'uart ' + port + ' baud ' + (options.baud || settings.baud) + ', image ' + image.image.length + ' bytes at 0x' + image.baseAddress.toString(16))
  const pipe = await SerialPipe.open(port, options.baud || settings.baud, settings.python)
  const started = now()
  try {
    const result = await flashImage(pipe, image.image, {
      baseAddress: image.baseAddress,
      log: (text) => log('flash', text),
    })
    state.lastFlash = { ok: true, bytes: result.bytes, pid: result.pid, elapsedMs: now() - started, transport: 'uart', at: now() }
    setPhase('running', 'flashed ' + result.bytes + ' bytes over UART in ' + ((now() - started) / 1000).toFixed(1) + 's')
    return state.lastFlash
  } catch (error) {
    state.lastFlash = { ok: false, error: error.message, transport: 'uart', at: now() }
    setPhase('error', 'UART flash failed: ' + error.message)
    throw error
  } finally {
    await pipe.close()
  }
}

async function doDeploy(file, options = {}) {
  const build = await doBuild(file, options)
  if (!build.ok) return { ok: false, stage: 'build', build }
  const flash = await doFlash(file, options)
  const result = { ok: Boolean(flash.ok), stage: 'flash', build, flash }
  const watchMs = Math.min(Number(options.watch || 0), 30000)
  if (result.ok && watchMs > 0) {
    const marker = seq
    const alreadyOpen = Boolean(monitor)
    try {
      if (!alreadyOpen) await startMonitor(options.port, options.baud)
      await new Promise((resolve) => setTimeout(resolve, watchMs))
      result.serial = logs.filter((entry) => entry.seq > marker && entry.channel === 'serial').map((entry) => entry.text).slice(-120)
    } catch (error) {
      result.serialError = error.message
    } finally {
      if (!alreadyOpen) await stopMonitor().catch(() => undefined)
    }
  }
  return result
}

/** The .ioc next to the selected project, if any. */
function iocIn(dir) {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.ioc')).map((name) => join(dir, name))
  } catch {
    return []
  }
}

/** An .ioc chosen by hand for this project (wins over any scan). */
function savedIoc(project) {
  const map = saved.iocByProject || {}
  const hit = map[project]
  return hit && existsSync(hit) ? hit : null
}

/**
 * Keil keeps the .uvprojx in MDK-ARM (or a similar build folder), the .ioc usually sits one
 * or two levels above it - but the layout varies, so look in the project folder, up to four
 * parents, and two levels below the project folder, preferring an .ioc named like the project.
 */
function projectIoc() {
  if (!state.project) return null
  const explicit = savedIoc(state.project)
  if (explicit) return explicit

  const stem = basename(state.project).replace(/\.uvprojx$/i, '').toLowerCase()
  const candidates = []
  let dir = dirname(state.project)
  for (let level = 0; level < 4; level += 1) {
    candidates.push(...iocIn(dir))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const sub of iocIn(dirname(state.project))) candidates.push(sub)
  try {
    for (const entry of readdirSync(dirname(state.project), { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(...iocIn(join(dirname(state.project), entry.name)))
    }
  } catch { /* no subfolders */ }

  const unique = [...new Set(candidates)]
  const exact = unique.find((file) => basename(file).replace(/\.ioc$/i, '').toLowerCase() === stem)
  return exact || unique[0] || null
}

/** True when the bridge answers on its control port within 1.5 s. */
function espPing(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port || 3333) })
    let text = ''
    const done = (value) => { try { socket.destroy() } catch { /* gone */ } ; resolve(value) }
    const timer = setTimeout(() => done(null), 1500)
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (/\+PING|\+STATUS|\+PONG/.test(text)) { clearTimeout(timer); done(text.split('\r\n')[0]) }
    })
    socket.once('connect', () => socket.write('PING\r\n'))
    socket.once('error', () => { clearTimeout(timer); done(null) })
  })
}

// ---------------------------------------------------------------- serial monitor
let monitor = null

const MONITOR_BAUDS = [115200, 460800, 230400, 57600, 38400, 19200, 9600]

/** Open the port at each candidate rate and keep the one that produces readable text. */
async function detectBaud(port) {
  let best = { baud: 115200, score: -1 }
  for (const baud of MONITOR_BAUDS) {
    let pipe = null
    try {
      pipe = await SerialPipe.open(port, baud, settings.python)
      await new Promise((resolve) => setTimeout(resolve, 450))
      const sample = pipe.buffer.subarray(0, 512)
      let printable = 0
      for (const byte of sample) {
        if (byte === 9 || byte === 10 || byte === 13) printable += 1
        else if (byte >= 32 && byte < 127) printable += 1
        else if (byte === 0) printable -= 2
      }
      const score = sample.length ? printable / Math.sqrt(sample.length) : 0
      if (score > best.score) best = { baud, score }
    } catch { /* port busy or unsupported rate */ }
    finally { if (pipe) await pipe.close().catch(() => undefined) }
  }
  return best
}

async function startMonitorWifi() {
  if (monitor) await stopMonitor()
  let host = settings.espHost
  if (!host) {
    setPhase('running', '正在探测 ESP…')
    const found = await discoverEsp({ port: settings.espCtrlPort }).catch(() => null)
    const devices = (found && found.devices) || []
    if (devices.length !== 1) {
      const why = devices.length
        ? '找到 ' + devices.length + ' 台候选：' + devices.map((d) => d.host).join('、')
        : '本网段没找到 ESP（热点没开？ESP 没上电？）'
      setPhase('error', '找不到 ESP：' + why)
      throw new Error('找不到 ESP：' + why)
    }
    host = devices[0].host
    settings.espHost = host
    saveSaved({ espHost: host })
    log('sys', '无线串口：自动探测到 ESP ' + host)
  }
  setPhase('running', '正在连接 ESP ' + host + '…')
  let pipe
  try {
    pipe = await WifiPipe.open(host, { pipePort: settings.espPipePort, timeoutMs: 2500 })
  } catch (error) {
    /* The address moved or the bridge slept - look for it instead of failing blind. */
    log('sys', '连接 ' + host + ' 失败（' + error.message + '），自动探测 ESP…')
    setPhase('running', 'ESP 无应答，正在探测…')
    const found = await discoverEsp({ port: settings.espCtrlPort }).catch(() => null)
    const devices = (found && found.devices) || []
    if (devices.length !== 1) {
      const why = devices.length
        ? '找到 ' + devices.length + ' 台候选：' + devices.map((d) => d.host).join('、')
        : '本网段没发现应答 3333 端口的设备'
      setPhase('error', '无线串口打不开：' + host + ' 无应答，且' + why)
      throw new Error(host + ' 无应答（' + error.message + '），自动探测也失败：' + why)
    }
    host = devices[0].host
    settings.espHost = host
    saveSaved({ espHost: host })
    log('sys', '无线串口：自动探测到 ESP ' + host + '，重试')
    pipe = await WifiPipe.open(host, { pipePort: settings.espPipePort, timeoutMs: 5000 })
  }
  const target = 'wifi://' + host + ':' + settings.espPipePort
  monitor = { pipe, port: target, baud: 115200, wireless: true, partial: '' }
  state.serialOpen = true
  state.port = target
  log('sys', 'wireless serial open on ' + target + '（速率由 ESP 固件决定：' + settings.espBaud + '）')
  pipe.onClose = () => {
    if (!monitor || monitor.pipe !== pipe) return
    log('sys', '无线串口已断开（ESP 重启或网络中断），需要时重新打开')
    monitor = null
    state.serialOpen = false
    setPhase(state.phase === 'error' ? 'idle' : state.phase, '无线串口已断开')
  }
  pipe.onData = (chunk) => {
    /* Keep raw bytes: decoding per chunk breaks multi-byte characters (CJK arrived as ï¼？). */
    monitor.pending = Buffer.concat([monitor.pending || Buffer.alloc(0), chunk])
    let index = monitor.pending.indexOf(0x0a)
    while (index >= 0) {
      let line = monitor.pending.subarray(0, index)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      monitor.pending = monitor.pending.subarray(index + 1)
      const text = line.toString('utf8')
      if (text.length) { log('serial', text); state.serialLines += 1 }
      index = monitor.pending.indexOf(0x0a)
    }
    if (monitor.pending.length > 8192) monitor.pending = monitor.pending.subarray(monitor.pending.length - 2048)
  }
  setPhase(state.phase === 'idle' || state.phase === 'error' ? 'running' : state.phase, 'wireless serial open on ' + target)
  return { port: target, baud: 115200, wireless: true }
}

async function startMonitor(port, baud) {
  if (settings.wifiSerial) return await startMonitorWifi()
  const target = port || settings.portName
  if (!target) throw new Error('no serial port: pass port=COMx')
  if (String(baud) === 'auto' || Number(baud) === 0) {
    const detected = await detectBaud(target)
    log('sys', '串口波特率自动检测：' + detected.baud + (detected.score > 0 ? '' : '（没读到可识别数据，用默认值）'))
    baud = detected.baud
    settings.baud = detected.baud
    saveSaved({ baud: detected.baud })
  }
  if (monitor) await stopMonitor()
  const pipe = await SerialPipe.open(target, baud || settings.baud, settings.python)
  monitor = { pipe, port: target, baud: baud || settings.baud, partial: '' }
  state.serialOpen = true
  state.port = target
  log('sys', 'serial monitor open on ' + target + ' @' + monitor.baud)
  pipe.onLine = () => {
    let line = pipe.takeLine()
    while (line !== null) {
      const text = settings.serialHex
        ? (Buffer.from(line).toString('hex').toUpperCase().match(/.{1,32}/g) || []).join(' ')
        : line.replace(/\r?\n$/, '')
      log('serial', text)
      state.serialLines += 1
      line = pipe.takeLine()
    }
  }
  setPhase(state.phase === 'idle' || state.phase === 'error' ? 'running' : state.phase, 'serial monitor open on ' + target)
  return { port: target, baud: monitor.baud }
}

async function stopMonitor() {
  if (!monitor) return { ok: true, alreadyClosed: true }
  const port = monitor.port
  await monitor.pipe.close()
  monitor = null
  state.serialOpen = false
  log('sys', 'serial monitor closed (' + port + ')')
  state.updatedAt = now()
  return { ok: true, port }
}

/**
 * A path captured from a GBK console arrives as mojibake ("D:\ʵ���Ҿ���"). If the
 * literal string does not exist, re-decode it as latin1 -> utf8 and retry.
 */
function repairPath(value) {
  if (typeof value !== 'string' || value === '') return value
  if (existsSync(value)) return value
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8')
    if (repaired !== value && existsSync(repaired)) return repaired
  } catch { /* not repairable */ }
  return value
}

/** Pick a file natively (OpenFileDialog) filtered to *.ioc. */
async function pickFile(filter, title) {
  const outFile = join(tmpdir(), 'dsh-stm32-pickfile-' + Date.now() + '.txt')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$top = New-Object System.Windows.Forms.Form',
    '$top.TopMost = $true',
    '$top.ShowInTaskbar = $false',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    "$dlg.Title = '" + title + "'",
    "$dlg.Filter = '" + filter + "'",
    '$dlg.CheckFileExists = $true',
    'if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.FileName }',
    '$top.Close()',
    "if ($picked) { [System.IO.File]::WriteAllText('" + outFile + "', $picked, (New-Object System.Text.UTF8Encoding($false))) }",
  ].join('\r\n')
  const result = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 180000 })
  let picked = ''
  try { picked = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim() } catch { /* cancelled */ }
  try { unlinkSync(outFile) } catch { /* nothing to remove */ }
  if (!picked) return { ok: false, cancelled: true, hint: result.out.trim().slice(0, 200) }
  return { ok: true, file: repairPath(picked) }
}

/** Pick a folder natively (Windows shell dialog) so the panel does not need a path typed by hand. */
async function pickFolder() {
  const outFile = join(tmpdir(), 'dsh-stm32-pick-' + Date.now() + '.txt')
  const cs = "using System;\r\nusing System.Runtime.InteropServices;\r\n\r\npublic static class DshFolderPicker {\r\n  [ComImport, Guid(\"DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7\")] private class FileOpenDialogRCW {}\r\n  [ComImport, Guid(\"d57c7288-d4ad-4768-be02-9d969532d960\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\r\n  private interface IFileOpenDialog {\r\n    [PreserveSig] int Show(IntPtr hwnd);\r\n    void SetFileTypes(uint c, IntPtr spec);\r\n    void SetFileTypeIndex(uint i);\r\n    void GetFileTypeIndex(out uint i);\r\n    void Advise(IntPtr e, out uint cookie);\r\n    void Unadvise(uint cookie);\r\n    void SetOptions(uint fos);\r\n    void GetOptions(out uint fos);\r\n    void SetDefaultFolder(IShellItem item);\r\n    void SetFolder(IShellItem item);\r\n    void GetFolder(out IShellItem item);\r\n    void GetCurrentSelection(out IShellItem item);\r\n    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);\r\n    void GetFileName(out IntPtr name);\r\n    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);\r\n    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);\r\n    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);\r\n    void GetResult(out IShellItem item);\r\n    void AddPlace(IShellItem item, int fdap);\r\n    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);\r\n    void Close(int hr);\r\n    void SetClientGuid(ref Guid guid);\r\n    void ClearClientData();\r\n    void SetFilter(IntPtr filter);\r\n    void GetResults(out IntPtr results);\r\n    void GetSelectedItems(out IntPtr items);\r\n  }\r\n  [ComImport, Guid(\"43826d1e-e718-42ee-bc55-a1e261c37bfe\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\r\n  private interface IShellItem {\r\n    void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);\r\n    void GetParent(out IShellItem parent);\r\n    void GetDisplayName(uint sigdn, out IntPtr name);\r\n    void GetAttributes(uint mask, out uint attrs);\r\n    void Compare(IShellItem other, uint hint, out int order);\r\n  }\r\n  public static string Pick(string title) {\r\n    var dialog = (IFileOpenDialog)new FileOpenDialogRCW();\r\n    uint options;\r\n    dialog.GetOptions(out options);\r\n    dialog.SetOptions(options | 0x20u | 0x40u | 0x800u);\r\n    if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);\r\n    if (dialog.Show(IntPtr.Zero) != 0) return null;\r\n    IShellItem item;\r\n    dialog.GetResult(out item);\r\n    IntPtr name;\r\n    item.GetDisplayName(0x80058000u, out name);\r\n    return Marshal.PtrToStringUni(name);\r\n  }\r\n}"
  const outLiteral = outFile.replace(/'/g, "''")
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$code = @'",
    cs,
    "'@",
    'try {',
    '  Add-Type -TypeDefinition $code -ErrorAction Stop',
    "  $picked = [DshFolderPicker]::Pick('选择包含 .uvprojx 的工程目录')",
    '} catch {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  $top = New-Object System.Windows.Forms.Form',
    '  $top.TopMost = $true',
    '  $top.ShowInTaskbar = $false',
    "  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "  $dlg.Description = '选择包含 .uvprojx 的工程目录'",
    '  if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.SelectedPath }',
    '  $top.Close()',
    '}',
    "if ($picked) { [System.IO.File]::WriteAllText('" + outLiteral + "', $picked, (New-Object System.Text.UTF8Encoding($false))) }",
  ].join('\r\n')
  const result = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 180000 })
  let picked = ''
  try { picked = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim() } catch { /* cancelled */ }
  try { unlinkSync(outFile) } catch { /* nothing to remove */ }
  if (!picked) {
    // keep the stdout hint for diagnostics, but never trust it as a path
    return { ok: false, cancelled: true, hint: result.out.trim().slice(0, 200) }
  }
  return { ok: true, folder: repairPath(picked) }
}

/** folder (or file) -> project -> chip -> transport/port, in one call. */
async function checkout(params = {}) {
  const raw = String(params.folder || params.file || '').trim()
  if (!raw) throw new Error('pass folder= or file=')
  const target = repairPath(raw)
  if (target !== raw) log('sys', 'repaired a mojibake path -> ' + target)
  let projectFile = repairPath(String(params.file || '').trim())
  let ambiguous = false
  let candidates = []
  if (!projectFile) {
    const scan = await scanProjects([target])
    candidates = scan.items
    if (candidates.length === 0) {
      const exists = existsSync(target)
      let entries = 0
      try { entries = exists ? readdirSync(target).length : 0 } catch { /* unreadable */ }
      const extra = exists
        ? '（目录存在，共 ' + entries + ' 个条目，但没有 .uvprojx；请确认选的是 MDK-ARM 这类工程目录）'
        : '（目录不存在）'
      throw new Error('no .uvprojx under ' + target + extra)
    }
    candidates.sort((a, b) => a.file.split(/[\\/]/).length - b.file.split(/[\\/]/).length || a.name.localeCompare(b.name))
    projectFile = candidates[0].file
    ambiguous = candidates.length > 1
  }
  const project = readProject(projectFile)
  settings.project = project.file
  saveSaved({ project: project.file })
  state.project = project.file
  state.chip = { device: project.device, family: project.chip.family, known: project.chip.known, note: project.chip.note }
  state.firmware = firmwareInfo(project)
  rememberProject(project.file)
  setPhase(state.phase, 'project: ' + project.name + ' / ' + project.device)
  log('sys', 'checkout ' + project.file + ' (' + project.device + ',' + project.chip.family + ')')
  return {
    ok: true,
    project: project.file,
    name: project.name,
    target: project.targetName,
    device: project.device,
    chip: state.chip,
    uart: project.chip.uart,
    transport: settings.transport,
    port: settings.portName,
    ambiguous,
    candidates: candidates.slice(0, 20),
  }
}

/**
 * Find .uvprojx files under the given roots (or the configured ones).
 *
 * The old version only looked at Desktop/Documents/D:\Program - so a project in
 * D:\实验室竞赛 was invisible and the picker never changed. Roots are configurable
 * now, the depth and the time budget are wider, and the report says what was
 * scanned instead of returning a bare list.
 */
async function scanProjects(roots, options = {}) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const configured = (settings.scanRoots || '').split(/[;\n]/).map((entry) => entry.trim()).filter(Boolean)
  const defaults = []
  const current = state.project || settings.project
  if (current) defaults.push(dirname(dirname(current)))
  for (const name of ['Desktop', '桌面', 'Documents', '文档', 'Downloads', '下载']) {
    if (home) defaults.push(join(home, name))
  }
  // Deliberately NOT the home folder itself: one scan walked 13k directories.
  const list = (Array.isArray(roots) && roots.length ? roots : configured.length ? configured : defaults)
    .map((entry) => repairPath(String(entry || '').trim()))
    .filter((entry) => entry && existsSync(entry))
  const started = Date.now()
  const depthLimit = Number(options.depth || 6)
  const limit = Number(options.limit || 200)
  const budgetMs = Number(options.budgetMs || 8000)
  const skip = new Set(['node_modules', '.git', '.tmp', 'Objects', 'Listings', 'build', 'dist', 'DebugConfig'])
  const found = []
  const seen = new Set()
  let scannedDirs = 0
  let truncated = false
  const walk = (dir, depth) => {
    if (found.length >= limit) { truncated = true; return }
    if (Date.now() - started > budgetMs) { truncated = true; return }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }); scannedDirs += 1 } catch { return }
    for (const entry of entries) {
      if (found.length >= limit) { truncated = true; return }
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && depth < depthLimit) walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.uvprojx')) {
        const key = full.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        let device = ''
        try { device = readProject(full).device } catch { /* unreadable project */ }
        found.push({ file: full, name: entry.name, device, at: statSyncSafe(full) })
      }
    }
  }
  for (const root of list) walk(root, 0)
  found.sort((a, b) => b.at - a.at)
  return { items: found, roots: list, scannedDirs, truncated, elapsedMs: Date.now() - started }
}

function statSyncSafe(path) {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

// ---------------------------------------------------------------- HTTP surface
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

async function handleAction(action, params = {}) {
  switch (action) {
    case 'build': return await guarded('build', params, () => doBuild(params.file, params))
    case 'flash': return await guarded('flash', params, () => doFlash(params.file, params))
    case 'deploy': return await guarded('deploy', params, () => doDeploy(params.file, params))
    case 'lease-renew': {
      if (!lease) return { ok: false, error: '当前没有占用' }
      lease.expiresAt = Date.now() + LEASE_TTL
      startHeartbeat(lease.token)
      return { ok: true, expiresInSeconds: leaseView().expiresInSeconds }
    }
    case 'claim': {
      const held = lease && lease.expiresAt > Date.now() ? lease : null
      const takeoverable = held && held.implicit && !held.busyKind && !params.token
      if (held && params.token !== held.token && !takeoverable) throw busy('claim')
      if (held && !takeoverable) { held.expiresAt = Date.now() + LEASE_TTL; return { ok: true, token: held.token, owner: held.owner, expiresAt: held.expiresAt } }
      lease = { token: randomToken(), owner: params.owner || 'panel', since: Date.now(), expiresAt: Date.now() + LEASE_TTL }
      state.leaseOwner = lease.owner
      log('sys', 'board claimed by ' + lease.owner)
      setPhase(state.phase, 'board claimed by ' + lease.owner)
      return { ok: true, token: lease.token, owner: lease.owner, expiresAt: lease.expiresAt }
    }
    case 'release': {
      if (lease && params.token && params.token !== lease.token && !params.force) throw busy('release')
      const owner = lease ? lease.owner : null
      lease = null
      state.leaseOwner = null
      stopHeartbeat()
      if (params.force) releaseLock()
      log('sys', 'board released' + (owner ? ' (' + owner + ')' : ''))
      setPhase(state.phase, 'board released' + (owner ? ' (' + owner + ')' : ''))
      return { ok: true, released: owner, forced: Boolean(params.force) }
    }
    case 'checkout': return await checkout(params)
    case 'pick-ioc': {
      const picked = await pickFile('STM32CubeMX 工程 (*.ioc)|*.ioc|所有文件 (*.*)|*.*', '选择 .ioc 文件')
      if (!picked || !picked.file) return { ok: false, cancelled: true }
      if (!/\.ioc$/i.test(picked.file)) throw new Error('请选择 .ioc 文件')
      const map = Object.assign({}, saved.iocByProject || {})
      map[state.project || picked.file] = picked.file
      saved.iocByProject = map
      saveSaved({ iocByProject: map })
      log('sys', '.ioc for this project: ' + picked.file)
      return { ok: true, ioc: picked.file }
    }
    case 'pick-folder': return await pickFolder(params)
    case 'monitor-start': return await startMonitor(params.port, params.baud)
    case 'monitor-stop': return await stopMonitor()
    case 'serial-write': {
      if (!monitor) throw new Error('串口监视器没打开')
      const text = String(params.text || '')
      try {
        await monitor.pipe.write(Buffer.from(text, 'utf8'))
      } catch (error) {
        /* Never claim a line was sent when it was not: the echo used to come first. */
        log('serial', '→ 发送失败：' + error.message)
        if (monitor && monitor.wireless) await stopMonitor().catch(() => undefined)
        throw error
      }
      if (settings.serialEcho !== false) log('serial', '→ ' + text.replace(/\r?\n$/, ''))
      return { ok: true }
    }
    case 'open-vscode': {
      const projectFile = state.project || settings.project || ''
      if (params.project) return await openInVscode({ folder: resolveProjectRoot(params.project) })
      if (params.folder) return await openInVscode({ folder: climbBuildDir(params.folder) })
      if (!params.file) throw new Error('open-vscode needs folder= or file=')
      const file = resolveOpenPath(params.file, projectFile)
      if (!existsSync(file)) {
        throw new Error('文件不存在：' + file + '（构建日志里的相对路径已按工程目录解析；不会为你打开一个空文件）')
      }
      return await openInVscode({ file, line: params.line })
    }
    case 'doctor': {
      const report = await doctor({ uv4: settings.uv4, cubeMx: settings.cubeMx })
      const toolchain = firmwareToolchain()
      return {
        ...report,
        espFirmware: {
          ok: toolchain.ok,
          core: toolchain.core,
          cli: toolchain.cli,
          build: BUILD_DIR,
          lastBin: state.espFirmware ? basename(state.espFirmware.bin) : '',
          ssid: settings.wifiSsid,
          hasPass: Boolean(settings.wifiPass),
        },
      }
    }
    case 'env-check': {
      setPhase(state.phase === 'idle' ? 'running' : state.phase, '正在检查环境…')
      const report = await doctor({ uv4: settings.uv4, cubeMx: settings.cubeMx })
      let espOnline = null
      if (settings.espHost) {
        try { espOnline = await espPing(settings.espHost, settings.espCtrlPort) } catch { espOnline = null }
      }
      const firmware = (() => {
        try { return firmwareToolchain(settings.arduinoCli || '') } catch { return { ok: false } }
      })()
      const items = [
        { id: 'keil', label: 'Keil uVision', ok: Boolean(report.keil.path), detail: report.keil.path || '未找到 UV4.exe', need: '在设置里填 UV4.exe 的完整路径' },
        { id: 'license', label: 'Keil 许可证', ok: report.keil.licensed !== false, detail: report.keil.licensed ? '已授权' : '未检测到 LIC', need: '用 Keil 自带的 License Management 激活' },
        { id: 'cube', label: 'STM32CubeMX', ok: Boolean(report.cubeMx.path), detail: report.cubeMx.path || '未找到', need: '在设置里填 STM32CubeMX.exe 的路径' },
        { id: 'python', label: 'Python + pyserial', ok: Boolean(report.python.pyserial), detail: report.python.pyserial ? 'pyserial ' + report.python.pyserial : '没导入 serial', need: 'pip install pyserial，或在设置里指向正确的 python.exe' },
        { id: 'ports', label: '串口设备', ok: report.ports.length > 0, detail: report.ports.length ? report.ports.map((p) => p.port).join(' ') : '没有可用串口', need: '插上 USB-TTL / NodeMCU，装 CH340 / CP210x 驱动' },
        { id: 'esp', label: 'ESP 桥接', ok: espOnline !== null, detail: espOnline !== null ? settings.espHost + ' 在线' : (settings.espHost ? settings.espHost + ' 无应答' : '未设置 ESP 主机'), need: '点「自动探测 ESP」，确认 ESP 已连上同一热点' },
        { id: 'arduino', label: 'arduino-cli + ESP8266 核心', ok: Boolean(firmware.ok), detail: firmware.ok ? '可用' : '缺少工具链', need: '安装 arduino-cli 并在设置里填路径（只有要生成 ESP 固件时才需要）' },
        { id: 'project', label: '当前工程', ok: Boolean(state.project), detail: state.project ? basename(state.project) : '还没选工程', need: '右侧「选择文件夹…」或「扫描工程」' },
      ]
      state.env = { at: now(), items, ok: items.filter((item) => item.ok).length, total: items.length }
      setPhase(state.phase, '环境检查：' + state.env.ok + '/' + state.env.total + ' 项就绪')
      log('sys', 'env-check ' + state.env.ok + '/' + state.env.total + ': ' + items.filter((i) => i.ok).map((i) => i.id).join(','))
      return state.env
    }
    case 'ports': return await listSerialPorts(settings.python || undefined)
    case 'projects': return await scanProjects(params.roots, params)
    case 'open-recent': {
      const file = String(params.file || '').trim()
      if (!file || !existsSync(file)) throw new Error('这个工程已经不存在了：' + file)
      return await handleAction('set-project', { file })
    }
    case 'set-project': {
      const project = readProject(params.file)
      settings.project = project.file
      saveSaved({ project: project.file })
      state.project = project.file
      state.chip = { device: project.device, family: project.chip.family, known: project.chip.known, note: project.chip.note }
      state.firmware = firmwareInfo(project)
      rememberProject(project.file)
      setPhase(state.phase, 'project: ' + project.name + ' / ' + project.device)
      log('sys', 'project set to ' + project.file + ' (' + project.device + ')')
      return { ok: true, project: project.file, device: project.device, chip: state.chip }
    }
    case 'set-transport': {
      const transport = params.transport === 'uart' ? 'uart' : params.transport === 'wifi' ? 'wifi' : 'swd'
    if (params.manualReset) options.manualReset = true
      settings.transport = transport
      state.transport = transport
      saveSaved({ transport })
      setPhase(state.phase, 'transport: ' + transport)
      return { ok: true, transport }
    }
    case 'set-port': {
      settings.portName = params.port || ''
      settings.baud = String(params.baud) === 'auto' ? 'auto' : (Number(params.baud) || settings.baud)
      state.port = settings.portName
      saveSaved({ portName: settings.portName, baud: settings.baud })
      setPhase(state.phase, settings.portName ? 'port: ' + settings.portName + ' @' + settings.baud : 'port cleared')
      return { ok: true, port: settings.portName, baud: settings.baud }
    }
    case 'set-serial-echo': {
      settings.serialEcho = params.on !== false
      saveSaved({ serialEcho: settings.serialEcho })
      return { ok: true, echo: settings.serialEcho }
    }
    case 'set-serial-hex': {
      settings.serialHex = Boolean(params.on)
      saveSaved({ serialHex: settings.serialHex })
      return { ok: true, hex: settings.serialHex }
    }
    case 'set-wifi-serial': {
      settings.wifiSerial = Boolean(params.on)
      saveSaved({ wifiSerial: settings.wifiSerial })
      setPhase(state.phase, settings.wifiSerial ? '串口走 Wi-Fi' : '串口走本地 COM')
      if (state.serialOpen) await stopMonitor()
      return { ok: true, wireless: settings.wifiSerial }
    }
    case 'esp-discover': {
      setPhase(state.phase, '正在扫描局域网里的 ESP…')
      const found = await discoverEsp({ port: settings.espCtrlPort })
      if (found.devices.length === 1) {
        settings.espHost = found.devices[0].host
        saveSaved({ espHost: settings.espHost })
        setPhase(state.phase, 'ESP 在 ' + settings.espHost)
      } else {
        setPhase(state.phase, found.devices.length ? '找到 ' + found.devices.length + ' 个 ESP，请手动选择' : '没找到 ESP')
      }
      return found
    }
    case 'stress': {
      /* Bytes on the ESP-STM32 wire are not retransmitted, so this measures the segment a
       * Wi-Fi flash actually depends on: send a known pattern, let the board echo it back. */
      const bytes = Math.max(64, Math.min(16384, Number(params.bytes) || 1024))
      if (monitor) await stopMonitor()
      const wireless = settings.wifiSerial || settings.transport === 'wifi'
      const pipe = wireless
        ? await WifiPipe.open(settings.espHost, { pipePort: settings.espPipePort, timeoutMs: 5000 })
        : await SerialPipe.open(settings.portName, settings.baud, settings.python)
      const link = wireless ? 'wifi://' + settings.espHost + ':' + settings.espPipePort : settings.portName
      log('serial', '压测 ' + bytes + ' 字节 ← ' + link)
      setPhase('running', '串口压测 ' + bytes + ' 字节…')
      try {
        await pipe.flush()
        await pipe.write(Buffer.from('LT ' + bytes + '\n', 'utf8'))
        let ack = ''
        const ackDeadline = Date.now() + 3000
        while (Date.now() < ackDeadline && !ack.includes('\n')) {
          try { ack += (await pipe.readExact(1, 500)).toString('latin1') } catch { break }
        }
        if (!/\+LT\s+\d+/.test(ack)) {
          /* The board may already be sitting in binary mode from an earlier attempt: feed it
           * the pattern anyway, otherwise it eats every later command as payload until reset. */
          await pipe.write(pattern).catch(() => undefined)
          throw new Error('板子没有进入自检模式（回复：' + JSON.stringify(ack.slice(0, 40)) + '）；已补发 ' + bytes + ' 字节解除二进制等待，必要时用 RUN 复位板子')
        }
        const pattern = Buffer.alloc(bytes)
        let seed = 0x9e3779b9
        for (let i = 0; i < bytes; i += 1) {
          seed ^= seed << 13; seed >>>= 0
          seed ^= seed >>> 17
          seed ^= seed << 5; seed >>>= 0
          pattern[i] = seed & 0xff
        }
        await pipe.write(pattern)
        const got = Buffer.alloc(bytes)
        let read = 0
        const deadline = Date.now() + Math.max(6000, bytes * 3)
        while (read < bytes && Date.now() < deadline) {
          try {
            const chunk = await pipe.readExact(bytes - read, Math.max(300, deadline - Date.now()))
            chunk.copy(got, read)
            read += chunk.length
          } catch { break }
        }
        let mismatches = 0
        let firstDiff = -1
        for (let i = 0; i < read; i += 1) {
          if (got[i] !== pattern[i]) { mismatches += 1; if (firstDiff < 0) firstDiff = i }
        }
        const result = {
          link,
          sent: bytes,
          received: read,
          lost: bytes - read,
          mismatches,
          firstDiff,
          errorRate: Number(((mismatches + Math.max(0, bytes - read)) / bytes).toFixed(4)),
          sample: firstDiff >= 0
            ? { at: firstDiff, sent: got.length ? pattern.subarray(firstDiff, firstDiff + 8).toString('hex') : '', got: got.subarray(firstDiff, firstDiff + 8).toString('hex') }
            : null,
        }
        const verdict = result.received === bytes && result.mismatches === 0 ? '无损' : '有错误'
        /* The board shows whatever it receives on its screen, so hand it the verdict. */
        await pipe.write(Buffer.from('R ' + (verdict === '无损' ? 'OK' : 'ERR') + ' ' + result.received + '/' + result.sent +
          ' lost=' + result.lost + ' err=' + result.mismatches + '\n', 'utf8')).catch(() => undefined)
        log('serial', '压测结果：' + verdict + ' 发送 ' + result.sent + ' 收到 ' + result.received +
          ' 丢失 ' + result.lost + ' 错字节 ' + result.mismatches +
          (result.sample ? ' 首个差异 @' + result.sample.at + ' 期望 ' + result.sample.sent + ' 实收 ' + result.sample.got : ''))
        setPhase(verdict === '无损' ? 'running' : 'error', '压测：' + verdict + '（' + result.received + '/' + result.sent + '，错 ' + result.mismatches + '）')
        state.lastStress = result
        return result
      } finally {
        await pipe.close().catch(() => undefined)
      }
    }
    case 'set-esp-baud': {
      const baud = Number(params.baud)
      if (!PIPE_BAUDS.includes(baud)) throw new Error('不支持的波特率：' + params.baud)
      settings.espBaud = baud
      saveSaved({ espBaud: baud })
      setPhase(state.phase, 'ESP 串口 ' + baud + '（重新生成并重烧固件后生效）')
      return { ok: true, baud }
    }
    case 'set-esp-board': {
      const board = params.board === 'esp01s' ? 'esp01s' : 'nodemcu'
      settings.espBoard = board
      saveSaved({ espBoard: board })
      setPhase(state.phase, 'ESP 板型：' + (board === 'nodemcu' ? 'ESP-12E / NodeMCU' : 'ESP-01S'))
      return { ok: true, board }
    }
    case 'set-wifi-fw': {
      settings.wifiSsid = String(params.ssid || '').trim()
      if (typeof params.pass === 'string') settings.wifiPass = params.pass
      saveSaved({ wifiSsid: settings.wifiSsid, wifiPass: settings.wifiPass })
      return { ok: true, ssid: settings.wifiSsid, hasPass: Boolean(settings.wifiPass) }
    }
    case 'gen-firmware': {
      const toolchain = firmwareToolchain()
      if (!toolchain.ok) throw new Error('缺少 Arduino 工具链：需要 arduino-cli 与 ESP8266 核心')
      const ssid = String(params.ssid || settings.wifiSsid || '').trim()
      const pass = typeof params.pass === 'string' ? params.pass : settings.wifiPass
      setPhase(state.phase, '正在生成 ESP 固件（首次编译约 30 s）')
      const firmware = await generateFirmware({ ssid, pass, board: settings.espBoard, baud: settings.espBaud, cli: toolchain.cli })
      if (!firmware.ok) throw new Error(firmware.error || '固件生成失败')
      settings.wifiSsid = ssid
      state.espFirmware = { bin: firmware.bin, bytes: firmware.bytes, at: Date.now(), ssid }
      saveSaved({ espFirmware: state.espFirmware, wifiSsid: settings.wifiSsid })
      setPhase(state.phase, 'ESP 固件已生成 ' + Math.round(firmware.bytes / 1024) + ' KB')
      return { ok: true, bin: firmware.bin, bytes: firmware.bytes, ssid, elapsedMs: firmware.elapsedMs }
    }
    case 'flash-esp': {
      const port = String(params.port || '').trim()
      const bin = String(params.bin || (state.espFirmware && state.espFirmware.bin) || '').trim()
      if (!bin) throw new Error('还没有生成固件：先点「生成固件」')
      if (!port) throw new Error('需要 ESP 的串口（USB-TTL），例如 COM5')
      setPhase(state.phase, '正在烧 ESP（' + port + '）')
      const result = await flashEsp({ port, bin, verify: params.verify !== false, cli: settings.uv4 && '' })
      if (!result.ok) throw new Error(result.error + (result.log ? '\n' + result.log : ''))
      setPhase(state.phase, 'ESP 固件已烧录 ' + port)
      return { ok: true, port, bytes: result.bytes, elapsedMs: result.elapsedMs }
    }
    case 'esp-detect': {
      const result = await detectEsp({ port: params.port })
      if (!result.ok) throw new Error(result.error || '读不到模块')
      setPhase(state.phase, 'ESP: ' + (result.flashSize || '?') + ' flash, ' + (result.chip || '未知芯片'))
      return result
    }
    case 'set-wifi': {
      settings.espHost = params.host || ''
      settings.espPort = Number(params.port || 23)
      saveSaved({ espHost: settings.espHost, espPort: settings.espPort })
      setPhase(state.phase, settings.espHost ? 'wifi bridge: ' + settings.espHost + ':' + settings.espPort : 'wifi bridge cleared')
      return { ok: true, host: settings.espHost, port: settings.espPort }
    }
    case 'set-tools': {
      if (typeof params.uv4Path === 'string') settings.uv4 = params.uv4Path
      if (typeof params.cubeMxPath === 'string') settings.cubeMx = params.cubeMxPath
      if (typeof params.pythonPath === 'string') settings.python = params.pythonPath
      if (typeof params.project === 'string' && params.project.trim()) settings.project = params.project.trim()
      saveSaved({ uv4Path: settings.uv4, cubeMxPath: settings.cubeMx, pythonPath: settings.python })
      setPhase(state.phase, '工具链路径已更新')
      return { ok: true, uv4: findUV4(settings.uv4) || settings.uv4, cubeMx: settings.cubeMx, python: settings.python }
    }
    case 'set-retry': {
      settings.retry = Math.max(1, Math.min(10, Number(params.retry || 3)))
      saveSaved({ retry: settings.retry })
      return { ok: true, retry: settings.retry }
    }
    case 'set-binding': {
      const sessionId = String(params.sessionId || '').trim()
      if (!sessionId) throw new Error('set-binding needs sessionId')
      state.binding = { sessionId, label: String(params.label || '').slice(0, 60), at: Date.now() }
      saveSaved({ binding: state.binding })
      setPhase(state.phase, '已绑定会话 ' + sessionId.slice(0, 8))
      return { ok: true, binding: state.binding }
    }
    case 'clear-binding': {
      state.binding = null
      saveSaved({ binding: null })
      setPhase(state.phase, '已解绑会话')
      return { ok: true, binding: null }
    }
    case 'clear-logs': {
      const channel = params.channel ? String(params.channel) : ''
      if (channel) {
        for (let index = logs.length - 1; index >= 0; index -= 1) {
          if (logs[index].channel === channel) logs.splice(index, 1)
        }
        if (channel === 'serial') state.serialLines = 0
        return { ok: true, cleared: channel, remaining: logs.length }
      }
      logs.length = 0
      state.serialLines = 0
      return { ok: true, cleared: 'all', remaining: 0 }
    }
    case 'open-ioc': {
      const ioc = params.ioc || projectIoc()
      if (!ioc) throw new Error('当前工程没有 .ioc 文件')
      const exe = findCubeMx(settings.cubeMx || undefined)
      if (!exe) throw new Error('没找到 STM32CubeMX.exe：请在设置里填路径')
      const info = spawn(exe, [ioc], { detached: true, stdio: 'ignore' })
      info.unref()
      log('sys', 'opened ' + ioc + ' in CubeMX')
      return { ok: true, ioc }
    }
    case 'open-keil': {
      /* The real IDE on the current project, next to the headless build/flash. */
      const project = projectOf(params.file)
      const exe = findUV4(settings.uv4)
      if (!exe) throw new Error('没找到 UV4.exe：请在设置里填 Keil 路径')
      const info = spawn(exe, [project.file], { detached: true, stdio: 'ignore' })
      info.unref()
      log('sys', 'opened ' + project.name + ' in Keil uVision')
      return { ok: true, project: project.file, uv4: exe }
    }
    case 'open-cube': {
      /* Just the IDE: opening a project is the separate 打开 .ioc action. */
      const exe = findCubeMx(settings.cubeMx || undefined)
      if (!exe) throw new Error('没找到 STM32CubeMX.exe：请在设置里填路径')
      const info = spawn(exe, [], { detached: true, stdio: 'ignore' })
      info.unref()
      log('sys', 'opened STM32CubeMX (no project)')
      return { ok: true, exe }
    }
    case 'cube-gen': {
      const ioc = params.ioc || projectIoc()
      if (!ioc) throw new Error('当前工程没有 .ioc 文件')
      setPhase(state.phase, 'CubeMX 正在生成代码…')
      log('sys', 'cube: generate from ' + ioc)
      const started = Date.now()
      try {
        const result = await queue('cube', () => cubeGenerate(ioc, { cubeMx: settings.cubeMx }))
        const elapsedMs = Date.now() - started
        const seconds = (elapsedMs / 1000).toFixed(1)
        log('sys', 'cube: ' + (result.ok ? 'done in ' + seconds + 's' : 'FAILED after ' + seconds + 's'))
        if (!result.ok) log('sys', 'cube: ' + String(result.log || '').trim().split('\n').slice(-4).join(' | '))
        setPhase(state.phase, result.ok ? 'CubeMX 代码已生成（' + seconds + 's）' : 'CubeMX 生成失败')
        return { ok: result.ok, elapsedMs, code: result.code, ioc }
      } catch (error) {
        log('sys', 'cube: FAILED ' + error.message)
        setPhase(state.phase, 'CubeMX 生成失败')
        throw error
      }
    }
    default: throw new Error('unknown action: ' + action)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, name: 'dsh-stm32-toolchain', version: VERSION, phase: state.phase })
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    return json(res, 200, snapshot())
  }
  if (req.method === 'GET' && url.pathname === '/logs') {
    const since = Number(url.searchParams.get('since') || 0)
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), MAX_LOGS)
    return json(res, 200, { logs: logs.filter((entry) => entry.seq > since).slice(-limit), seq })
  }
  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    res.write('event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n')
    const since = Number(url.searchParams.get('since') || 0)
    for (const entry of logs.filter((e) => e.seq > since)) {
      res.write('event: log\ndata: ' + JSON.stringify(entry) + '\n\n')
    }
    const push = (payload) => {
      if (payload.state) res.write('event: state\ndata: ' + JSON.stringify(payload.state) + '\n\n')
      else res.write('event: log\ndata: ' + JSON.stringify(payload) + '\n\n')
    }
    subscribers.add(push)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => { clearInterval(keepAlive); subscribers.delete(push) })
    return
  }
  if (req.method === 'POST' && url.pathname === '/action') {
    const body = await readBody(req)
    try {
      const result = await handleAction(body.action, body.params || {})
      return json(res, 200, { ok: true, result })
    } catch (error) {
      if (error.code !== 'BOARD_BUSY') setPhase('error', error.message)
      return json(res, 200, { ok: false, code: error.code || 'ERROR', error: error.message })
    }
  }
  json(res, 404, { ok: false, error: 'not found' })
})

server.on('error', (error) => {
  process.stderr.write('[sys] http listen failed: ' + error.message + '\n')
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  log('sys', 'bridge ' + INSTANCE + ' listening on 127.0.0.1:' + PORT)
})

// ---------------------------------------------------------------- MCP over stdio
const TOOLS = [
  { name: 'stm32_esp_firmware', description: 'Build an ESP-01S bridge firmware with the given Wi-Fi baked in (action: build), or flash a generated .bin to the ESP over USB-TTL (action: flash).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['build', 'flash', 'status', 'detect', 'discover'] }, ssid: { type: 'string' }, pass: { type: 'string' }, port: { type: 'string', description: 'ESP USB-TTL port for action=flash' } }, required: ['action'] } },
  { name: 'stm32_doctor', description: 'Report the STM32 toolchain environment: Keil path/version/license, CubeMX, pyserial, COM ports, chip table, available transports.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stm32_status', description: 'Current board state: phase, chip, transport, open port, firmware size, last build/flash result.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stm32_project', description: 'Read one .uvprojx: device, resolved chip family, bootloader UART pins, output paths, whether ST-Link is configured.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the .uvprojx; defaults to the project selected in the panel' } } } },
  { name: 'stm32_build', description: 'Build one uVision target headlessly (UV4 -b) and return structured diagnostics.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, rebuild: { type: 'boolean' } } } },
  { name: 'stm32_flash', description: 'Flash the built firmware: swd uses the project ST-Link (UV4 -f), uart drives AN3155 over a serial port, wifi drives AN3155 through an ESP-01S bridge. manualReset=BOOT0 only, you press the board reset button.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, transport: { type: 'string', enum: ['swd', 'uart', 'wifi'] }, port: { type: 'string', description: 'serial port (uart) - wifi uses the ESP host setting' }, baud: { type: 'number' }, manualReset: { type: 'boolean', description: 'wifi only: assert BOOT0 and wait for a manual reset press' } } } },
  { name: 'stm32_deploy', description: 'Build then flash in one call; watch=<ms> keeps the serial port open afterwards and returns the startup log. This is the one-sentence path.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, transport: { type: 'string', enum: ['swd', 'uart', 'wifi'] }, manualReset: { type: 'boolean', description: 'wifi only: assert BOOT0 and wait for a manual reset press' }, port: { type: 'string' }, watch: { type: 'number', description: 'ms to capture serial output after flashing (max 30000)' }, token: { type: 'string' }, owner: { type: 'string' } } } },
  { name: 'stm32_checkout', description: 'Point the toolchain at a project in one call: pass a folder, it finds the .uvprojx, reads the Device, resolves the chip family and reports transport/port. Use it first when the user names a folder rather than a project file.', inputSchema: { type: 'object', properties: { folder: { type: 'string' }, file: { type: 'string' } } } },
  { name: 'stm32_claim', description: 'Exclusive lease on the board. Mutating tools auto-claim when single-session, but two sessions flashing the same board otherwise collide: claim first (owner=<label>), pass the returned token to build/flash/deploy/set-*, release when done.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, token: { type: 'string' }, release: { type: 'boolean' }, force: { type: 'boolean' } } } },
  { name: 'stm32_serial_stress', description: 'Measure byte loss on the serial link itself: the board is asked to echo a pseudo-random pattern back (LT <n> self-test), and the tool reports how many bytes went missing or arrived corrupted. Use it before blaming a flashing failure on the protocol.', inputSchema: { type: 'object', properties: { bytes: { type: 'number', description: 'pattern size, 64..16384 (default 1024)' } } } },
  { name: 'stm32_serial', description: 'Serial monitor control: action=open|close|write|tail. open starts a background reader that streams into the panel and the log ring.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'close', 'write', 'tail'] }, port: { type: 'string' }, baud: { type: 'number' }, text: { type: 'string' }, lines: { type: 'number' } }, required: ['action'] } },
  { name: 'stm32_logs', description: 'Read the bridge log ring (build/flash/serial/sys channels), filtered by sequence, channel or regex.', inputSchema: { type: 'object', properties: { since: { type: 'number' }, channel: { type: 'string' }, pattern: { type: 'string' }, lines: { type: 'number' } } } },
  { name: 'stm32_chips', description: 'Query the chip table: family bootloader pins/baud/erase mode, or resolve one device string.', inputSchema: { type: 'object', properties: { device: { type: 'string' } } } },
  { name: 'stm32_ports', description: 'List serial ports with descriptions (CH340, ST-Link VCP, ...).', inputSchema: { type: 'object', properties: {} } },
  { name: 'stm32_open_vscode', description: 'Open something in VS Code: project=<.uvprojx> opens its source root (climbing out of MDK-ARM/Objects), folder=<dir> does the same for a directory, file+line jumps to a build diagnostic.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, folder: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' } } } },
  { name: 'stm32_cube_gen', description: 'Regenerate code from an .ioc with STM32CubeMX in headless mode (-q script).', inputSchema: { type: 'object', properties: { ioc: { type: 'string' } }, required: ['ioc'] } },
]

/** Tool calls name their owner "AI" so the panel does not blame the user. */
function asAgent(args) {
  return args.owner ? args : { ...args, owner: 'AI' }
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

async function callTool(name, args) {
  switch (name) {
    case 'stm32_esp_firmware': {
      const action = String(args.action || 'status')
      if (action === 'status') {
        const toolchain = firmwareToolchain()
        return text(JSON.stringify({
          toolchain: { ok: toolchain.ok, core: toolchain.core, cli: toolchain.cli },
          ssid: settings.wifiSsid,
          hasPass: Boolean(settings.wifiPass),
          firmware: state.espFirmware ? { bin: state.espFirmware.bin, bytes: state.espFirmware.bytes } : null,
        }))
      }
      if (action === 'discover') return text(JSON.stringify(await handleAction('esp-discover', {})))
      if (action === 'detect') return text(JSON.stringify(await handleAction('esp-detect', { port: args.port })))
      return text(JSON.stringify(await handleAction(action === 'build' ? 'gen-firmware' : 'flash-esp', {
        ssid: args.ssid, pass: args.pass, port: args.port,
      })))
    }
    case 'stm32_doctor': {
      const report = await doctor({ uv4: settings.uv4, cubeMx: settings.cubeMx })
      const toolchain = firmwareToolchain()
      return text({ ...report, espFirmware: { ok: toolchain.ok, core: toolchain.core, cli: toolchain.cli } })
    }
    case 'stm32_status': return text(snapshot())
    case 'stm32_project': {
      const project = projectOf(args.file)
      return text({
        file: project.file, name: project.name, target: project.targetName, device: project.device,
        chip: project.chip, outputs: { axf: project.axf, hex: project.hex, bin: project.bin }, createHex: project.createHex,
        usesStlink: project.usesStlink, firmware: firmwareInfo(project),
      })
    }
    case 'stm32_build': return text(await guarded('build', asAgent(args), () => doBuild(args.file, args)))
    case 'stm32_flash': return text(await guarded('flash', asAgent(args), () => doFlash(args.file, args)))
    case 'stm32_deploy': return text(await guarded('deploy', asAgent(args), () => doDeploy(args.file, args)))
    case 'stm32_checkout': return text(await checkout(args))
    case 'stm32_claim': {
      if (args.release) return text(await handleAction('release', { token: args.token, force: args.force }))
      return text(await handleAction('claim', { owner: args.owner || 'agent', token: args.token }))
    }
    case 'stm32_serial_stress': {
      return text(JSON.stringify(await handleAction('stress', { bytes: args.bytes })))
    }
    case 'stm32_serial': {
      if (args.action === 'open') return text(await startMonitor(args.port, args.baud))
      if (args.action === 'close') return text(await stopMonitor())
      if (args.action === 'write') {
        if (!monitor) throw new Error('serial monitor is not open')
        await monitor.pipe.write(Buffer.from(args.text || '', 'utf8'))
        return text({ ok: true })
      }
      const wanted = args.lines || 40
      const recent = logs.filter((entry) => entry.channel === 'serial').slice(-wanted)
      return text(recent.length ? recent.map((entry) => entry.text).join('\n') : 'no serial data yet')
    }
    case 'stm32_logs': {
      const wanted = args.lines || 80
      let selected = logs.filter((entry) => entry.seq > (args.since || 0))
      if (args.channel) selected = selected.filter((entry) => entry.channel === args.channel)
      if (args.pattern) {
        const re = new RegExp(args.pattern, 'i')
        selected = selected.filter((entry) => re.test(entry.text))
      }
      return text(selected.slice(-wanted))
    }
    case 'stm32_chips': return text(args.device ? resolveChip(args.device) : loadChips())
    case 'stm32_ports': return text(await listSerialPorts(settings.python || undefined))
    case 'stm32_open_vscode': return text(await handleAction('open-vscode', args))
    case 'stm32_cube_gen': return text(await queue('cube', () => cubeGenerate(args.ioc, { cubeMx: settings.cubeMx })))
    default: throw new Error('unknown tool: ' + name)
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, method, params } = request
  const isNotification = id === undefined
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-stm32-toolchain', version: VERSION },
        instructions: 'STM32 toolchain: build via uVision UV4 -b, flash via ST-Link (swd) or the system bootloader (uart). Always prefer these tools over opening Keil by hand.',
      } })
      return
    }
    if (method === 'notifications/initialized' || isNotification) return
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return }
    if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments || {})
        send({ jsonrpc: '2.0', id, result })
      } catch (error) {
        if (error.code !== 'BOARD_BUSY') setPhase('error', error.message)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR ' + error.message }], isError: true } })
      }
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
  } catch (error) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } })
  }
})

process.on('uncaughtException', (error) => log('sys', 'uncaught: ' + error.message))
process.on('unhandledRejection', (error) => log('sys', 'unhandled: ' + (error && error.message)))

// Bootstrap the panel with something useful.
if (settings.project) {
  try {
    const project = readProject(settings.project)
    state.chip = { device: project.device, family: project.chip.family, known: project.chip.known, note: project.chip.note }
    state.firmware = firmwareInfo(project)
    state.message = 'ready: ' + project.name + ' / ' + project.device
  } catch (error) {
    log('sys', 'project load failed: ' + error.message)
  }
}
log('sys', 'dsh-stm32 bridge ' + VERSION + ' up (transport ' + settings.transport + ')')
