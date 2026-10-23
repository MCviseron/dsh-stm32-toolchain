import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'serial-worker.py')
const PYTHON = process.env.DSH_STM32_PYTHON || 'D:\\Python\\Python312\\python.exe'

/** Byte pipe over a serial port, driven by the bundled pyserial worker. */
export class SerialPipe {
  constructor() {
    this.child = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.onLine = null
    this.port = null
    this.closed = true
  }

  static async open(port, baud = 115200, pythonPath = '') {
    const pipe = new SerialPipe()
    await pipe.#spawn(pythonPath)
    await pipe.#request({ op: 'open', port, baud }, 'open', 8000)
    pipe.port = port
    pipe.closed = false
    return pipe
  }

  #spawn(pythonPath = '') {
    return new Promise((resolve, reject) => {
      const child = spawn(pythonPath || PYTHON, ['-u', WORKER], { windowsHide: true })
      this.child = child
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => this.#handleLine(line))
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        error ? reject(error) : resolve()
      }
      child.once('error', done)
      child.once('spawn', () => done())
      child.on('close', () => {
        this.closed = true
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('serial worker exited')) }
        this.pending.clear()
      })
    })
  }

  #handleLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.t === 'data') {
      const chunk = Buffer.from(msg.b64, 'base64')
      this.buffer = Buffer.concat([this.buffer, chunk])
      if (this.onLine) this.onLine(msg)
      return
    }
    if (msg.t === 'ok') {
      const entry = this.pending.get(msg.op)
      if (entry) { clearTimeout(entry.timer); this.pending.delete(msg.op); entry.resolve(msg) }
      return
    }
    if (msg.t === 'err' || msg.t === 'fatal') {
      const error = new Error(msg.msg || 'serial error')
      if (msg.op && this.pending.has(msg.op)) {
        const entry = this.pending.get(msg.op)
        clearTimeout(entry.timer)
        this.pending.delete(msg.op)
        entry.reject(error)
      } else {
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
        this.pending.clear()
      }
    }
  }

  #request(obj, expectOp, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('serial worker not started'))
      const key = expectOp || obj.op
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error('serial ' + key + ' timeout after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify(obj) + '\n')
    })
  }

  write(bytes) {
    const b64 = Buffer.from(bytes).toString('base64')
    return this.#request({ op: 'write', b64 }, 'write', 5000)
  }

  setBaud(baud) {
    return this.#request({ op: 'baud', baud }, 'baud', 3000)
  }

  flush() {
    this.buffer = Buffer.alloc(0)
    return this.#request({ op: 'flush' }, 'flush', 3000).catch(() => undefined)
  }

  /** Resolve as soon as the buffer holds at least n bytes; then consume them. */
  async readExact(n, timeoutMs = 1000) {
    const started = Date.now()
    while (this.buffer.length < n) {
      if (Date.now() - started > timeoutMs) throw new Error('serial read timeout (' + this.buffer.length + '/' + n + ' bytes)')
      await new Promise((r) => setTimeout(r, 4))
    }
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }

  async readByte(timeoutMs = 1000) {
    return (await this.readExact(1, timeoutMs))[0]
  }

  takeLine() {
    const index = this.buffer.indexOf(0x0a)
    if (index < 0) return null
    const line = this.buffer.subarray(0, index + 1).toString('utf8')
    this.buffer = this.buffer.subarray(index + 1)
    return line
  }

  async close() {
    if (!this.child) return
    try { this.child.stdin.write(JSON.stringify({ op: 'close' }) + '\n') } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 80))
    try { this.child.kill() } catch { /* ignore */ }
    this.child = null
    this.closed = true
  }
}
