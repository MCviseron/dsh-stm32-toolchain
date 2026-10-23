import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cString, credentialsHeader, firmwareToolchain, generateFirmware, flashEsp, FQBN, SKETCH_DIR } from '../lib/wifi-fw.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

check('a password with quotes and backslashes becomes a C literal',
  cString('p@ss"word\\1') === '"p@ss\\"word\\\\1"', cString('p@ss"word\\1'))
check('the generated header carries both values',
  credentialsHeader('My Net', 'secret').includes('#define WIFI_SSID "My Net"') &&
  credentialsHeader('My Net', 'secret').includes('#define WIFI_PASS "secret"'))
check('the header warns against committing', credentialsHeader('a', 'b').includes('do not commit'))

const toolchain = firmwareToolchain()
check('the toolchain probe answers even without arduino-cli',
  typeof toolchain.ok === 'boolean' && toolchain.fqbn === FQBN && typeof toolchain.core === 'string',
  JSON.stringify({ ok: toolchain.ok, core: toolchain.core }))
check('the sketch lives next to the plugin', toolchain.sketch === SKETCH_DIR)

const empty = await generateFirmware({})
check('an empty SSID is refused before spawning a compiler', empty.ok === false && /名称/.test(empty.error), empty.error)
const tooLong = await generateFirmware({ ssid: 'x'.repeat(40) })
check('a 40 character SSID is refused', tooLong.ok === false && /32/.test(tooLong.error), tooLong.error)
const longPass = await generateFirmware({ ssid: 'ok', pass: 'y'.repeat(70) })
check('a 70 character password is refused', longPass.ok === false && /63/.test(longPass.error), longPass.error)

const noPort = await flashEsp({})
check('flashing without a port is refused', noPort.ok === false && /串口/.test(noPort.error), noPort.error)
const noBin = await flashEsp({ port: 'COM9' })
check('flashing without a bin is refused', noBin.ok === false && /固件/.test(noBin.error), noBin.error)

const bridge = readFileSync(join(HERE, '..', 'lib', 'bridge.mjs'), 'utf8')
check('the password never leaves the bridge', bridge.includes('wifiPass: undefined'))
check('the bridge exposes the ESP flow as actions',
  bridge.includes("case 'gen-firmware'") && bridge.includes("case 'flash-esp'") && bridge.includes("case 'set-wifi-fw'"))
check('and as an agent tool', bridge.includes("stm32_esp_firmware"))

const client = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
check('the panel asks for both credentials',
  client.includes('label: "Wi-Fi 名称"') && client.includes('Wi-Fi 密码') && client.includes('type: "password"'))
check('with a generate and a flash button', client.includes('"生成固件"') && client.includes('"烧到 ESP"'))
