import { Stm32UartBootloader, checksum } from '../lib/bootloader.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/** Records writes and answers ACK to every read. */
class FakePipe {
  constructor() { this.writes = [] }
  async write(bytes) { this.writes.push(Buffer.from(bytes)) }
  async readByte() { return 0x79 }
  async readExact(n) { return Buffer.alloc(n) }
  async flush() {}
}

const pipe = new FakePipe()
const boot = new Stm32UartBootloader(pipe)
await boot.writeMemory(0x08000000, Buffer.from([1, 2, 3, 4, 5]))

const all = Buffer.concat(pipe.writes)
check('write memory is three exchanges (pair, address, data)', all.length === 2 + 5 + 10,
  pipe.writes.map((b) => b.toString('hex')).join(' | '))
check('the frame starts with 0x31 and its complement', all.subarray(0, 2).equals(Buffer.from([0x31, 0xce])),
  all.subarray(0, 2).toString('hex'))

const address = all.subarray(2, 7)
check('address is 4 bytes big endian plus an XOR checksum',
  address.length === 5 && address.readUInt32BE(0) === 0x08000000 && address[4] === checksum(address.subarray(0, 4)),
  address.toString('hex'))

const data = all.subarray(7)
const paddedLength = 8 /* 5 bytes padded to 8 with 0xFF */
check('the payload is padded to a multiple of four bytes',
  data.length === 1 + paddedLength + 1 && data[0] === paddedLength - 1 &&
  data.subarray(1, 6).equals(Buffer.from([1, 2, 3, 4, 5])) &&
  data[6] === 0xff && data[7] === 0xff,
  data.toString('hex'))
check('the data checksum covers the length byte and the payload',
  data[data.length - 1] === checksum(data.subarray(0, data.length - 1)), data.toString('hex'))
