import { createServer } from 'node:net'
import { WifiPipe } from '../lib/wifi.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/* ---- fake ESP-01S: 3333 control lines, 3334 raw echo ---- */
const commands = []
const ctrl = createServer((socket) => {
  socket.write('+READY mode=sta src=build ssid=W14917 ip=127.0.0.1 boot0=0 nrst=1\r\n')
  let rest = ''
  socket.on('data', (chunk) => {
    rest += chunk.toString('latin1')
    let index
    while ((index = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, index).trim()
      rest = rest.slice(index + 1)
      if (!line) continue
      commands.push(line)
      if (line === 'PING') socket.write('+PONG 1234\r\n')
      else if (line === 'STATUS') socket.write('+STATUS mode=sta ip=127.0.0.1\r\n')
      else if (line === 'BOOTLOADER') socket.write('+BOOTLOADER boot0=1\r\n')
      else if (line === 'RUN') socket.write('+RUN\r\n')
      else if (line.startsWith('BOOT ')) socket.write('+BOOT ' + line.slice(5) + '\r\n')
      else if (line.startsWith('PULSE')) socket.write('+PULSE ' + line.slice(6).trim() + '\r\n')
      else socket.write('+ERR unknown\r\n')
    }
  })
})
const data = createServer((socket) => {
  socket.on('data', (chunk) => {
    if (chunk[0] === 0xee) { socket.write(Buffer.from([0x79, 0x01, 0x02, 0x03])); return }
    if (chunk[0] === 0xdd) return            /* silent: forces a timeout */
    socket.write(chunk)                      /* echo */
  })
})
await new Promise((resolve) => ctrl.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => data.listen(0, '127.0.0.1', resolve))
const ctrlPort = ctrl.address().port
const pipePort = data.address().port

const pipe = await WifiPipe.open('127.0.0.1', { ctrlPort, pipePort, timeoutMs: 3000 })

check('ping reaches the control port', (await pipe.ping()).includes('+PONG'), commands.at(-1))
check('status reports the station', (await pipe.status()).includes('mode=sta'))

await pipe.enterBootloader({ pulseMs: 100 })
check('enterBootloader asks the ESP for bootloader framing (8E1) and resets',
  commands.at(-1) === 'BOOTLOADER', commands.at(-1))

await pipe.write([0x7f])
check('bytes written to the pipe come back (echo)', (await pipe.readByte(1000)) === 0x7f)
check('readExact returns the requested slice',
  Buffer.compare(await pipe.readExact(0, 500), Buffer.alloc(0)) === 0)

await pipe.write([0xee])
const ack = await pipe.readByte(1000)
const rest = await pipe.readExact(3, 1000)
check('multi-byte replies are buffered in order',
  ack === 0x79 && rest.equals(Buffer.from([0x01, 0x02, 0x03])), ack.toString(16) + '/' + rest.toString('hex'))

await pipe.write([0xdd])
let timedOut = ''
try { await pipe.readByte(200) } catch (error) { timedOut = error.message }
check('a silent peer times out instead of hanging', /超时/.test(timedOut), timedOut.slice(0, 40))

await pipe.enterBootloader({ pulse: false })
check('manual mode asserts BOOT0 without a reset pulse',
  commands.at(-1) === 'BOOT 1', commands.at(-1))

await pipe.run(50)
check('run asks for the application framing (8N1)',
  commands.at(-1) === 'RUN', commands.at(-1))
await pipe.close()
ctrl.close()
data.close()

const missing = await WifiPipe.open('').catch((error) => error.message)
check('an empty host is refused', /IP/.test(String(missing)), String(missing).slice(0, 40))
