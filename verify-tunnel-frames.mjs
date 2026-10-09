/**
 * End-to-end tunnel check with real WebSocket frames, no dependencies.
 *
 * The Host side is a raw socket server that performs the RFC 6455 handshake by hand
 * and echoes one unmasked text frame, so a failure here is a failure in the tunnel.
 */
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { pipeUpgrade } from './lib/upgrade-tunnel.js'

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A minimal server-side WebSocket: handshake, then echo whatever arrives. */
function startEchoServer() {
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${MAGIC}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('data', (chunk) => {
      /* Unmask the client frame and echo the payload back as a server frame. */
      if (chunk.length < 6) return
      const length = chunk[1] & 0x7f
      const mask = chunk.subarray(2, 6)
      const payload = Buffer.alloc(length)
      for (let index = 0; index < length; index += 1) payload[index] = chunk[6 + index] ^ mask[index % 4]
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      socket.write(Buffer.concat([header, payload]))
    })
    socket.on('error', () => {})
  })
  return server
}

const host = startEchoServer()
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve))
const hostBase = `http://127.0.0.1:${host.address().port}`

const forwarder = createServer()
forwarder.on('upgrade', (req, socket, head) => {
  pipeUpgrade(req, socket, head, { hostBase, cookie: 'dsh-auth-x=session', log: (line) => console.log('   [tunnel]', line) })
})
await new Promise((resolve) => forwarder.listen(0, '127.0.0.1', resolve))

/** Perform the client handshake through the tunnel, then send one masked text frame. */
const result = await new Promise((resolve) => {
  const key = randomBytes(16).toString('base64')
  const req = httpRequest({
    hostname: '127.0.0.1',
    port: forwarder.address().port,
    path: '/api/remote.mux',
    method: 'GET',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      host: '192.0.2.10:8790',
    },
  })
  const timer = setTimeout(() => resolve('TIMEOUT: no frame came back'), 6000)
  req.on('upgrade', (res, socket) => {
    const expected = createHash('sha1').update(`${key}${MAGIC}`).digest('base64')
    if (res.headers['sec-websocket-accept'] !== expected) {
      clearTimeout(timer)
      resolve(`handshake mismatch: ${res.headers['sec-websocket-accept']} != ${expected}`)
      return
    }
    const payload = Buffer.from('ping-through-tunnel')
    const mask = randomBytes(4)
    const masked = Buffer.alloc(payload.length)
    for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]))
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      const length = chunk[1] & 0x7f
      const text = chunk.subarray(2, 2 + length).toString()
      socket.destroy()
      resolve(`frame echoed: "${text}"`)
    })
  })
  req.on('response', (res) => {
    clearTimeout(timer)
    resolve(`refused ${res.statusCode}`)
  })
  req.on('error', (error) => {
    clearTimeout(timer)
    resolve(`ERROR ${error?.code} ${String(error?.message ?? error).slice(0, 60)}`)
  })
  req.end()
})

console.log('result:', result)
console.log(result.startsWith('frame echoed') ? 'PASS tunnel carries frames' : 'FAIL tunnel does not carry frames')
process.exit(result.startsWith('frame echoed') ? 0 : 1)
