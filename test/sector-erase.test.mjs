import { Stm32UartBootloader, sectorsForImage } from '../lib/bootloader.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

check('a 14 KB image fits in sector 0',
  sectorsForImage(0x08000000, 14404).join(',') === '0', sectorsForImage(0x08000000, 14404).join(','))
check('a 40 KB image needs sectors 0,1,2',
  sectorsForImage(0x08000000, 40 * 1024).join(',') === '0,1,2', sectorsForImage(0x08000000, 40 * 1024).join(','))
check('an image starting in sector 4 skips the small ones',
  sectorsForImage(0x08000000 + 0x10000, 100).join(',') === '4', sectorsForImage(0x08000000 + 0x10000, 100).join(','))

class FakePipe {
  constructor() { this.writes = [] }
  async write(bytes) { this.writes.push(Buffer.from(bytes).toString('hex')) }
  async readByte() { return 0x79 }
  async readExact(n) { return Buffer.alloc(n) }
  async flush() {}
}

const extendedPipe = new FakePipe()
await new Stm32UartBootloader(extendedPipe).eraseSectors([0, 1], { extended: true })
/* 44 BB | N=0001 (count-1) | sectors 0000 0001 | checksum 00^01^00^00^00^01 = 00 */
check('extended sector erase frame', extendedPipe.writes.join('').endsWith('00010000000100'), extendedPipe.writes.join(' '))

const legacyPipe = new FakePipe()
await new Stm32UartBootloader(legacyPipe).eraseSectors([0, 1], { extended: false })
/* 43 BC | N=01 (count-1) | sectors 00 01 | checksum 01^00^01 = 00 */
check('legacy sector erase frame', legacyPipe.writes.join('').endsWith('01000100'), legacyPipe.writes.join(' '))
