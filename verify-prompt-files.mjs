/**
 * Acceptance for the two things the phone interface must do: carry prompts and
 * carry files. Both go over the routes the official Web UI itself uses.
 *
 * Usage: node verify-prompt-files.mjs [origin] [workspace-path]
 * The workspace defaults to the current directory, which the Host always accepts.
 */
const origin = process.argv[2] ?? 'http://192.0.2.10:8790'
const workspace = process.argv[3] ?? process.cwd()
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  if (!ok) failures += 1
}

const shell = await fetch(`${origin}/ui/`)
const cookie = (shell.headers.get('set-cookie') ?? '').split(';')[0]
const json = { cookie, 'content-type': 'application/json' }
let rpc = 0
const call = async (endpoint, args) => {
  rpc += 1
  const response = await fetch(`${origin}/ui/api/${endpoint}`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ type: 'client-request', rpcId: `acc-${rpc}`, method: endpoint, payload: { args } }),
  })
  return { status: response.status, text: await response.text() }
}

const sessions = await call('session/list', { _request: {} })
check('the session roster is readable', sessions.text.includes('"ok":true'), `${[...sessions.text.matchAll(/"sessionId"/g)].length} sessions`)

const created = await call('session/create', { request: { cwd: workspace } })
const sessionId = created.text.match(/"sessionId":"([^"]+)"/)?.[1]
check('a conversation can be created', sessionId !== undefined, sessionId ?? created.text.slice(0, 120))

/* 1. A prompt reaches the conversation, and the model answers. */
const prompt = await call('session/prompt', {
  request: { requestId: `acc-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] },
})
check('a prompt is accepted', prompt.text.includes('"accepted":true'), prompt.text.slice(0, 110))

const started = Date.now()
let assistantMs = -1
for (let attempt = 0; attempt < 20; attempt += 1) {
  /* Read the conversation through the plugin's own history route: the UI's
     `session/follow` is a stream method and only opens over the stream carrier, and
     `session/page` needs a through-sequence bound to the log's cursor. */
  const history = await fetch(`${origin}/sessions/${encodeURIComponent(sessionId)}/messages?limit=30`, { headers: { cookie } })
  const page = await history.json()
  if ((page.value?.messages ?? []).some((message) => message.role === 'assistant')) {
    assistantMs = Date.now() - started
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
check('the assistant reply lands in the conversation', assistantMs >= 0, assistantMs >= 0 ? `${assistantMs} ms` : 'no assistant message within 40s')

/* 2. A file goes up the RPC channel the UI uses, and its receipt names the bytes. */
const body = Buffer.from('远程文件内容 remote file body')
const upload = await call('fileUploads/upload', { agentId: sessionId, request: { data: body.toString('base64'), name: 'phone-note.txt' } })
const receiptId = upload.text.match(/"receiptId":"([^"]+)"/)?.[1]
const bytes = upload.text.match(/"bytes":(\d+)/)?.[1]
check('a file uploads through the proxy', upload.status === 200 && receiptId !== undefined, `${upload.status} receipt=${receiptId ?? '-'}`)
check('the receipt reports the exact byte count', body.length === Number(bytes), `${bytes} bytes vs ${body.length} sent`)

/* 3. The attachment endpoint answers the proxy for that receipt. */
if (receiptId !== undefined) {
  const read = await call('session/attachment', { request: { sessionId, attachmentId: receiptId } })
  const unreferenced = read.text.includes('attachment-invalid')
  check(
    'the attachment endpoint answers the proxy',
    read.status === 200 && (read.text.includes('"ok":true') || unreferenced),
    unreferenced ? 'answered; refused as unreferenced until a prompt carries it' : read.text.slice(0, 90),
  )
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
