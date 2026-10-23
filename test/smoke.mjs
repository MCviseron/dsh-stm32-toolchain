import { doctor, readProject, buildProject } from '../lib/core.mjs'
import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const projects = [
  'D:\\Program\\5.机器人红外循迹传感器循迹\\Project.uvprojx',
  'D:\\桌面\\作业\\二班单片机\\Code\\Clock.uvprojx',
  'D:\\Program\\Project\\example\\BallMontorTest\\keil\\Project.uvprojx',
]

import { resolveChip } from '../lib/core.mjs'

for (const [device, expectFamily, expectUart, forbid] of [
  ['STM32F411CEUx', 'STM32F4', 'USART6', 'USART3'],
  ['STM32F407VETx', 'STM32F4', 'USART3', null],
  ['STM32F103C8Tx', 'STM32F1', 'USART1', 'USART6'],
]) {
  const chip = resolveChip(device)
  const pins = chip.uart.map((entry) => entry.p)
  const ok = chip.known && chip.family === expectFamily && pins.includes(expectUart) && (forbid === null || !pins.includes(forbid))
  console.log((ok ? 'PASS ' : 'FAIL ') + device + ' -> ' + chip.family + ' [' + pins.join(',') + ']')
  if (!ok) process.exitCode = 1
}

const doc = await doctor()
console.log('doctor:', JSON.stringify(doc, null, 1))

for (const file of projects) {
  if (!existsSync(file)) { console.log('missing', file); continue }
  const p = readProject(file)
  console.log('project:', p.name, '| device', p.device, '| family', p.chip.family, '| known', p.chip.known, '| hex', p.createHex, '| stlink', p.usesStlink)
}

// Build a copy so the user's own tree is never touched.
const source = 'D:\\桌面\\作业\\二班单片机\\Code'
const copy = 'D:\\Program\\DSH-Plugin-Class\\dsh-stm32-toolchain\\.tmp\\code-copy-' + process.pid
if (existsSync(source)) {
  try {

    await mkdir(copy, { recursive: true })

    await cp(source, copy, { recursive: true, force: true })

  } catch (error) {

    console.log('FAIL could not copy the scratch project :: ' + (error && error.message))

    process.exitCode = 1

  }
  const projectFile = copy + '\\Clock.uvprojx'
  if (existsSync(projectFile)) {
    let result = await buildProject(projectFile)

    /* uVision is single instance: a busy/lingering instance returns non-zero with an empty log */

    if (!result.ok && result.errors === 0 && String(result.log || '').trim() === '') {

      await new Promise((resolve) => setTimeout(resolve, 3000))

      result = await buildProject(projectFile)

    }
    console.log('build:', result.ok, 'code', result.code, result.reason, result.elapsedMs + 'ms', 'errors', result.errors, 'warnings', result.warnings)
    console.log('diagnostics sample:', JSON.stringify(result.diagnostics.slice(0, 3)))
    console.log('log tail:', result.log.split(/\r?\n/).filter(Boolean).slice(-4).join(' | '))
  } else {
    console.log('copy has no Clock.uvprojx:', copy)
  }
}
