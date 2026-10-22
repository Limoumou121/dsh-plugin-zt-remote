/**
 * In-process caller for the Remote methods the Web UI itself calls.
 *
 * The plugin runs inside the Harness Host, so it reaches the same services the
 * browser reaches over `/api` by invoking the Typert Gateway directly. Omitting
 * the gateway request's `peer` selects the in-process carrier, which answers as
 * the operator, exactly like an authenticated browser request. Nothing here
 * constructs session events or workspace records by hand: every mutation goes
 * through the owning controller, so remote changes and desktop changes are the
 * same change.
 *
 * Wire contracts below mirror the generated descriptors of
 * `@deepseek-ai/dsh-api-workspace-controller` and
 * `@deepseek-ai/dsh-api-session-controller`; the gateway validates every call
 * against those descriptors before the business method runs.
 */

/** Endpoints this surface is allowed to reach. Anything absent is unreachable by design. */
const ENDPOINTS = {
  workspaceCreate: { namespace: 'workspace', method: 'create' },
  workspaceFollow: { namespace: 'workspace', method: 'follow' },
  sessionList: { namespace: 'session', method: 'list' },
  sessionCreate: { namespace: 'session', method: 'create' },
  sessionPage: { namespace: 'session', method: 'page' },
  sessionPrompt: { namespace: 'session', method: 'prompt' },
  sessionCancel: { namespace: 'session', method: 'cancel' },
  sessionRename: { namespace: 'session', method: 'rename' },
  sessionFollow: { namespace: 'session', method: 'follow' },
}

/**
 * Create the owner Peer that in-process Host calls speak for.
 *
 * The Gateway requires a `PeerScope` on every invocation: it reads `principal` for
 * authorisation and `signal` for liveness. A plugin running inside the Host is the
 * local user, so its peer is an owner peer with a connection-lifetime signal.
 *
 * @param ctx - Plugin context; becomes the Peer scope that owns its registrations.
 * @param id - Stable peer id, visible only to the Gateway.
 * @returns A `PeerScope`-shaped object; `dispose()` ends its streams.
 */
export function createOperatorPeer(ctx, id = 'zt-remote-operator') {
  const controller = new AbortController()
  return {
    id,
    ctx,
    principal: { kind: 'owner' },
    signal: controller.signal,
    interactions: 'answer',
    async dispose() {
      controller.abort()
    },
  }
}

/**
 * Build the caller bound to one live Typert Gateway.
 * @param gateway - `ctx.typertGateway`; the only value this module needs from the Host.
 * @param peer - Owner Peer the calls speak for; required by the Gateway contract.
 * @returns One method per allowed endpoint, each resolving to the exact wire result.
 */
export function createCaller(gateway, peer) {
  const call = (key, args, signal) => gateway.invoke({ ...ENDPOINTS[key], args, signal, peer })
  return {
    createWorkspace: (path) => call('workspaceCreate', { request: { path } }),
    /* `session/list` names its only parameter `_request` in the controller source, and the
       gateway validates wire fields against that exact name. */
    listSessions: (cursor) => call('sessionList', { _request: cursor === undefined ? {} : { cursor } }),
    createSession: (request) => call('sessionCreate', { request }),
    pageSession: (request, signal) => call('sessionPage', { request }, signal),
    promptSession: (request, signal) => call('sessionPrompt', { request }, signal),
    cancelSession: (sessionId) => call('sessionCancel', { request: { sessionId } }),
    renameSession: (sessionId, title) => call('sessionRename', { request: { sessionId, title } }),
  }
}

/**
 * Read the workspace roster from its follow stream.
 *
 * The workspace controller exposes no `list` method: the roster arrives as the
 * opening `baseline` frame of `workspace/follow`, exactly as the browser reads
 * it. The stream is closed as soon as that frame lands.
 *
 * @param gateway - `ctx.typertGateway`.
 * @param signal - Caller lifetime for the brief subscription.
 * @param peer - Owner Peer the stream speaks for; required by the Gateway contract.
 * @returns The opening baseline value.
 * @throws When the stream ends without a baseline frame.
 */
export async function readWorkspaces(gateway, signal, peer) {
  const frames = await gateway.stream({ ...ENDPOINTS.workspaceFollow, args: {}, signal, peer })
  try {
    for await (const frame of frames) {
      if (frame?.type === 'baseline') return frame.value
    }
  } finally {
    if (typeof frames?.return === 'function') await frames.return()
  }
  throw Object.assign(new Error('workspace/follow ended without a baseline'), { code: 'gateway/protocol' })
}

/**
 * Extract the workspace views from a workspace baseline value.
 * @param baseline - `WorkspaceBaseline` from the opening frame.
 * @returns The workspace views, or an empty list when the baseline carries none.
 */
export function workspacesOf(baseline) {
  /* `WorkspaceBaseline` names its array `items`; the other two arms keep a future
     rename from silently producing an empty roster again. */
  if (Array.isArray(baseline?.items)) return baseline.items
  if (Array.isArray(baseline?.workspaces)) return baseline.workspaces
  if (Array.isArray(baseline)) return baseline
  return []
}

/**
 * Follow one session log through the Gateway's in-process stream carrier.
 * @param gateway - `ctx.typertGateway`.
 * @param request - `{ address, assistantStream }` per the generated follow descriptor.
 * @param signal - Caller lifetime; aborting ends the iteration and releases the carrier.
 * @param peer - Owner Peer the stream speaks for; required by the Gateway contract.
 * @returns The frame iterable the caller must consume and dispose.
 */
export async function followSession(gateway, request, signal, peer) {
  return gateway.stream({ ...ENDPOINTS.sessionFollow, args: { request }, signal, peer })
}

/**
 * Read the conversation history from the log stream's opening snapshot.
 *
 * `session/page` needs a `throughSeq` bound to the log's current head, which a
 * caller cannot know without another round trip, and an out-of-range bound
 * answers with no records at all. The follow stream's first frame carries the
 * same history already bounded by the Host, so this reads that and closes the
 * stream instead of guessing a bound.
 *
 * `assistantStream` is omitted rather than set to false: its schema is
 * `literal(true).optional()`, so false fails boundary validation.
 *
 * @param gateway - `ctx.typertGateway`.
 * @param sessionId - Session whose history is wanted.
 * @param signal - Caller lifetime for the brief subscription.
 * @param peer - Owner Peer the stream speaks for; required by the Gateway contract.
 * @returns The snapshot records, or an empty list when the session has none.
 */
export async function readHistory(gateway, sessionId, signal, peer) {
  const frames = await gateway.stream({
    ...ENDPOINTS.sessionFollow,
    args: { request: { address: { kind: 'session', sessionId } } },
    signal,
    peer,
  })
  try {
    for await (const frame of frames) {
      if (frame?.type === 'snapshot') return frame.records ?? []
    }
  } finally {
    if (typeof frames?.return === 'function') await frames.return()
  }
  return []
}

/**
 * Translate a gateway or business failure into an HTTP status and stable code.
 * @param error - Rejection from a caller method.
 * @returns The status to send and the code the phone UI switches on.
 */
export function describeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'remote/unknown'
  if (code === 'gateway/arguments-invalid' || code === 'gateway/input-invalid') return { status: 400, code }
  if (code === 'gateway/lookup-not-found' || code === 'gateway/method-unavailable') return { status: 404, code }
  if (code === 'gateway/context-unavailable' || code === 'gateway/invocation-unavailable') return { status: 503, code }
  return { status: 500, code }
}
