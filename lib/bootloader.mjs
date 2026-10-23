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
        await this.pipe.write([op, op ^ 0xff])
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
      await this.pipe.write([command, command ^ 0xff])
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
      await this.pipe.write(payload)
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
    await this.pipe.write([COMMANDS.extendedErase, COMMANDS.extendedErase ^ 0xff])
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

  async writeMemory(address, data) {
    const chunk = Math.min(data.length, 256)
    const payload = data.subarray(0, chunk)
    const buffer = Buffer.alloc(1 + 4 + 1 + 1 + payload.length + 1)
    buffer[0] = COMMANDS.writeMemory
    buffer[1] = COMMANDS.writeMemory ^ 0xff
    buffer.writeUInt32BE(address, 2)
    buffer[6] = checksum(buffer.subarray(2, 6))
    buffer[7] = payload.length - 1
    payload.copy(buffer, 8)
    buffer[8 + payload.length] = checksum(Buffer.concat([Buffer.from([payload.length - 1]), payload]))
    await this.pipe.write(buffer)
    await this.#waitAck(5000)
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
    }
  }
  log('bootloader ' + (info.version ? 'v' + info.version : 'version unknown') + ', PID 0x' + id.pid.toString(16).padStart(4, '0'))
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
  let written = 0
  while (written < image.length) {
    const slice = image.subarray(written, written + 256)
    await boot.writeMemory(base + written, slice)
    written += slice.length
    if (written % 8192 === 0 || written === image.length) log('wrote ' + written + '/' + image.length + ' bytes')
  }
  if (options.go !== false) {
    log('starting application at 0x' + base.toString(16))
    await boot.go(base)
  }
  return { bytes: written, pid: id.pid, version: info.version }
}
