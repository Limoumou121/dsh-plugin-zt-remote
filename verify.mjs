/**
 * One-command acceptance check for the ZeroTier remote surface.
 *
 * Run it after restarting DeepSeek Harness. It reads the pairing file the plugin
 * writes, mints a fresh pairing code through the operator key, then exercises
 * every capability the plugin claims — and fails loudly with the raw response
 * when one of them does not behave.
 *
 *   node verify.mjs                 # uses the address in pairing.txt
 *   node verify.mjs 10.8.0.2:8790   # or an explicit authority
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const stateDir = join(HOME, 'plugin-data', 'dsh-plugin-zt-remote')
const pairingFile = join(stateDir, 'pairing.txt')

/** The build id this script knows how to verify; a mismatch means stale module code. */
const EXPECTED_BUILD = 'r14-query-target'

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

let authority = process.argv[2]
let operatorKey
if (authority === undefined) {
  const lines = readFileSync(pairingFile, 'utf8').trim().split('\n')
  authority = lines[0].match(/https?:\/\/[^/]+/)?.[0]
  operatorKey = lines[1]?.trim()
  console.log(`pairing file: ${pairingFile}`)
} else {
  console.log(`authority from argv: ${authority}`)
}
if (authority === undefined) {
  console.error('no authority: pass one, or let the plugin write pairing.txt first')
  process.exit(2)
}
console.log(`authority: ${authority}\n`)

async function call(path, { method = 'GET', token, operator = false, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (operator && operatorKey) headers['x-zt-operator-key'] = operatorKey
  const res = await fetch(`${authority}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 300) } }
  }
}

/* 1. The loaded module generation. */
const hello = await call('/hello')
check('plugin answers /hello', hello.status === 200, hello.json.value?.plugin)
check(
  `module generation is ${EXPECTED_BUILD}`,
  hello.json.value?.build === EXPECTED_BUILD,
  hello.json.value?.build === undefined ? 'no build field: the Host is still running older module code — restart it' : hello.json.value.build,
)

/* 2. The access model. With auto access, any reachable peer is admitted and gets a
      device row; with the paired model, an unpaired request must be refused. */
const accessModel = hello.json.value?.access ?? 'paired'
const firstContact = await call('/workspaces')
if (accessModel === 'auto') {
  check('auto access admits a peer and issues a device cookie', firstContact.status === 200, `${firstContact.status}`)
} else {
  check('a request without a device token is refused', firstContact.status === 401, `${firstContact.status} ${firstContact.json.error?.code ?? ''}`)
}
check('the plugin reports which access model is live', accessModel === 'auto' || accessModel === 'paired', accessModel)

/* 3. Pairing through the operator key. */
const issued = await call('/operator/code', { operator: true })
check('operator key mints a pairing code', issued.json.ok === true, issued.json.ok ? issued.json.value.code : JSON.stringify(issued.json))

/* The device-pairing exchange is checked in both models: it is how a device earns a
   durable row, and the operator keeps using it to hand out credentials deliberately. */
const paired = await call('/pair', {
  method: 'POST',
  body: { code: issued.json.value?.code, secret: issued.json.value?.secret, deviceName: 'verify-script' },
})
check('pairing issues a device token', paired.json.ok === true, paired.json.ok ? `${paired.json.value.token.length} chars` : JSON.stringify(paired.json))
const token = paired.json.value?.token
if (token === undefined) {
  console.log('\nno token: cannot continue')
  process.exit(1)
}

/* 4. Workspace roster (the `items` baseline) and creation. */
const workspaces = await call('/workspaces', { token })
const roster = workspaces.json.value?.workspaces
check('workspace roster is readable', Array.isArray(roster), `${Array.isArray(roster) ? roster.length : '?'} workspaces`)
for (const workspace of (roster ?? []).slice(0, 3)) console.log(`    · ${workspace.path ?? workspace.workspaceId}`)
const target = join(HOME, 'plugin-data', 'dsh-plugin-zt-remote', 'verify-workspace')
mkdirSync(target, { recursive: true })
const created = await call('/workspaces', { method: 'POST', token, body: { path: target } })
check('a workspace can be created', created.json.ok === true && created.json.value?.workspace?.workspaceId !== undefined, created.json.ok ? created.json.value.workspace.workspaceId : JSON.stringify(created.json))
const workspaceId = created.json.value?.workspace?.workspaceId

/* 5. Session roster, creation, history. */
const sessions = await call('/sessions', { token })
check('session roster is readable', Array.isArray(sessions.json.value?.sessions), `${sessions.json.value?.sessions?.length ?? '?'} sessions`)
const session = await call('/sessions', { method: 'POST', token, body: workspaceId ? { workspaceId } : {} })
check('a conversation can be created', session.json.ok === true, session.json.value?.sessionId ?? JSON.stringify(session.json))
const sessionId = session.json.value?.sessionId

/* 6. Continue an existing conversation. */
const prompted = await call(`/sessions/${sessionId}/prompt`, { method: 'POST', token, body: { text: '只回复两个字：收到' } })
check('a prompt is accepted', prompted.json.value?.accepted === true, JSON.stringify(prompted.json).slice(0, 120))

/* 7. The turn lands in history and streams. */
let messages = []
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const page = await call(`/sessions/${sessionId}/messages?limit=30`, { token })
  messages = page.json.value?.messages ?? []
  if (messages.some((m) => m.role === 'assistant')) break
}
check('the turn produced an assistant message', messages.some((m) => m.role === 'assistant'), messages.map((m) => m.role).join(',') || 'no messages')
for (const message of messages.slice(0, 6)) console.log(`    · ${message.role}: ${JSON.stringify(String(message.text ?? '').slice(0, 80))}`)

const controller = new AbortController()
const stream = await fetch(`${authority}/sessions/${sessionId}/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let text = ''
const deadline = Date.now() + 15_000
while (Date.now() < deadline) {
  const race = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now())))])
  if (race.timeout === true || race.done === true) break
  text += decoder.decode(race.value, { stream: true })
}
controller.abort()
const events = [...new Set([...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]))]
check('the event stream delivers frames', events.length > 0, `${text.length} bytes, events: ${events.join(',') || 'none'}`)

/* 8. Approvals. */
const approvals = await call('/approvals', { token })
check('the approval desk answers', approvals.json.ok === true && Array.isArray(approvals.json.value?.pending), `${approvals.json.value?.pending?.length ?? '?'} pending`)

/* 9. Revocation. Repeated runs leave same-named device rows behind, so retire that
      whole family first and then revoke the token this run actually paired. */
const DEVICE_NAME = 'verify-script'
const before = await call('/operator/devices', { operator: true })
const stale = (before.json.value?.devices ?? []).filter((device) => device.name === DEVICE_NAME)
for (const device of stale) await call('/operator/revoke', { method: 'POST', operator: true, body: { deviceId: device.id } })

const repairable = await call('/operator/code', { operator: true })
const second = await call('/pair', {
  method: 'POST',
  body: { code: repairable.json.value?.code, secret: repairable.json.value?.secret, deviceName: DEVICE_NAME },
})
const secondToken = second.json.value?.token
check('a device can pair after a revoke cycle', secondToken !== undefined, secondToken === undefined ? JSON.stringify(second.json) : `${secondToken.length} chars`)

const devices = await call('/operator/devices', { operator: true })
const mine = (devices.json.value?.devices ?? []).filter((device) => device.name === DEVICE_NAME).at(-1)
const owned = devices.json.value?.devices?.filter((device) => device.name === DEVICE_NAME).length ?? 0
check('this run owns exactly one row with its name', owned === 1, `${owned} rows named ${DEVICE_NAME}`)
const revoked = await call('/operator/revoke', { method: 'POST', operator: true, body: { deviceId: mine?.id } })
check('the paired device can be revoked', revoked.json.value?.removed === 1, JSON.stringify(revoked.json.value ?? revoked.json))

if (accessModel === 'auto') {
  /* The revoked row is gone, and a fresh visit is admitted as a new device — that is
     the intended model when the network is the boundary. */
  const rosterAfter = await call('/operator/devices', { operator: true })
  const stillThere = (rosterAfter.json.value?.devices ?? []).some((device) => device.id === mine?.id)
  check('the revoked device row is gone', stillThere === false, stillThere ? 'row still present' : 'removed')
  const revisit = await call('/workspaces')
  check('a fresh visit is admitted as a new device', revisit.status === 200, `${revisit.status}`)
} else {
  const after = await call('/workspaces', { token: secondToken })
  check('a revoked token stops working', after.status === 401, `${after.status} ${after.json.error?.code ?? ''}`)
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
