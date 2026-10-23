import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CHIPS_PATH = join(HERE, 'chips.json')

const UV4_CANDIDATES = ['D:\\Keli_v5\\UV4\\UV4.exe', 'C:\\Keil_v5\\UV4\\UV4.exe', 'C:\\Keil\\UV4\\UV4.exe']
const CUBEMX_CANDIDATES = ['D:\\CubeMX\\STM32CubeMX.exe', 'C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX\\STM32CubeMX.exe']

export function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}

export function findUV4(explicit) {
  return firstExisting([explicit, process.env.UV4, ...UV4_CANDIDATES])
}

export function findCubeMx(explicit) {
  return firstExisting([explicit, process.env.STM32CUBEMX, ...CUBEMX_CANDIDATES])
}

/** Run a process, capture output, never throw on a non-zero exit. */
export function run(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true })
    let out = ''
    const timer = options.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, options.timeoutMs) : null
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (error) => { if (timer) clearTimeout(timer); done({ code: -1, out: out + String(error.message) }) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); done({ code, out }) })
  })
}

export function loadChips() {
  return JSON.parse(readFileSync(CHIPS_PATH, 'utf8'))
}

/** Map a uVision Device string (STM32F407VETx) onto the family table. */
export function resolveChip(device) {
  const chips = loadChips()
  const raw = (device || '').trim()
  if (!raw) return { device: raw, family: null, known: false, uart: [], note: 'no <Device> in the project file' }
  const upper = raw.toUpperCase()
  let best = null
  for (const key of Object.keys(chips.devices)) {
    if (upper.startsWith(key.toUpperCase())) {
      if (!best || key.length > best.length) best = key
    }
  }
  const familyKey = (best ? chips.devices[best].family : null) || (upper.match(/^STM32([A-Z]\d)/) ? 'STM32' + upper.slice(5, 7) : null)
  const family = familyKey && chips.families[familyKey] ? { key: familyKey, ...chips.families[familyKey] } : null
  return {
    device: raw,
    matched: best,
    family: family ? family.key : null,
    known: Boolean(best && family),
    uart: (best && chips.devices[best].uart) || (family ? family.uart : []),
    maxBaud: family ? family.maxBaud : 115200,
    erase: family ? family.erase : 'extended',
    flashPage: family ? family.flashPage : null,
    identity: best ? chips.devices[best] : null,
    note: best && chips.devices[best].note ? chips.devices[best].note : (family ? '' : 'unknown chip: defaulting to USART1/115200, add it to chips.json'),
  }
}

const tag = (xml, name) => {
  const match = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'))
  return match ? match[1].trim() : ''
}

/** Parse the handful of uVision fields the toolchain needs. */
export function readProject(file) {
  const path = resolve(file)
  const xml = readFileSync(path, 'utf8')
  const targetName = tag(xml, 'TargetName')
  const device = tag(xml, 'Device')
  const outputDirRaw = tag(xml, 'OutputDirectory') || '.\\Objects\\'
  const outputName = tag(xml, 'OutputName') || targetName
  const createHex = tag(xml, 'CreateHexFile') === '1'
  const outputDir = resolve(dirname(path), outputDirRaw.replace(/^[.\\/]+/, ''))
  return {
    file: path,
    dir: dirname(path),
    name: basename(path),
    targetName,
    device,
    outputName,
    createHex,
    outputDir,
    axf: join(outputDir, outputName + '.axf'),
    hex: join(outputDir, outputName + '.hex'),
    bin: join(outputDir, outputName + '.bin'),
    chip: resolveChip(device),
    usesStlink: /ST-?Link/i.test(xml),
  }
}

const UV4_CODE_MEANING = {
  0: 'no errors or warnings',
  1: 'warnings only',
  2: 'errors',
  3: 'fatal errors',
  11: 'cannot open the project file',
  12: 'device error / bad target',
  13: 'error writing the project output',
  15: 'error reading the project file',
  20: 'license error',
}

/**
 * uVision is single-instance: running it while the GUI (or another build) holds the
 * licence/device gives a bare non-zero exit with an empty log - which looks exactly
 * like a compile failure. Retry once after a short pause and label the retry.
 */
const UV4_LOCK_HINT = /already running|Cannot open|device is locked|access is denied|被占用|正在运行/i
async function runUV4(uv4, args, options) {
  const first = await run(uv4, args, options)
  if (first.code === 0 || first.code === 1) return first
  const text = String((first.out || '') + (first.err || ''))
  if (!UV4_LOCK_HINT.test(text)) return first
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const second = await run(uv4, args, options)
  second.contended = true
  return second
}

/** Build one target headlessly with uVision. */
export async function buildProject(projectFile, options = {}) {
  const uv4 = findUV4(options.uv4)
  if (!uv4) throw new Error('UV4.exe not found: set the Keil path in the plugin settings')
  const project = options.project || readProject(projectFile)
  const logPath = join(process.env.TEMP || '.', 'dsh-stm32-build-' + Date.now() + '.log')
  const started = Date.now()
  const args = [options.rebuild ? '-r' : '-b', project.file, '-j0', '-o', logPath]
  const result = await runUV4(uv4, args, { cwd: project.dir, timeoutMs: options.timeoutMs || 600000 })
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : result.out
  const diagnostics = parseDiagnostics(log)
  const busy = result.contended && result.code !== 0 && log.trim() === ''
  return {
    ok: result.code === 0 || result.code === 1,
    code: result.code,
    reason: busy
      ? 'uVision 被另一个实例占用（关掉 Keil 界面或等上一次编译结束再试）'
      : UV4_CODE_MEANING[result.code] || 'exit code ' + result.code,
    contended: Boolean(result.contended),
    elapsedMs: Date.now() - started,
    logPath,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity !== 'warning').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    output: project.axf,
    log,
  }
}

/** Download the built image through the debugger configured in the project (ST-Link). */
export async function flashSwd(projectFile, options = {}) {
  const uv4 = findUV4(options.uv4)
  if (!uv4) throw new Error('UV4.exe not found: set the Keil path in the plugin settings')
  const project = options.project || readProject(projectFile)
  const logPath = join(process.env.TEMP || '.', 'dsh-stm32-flash-' + Date.now() + '.log')
  const started = Date.now()
  const result = await runUV4(uv4, ['-f', project.file, '-j0', '-o', logPath], { cwd: project.dir, timeoutMs: options.timeoutMs || 180000 })
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : result.out
  const busy = result.contended && result.code !== 0 && log.trim() === ''
  return {
    ok: result.code === 0,
    code: result.code,
    elapsedMs: Date.now() - started,
    logPath,
    log,
    reason: busy ? 'uVision 被另一个实例占用（关掉 Keil 界面或等上一次编译结束再试）' : undefined,
  }
}

const DIAGNOSTIC_RE = /^(.+?)\((\d+)\):\s*(warning|error|fatal error)\s*:\s*(.*?)(?:\s*:\s*(.*))?$/i

/** Turn a uVision log into structured diagnostics the panel and the agent both read. */
export function parseDiagnostics(logText) {
  const out = []
  for (const line of String(logText).split(/\r?\n/)) {
    const match = line.match(DIAGNOSTIC_RE)
    if (!match) continue
    out.push({
      file: match[1].trim(),
      line: Number(match[2]),
      severity: match[3].toLowerCase().replace('fatal error', 'error'),
      message: (match[4] || '').trim(),
      detail: (match[5] || '').trim(),
    })
  }
  return out
}

/** Minimal Intel HEX reader: the UART path needs a raw image, Keil often only emits .hex. */
export function parseIntelHex(text) {
  const chunks = []
  let upper = 0
  let minAddress = Infinity
  let maxAddress = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(':')) continue
    const bytes = Buffer.from(line.slice(1), 'hex')
    if (bytes.length < 5) continue
    const count = bytes[0]
    const address = bytes.readUInt16BE(1)
    const type = bytes[3]
    const data = bytes.subarray(4, 4 + count)
    if (type === 0x00) {
      const absolute = upper + address
      chunks.push({ address: absolute, data })
      minAddress = Math.min(minAddress, absolute)
      maxAddress = Math.max(maxAddress, absolute + count)
    } else if (type === 0x04) {
      upper = data.readUInt16BE(0) << 16
    } else if (type === 0x02) {
      upper = data.readUInt16BE(0) << 4
    }
  }
  if (!chunks.length) throw new Error('no data records in the hex file')
  const image = Buffer.alloc(maxAddress - minAddress, 0xff)
  for (const chunk of chunks) chunk.data.copy(image, chunk.address - minAddress)
  return { image, baseAddress: minAddress }
}

/** Firmware bytes for the UART path: prefer the hex (absolute addresses), fall back to a raw bin. */
export async function loadImage(project) {
  if (project.createHex && existsSync(project.hex)) {
    return parseIntelHex(await readFile(project.hex, 'utf8'))
  }
  if (existsSync(project.bin)) return { image: await readFile(project.bin), baseAddress: 0x08000000 }
  if (existsSync(project.axf)) {
    const elf = await readFile(project.axf)
    throw new Error('only .axf available: enable "Create HEX File" in uVision Options for Target -> Output, or set the output name so a .hex/.bin exists')
  }
  throw new Error('no firmware output found for ' + project.name + ' (build it first)')
}

/** Environment + toolchain report used by both the CLI and the panel. */
export async function doctor(options = {}) {
  const chips = loadChips()
  const uv4 = findUV4(options.uv4)
  const cubeMx = findCubeMx(options.cubeMx)
  const toolsIni = uv4 ? join(dirname(dirname(uv4)), 'TOOLS.INI') : null
  let keilVersion = null
  let licensed = null
  if (toolsIni && existsSync(toolsIni)) {
    const ini = readFileSync(toolsIni, 'utf8')
    const versionMatch = ini.match(/PATH="[^"]*ARM\\"[^>]*?VERSION=([\d.a-z]+)/) || ini.match(/VERSION=([\d.a-z]+)/)
    keilVersion = versionMatch ? versionMatch[1] : null
    licensed = /LIC0=[0-9A-Z-]{20,}/.test(ini)
  }
  const python = process.env.DSH_STM32_PYTHON || 'D:\\Python\\Python312\\python.exe'
  const pythonCheck = await run(python, ['-c', 'import serial;print(serial.__version__)'], { timeoutMs: 15000 })
  const ports = await listSerialPorts(python)
  return {
    keil: { path: uv4, version: keilVersion, licensed },
    cubeMx: { path: cubeMx },
    python: { path: python, pyserial: pythonCheck.code === 0 ? pythonCheck.out.trim() : null },
    ports,
    chips: { families: Object.keys(chips.families), devices: Object.keys(chips.devices) },
    transports: { swd: Boolean(uv4), uart: Boolean(pythonCheck.code === 0) },
  }
}

export async function listSerialPorts(python) {
  const script = 'import serial.tools.list_ports as l,json;print(json.dumps([{"port":p.device,"desc":p.description} for p in l.comports()]))'
  const result = await run(python || (process.env.DSH_STM32_PYTHON || 'D:\\Python\\Python312\\python.exe'), ['-c', script], { timeoutMs: 15000 })
  if (result.code !== 0) return []
  try { return JSON.parse(result.out.trim()) } catch { return [] }
}

/** Directories that hold a build, not sources: opening them in VS Code is useless. */
const BUILD_DIRECTORIES = new Set(['mdk-arm', 'mdk', 'keil', 'objects', 'debug', 'build', 'listings', 'project', 'projects', 'ewarm', 'iar'])

/** Climb out of build directories (MDK-ARM, Objects, ...) to the real project root. */
export function climbBuildDir(start) {
  let dir = resolve(String(start || ''))
  for (let step = 0; step < 3; step += 1) {
    if (!BUILD_DIRECTORIES.has(basename(dir).toLowerCase())) break
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
  return dir
}

/** The folder a user means by "the project": the .uvprojx's directory, minus build dirs. */
export function resolveProjectRoot(projectFile) {
  if (!projectFile) return ''
  return climbBuildDir(dirname(projectFile))
}

/** Absolute paths pass through; build-log paths are relative to the project dir. */
export function resolveOpenPath(file, projectFile) {
  const value = String(file || '').trim()
  if (!value) return ''
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value
  const base = projectFile ? dirname(projectFile) : ''
  if (!base) return value
  try { return resolve(base, value) } catch { return value }
}

/**
 * Build the argv that opens a folder (no -g) or a file at a line in VS Code.
 *
 * spawn() hands the vector to cmd.exe, which re-parses it: a path with spaces
 * must arrive pre-quoted in ONE /c argument, otherwise VS Code receives
 * "…\2026-Logistics" and "- Back\…" as separate files and shows an empty buffer.
 */
export function buildOpenCommand(target = {}) {
  const folder = typeof target.folder === 'string' ? target.folder.trim() : ''
  const file = typeof target.file === 'string' ? target.file.trim() : ''
  const line = Number(target.line) > 0 ? Number(target.line) : 0
  // No manual quoting: spawn() quotes each element for cmd, which unquotes it
  // again. Hand-written quotes used to split "… - Back\…" into two files.
  if (folder) return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'code', folder] }
  if (file && line) return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'code', '-g', file + ':' + line] }
  if (file) return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'code', file] }
  throw new Error('open-vscode needs a folder or a file')
}

export async function openInVscode(target) {
  const spec = typeof target === 'string' ? { file: target } : (target || {})
  const built = buildOpenCommand(spec)
  const result = await run(built.command, built.args, { timeoutMs: 20000 })
  return { ok: result.code === 0, target: spec.folder || (spec.line ? spec.file + ':' + spec.line : spec.file), output: result.out.slice(0, 400) }
}

export async function cubeGenerate(iocPath, options = {}) {
  const exe = findCubeMx(options.cubeMx)
  if (!exe) throw new Error('STM32CubeMX.exe not found: set its path in the plugin settings')
  const scriptPath = join(process.env.TEMP || '.', 'dsh-stm32-cube-' + Date.now() + '.txt')
  const script = ['config load ' + iocPath, 'project generate', 'exit'].join('\n') + '\n'
  const { writeFile } = await import('node:fs/promises')
  await writeFile(scriptPath, script, 'utf8')
  const result = await run(exe, ['-q', scriptPath], { timeoutMs: options.timeoutMs || 600000 })
  return { ok: result.code === 0, code: result.code, log: result.out, scriptPath }
}
