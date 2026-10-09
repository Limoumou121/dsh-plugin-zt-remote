import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientBundle } from './client-harness.js'

/**
 * The client bundle registers two slots and drives the plugin's HTTP routes. These
 * tests exercise the factory, the registrations, and the panel's request behaviour
 * against a stub React; they do not render a page in a browser.
 */

/** Restorers for the global stubs each bundle load installs. */
const restores = []
afterEach(() => {
  while (restores.length > 0) restores.pop()()
})

/** Load one bundle and register its stub restorer for this test. */
const load = (fetchImpl) => loadClientBundle(fetchImpl, restores)

/** One JSON reply in the plugin's `{ ok, value }` envelope. */
const ok = (value) =>
  new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'content-type': 'application/json' } })

/** One JSON reply in the plugin's `{ ok: false, error }` envelope. */
const fail = (status, code, message) =>
  new Response(JSON.stringify({ ok: false, error: message === undefined ? { code } : { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Let every already-scheduled microtask, including an async effect body, run. */
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

/**
 * Render the panel once with its effects, let them settle, then render again so the
 * published state shows. Hook state lives in the harness slots, so later renders
 * continue the same component instance.
 * @param harness - result of {@link loadClientBundle}.
 * @returns the settled tree.
 */
async function renderPanel(harness) {
  const panel = harness.componentFor('main', harness.exports.PANEL_ID)
  assert.ok(panel !== undefined, 'the main panel must be registered under the sidebar id')
  const element = harness.createElement(panel.component, {})
  harness.render(element, { runEffects: true })
  await settle()
  return harness.render(element, { runEffects: true }).tree
}

/**
 * Render the panel without settling, for a caller that will interact first.
 * @param harness - result of {@link loadClientBundle}.
 * @returns the first-pass tree.
 */
function renderPanelOnce(harness) {
  const panel = harness.componentFor('main', harness.exports.PANEL_ID)
  assert.ok(panel !== undefined, 'the main panel must be registered under the sidebar id')
  return harness.render(harness.createElement(panel.component, {}), { runEffects: true }).tree
}

/** Render again over the same component instance and return the tree. */
function rerenderPanel(harness) {
  const panel = harness.componentFor('main', harness.exports.PANEL_ID)
  return harness.render(harness.createElement(panel.component, {}), { runEffects: true }).tree
}

/**
 * Find one rendered host node.
 * @param harness - result of {@link loadClientBundle}.
 * @param tree - tree to search.
 * @param match - predicate over one node.
 * @returns the first matching node.
 */
function findNode(harness, tree, match) {
  const node = [...harness.walk(tree)].find(match)
  assert.ok(node !== undefined, 'the expected node must render')
  return node
}

/** Find the button whose text is `label`. */
const buttonWith = (harness, tree, label) =>
  findNode(harness, tree, (node) => node.tag === 'button' && harness.textOf(node.children) === label)

/** The operator-key input on a settled panel. */
const keyInput = (harness, tree) => findNode(harness, tree, (node) => node.tag === 'input' && node.props.type === 'password')

test('the bundle opens one module factory whose id is the package name', () => {
  const harness = load(() => ok({ workspaces: [] }))
  const loadEntry = harness.registrations.find((entry) => entry.kind === 'load')
  assert.ok(loadEntry !== undefined, 'the first statement must be __ModuleLoader__.load')
  assert.equal(loadEntry.id, 'dsh-plugin-zt-remote')
  assert.equal(typeof harness.exports.apply, 'function')
})

test('the client declares no non-baseline modules and injects a static array', () => {
  const harness = load(() => ok({ workspaces: [] }))
  assert.deepEqual(harness.exports.inject, ['slots'], 'the slots service is injected by name')
})

test('the sidebar entry and the main panel share one panel id', () => {
  const harness = load(() => ok({ workspaces: [] }))
  const entry = harness.componentFor('sidebar.panellist', 'zt-remote')
  const panel = harness.componentFor('main', 'zt-remote')
  assert.ok(entry !== undefined, 'sidebar.panellist must be registered')
  assert.ok(panel !== undefined, 'main must be registered')
  assert.equal(entry.options.id, panel.options.key, 'the panellist id and the main key must match')
  assert.equal(entry.options.order, 10)
  assert.equal(entry.options.label, '远程管理')

  const injected = harness.registrations
    .filter((registration) => registration.kind === 'inject')
    .map((registration) => registration.key)
    .toSorted()
  assert.deepEqual(injected, ['main', 'sidebar.panellist'])

  /* The icon is rendered through the host's icon contract: a size prop, no throw. */
  const icon = harness.render(harness.createElement(entry.component, { size: 16 }), { runEffects: false })
  const svg = [...harness.walk(icon.tree)].find((node) => node.tag === 'svg')
  assert.ok(svg !== undefined, 'the sidebar occupant must draw one inline svg')
  assert.equal(svg.props.viewBox, '0 0 16 16')
  assert.equal(svg.props.stroke, 'currentColor')
  assert.equal(svg.props.width, 16)
})

test('the panel reads the workspace roster from the plugin route', async () => {
  const calls = []
  const harness = load((url) => {
    calls.push(url)
    return ok({
      workspaces: [
        { workspaceId: 'w1', path: 'D:\proj', title: '项目', sessionCount: 2 },
        { workspaceId: 'w2', path: 'C:\\other' },
      ],
    })
  })
  const text = harness.textOf(await renderPanel(harness))
  assert.deepEqual(calls, ['/workspaces'])
  assert.match(text, /已登记工作区/)
  assert.match(text, /按路径添加工作区/)
  assert.match(text, /接入设备/)
  assert.match(text, /项目/)
  assert.match(text, /D:\proj/)
  assert.match(text, /2 个会话/)
  assert.match(text, /共 2 个工作区。/)
})

test('the panel creates a workspace from the typed path and reports the outcome', async () => {
  const seen = []
  const harness = load((url, init) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body })
    if (init.method === 'POST') return ok({ workspace: { workspaceId: 'w9', path: 'D:\proj' }, created: true })
    return ok({ workspaces: [{ workspaceId: 'w9', path: 'D:\proj' }] })
  })
  renderPanelOnce(harness)
  await settle()

  findNode(harness, rerenderPanel(harness), (node) => node.tag === 'input').props.onChange({ target: { value: 'D:\proj' } })
  buttonWith(harness, rerenderPanel(harness), '添加').props.onClick()
  await settle()

  const post = seen.find((call) => call.method === 'POST')
  assert.ok(post !== undefined, 'adding must POST to the plugin route')
  assert.equal(post.url, '/workspaces')
  assert.equal(post.body, JSON.stringify({ path: 'D:\proj' }))
  assert.match(harness.textOf(rerenderPanel(harness)), /已添加：D:\proj/)
})

test('an empty path is refused before any request', async () => {
  const seen = []
  const harness = load((url) => {
    seen.push(url)
    return ok({ workspaces: [] })
  })
  renderPanelOnce(harness)
  await settle()
  buttonWith(harness, rerenderPanel(harness), '添加').props.onClick()
  await settle()
  assert.deepEqual(seen, ['/workspaces'], 'no POST may be sent for an empty path')
  assert.match(harness.textOf(rerenderPanel(harness)), /请先填写运行 dsh 的电脑上的绝对路径。/)
})

test('the device roster is read with the operator-key header', async () => {
  const seen = []
  const harness = load((url, init) => {
    seen.push({ url, headers: init.headers ?? {}, method: init.method ?? 'GET' })
    if (url === '/operator/devices') {
      return ok({ devices: [{ id: 'd1', name: '访问设备 10.0.0.2', lastSeenAt: '2026-10-10T00:00:00.000Z' }] })
    }
    return ok({ workspaces: [] })
  })
  renderPanelOnce(harness)
  await settle()

  keyInput(harness, rerenderPanel(harness)).props.onChange({ target: { value: 'op-secret' } })
  buttonWith(harness, rerenderPanel(harness), '查看设备').props.onClick()
  await settle()

  const call = seen.find((entry) => entry.url === '/operator/devices')
  assert.ok(call !== undefined, 'the roster read must reach /operator/devices')
  assert.equal(call.headers['x-zt-operator-key'], 'op-secret')
  const text = harness.textOf(rerenderPanel(harness))
  assert.match(text, /访问设备 10\.0\.0\.2/)
  assert.match(text, /共 1 台接入设备。/)
})

test('a device can be revoked individually and all at once', async () => {
  const seen = []
  const harness = load((url, init) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body })
    if (url === '/operator/devices') return ok({ devices: [{ id: 'd1', name: '手机 A' }, { id: 'd2', name: '手机 B' }] })
    if (url === '/operator/revoke') return ok({ removed: { id: 'd1', name: '手机 A' } })
    return ok({ workspaces: [] })
  })
  renderPanelOnce(harness)
  await settle()

  keyInput(harness, rerenderPanel(harness)).props.onChange({ target: { value: 'op-secret' } })
  buttonWith(harness, rerenderPanel(harness), '查看设备').props.onClick()
  await settle()

  buttonWith(harness, rerenderPanel(harness), '撤销').props.onClick()
  await settle()
  await settle()
  const perDevice = seen.find((entry) => entry.url === '/operator/revoke')
  assert.ok(perDevice !== undefined, 'revocation must POST to /operator/revoke')
  assert.equal(perDevice.method, 'POST')
  assert.equal(perDevice.body, JSON.stringify({ deviceId: 'd1' }))
  assert.match(harness.textOf(rerenderPanel(harness)), /已撤销设备：手机 A/)

  buttonWith(harness, rerenderPanel(harness), '全部撤销').props.onClick()
  await settle()
  await settle()
  const all = seen.filter((entry) => entry.url === '/operator/revoke').at(-1)
  assert.equal(all.body, JSON.stringify({}))
  assert.match(harness.textOf(rerenderPanel(harness)), /已撤销全部接入设备。/)
})

test('a refused operator key renders an inline message instead of throwing', async () => {
  const harness = load((url) => (url === '/operator/devices' ? fail(403, 'operator/key-required') : ok({ workspaces: [] })))
  renderPanelOnce(harness)
  await settle()
  keyInput(harness, rerenderPanel(harness)).props.onChange({ target: { value: 'wrong' } })
  buttonWith(harness, rerenderPanel(harness), '查看设备').props.onClick()
  await settle()
  assert.match(harness.textOf(rerenderPanel(harness)), /操作者密钥不正确。/)
})

test('a transport failure and a non-JSON body both render inline messages', async () => {
  const down = load(() => {
    throw new Error('network down')
  })
  renderPanelOnce(down)
  await settle()
  assert.match(down.textOf(rerenderPanel(down)), /无法连接远程服务：network down/)

  const html = load(() => new Response('<!doctype html><title>Host</title>', { status: 200, headers: { 'content-type': 'text/html' } }))
  renderPanelOnce(html)
  await settle()
  assert.match(html.textOf(rerenderPanel(html)), /读取工作区失败：HTTP 200/)
})

test('an auth refusal on the workspace route names the device credential', async () => {
  const harness = load(() => fail(401, 'auth/required'))
  const text = harness.textOf(await renderPanel(harness))
  assert.match(text, /读取工作区需要先通过远程面板打开本页（设备凭据）。/)
  assert.doesNotMatch(text, /读取工作区失败/, 'a credential refusal must not read as a generic failure')
})
