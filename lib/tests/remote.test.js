import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspacesOf, createCaller, readHistory } from '../remote.js'

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
