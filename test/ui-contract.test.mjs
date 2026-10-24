import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fsRead = (path) => readFileSync(path, 'utf8')
const bridge = readFileSync(join(root, 'lib/bridge.mjs'), 'utf8')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
const entry = readFileSync(join(root, 'lib/index.js'), 'utf8')

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/* These guard behaviour that silently disappeared once: a multi-line replace that matched
 * nothing (CRLF) or a component that dropped its children. Assert the real markers. */
check('serial writes are echoed to the 串口 channel', /log\('serial', '→ '\s*\+/.test(bridge))
check('the echo can be switched off', bridge.includes("'set-serial-echo'") && bridge.includes('settings.serialEcho !== false'))
check('the echo is logged only after a successful write',
  bridge.indexOf("→ ' + text") > bridge.indexOf("await monitor.pipe.write") && bridge.includes('→ 发送失败：'))
check('the wireless monitor finds the ESP itself and says so',
  bridge.includes('无线串口：自动探测到 ESP') && bridge.includes('无线串口打不开：'))
check('the wireless monitor decodes bytes as utf8', bridge.includes("line.toString('utf8')") && bridge.includes('monitor.pending = Buffer.concat'))
check('a dropped wireless pipe closes the monitor',
  bridge.includes('无线串口已断开') && fsRead(join(root, 'lib/wifi.mjs')).includes('data.destroyed'))
check('the panel offers the 显示发送 toggle', client.includes('显示发送') && client.includes('set-serial-echo'))

check('the CubeMX actions are in the toolbar',
  client.includes('"打开 .ioc"') && client.includes('"生成代码"') && client.includes('"选择 .ioc…"'))
check('生成代码 reports progress through the phase', bridge.includes('CubeMX 正在生成代码'))
check('the .ioc picker is a file dialog', bridge.includes('async function pickFile') && bridge.includes('OpenFileDialog'))
check('the .ioc is remembered per project', bridge.includes('iocByProject'))

check('Card renders its children', /props\.children \|\| null/.test(client))
check('the monitor baud can be auto-detected or picked',
  client.includes('"本地串口 自动"') && client.includes('"本地串口 " + rate') && client.includes('var BAUD_CHOICES'))
check('the ESP flashing baud has its own picker',
  client.includes('"ESP↔STM32 串口速率"') && client.includes('set-esp-baud') && bridge.includes("case 'set-esp-baud'"))
check('the bridge bakes the chosen baud into the firmware', bridge.includes('baud: settings.espBaud'))
check('a slow pipe baud is offered', String(readFileSync(join(root, 'lib/wifi-fw.mjs'), 'utf8')).includes('PIPE_BAUDS'))
check('the quick-start dialog exists', client.includes('快速上手') && client.includes('showHelp ? h("div"'))
check('the empty state points at the project picker', client.includes('还没选工程'))
check('recent projects are offered', client.includes('最近工程') && bridge.includes('rememberProject'))

check('a new session is told about the wifi transport',
  entry.includes('transport wifi') && entry.includes('stm32_esp_firmware'))
