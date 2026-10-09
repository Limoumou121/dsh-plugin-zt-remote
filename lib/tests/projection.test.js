import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldRecord, projectHistory, deriveTitle, titleOf, projectSessionRow, projectWorkspace, isVisibleMessage } from '../projection.js'

/**
 * Real record shapes.
 *
 * These payloads were copied from a live `session.v4.jsonl.zstd` log: the kind
 * field is `type` and the payload is under `data`. Writing them by hand from a
 * type declaration is what made the first projection silently render nothing.
 */
const userMessage = (seq, text, sourceKind = 'user') => ({
  seq,
  event: {
    type: 'user/message',
    seq,
    time: 1791524127795,
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind, rpcId: 'rpc-1' }, role: 'user', id: `id-${seq}` },
    surfaceOp: 'append',
  },
})

const assistantMessage = (seq, text) => ({
  seq,
  event: {
    type: 'assistant/message',
    seq,
    time: 1791524128739,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text }], source: { kind: 'model' }, id: `a-${seq}` },
    },
  },
})

test('a user message folds from the real record shape', () => {
  assert.deepEqual(foldRecord(userMessage(9, '只回复两个字：收到')), { seq: 9, role: 'user', text: '只回复两个字：收到', attachments: 0 })
})

test('injected context is not shown as something the person said', () => {
  const injected = userMessage(10, 'Current runtime context. This snapshot supersedes…', 'time-context')
  assert.equal(isVisibleMessage(injected.event.data), false)
  assert.equal(foldRecord(injected), undefined)
  assert.equal(foldRecord(userMessage(11, '<system-reminder>…', 'system-reminder')), undefined)
})

test('an assistant message folds text out of its content parts and counts skipped ones', () => {
  assert.deepEqual(foldRecord(assistantMessage(20, '收到')), { seq: 20, role: 'assistant', text: '收到', attachments: 1 })
})

test('system messages, internal traffic, and unknown types fold away', () => {
  assert.equal(foldRecord({ seq: 8, event: { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'You are an AI agent…' }] } } } }), undefined)
  assert.equal(foldRecord({ seq: 13, event: { type: 'request/header', data: {} } }), undefined)
  assert.equal(foldRecord({ seq: 16, event: { type: 'session/title-llm-request', data: {} } }), undefined)
  assert.equal(foldRecord({ seq: 21, event: { type: 'something/new', data: {} } }), undefined)
  assert.equal(foldRecord({ seq: 22 }), undefined)
  assert.equal(foldRecord(undefined), undefined)
})

test('tool, turn, and error records fold to timeline markers', () => {
  assert.deepEqual(foldRecord({ seq: 30, event: { type: 'tool/call', data: { name: 'pwsh' } } }), { seq: 30, role: 'tool', name: 'pwsh', text: '' })
  assert.equal(foldRecord({ seq: 31, event: { type: 'tool/result', data: { name: 'pwsh', status: 'error' } } }).failed, true)
  assert.equal(foldRecord({ seq: 32, event: { type: 'turn/end', data: {} } }).role, 'turn-end')
  assert.equal(foldRecord({ seq: 33, event: { type: 'error', data: { message: 'boom' } } }).text, 'boom')
})

test('a whole page keeps only the visible conversation, in order', () => {
  const records = [
    { seq: 8, event: { type: 'system/message', data: { message: { content: [] } } } },
    userMessage(9, '请继续这个任务'),
    userMessage(10, 'Current runtime context…', 'time-context'),
    userMessage(12, 'Time sampled while preparing…', 'time-context'),
    { seq: 13, event: { type: 'request/header', data: {} } },
    assistantMessage(20, '好的'),
    { seq: 21, event: { type: 'turn/end', data: {} } },
  ]
  assert.deepEqual(
    projectHistory(records).map((entry) => `${entry.role}:${entry.text}`),
    ['user:请继续这个任务', 'assistant:好的', 'turn-end:undefined'],
  )
})

test('the title comes from the log when the log carries one', () => {
  const records = [
    userMessage(9, '只回复两个字：收到'),
    { seq: 15, event: { type: 'session/title', data: { title: '只回复两个字：收到', messageSeqs: [9], source: { kind: 'fallback' } } } },
    { seq: 19, event: { type: 'session/title', data: { title: '收到', messageSeqs: [9], source: { kind: 'provider' } } } },
  ]
  assert.equal(titleOf(records), '收到')
  assert.equal(titleOf([]), undefined)
  assert.equal(deriveTitle(records), '只回复两个字：收到')
})

test('session rows and workspace views reduce without inventing fields', () => {
  assert.deepEqual(projectSessionRow({ sessionId: 's1', title: 't', status: 'running' }), {
    sessionId: 's1',
    workspaceId: undefined,
    title: 't',
    updatedAt: undefined,
    running: true,
    archived: false,
  })
  assert.equal(projectSessionRow({}), undefined)
  assert.deepEqual(projectWorkspace({ workspaceId: 'w1', path: 'F:\\x', title: '项目', sessionIds: ['a', 'b'] }), {
    workspaceId: 'w1',
    path: 'F:\\x',
    title: '项目',
    sessionCount: 2,
  })
  assert.equal(projectWorkspace({}), undefined)
})
