import { doctor, readProject, resolveChip } from '../lib/core.mjs'

const report = await doctor()
console.log(JSON.stringify(report, null, 2))

for (const device of ['STM32F103C8Tx', 'STM32F407VETx', 'STM32G431CBTx', 'AI8051U-8Bit Series']) {
  const chip = resolveChip(device)
  console.log(device.padEnd(22), '->', (chip.family || 'unknown').padEnd(10), chip.uart.map((u) => u.p + ' ' + u.tx + '/' + u.rx).join(', '))
}
