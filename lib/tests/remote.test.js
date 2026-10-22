import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspacesOf, createCaller, createOperatorPeer, readHistory, readWorkspaces } from '../remote.js'

test('the operator peer is an owner scope with a liveness signal', async () => {
  const ctx = {}
  const peer = createOperatorPeer(ctx, 'peer-1')
  assert.equal(peer.id, 'peer-1')
  assert.equal(peer.ctx, ctx)
  assert.deepEqual(peer.principal, { kind: 'owner' })
  assert.equal(peer.interactions, 'answer')
  assert.equal(peer.signal.aborted, false)
  await peer.dispose()
  assert.equal(peer.signal.aborted, true, 'disposing the peer ends its streams')
})

test('every unary call names the caller peer', async () => {
  const seen = []
  const peer = createOperatorPeer({}, 'peer-code')
  const caller = createCaller(
    {
      async invoke(request) {
        seen.push(request)
        return {}
      },
    },
    peer,
  )
  await caller.listSessions()
  await caller.createWorkspace('D:\\proj')
  for (const request of seen) assert.equal(request.peer, peer, 'the Gateway requires request.peer')
})

test('every stream call names the caller peer', async () => {
  const seen = []
  const peer = createOperatorPeer({}, 'peer-stream')
  const gateway = {
    async stream(request) {
      seen.push(request)
      /* Each reader stops at its opening frame, so yield the one it looks for. */
      const frame = request.namespace === 'workspace' ? { type: 'baseline', value: { items: [] } } : { type: 'snapshot', records: [] }
      return (async function* opening() {
        yield frame
      })()
    },
  }
  await readWorkspaces(gateway, undefined, peer)
  await readHistory(gateway, 'session-1', undefined, peer)
  assert.equal(seen.length, 2)
  for (const request of seen) assert.equal(request.peer, peer)
})


test('the workspace baseline array is named items', () => {
  const view = { workspaceId: 'w1', path: 'F:\\p', title: 't', sessionIds: ['s1'] }
  assert.deepEqual(workspacesOf({ items: [view], archivedSessionIds: [], pinnedSessionIds: [] }), [view])
})

test('a renamed or wrapped baseline degrades to an empty roster instead of throwing', () => {
  assert.deepEqual(workspacesOf({ workspaces: [1] }), [1])
  assert.deepEqual(workspacesOf([1, 2]), [1, 2])
  assert.deepEqual(workspacesOf(undefined), [])
  assert.deepEqual(workspacesOf({}), [])
})

test('session/list is called with the wire field name the descriptor declares', async () => {
  const seen = []
  const caller = createCaller({
    async invoke(request) {
      seen.push(request)
      /* The real result names its array `items`. */
      return { items: [] }
    },
  })
  const first = await caller.listSessions()
  const second = await caller.listSessions('cursor-1')
  assert.deepEqual(first, { items: [] })
  assert.deepEqual(second, { items: [] })
  assert.deepEqual(seen[0].args, { _request: {} })
  assert.deepEqual(seen[1].args, { _request: { cursor: 'cursor-1' } })
  assert.equal(seen[0].namespace, 'session')
  assert.equal(seen[0].method, 'list')
})

test('the remaining endpoints use the request field the descriptors declare', async () => {
  const seen = []
  const caller = createCaller({
    async invoke(request) {
      seen.push(`${request.namespace}/${request.method}:${Object.keys(request.args).join(',')}`)
      return {}
    },
  })
  await caller.createWorkspace('F:\\p')
  await caller.createSession({ workspaceId: 'w1' })
  await caller.pageSession({ address: { kind: 'session', sessionId: 's1' }, throughSeq: 1 })
  await caller.cancelSession('s1')
  await caller.renameSession('s1', 'title')
  assert.deepEqual(seen, [
    'workspace/create:request',
    'session/create:request',
    'session/page:request',
    'session/cancel:request',
    'session/rename:request',
  ])
})

test('a history read omits assistantStream, which the schema only accepts as true', async () => {
  const seen = []
  const gateway = {
    async stream(request) {
      seen.push(request.args.request)
      return (async function* snapshot() {
        yield { type: 'snapshot', records: [{ seq: 1, event: { type: 'user/message', data: { content: [], source: { kind: 'user' } } } }] }
      })()
    },
  }
  const records = await readHistory(gateway, 'session-1')
  assert.deepEqual(records, [{ seq: 1, event: { type: 'user/message', data: { content: [], source: { kind: 'user' } } } }])
  assert.deepEqual(seen[0], { address: { kind: 'session', sessionId: 'session-1' } })
  assert.equal('assistantStream' in seen[0], false)
})
