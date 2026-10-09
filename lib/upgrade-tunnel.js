import { connect } from 'node:net'

/**
 * Forward one WebSocket upgrade as raw bytes through a TCP tunnel.
 *
 * Node's HTTP client upgrade path proved unreliable here: against the real Host a
 * refused upgrade surfaced as a connection reset before any HTTP bytes reached the
 * phone. A tunnel is faithful to the protocol — the request line the client already
 * sent is replayed (authority and cookie rewritten) and every later byte is piped,
 * which is how a reverse proxy normally carries an upgrade.
 *
 * @param incoming - Phone request that carried the upgrade; its line and headers are replayed.
 * @param clientSocket - Phone socket.
 * @param head - Bytes already read from the phone socket.
 * @param options - Target authority, cookie the Host accepts, and a logger.
 * @returns Nothing; the sockets are piped, or both destroyed on failure.
 */
export function pipeUpgrade(incoming, clientSocket, head, { hostBase, cookie, log, connectSocket = connect }) {
  const target = new URL(hostBase)
  const upstream = connectSocket(Number(target.port), target.hostname)

  const shutdown = () => {
    upstream.destroy()
    clientSocket.destroy()
  }

  const lines = [`${incoming.method ?? 'GET'} ${incoming.url ?? '/'} HTTP/1.1`]
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    /* `origin` is rewritten below: a browser sends it on every WebSocket upgrade, and
       the Host refuses an upgrade whose origin is not its own authority (403), which
       the client reports as an endless "reconnecting". */
    if (lower === 'host' || lower === 'cookie' || lower === 'origin') continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
  }
  lines.push(`Host: ${target.host}`)
  lines.push(`Cookie: ${cookie}`)
  /* Present the Host's own authority so the upgrade passes its origin check. */
  if (incoming.headers.origin !== undefined) lines.push(`Origin: ${target.origin}`)

  upstream.on('connect', () => {
    log?.(`tunnel connected to ${target.host}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })
  /* Byte accounting after the handshake: a tunnel can accept an upgrade and still
     carry nothing, which looks exactly like an empty sidebar on the phone. */
  let toHost = 0
  let toPhone = 0
  upstream.on('data', (chunk) => {
    toPhone += chunk.length
  })
  clientSocket.on('data', (chunk) => {
    toHost += chunk.length
  })
  const report = setInterval(() => {
    if (toHost > 0 || toPhone > 0) log?.(`tunnel traffic phone->host=${toHost}B host->phone=${toPhone}B`)
  }, 5000)
  report.unref?.()
  clientSocket.on('close', () => clearInterval(report))
  upstream.on('close', () => clearInterval(report))
  upstream.on('error', (error) => {
    log?.(`tunnel failed: [${error?.code ?? '?'}] ${String(error?.message ?? error)}`)
    shutdown()
  })
  clientSocket.on('error', (error) => {
    log?.(`client socket error: [${error?.code ?? '?'}] ${String(error?.message ?? error)}`)
    shutdown()
  })
  clientSocket.on('close', () => upstream.destroy())
  upstream.on('close', () => clientSocket.destroy())
  /* A tunnel that neither errors nor answers must not hold the phone open forever. */
  upstream.setTimeout(15_000, () => {
    log?.('zt-remote: upgrade tunnel idle timeout')
    shutdown()
  })
}
