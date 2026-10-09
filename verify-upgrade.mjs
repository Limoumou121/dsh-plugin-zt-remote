/**
 * Standalone check for WebSocket upgrade tunneling.
 *
 * Kept out of the node:test suite on purpose: sockets that outlive an assertion make
 * the runner wait, and a hanging runner hides the result. This script always exits.
 */
import { createServer, request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { pipeUpgrade } from './lib/upgrade-tunnel.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  if (!ok) failures += 1
}

/** A Host stand-in that either accepts the upgrade or refuses it, per mode. */
async function startHost(mode) {
  const seen = []
  const server = createServer((req, res) => {
    res.writeHead(200)
    res.end('plain')
  })
  server.on('upgrade', (req, socket) => {
    seen.push(`upgrade ${req.url} host=${req.headers.host ?? '-'} cookie=${req.headers.cookie ?? '-'}`)
    if (mode === 'refuse') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\nunauthorized')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
    socket.write('host-payload')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen }
}

/** A forwarder that tunnels upgrades to the Host stand-in. */
async function startForwarder(hostBase) {
  const server = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    pipeUpgrade(req, socket, head, { hostBase, cookie: 'dsh-auth-x=session' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** One upgrade attempt, reporting what came back. */
function upgradeOnce(port, path) {
  return new Promise((resolve) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        cookie: 'dsh-zt-token=phone-token',
        host: '192.0.2.10:8790',
      },
    })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done('TIMEOUT'), 4000)
    req.on('upgrade', (res, socket, head) => {
      socket.once('data', (chunk) => {
        socket.destroy()
        done(`101 payload="${head.toString()}${chunk.toString()}"`)
      })
      setTimeout(() => {
        socket.destroy()
        done(`101 payload="${head.toString()}"`)
      }, 500)
    })
    req.on('response', (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk.toString()
      })
      res.on('end', () => done(`refused ${res.statusCode} body="${body.slice(0, 20)}"`))
      res.resume()
    })
    req.on('error', (error) => done(`ERROR ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 50)}`))
    req.end()
  })
}

const accepting = await startHost('accept')
const acceptingPort = await startForwarder(accepting.base)
const accepted = await upgradeOnce(acceptingPort, '/api/remote.mux')
check('an upgrade is tunneled and the Host payload reaches the client', accepted.startsWith('101 payload="host-payload"'), accepted)
check(
  'the Host sees the loopback authority and the Host session cookie',
  /host=127\.0\.0\.1:\d+/.test(accepting.seen.at(-1) ?? '') && /cookie=dsh-auth-x=session/.test(accepting.seen.at(-1) ?? ''),
  accepting.seen.at(-1),
)

const refusing = await startHost('refuse')
const refusingPort = await startForwarder(refusing.base)
const refused = await upgradeOnce(refusingPort, '/api/remote.mux')
check('a refused upgrade is relayed as HTTP 401 instead of resetting', refused.startsWith('refused 401'), refused)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
/* Exit without awaiting server shutdown: a lingering socket must not hide the result. */
process.exit(failures === 0 ? 0 : 1)
