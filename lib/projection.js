/**
 * Pure projection from durable session-log events to one mobile timeline entry.
 *
 * The persisted session format writes `{ type, seq, time, data }` records: the
 * kind field is named `type` and the payload sits under `data`. This was
 * verified against a real `session.v4.jsonl.zstd` log, not against a type
 * declaration.
 *
 * The phone must never invent state and must never leak orchestration detail:
 * everything it renders comes from the session log the desktop reads, folded
 * once here, and runtime-context snapshots, skill reminders and internal
 * messages are filtered out. Unknown event types fold to `undefined` instead of
 * throwing, so a Harness upgrade degrades the timeline rather than breaking the
 * surface.
 */

/** Source kinds that mean a human or the model spoke, rather than injected context. */
const VISIBLE_SOURCES = new Set(['user', 'model'])

/**
 * Extract display text from a message payload.
 * @param message - Message with a `content` part array.
 * @returns Concatenated text parts, plus how many non-text parts were skipped.
 */
export function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  let text = ''
  let attachments = 0
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') text += part.text
    else attachments += 1
  }
  return { text: text.trim(), attachments }
}

/**
 * Whether a message carries conversation rather than injected context.
 *
 * The runtime injects context snapshots, skill catalogs and time samples as
 * `user/message` with a different `source.kind`; those must not appear as things
 * the person said.
 *
 * @param data - Message event payload.
 * @returns True when the phone should show this message.
 */
export function isVisibleMessage(data) {
  return VISIBLE_SOURCES.has(data?.source?.kind)
}

/**
 * Fold one session-log record into a timeline entry.
 * @param record - One `SessionHistoryRecord` (`{ seq, event }`, where `event` is `{ type, data }`).
 * @returns A timeline entry, or undefined for records the phone does not render.
 */
export function foldRecord(record) {
  const event = record?.event
  const type = event?.type
  const seq = record?.seq ?? event?.seq
  if (typeof type !== 'string') return undefined
  const data = event?.data ?? {}

  switch (type) {
    case 'user/message': {
      if (!isVisibleMessage(data)) return undefined
      const { text, attachments } = messageText(data)
      if (text === '' && attachments === 0) return undefined
      return { seq, role: 'user', text, attachments }
    }
    case 'assistant/message': {
      const { text, attachments } = messageText(data.message)
      if (text === '' && attachments === 0) return undefined
      return { seq, role: 'assistant', text, attachments }
    }
    case 'system/message':
      return undefined
    case 'tool/call':
      return { seq, role: 'tool', name: data.name ?? 'tool', text: '' }
    case 'tool/result':
      return { seq, role: 'tool-result', name: data.name ?? 'tool', text: '', failed: data.status !== undefined && data.status !== 'ok' }
    case 'turn/end':
      return { seq, role: 'turn-end', failed: data.failure !== undefined }
    case 'error':
      return { seq, role: 'error', text: typeof data.message === 'string' ? data.message : 'error' }
    case 'compaction/end':
      return { seq, role: 'notice', text: 'context compacted' }
    default:
      return undefined
  }
}

/**
 * Fold a page of records, dropping every record the phone does not render.
 * @param records - `SessionPage.records` in chronological order.
 * @returns Timeline entries in the same order.
 */
export function projectHistory(records) {
  const out = []
  for (const record of records ?? []) {
    const entry = foldRecord(record)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/**
 * Find the title the session log already carries.
 * @param records - Page records.
 * @returns The last `session/title` value, or undefined.
 */
export function titleOf(records) {
  let title
  for (const record of records ?? []) {
    const event = record?.event
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title
  }
  return title
}

/**
 * Derive a display title from history when the log carries none.
 * @param records - Page records.
 * @returns First visible user message text clipped to 60 characters, or undefined.
 */
export function deriveTitle(records) {
  for (const record of records ?? []) {
    const event = record?.event
    if (event?.type !== 'user/message' || !isVisibleMessage(event.data)) continue
    const { text } = messageText(event.data)
    if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text
  }
  return undefined
}

/**
 * Reduce a session-list row to the fields the phone needs.
 * @param row - One item from `session.list`.
 * @returns A roster entry, or undefined when the row has no identity.
 */
export function projectSessionRow(row) {
  const sessionId = row?.sessionId ?? row?.id
  if (typeof sessionId !== 'string') return undefined
  return {
    sessionId,
    workspaceId: row?.workspaceId,
    title: row?.title,
    updatedAt: row?.updatedAt,
    running: row?.status === 'running',
    archived: row?.archived === true,
  }
}

/**
 * Reduce a workspace view to the fields the phone needs.
 * @param view - One `WorkspaceView` from the workspace baseline.
 * @returns A workspace entry, or undefined when the view has no identity.
 */
export function projectWorkspace(view) {
  const workspaceId = view?.workspaceId ?? view?.id
  if (typeof workspaceId !== 'string') return undefined
  return {
    workspaceId,
    path: view?.path,
    title: view?.title,
    sessionCount: view?.sessionIds?.length ?? view?.sessions?.length,
  }
}
