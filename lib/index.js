import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PairingRegistry } from './auth.js'
import { ApprovalDesk } from './approvals.js'
import { createCaller, followSession } from './remote.js'
import { createHandler, createUpgradeHandler } from './server.js'
import { createHostSession } from './proxy.js'
import { readWebServer, resolveHostBase } from './host-origin.js'
import { resolveBindAddress, listIpv4Interfaces } from './net.js'

/** Stable Cordis plugin name; also the bundle patch row id. */
export const name = 'dsh-plugin-zt-remote'

/** Services this plugin reads. The gateway carries every Remote call; connection mints the Host session the UI proxy replays. */
export const inject = ['typertGateway', 'connection']

export { Config } from './config.js'

/** How long one approval ask waits for a phone answer before the desktop answerers take over. */
const APPROVAL_WAIT_MS = 60_000

/**
 * Resolve the Harness home the way `dsh-home-paths` resolves the default home.
 * @param configured - `stateDir` from the plugin config.
 * @returns Absolute directory holding this plugin's paired-device state.
 */
function stateDirectory(configured) {
  if (configured !== '') return configured
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'plugin-data', name)
}

/**
 * Mount the ZeroTier remote surface: one HTTP listener bound to the ZeroTier
 * interface, a device-token gate, an in-process caller for the Remote methods
 * the Web UI uses, and an approval desk that lets a paired phone decide asks
 * while they are still pending.
 *
 * Every registration is an effect, so unloading the plugin closes the socket,
 * releases any held approval, and stops serving.
 *
 * @param ctx - Plugin context; `ctx.typertGateway` is the only required service.
 * @param config - Validated Config.
 */
export function apply(ctx, config) {
  if (!config.enabled) return

  const directory = stateDirectory(config.stateDir)
  const stateFile = join(directory, 'devices.json')
  const pairingFile = join(directory, 'pairing.txt')

  const persist = async (state) => {
    await mkdir(directory, { recursive: true })
    await writeFile(stateFile, JSON.stringify(state, undefined, 2), { encoding: 'utf8', mode: 0o600 })
  }

  const registry = new PairingRegistry(persist)
  const caller = createCaller(ctx.typertGateway)
  const openFollow = (request, signal) => followSession(ctx.typertGateway, request, signal)
  const logger = (...args) => console.error(`[${name}]`, ...args)

  /**
   * Operator key: the desktop's only path to pairing material.
   *
   * The listener binds the ZeroTier address only, so no loopback peer can reach
   * `/operator/*`. Without a key the operator could never learn the pairing code
   * after the first one expires. The key is written to a 0600 file beside the
   * pairing URL, and only its holder may read or rotate device state.
   */
  const operatorKey = randomBytes(24).toString('base64url')

  /** Phones listening for live events; one entry per open stream. */
  const streams = new Set()
  const broadcast = (frame) => {
    for (const write of streams) {
      try {
        write(frame)
      } catch {
        /* a closed stream removes itself through its own abort listener */
      }
    }
  }

  const desk = new ApprovalDesk({
    timeoutMs: APPROVAL_WAIT_MS,
    publish: (notification) => {
      if (notification.type === 'pending') logger(`approval pending: ${notification.ask.toolName}`)
      broadcast(notification)
    },
  })

  ctx.effect(() => () => desk.releaseAll(), `${name}:approvals`)

  if (typeof ctx.on === 'function') {
    ctx.on('approval/request', (request) => desk.handle(request))
  } else {
    logger('ctx.on is unavailable; phone approval decisions stay disabled')
  }

  /**
   * Official Web UI proxy: the Host serves the real interface on loopback behind
   * its launch-token exchange, so the plugin takes that session once and replays
   * it while presenting the loopback authority. A phone then sees the genuine UI.
   */
  const hostOrigin = resolveHostBase(config.hostBase, readWebServer(ctx))
  const hostSession =
    config.webui === false
      ? undefined
      : createHostSession({
          /* The desktop Host picks its port per launch, so an empty config value is
             resolved from the live webServer service instead of a stale constant. */
          hostBase: hostOrigin.base,
          authenticatedUrl: (base) => ctx.connection.authenticatedUrl(base),
          log: logger,
        })
  logger(`zt-remote: Host Web UI origin ${hostOrigin.base} (${hostOrigin.source})`)

  const handler = createHandler({
    caller,
    gateway: ctx.typertGateway,
    registry,
    openFollow,
    desk,
    streams,
    operatorKey,
    hostSession,
    config,
    log: logger,
  })

  /* The sidebar panel calls its routes on whichever origin served the page. This
     listener serves a phone's page, so those calls land here directly. A desktop page
     is served by the Host origin, where nothing answers them; the panel reports that
     as inline text instead of the plugin failing to activate. */

  /* One journal line per admission decision: a refused upgrade leaves no HTTP
     response to inspect, so the reason is the only evidence there is. */
  const upgradeJournal = join(directory, 'upgrades.log')
  const trace = (line) => {
    logger('upgrade:', line)
    void appendFile(upgradeJournal, `${new Date().toISOString()} ${line}\n`).catch(() => {})
  }

  const upgradeHandler = createUpgradeHandler({
    caller,
    gateway: ctx.typertGateway,
    registry,
    openFollow,
    desk,
    streams,
    operatorKey,
    hostSession,
    config,
    log: (message, error) => trace(`${message}${error === undefined ? '' : ` ${String(error?.message ?? error)}`}`),
    trace,
  })

  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      logger('request failed', error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'remote/internal' } }))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    trace(`request ${req.method ?? '?'} ${req.url ?? '?'} host=${req.headers.host ?? '-'} cookie=${req.headers.cookie ? 'yes' : 'no'}`)
    upgradeHandler(req, socket, head)
  })

  const binding = resolveBindAddress(config.listenAddress, config.interfaceHint)
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listenPort, binding.address, () => {
      server.off('error', reject)
      server.on('error', (error) => logger('server error', error))
      resolve()
    })
  })

  ctx.effect(() => () => {
    server.closeAllConnections()
    server.close()
  }, `${name}:listen`)

  ;(async () => {
    try {
      const raw = await readFile(stateFile, 'utf8')
      registry.restore(JSON.parse(raw))
    } catch (error) {
      if (error?.code !== 'ENOENT') logger('state file unreadable; starting with no paired devices', error)
    }
    await listening
    const issued = registry.issueCode(config.pairCodeTtlSeconds)
    const origin = `http://${binding.address}:${config.listenPort}`
    const pairingUrl = `${origin}/#p=${issued.code}.${issued.secret}`
    const prefix = config.webui === false ? '' : config.webuiPrefix.replace(/\/+$/u, '')
    await mkdir(directory, { recursive: true })
    await writeFile(pairingFile, `${pairingUrl}\n${operatorKey}\n`, { encoding: 'utf8', mode: 0o600 })
    logger(`listening on ${origin} (${binding.name})`)
    logger(`pairing URL (open once on the phone): ${pairingUrl}`)
    if (prefix !== '') logger(`official Web UI after pairing: ${origin}${prefix}/`)
    logger(`operator key: ${operatorKey}`)
    logger(`operator code endpoint: ${origin}/operator/code?key=${operatorKey}`)
  })().catch((error) => {
    logger('startup failed', error)
  })
}

/** Exported for tests: the interface list the auto-detection reads. */
export const internals = { listIpv4Interfaces }
