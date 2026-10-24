import { flashImage } from '../lib/bootloader.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/** Never answers: every handshake attempt is lost, which is what the hook has to recover from. */
class DeadPipe {
  constructor() { this.writes = [] }
  async flush() { this.writes = [] }
  async write(bytes) { this.writes.push(Buffer.from(bytes)) }
  async close() {}
  async readByte() { throw new Error('等待 ESP 数据超时（600ms）') }
  async readExact() { throw new Error('等待 ESP 数据超时') }
}

const image = Buffer.alloc(64, 0xff)
const log = []
const resets = []

let error = null
try {
  await flashImage(new DeadPipe(), image, {
    log: (line) => log.push(line),
    cmdTimeoutMs: 20,
    onHandshakeRetry: async (attempt) => { resets.push(attempt) },
  })
} catch (caught) {
  error = caught
}

check('the flash still fails when nothing answers', Boolean(error), error && error.message)
check('the reset hook runs between attempts', JSON.stringify(resets) === '[1,2,3]', 'attempts=' + JSON.stringify(resets))
check('each lost handshake is logged', log.filter((line) => line.includes('handshake attempt')).length === 3,
  log.filter((line) => line.includes('handshake attempt')).join(' | '))

/* A throwing hook must not abort the retry loop: the flash keeps trying with its own re-sync. */
const throwing = []
try {
  await flashImage(new DeadPipe(), image, {
    log: () => {},
    cmdTimeoutMs: 20,
    onHandshakeRetry: async (attempt) => { throwing.push(attempt); throw new Error('ESP 控制端口连接超时') },
  })
} catch { /* expected */ }
check('a failing hook does not stop the retries', JSON.stringify(throwing) === '[1,2,3]', JSON.stringify(throwing))

/* Without a hook the loop behaves exactly as before. */
let bareFailed = false
try {
  await flashImage(new DeadPipe(), image, { log: () => {}, cmdTimeoutMs: 20 })
} catch {
  bareFailed = true
}
check('no hook is required', bareFailed)
