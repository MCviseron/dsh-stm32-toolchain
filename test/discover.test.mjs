import { createServer } from 'node:net'
import { discoverEsp } from '../lib/wifi.mjs'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

/* A fake ESP: answers +STATUS on the control port. */
const server = createServer((socket) => {
  socket.on('error', () => {})
  socket.write('+READY mode=sta src=build\r\n')
  socket.on('data', (chunk) => {
    if (chunk.toString('latin1').includes('STATUS')) socket.write('+STATUS mode=sta ip=127.0.0.1\r\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/* A different port that only accepts connections and says nothing: must not be reported. */
const silent = createServer((socket) => { socket.on('error', () => {}) })
await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))

const found = await discoverEsp({ subnets: ['127.0.0.'], port, timeoutMs: 150, concurrency: 64 })
check('discovery finds the control port that answers +STATUS',
  found.devices.length === 1 && found.devices[0].host === '127.0.0.1' && found.devices[0].status.startsWith('+STATUS'),
  JSON.stringify(found.devices))

const quiet = await discoverEsp({ subnets: ['127.0.0.'], port: silent.address().port, timeoutMs: 150, concurrency: 64 })
check('a port that never speaks is ignored', quiet.devices.length === 0, JSON.stringify(quiet.devices))

server.close()
silent.close()
