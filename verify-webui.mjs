const origin = process.argv[2] ?? 'http://192.0.2.10:8790'
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const hello = await (await fetch(`${origin}/hello`)).json()
check('build generation', hello.value?.build === 'r27-sidebar-panel', hello.value?.build ?? '(none)')

/* The shell's plugin-bundle URL is a `?` query, so the proxy must forward it verbatim.
   Dropping that query was what produced "Failed to load plugins". */
const shell = await (await fetch(`${origin}/ui/`)).text()
const bundleRefs = [...shell.matchAll(/href="(plugins\/\?\?[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
check('the shell declares plugin bundles', bundleRefs.length > 0, `${bundleRefs.length} bundles`)
if (bundleRefs.length > 0) {
  const bundleCookie = (await (await fetch(`${origin}/ui/`)).headers.get('set-cookie') ?? '').split(';')[0]
  const bundle = await fetch(`${origin}/ui/${bundleRefs[0]}`, { headers: { cookie: bundleCookie } })
  const bundleBody = await bundle.text()
  check(
    'a plugin bundle loads through the proxy',
    bundle.status === 200 && bundleBody.includes('__ModuleLoader__'),
    `${bundle.status}, ${bundleBody.length} bytes, ${bundle.headers.get('content-type') ?? 'no type'}`,
  )
}

/* The bare fixed address must land on the official UI, with no credential. */
const root = await fetch(`${origin}/`, { redirect: 'manual' })
check('GET / → 303 /ui/', root.status === 303 && root.headers.get('location') === '/ui/', `${root.status} ${root.headers.get('location') ?? ''}`)

const pageResponse = await fetch(`${origin}/ui/`)
const page = await pageResponse.text()
const cookie = (pageResponse.headers.get('set-cookie') ?? '').split(';')[0]
check('GET /ui/ serves the official shell', pageResponse.status === 200 && page.includes('<div id="root">'), `${page.length} bytes`)
check('a device cookie is issued automatically', cookie.startsWith('dsh-zt-token='), cookie === '' ? '(none)' : 'yes')
check('the plugin pairing page is not what answers', !page.includes('DSH 远程'))

/* Every asset the shell declares, resolved the way the browser will resolve it: an
   absolute path is origin-root, a relative one belongs to the document's directory. */
const refs = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
const assets = refs.filter((ref) => /\.(js|css)$/.test(ref))
let served = 0
for (const ref of assets) {
  const resolved = ref.startsWith('http')
    ? ref
    : ref.startsWith('/')
      ? `${origin}${ref}`
      : `${origin}/ui/${ref.replace(/^\.\//, '')}`
  const response = await fetch(resolved)
  if (response.status === 200) served += 1
  else console.log('   ✖ asset', ref.slice(0, 60), response.status, `(${resolved})`)
}
check(`all ${assets.length} declared script/style assets are served`, served === assets.length, `${served}/${assets.length}`)

/* A real Remote call the sidebar makes, through the SPA's own URL shape. */
const call = async (endpoint) =>
  fetch(`${origin}/ui/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${endpoint}`, method: endpoint, payload: { args: endpoint === 'session/list' ? { _request: {} } : {} } }),
  })

const sessions = await (await call('session/list')).json()
check('session/list works through the UI proxy', sessions.result?.ok === true, `${(sessions.result?.value?.items ?? []).length} sessions`)
const workspaces = await (await call('workspace/follow')).json()
check('workspace/follow opens through the UI proxy', workspaces.result !== undefined, JSON.stringify(workspaces.result).slice(0, 90))

/* Reopening with only the cookie, as a phone does on the next visit. */
const reopened = await fetch(`${origin}/ui/`, { headers: { cookie } })
check('the cookie alone reopens the UI', reopened.status === 200, `${reopened.status}`)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
