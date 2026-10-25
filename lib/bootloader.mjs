/**
 * AN3155 (STM32 system bootloader over UART) on top of a byte pipe.
 *
 * The pipe only has to provide write(bytes), readExact(n, ms), flush(). A
 * SerialPipe satisfies it today; an ESP-01S TCP wrapper will satisfy it later
 * without touching this file.
 */
const ACK = 0x79
const NAK = 0x1f
const COMMANDS = {
  get: 0x00, getVersion: 0x01, getID: 0x02, readMemory: 0x11, go: 0x21,
  writeMemory: 0x31, erase: 0x43, extendedErase: 0x44, writeProtect: 0x63,
}

/** STM32F4 sector layout (the first 8 sectors are identical on 512 KB and 1 MB parts). */
const F4_SECTORS = [
  { index: 0, size: 0x4000 }, { index: 1, size: 0x4000 }, { index: 2, size: 0x4000 }, { index: 3, size: 0x4000 },
  { index: 4, size: 0x10000 },
  { index: 5, size: 0x20000 }, { index: 6, size: 0x20000 }, { index: 7, size: 0x20000 },
  { index: 8, size: 0x20000 }, { index: 9, size: 0x20000 }, { index: 10, size: 0x20000 }, { index: 11, size: 0x20000 },
]

/** Sectors an image at baseAddress/length occupies - the set a normal flasher erases. */
export function sectorsForImage(baseAddress, length) {
  const offset = baseAddress - 0x08000000
  const sectors = []
  let start = 0
  for (const sector of F4_SECTORS) {
    const end = start + sector.size
    if (end > offset && start < offset + length) sectors.push(sector.index)
    start = end
  }
  return sectors
}

/** Measured: this board's bootloader also needs a gap inside long data frames. */
export const dataGapMs = (() => {
  const raw = Number(process.env.DSH_STM32_DATA_GAP_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 0
})()

/** Split a long frame into pieces of this size; 0 keeps it as one write. */
export const dataChunkBytes = (() => {
  const raw = Number(process.env.DSH_STM32_DATA_CHUNK)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
})()

async function writeFrame(pipe, frame) {
  if (!dataChunkBytes || frame.length <= dataChunkBytes) {
    if (dataGapMs > 0) await writeSlow(pipe, frame)
    else await pipe.write(frame)
    return
  }
  for (let offset = 0; offset < frame.length; offset += dataChunkBytes) {
    await pipe.write(frame.subarray(offset, offset + dataChunkBytes))
    if (dataGapMs > 0) await new Promise((resolve) => setTimeout(resolve, dataGapMs))
  }
}

export const pairGapMs = (() => {
  const raw = Number(process.env.DSH_STM32_PAIR_GAP_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 10   /* measured: 0 ms NAKs, 10 ms is solid */
})()

/** AN3155 wants "<cmd> <cmd^0xFF>" back to back, but this board's bootloader mangles the
 *  second byte unless there is a short gap - measured 3/3 at 10 ms, 0/3 at 0 ms. */
async function writePair(pipe, op) {
  await pipe.write([op])
  if (pairGapMs > 0) await new Promise((resolve) => setTimeout(resolve, pairGapMs))
  await pipe.write([op ^ 0xff])
}

/** Short frames (address, erase payload) get the same treatment; bulk data stays batched. */
async function writeSlow(pipe, bytes) {
  for (const byte of bytes) {
    await pipe.write([byte])
    if (pairGapMs > 0) await new Promise((resolve) => setTimeout(resolve, pairGapMs))
  }
}

export class Stm32UartBootloader {
  constructor(pipe, log = () => {}, options = {}) {
    this.pipe = pipe
    this.log = log
    this.ackCount = 0
    /* Wi-Fi adds a Wi-Fi hop and an ESP that is also serving TCP: 1 s is too tight. */
    this.cmdTimeout = Number(options.cmdTimeoutMs || 3000)
  }

  async #waitAck(timeoutMs = 1000) {
    const value = await this.pipe.readByte(timeoutMs)
    if (value === ACK) { this.ackCount += 1; return true }
    if (value === NAK) throw new Error('bootloader NAK (0x1F)')
    if (value === 0x7f) return 'sync'
    throw new Error('bootloader unexpected byte 0x' + value.toString(16))
  }

  /**
   * AN3155: after a NAK (or a command the part does not know) the bootloader falls back to
   * "waiting for 0x7F". Any command sent before re-syncing is swallowed, which is what made
   * the erase frame disappear. ACK and NAK both mean "synced now".
   */
  async resync(attempts = 6) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.pipe.flush()
      await this.pipe.write([0x7f])
      try {
        const first = await this.pipe.readByte(600)
        if (first === ACK) { this.log('re-synced'); return true }
        if (first === NAK) { this.log('re-synced (NAK to 0x7F)'); return true }
        if (first === 0x7f) {
          const second = await this.pipe.readByte(600)
          if (second === ACK) { this.log('re-synced (two-sync part)'); return true }
        }
      } catch { /* try again */ }
    }
    throw new Error('could not re-sync with the bootloader')
  }

  async #sendCommand(op) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await writePair(this.pipe, op)
        await this.#waitAck(this.cmdTimeout)
        return
      } catch (error) {
        if (attempt >= 2) throw error
        this.log('command 0x' + op.toString(16) + ' failed (' + error.message + '), re-syncing and retrying')
        await this.resync()
      }
    }
  }

  /** Enter the bootloader: 0x7F, answered by ACK or by 0x7F+ACK on some parts. */
  async connect({ attempts = 4, waitMs = 0, intervalMs = 250 } = {}) {
    const deadline = waitMs > 0 ? Date.now() + waitMs : 0
    for (let attempt = 1; attempt <= attempts || (deadline > 0 && Date.now() < deadline); attempt += 1) {
      if (deadline > 0 && Date.now() > deadline) break
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
      await this.pipe.flush()
      await this.pipe.write([0x7f])
      try {
        const first = await this.pipe.readByte(600)
        if (first === ACK) { this.log('bootloader synced'); return true }
        if (first === 0x7f) {
          const second = await this.pipe.readByte(600)
          if (second === ACK) { this.log('bootloader synced (two-sync part)'); return true }
        }
        /* Some F4 bootloaders NAK a repeated 0x7F: they are already synced, so treat it as success. */
        if (first === NAK) { this.log('bootloader answered NAK to 0x7F, treating it as synced'); return true }
      } catch (error) {
        this.log('sync attempt ' + attempt + ' failed: ' + error.message)
      }
    }
    throw new Error('no bootloader answer: check BOOT0=1, reset, TX/RX, and that the chip is in system memory')
  }

  async get() {
    await this.#sendCommand(COMMANDS.get)
    const n = (await this.pipe.readByte(this.cmdTimeout)) + 1
    const payload = await this.pipe.readExact(n, this.cmdTimeout)
    await this.#waitAck(this.cmdTimeout)
    const version = payload[0]
    const commands = [...payload.subarray(1)]
    return { version, commands, supportsExtendedErase: commands.includes(COMMANDS.extendedErase) }
  }

  async getId() {
    await this.#sendCommand(COMMANDS.getID)
    const n = (await this.pipe.readByte(this.cmdTimeout)) + 1
    const payload = await this.pipe.readExact(n, this.cmdTimeout)
    await this.#waitAck(this.cmdTimeout)
    return { pid: payload.readUInt16BE(0), raw: payload.toString('hex') }
  }

  /**
   * Sector erase, the way CubeProgrammer/Keil do it: N and the sector list, then the XOR
   * checksum. Extended form uses two byte sector numbers, the legacy form one byte.
   */
  async eraseSectors(sectors, { extended }, retry = true) {
    if (sectors.length === 0) return true
    const command = extended ? COMMANDS.extendedErase : COMMANDS.erase
    try {
      await writePair(this.pipe, command)
      await this.#waitAck(this.cmdTimeout)
    } catch (error) {
      if (!retry) throw error
      this.log('erase command refused (' + error.message + '), re-syncing and retrying')
      await this.resync()
      return await this.eraseSectors(sectors, { extended }, false)
    }

    /* AN3155: N is the number of sectors MINUS ONE (0xFFFF / 0xFF means "mass erase"),
     * which is what stm32loader and CubeProgrammer send. Sending the plain count makes
     * the bootloader wait for one more sector code - a silent 30 s timeout. */
    const count = sectors.length - 1
    const payload = []
    if (extended) {
      payload.push((count >> 8) & 0xff, count & 0xff)
      for (const sector of sectors) payload.push((sector >> 8) & 0xff, sector & 0xff)
    } else {
      payload.push(count & 0xff)
      for (const sector of sectors) payload.push(sector & 0xff)
    }
    payload.push(payload.reduce((acc, byte) => acc ^ byte, 0) & 0xff)
    try {
      await writeSlow(this.pipe, payload)
      await this.#waitAck(30000)
      return true
    } catch (error) {
      if (!retry) throw error
      this.log('erase payload refused (' + error.message + '), re-syncing and retrying')
      await this.resync()
      return await this.eraseSectors(sectors, { extended }, false)
    }
  }

  async massErase({ extended }) {
    await writePair(this.pipe, COMMANDS.extendedErase)
    await this.#waitAck(30000)
    /* N follows the command, big endian, plus its checksum:
     *   0x43 (standard) -> N = 0xFF        -> "mass erase"
     *   0x44 (extended) -> N = 0xFFFF      -> "global mass erase"
     * Sending the two byte form to a 0x44 bootloader makes it wait for 254 more
     * sector codes, which is a silent 60 s timeout. */
    if (extended) {
      await this.pipe.write([0xff, 0xff, 0x00])
    } else {
      await this.pipe.write([0xff, 0x00])
    }
    // Global mass erase takes ~20-30 s on a 1 MB part; the ACK only comes when it is done.
    await this.#waitAck(90000)
    return true
  }

  /**
   * AN3155 write memory is three exchanges with an ACK after each:
   *   0x31 + complement -> ACK -> address(4) + checksum -> ACK -> (N-1) + data + checksum -> ACK
   * Sending it as one blob is NAKed, and the F4 bootloader writes 32-bit words, so the
   * payload is padded with 0xFF to a multiple of four bytes (as stm32loader does).
   */
  async writeMemory(address, data) {
    const chunk = Math.min(data.length, 256)
    const payload = Buffer.from(data.subarray(0, chunk))
    const padded = payload.length % 4 === 0
      ? payload
      : Buffer.concat([payload, Buffer.alloc(4 - (payload.length % 4), 0xff)])

    await this.#sendCommand(COMMANDS.writeMemory)

    const addressFrame = Buffer.alloc(5)
    addressFrame.writeUInt32BE(address, 0)
    addressFrame[4] = checksum(addressFrame.subarray(0, 4))
    await writeSlow(this.pipe, addressFrame)
    await this.#waitAck(this.cmdTimeout)

    const lengthByte = padded.length - 1
    const dataFrame = Buffer.alloc(1 + padded.length + 1)
    dataFrame[0] = lengthByte
    padded.copy(dataFrame, 1)
    dataFrame[1 + padded.length] = checksum(Buffer.concat([Buffer.from([lengthByte]), padded]))
    await writeFrame(this.pipe, dataFrame)
    await this.#waitAck(this.cmdTimeout * 2)
    return chunk
  }

  async go(address) {
    const buffer = Buffer.alloc(7)
    buffer[0] = COMMANDS.go
    buffer[1] = COMMANDS.go ^ 0xff
    buffer.writeUInt32BE(address, 2)
    buffer[6] = checksum(buffer.subarray(2, 6))
    await this.pipe.write(buffer)
    await this.#waitAck(5000)
    return true
  }

  async readMemory(address, length) {
    const buffer = Buffer.alloc(7)
    buffer[0] = COMMANDS.readMemory
    buffer[1] = COMMANDS.readMemory ^ 0xff
    buffer.writeUInt32BE(address, 2)
    buffer[6] = checksum(buffer.subarray(2, 6))
    await this.pipe.write(buffer)
    await this.#waitAck(this.cmdTimeout)
    const n = (await this.pipe.readByte(this.cmdTimeout)) + 1
    const data = await this.pipe.readExact(n, 3000)
    return Buffer.from(data)
  }
}

export function checksum(bytes) {
  let sum = 0
  for (const byte of bytes) sum ^= byte
  return sum & 0xff
}

const readSpoolLine = async (pipe, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    try {
      const byte = await pipe.readByte(Math.max(150, deadline - Date.now()))
      if (byte === 0x0a) {
        const line = text.trim()
        text = ''
        /* 目标板的打印会经管道透传上来，只有 '+' 开头的才是桥的回执 */
        if (line.startsWith('+')) return line
        continue
      }
      text += String.fromCharCode(byte)
    } catch {
      break
    }
  }
  return ''
}

/**
 * Upload the image into the ESP file system, then let the ESP flash it by itself.
 * Wi-Fi stays out of the AN3155 timing loop, so an interruption leaves the target untouched.
 */
export async function flashSpool(pipe, image, options = {}) {
  const log = options.log || (() => {})
  const base = options.baseAddress ?? 0x08000000
  const sectors = options.sectors || []
  const eraseCmd = options.eraseCmd || 0x44
  const chunk = Math.max(64, Math.min(256, options.chunk || 256))

  await pipe.write(Buffer.from('#I ' + image.length + '\n', 'utf8'))
  const begin = await readSpoolLine(pipe, 4000)
  if (!/^\+I ok/.test(begin)) throw new Error('ESP 拒绝接收镜像：' + (begin || 'no reply'))

  for (let offset = 0; offset < image.length; offset += chunk) {
    const slice = image.subarray(offset, offset + chunk)
    await pipe.write(Buffer.concat([Buffer.from('#S ' + offset + ' ' + slice.length + '\n', 'utf8'), slice]))
    const reply = await readSpoolLine(pipe, 5000)
    if (!/^\+S ok/.test(reply)) throw new Error('镜像第 ' + offset + ' 字节被拒：' + (reply || 'no reply'))
  }
  log('spool: ' + image.length + ' bytes stored in the bridge (' + sectors.length + ' sector(s) to erase)')

  const frame = '#F ' + base.toString(16) + ' ' + eraseCmd.toString(16) + ' ' + sectors.length + ' ' + sectors.join(',') + '\n'
  await pipe.write(Buffer.from(frame, 'utf8'))

  const started = Date.now()
  for (;;) {
    const line = await readSpoolLine(pipe, 180000)
    if (!line) throw new Error('ESP 自烧录没有回报（超时）')
    const progress = /^\+F write (\d+) (\d+)/.exec(line)
    if (progress) {
      log('wrote ' + progress[1] + '/' + progress[2] + ' bytes (esp)')
      continue
    }
    if (/^\+F (sync|erase|reset)/.test(line)) { log('esp: ' + line.replace('+F ', '')); continue }
    if (/^\+F ok/.test(line)) return { ok: true, elapsedMs: Date.now() - started }
    if (/^\+F err/.test(line)) throw new Error('ESP 自烧录失败：' + line.replace('+F err ', ''))
  }
}


/** Flash one binary image through the system bootloader. */
export async function flashImage(pipe, image, options = {}) {
  const log = options.log || (() => {})
  const boot = new Stm32UartBootloader(pipe, log, { cmdTimeoutMs: options.cmdTimeoutMs })
  const base = options.baseAddress ?? 0x08000000
  /* BOOT0 stays high for the whole session, so a stray extra reset press only costs us
   * the current handshake: re-sync instead of failing the whole flash. */
  let info
  let id
  for (let attempt = 1; ; attempt += 1) {
    try {
      await boot.connect(attempt === 1
        ? { waitMs: options.syncWaitMs || 0 }
        : { attempts: 10 })
      try {
        info = await boot.get()
      } catch (error) {
        log('Get (0x00) refused (' + error.message + '), re-syncing')
        await boot.resync()
        log('identifying by GetID only')
        info = { version: 0, commands: [], supportsExtendedErase: true }
      }
      id = await boot.getId()
      break
    } catch (error) {
      if (attempt >= 4) throw error
      log('handshake attempt ' + attempt + ' lost (' + error.message + '), re-syncing')
      /* Re-syncing alone cannot help once the chip runs the application: the caller may
       * re-assert BOOT0 and pulse reset here (the Wi-Fi bridge does exactly that). */
      if (typeof options.onHandshakeRetry === 'function') {
        try {
          await options.onHandshakeRetry(attempt)
        } catch (retryError) {
          log('handshake retry ' + attempt + ' failed: ' + retryError.message)
        }
      }
    }
  }
  log('bootloader ' + (info.version ? 'v' + info.version : 'version unknown') + ', PID 0x' + id.pid.toString(16).padStart(4, '0'))
  /* ---- block-level ACK: the ESP owns the three exchanges and retries locally ---- */
  const readReplyLine = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let text = ''
    while (Date.now() < deadline) {
      try {
        const byte = await pipe.readByte(Math.max(200, deadline - Date.now()))
        text += String.fromCharCode(byte)
        if (byte === 0x0a) break
      } catch { break }
    }
    return text.trim()
  }
  const writeBlockAck = async (address, data) => {
    const header = Buffer.from('#B ' + address.toString(16) + ' ' + data.length + '\n', 'utf8')
    await pipe.write(Buffer.concat([header, data]))
    const reply = await readReplyLine(5000)
    if (!/^\+B ok/.test(reply)) throw new Error('block @0x' + address.toString(16) + ' rejected: ' + (reply || 'no reply'))
  }

  const sectors = sectorsForImage(base, image.length)
  log('erase sectors ' + sectors.join(',') + ' (image ' + image.length + ' bytes)')
  let erased = false
  for (const extended of [true, false]) {
    try {
      await boot.eraseSectors(sectors, { extended })
      erased = true
      break
    } catch (error) {
      log('sector erase (' + (extended ? 'extended 0x44' : 'standard 0x43') + ') refused: ' + error.message)
    }
  }
  if (!erased) {
    log('falling back to a full mass erase')
    for (const extended of [true, false]) {
      try {
        await boot.massErase({ extended })
        erased = true
        break
      } catch (error) {
        log('mass erase (' + (extended ? 'extended' : 'standard') + ') refused: ' + error.message)
      }
    }
  }
  if (!erased) throw new Error('the bootloader refused every erase framing')
  /* Shorter frames survive a loose wire far better than 256 byte bursts. */
  const chunkSize = Math.max(16, Math.min(256, Number(options.chunkSize || 128)))
  const chunkRetries = Math.max(1, Number(options.chunkRetries || 4))
  let written = 0
  while (written < image.length) {
    const slice = image.subarray(written, written + chunkSize)
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        if (options.linkMode === 'block') await writeBlockAck(base + written, slice)
        else await boot.writeMemory(base + written, slice)
        break
      } catch (error) {
        if (attempt >= chunkRetries) throw error
        log('write block at 0x' + (base + written).toString(16) + ' failed (' + error.message + '), re-syncing and retrying ' + attempt + '/' + (chunkRetries - 1))
        await boot.resync()
      }
    }
    written += slice.length
    if (written % 8192 === 0 || written === image.length) log('wrote ' + written + '/' + image.length + ' bytes')
  }
  if (options.go !== false) {
    log('starting application at 0x' + base.toString(16))
    await boot.go(base)
  }
  return { bytes: written, pid: id.pid, version: info.version }
}
