/**
 * ESP-01S Wi-Fi pipe.
 *
 * The firmware exposes two TCP servers (see firmware/esp01s):
 *   3333 - line oriented control (BOOT0 / NRST / BOOTLOADER / RUN / PING / STATUS)
 *   3334 - raw bytes straight to UART0, i.e. the STM32 USART
 *
 * WifiPipe satisfies the same contract as SerialPipe (write / readByte / readExact /
 * flush / close), so bootloader.mjs drives the AN3155 protocol over Wi-Fi unchanged.
 */
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

const CTRL_PORT = 3333
const PIPE_PORT = 3334

function parseLines(buffer) {
  const text = buffer.toString('latin1')
  const parts = text.split('\r\n')
  return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] }
}

export class WifiPipe {
  constructor(host) {
    this.host = host
    this.ctrl = null
    this.data = null
    this.buffer = Buffer.alloc(0)
    this.ctrlBuffer = ''
    this.closed = false
    this.rxBytes = 0
    this.onData = null
    this.onClose = null
    this.log = () => {}
  }

  /** Connect the data socket; call enterBootloader() first to put the STM32 in AN3155 mode. */
  static async open(host, options = {}) {
    if (!host) throw new Error('需要 ESP 的 IP（设置里填「ESP 主机」）')
    const pipe = new WifiPipe(host)
    pipe.log = options.log || (() => {})
    pipe.pipePort = Number(options.pipePort || PIPE_PORT)
    pipe.ctrlPort = Number(options.ctrlPort || CTRL_PORT)
    pipe.timeoutMs = Number(options.timeoutMs || 8000)
    await pipe.#openData()
    return pipe
  }

  #openData() {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.pipePort })
      socket.setNoDelay(true)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接 ' + this.host + ':' + this.pipePort + ' 超时')) }, this.timeoutMs)
      socket.once('connect', () => { clearTimeout(timer); this.data = socket; resolve() })
      socket.once('error', (error) => { clearTimeout(timer); reject(new Error('数据端口: ' + error.message)) })
      socket.on('data', (chunk) => {
        this.rxBytes += chunk.length
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (this.onData) this.onData(chunk)
      })
      socket.on('close', () => {
        this.closed = true
        if (this.onClose) this.onClose()
      })
      socket.on('error', () => {
        this.closed = true
        if (this.onClose) this.onClose()
      })
    })
  }

  /** One control round-trip: connect, wait for the banner, send a line, wait for its answer. */
  async #command(line, expectPrefix) {
    const socket = await new Promise((resolve, reject) => {
      const s = connect({ host: this.host, port: this.ctrlPort })
      const timer = setTimeout(() => { s.destroy(); reject(new Error('控制端口连接超时')) }, this.timeoutMs)
      s.once('connect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', (error) => { clearTimeout(timer); reject(new Error('控制端口: ' + error.message)) })
    })
    try {
      let text = ''
      const readUntil = (prefix, timeoutMs) => new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        const onData = (chunk) => {
          text += chunk.toString('latin1')
          let index
          while ((index = text.indexOf('\r\n')) >= 0) {
            const line = text.slice(0, index).trim()
            text = text.slice(index + 2)
            if (line.startsWith(prefix)) { cleanup(); resolve(line) }
          }
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error('等 ' + prefix + ' 超时（收到: ' + JSON.stringify(text.slice(0, 80)) + '）')) }, Math.max(300, deadline - Date.now()))
        const cleanup = () => { clearTimeout(timer); socket.off('data', onData) }
        socket.on('data', onData)
      })
      await readUntil('+READY', this.timeoutMs).catch(() => undefined)   /* banner is optional */
      socket.write(line + '\r\n')
      return await readUntil(expectPrefix, this.timeoutMs)
    } finally {
      socket.end()
    }
  }

  /** Round-trip check used by doctor/status. */
  async ping() {
    return await this.#command('PING', '+PONG')
  }

  async status() {
    return await this.#command('STATUS', '+STATUS')
  }

  /** BOOTLOADER = BOOT0 HIGH + reset pulse; afterwards the STM32 listens on AN3155. */
  async enterBootloader(options = {}) {
    const pulse = options.pulse !== false
    const pulseMs = options.pulseMs || 120
    const waitMs = options.waitMs || 0
    this.log(pulse ? 'wifi: BOOTLOADER (BOOT0 high + reset)' : 'wifi: BOOT0 high, waiting for a manual reset')
    await this.#command('BOOT 1', '+BOOT')
    if (pulse) await this.#command('PULSE ' + pulseMs, '+PULSE')
    else if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  /** RUN = BOOT0 LOW + reset pulse, i.e. start the flashed application. */
  async run(pulseMs = 120) {
    this.log('wifi: RUN (BOOT0 low + reset)')
    await this.#command('BOOT 0', '+BOOT')
    await this.#command('PULSE ' + pulseMs, '+PULSE')
  }

  /* ---------------- pipe contract used by AN3155 ---------------- */
  async write(bytes) {
    if (!this.data) throw new Error('数据端口未连接')
    if (this.closed || this.data.destroyed) throw new Error('ESP 管道已断开（ESP 重启或网络中断），重新点一次「打开串口」')
    await new Promise((resolve, reject) => {
      this.data.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve()))
    })
  }

  async readByte(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length === 0) {
      if (this.closed) throw new Error('ESP 连接已断开')
      if (Date.now() > deadline) throw new Error('等待 ESP 数据超时（' + timeoutMs + 'ms）')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const value = this.buffer[0]
    this.buffer = this.buffer.subarray(1)
    return value
  }

  async readExact(count, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < count) {
      if (this.closed) throw new Error('ESP 连接已断开')
      if (Date.now() > deadline) throw new Error('等待 ' + count + ' 字节超时（收到 ' + this.buffer.length + '）')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const chunk = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return chunk
  }

  async flush() {
    this.buffer = Buffer.alloc(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    this.buffer = Buffer.alloc(0)
  }

  async close() {
    this.closed = true
    try { if (this.data) this.data.destroy() } catch { /* already gone */ }
    try { if (this.ctrl) this.ctrl.destroy() } catch { /* already gone */ }
  }
}


/* ---------------------------- discovery ---------------------------- */

function privateSubnets() {
  const nets = networkInterfaces()
  const bases = []
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const parts = net.address.split('.')
      if (parts.length !== 4) continue
      bases.push(parts.slice(0, 3).join('.') + '.')
    }
  }
  return [...new Set(bases)]
}

function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (value) => { try { socket.destroy() } catch { /* gone */ } ; resolve(value) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
  })
}

function controlStatus(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let text = ''
    const done = (value) => { try { socket.destroy() } catch { /* gone */ } ; resolve(value) }
    const timer = setTimeout(() => done(''), timeoutMs)
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      const line = text.split('\r\n').find((entry) => entry.startsWith('+STATUS'))
      if (line) { clearTimeout(timer); done(line) }
    })
    socket.once('connect', () => socket.write('STATUS\r\n'))
    socket.once('error', () => { clearTimeout(timer); done('') })
  })
}

/**
 * Find ESP bridges on the local networks: a host answers when TCP 3333 is open AND the
 * control port returns +STATUS, so unrelated web servers are ignored.
 */
export async function discoverEsp(options = {}) {
  const port = Number(options.port || CTRL_PORT)
  const bases = options.subnets && options.subnets.length ? options.subnets : privateSubnets()
  const timeoutMs = Number(options.timeoutMs || 150)
  const concurrency = Number(options.concurrency || 128)
  const hosts = []
  for (const base of bases) for (let last = 1; last <= 254; last += 1) hosts.push(base + last)

  const found = []
  let index = 0
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const host = hosts[index]
      index += 1
      if (!host) return
      if (!(await portOpen(host, port, timeoutMs))) continue
      const status = await controlStatus(host, port, 1500)
      if (status) found.push({ host, port, status })
    }
  })
  await Promise.all(workers)
  return { subnets: bases, scanned: hosts.length, devices: found }
}
