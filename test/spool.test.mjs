import { flashSpool } from '../lib/bootloader.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/** Scripted pipe: records writes, answers each '#…' frame with a canned line. */
class ScriptedPipe {
  constructor(replies) {
    this.replies = replies.slice()
    this.pending = Buffer.alloc(0)
    this.frames = []
  }
  async write(bytes) {
    this.frames.push(Buffer.from(bytes))
    const text = Buffer.from(bytes).toString('latin1')
    const nl = text.indexOf('\n')
    if (nl < 0) return
    const line = text.slice(0, nl)
    /* '#F' streams several lines for one write; a '#S' header is answered twice
     * (begin, then ok after the payload), so queue both. */
    const take = line.startsWith('#F') ? this.replies.splice(0)
      : line.startsWith('#S') ? this.replies.splice(0, 2)
      : [this.replies.shift()]
    const text2 = take.filter((entry) => entry !== undefined).join('\r\n')
    this.pending = Buffer.from(text2 ? text2 + '\r\n' : '', 'latin1')
  }
  async readByte() {
    if (!this.pending.length) throw new Error('no data')
    const b = this.pending[0]
    this.pending = this.pending.subarray(1)
    return b
  }
}

const image = Buffer.alloc(600, 0xAB)
const good = new ScriptedPipe([
  '+I ok 600',
  '+S begin 0', '+S ok 256', '+S begin 256', '+S ok 512', '+S begin 512', '+S ok 600',
  '+Z ok 1234 600',
  '+F reset', '+F sync ok', '+F erase ok', '+F write 600 600', '+F ok 1234',
])
const result = await flashSpool(good, image, { baseAddress: 0x08000000, sectors: [0, 1], eraseCmd: 0x44, log: () => {} })
check('spool uploads, then lets the bridge flash', result.ok === true, JSON.stringify(result))
const frames = good.frames.map((b) => Buffer.from(b).toString('latin1'))
check('the upload declares the size once', frames[0].startsWith('#I 600'), frames[0].trim())
check('each chunk header carries offset, length and CRC',
  /^#S 0 256 [0-9a-f]{4}/.test(frames[1]) && /^#S 256 256 [0-9a-f]{4}/.test(frames[3]) && /^#S 512 88 [0-9a-f]{4}/.test(frames[5]),
  frames.slice(1, 6).map((f) => f.split('\n')[0]).join(' | '))
check('the payload is written after the begin ack', good.frames[2].length === 256, String(good.frames[2].length))
check('a whole-image CRC is checked before flashing', frames.some((f) => /^#Z [0-9a-f]{4}/.test(f)), frames.filter((f) => f.startsWith('#Z')).join(''))
check('the flash frame names base, erase command and sectors',
  frames[frames.length - 1].startsWith('#F 8000000 44 2 0,1'), frames[frames.length - 1].trim())

const refused = new ScriptedPipe(['+I err'])
let refusedError = null
try { await flashSpool(refused, image, { log: () => {} }) } catch (error) { refusedError = error }
check('a refused upload reports the bridge answer', Boolean(refusedError) && /拒绝接收镜像/.test(refusedError.message), refusedError && refusedError.message)

const failed = new ScriptedPipe(['+I ok 600', '+S begin 0', '+S ok 256', '+S begin 256', '+S ok 512', '+S begin 512', '+S ok 600', '+Z ok 1234 600', '+F reset', '+F err erase'])
let failedError = null
try { await flashSpool(failed, image, { sectors: [0], log: () => {} }) } catch (error) { failedError = error }
check('a failed self-flash surfaces the stage', Boolean(failedError) && /ESP 自烧录失败/.test(failedError.message), failedError && failedError.message)
