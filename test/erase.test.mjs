import { Stm32UartBootloader } from '../lib/bootloader.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/** Records what we write and answers every read with ACK (0x79). */
class FakePipe {
  constructor() { this.writes = [] }
  async write(bytes) { this.writes.push(Buffer.from(bytes).toString('hex')) }
  async readByte() { return 0x79 }
  async readExact(count) { return Buffer.alloc(count, 0x00) }
  async flush() {}
}

for (const [extended, expect, label] of [
  [true, ['44bb', 'ffff00'], 'extended erase sends FF FF 00'],
  [false, ['44bb', 'ff00'], 'standard erase sends FF 00'],
]) {
  const pipe = new FakePipe()
  const boot = new Stm32UartBootloader(pipe)
  await boot.massErase({ extended })
  const sent = pipe.writes.slice(-1)[0]
  check('AN3155 mass erase: ' + label, sent === expect[1], pipe.writes.join(' '))
}
