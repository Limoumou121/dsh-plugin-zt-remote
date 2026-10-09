/**
 * Live approval decisions taken by a paired phone.
 *
 * The approval service dispatches `approval/request` through a waterfall and
 * awaits the result, so a listener may hold the decision open while a human
 * answers elsewhere. This module owns that hold: it registers one listener,
 * publishes each pending ask to every connected phone stream, and resolves when
 * a phone answers or when the ask's own signal aborts.
 *
 * The decision is never invented here. `allowed once` is the only grant the
 * approval vocabulary accepts, and it applies to exactly the action asked
 * about; every other path (no answer, timeout, abort, revocation) declines by
 * returning without a decision, which the service reports as `unavailable`.
 */

/** Outcomes the approval vocabulary accepts from an answerer. */
const GRANT = 'allowed-once'
const DENY = 'rejected'

/**
 * Registry of asks waiting for a phone answer.
 *
 * @param options - Publication hook and wait budget.
 * @param options.publish - Receives one `pending` or `settled` notification for each ask.
 * @param options.timeoutMs - How long one ask waits before the phone is treated as absent.
 */
export class ApprovalDesk {
  constructor({ publish, timeoutMs }) {
    this.publish = publish
    this.timeoutMs = timeoutMs
    this.pending = new Map()
  }

  /** Asks currently waiting for an answer, newest first. */
  list() {
    return [...this.pending.values()].map(({ settle, timer, ...ask }) => ask).reverse()
  }

  /**
   * Offer one ask to the phones.
   *
   * Registered on `approval/request`: returning the outcome claims the decision,
   * and returning `undefined` delegates to the next answerer.
   *
   * @param ask - Approval request from the service (agent, tool identity, reason, signal).
   * @returns The grant, the denial, or undefined when no phone answered in time.
   */
  async handle(ask) {
    if (this.pending.size > 0) return undefined
    const id = globalThis.crypto.randomUUID()
    const pending = {
      id,
      at: Date.now(),
      expiresAt: Date.now() + this.timeoutMs,
      toolName: typeof ask?.toolName === 'string' ? ask.toolName : 'tool',
      reason: typeof ask?.reason === 'string' ? ask.reason : undefined,
      sessionId: ask?.agent?.id,
      callId: ask?.callId,
    }
    const decision = new Promise((resolve) => {
      pending.settle = resolve
    })
    const timer = setTimeout(() => {
      this.finish(id, undefined)
    }, this.timeoutMs)
    this.pending.set(id, { ...pending, timer })
    this.publish({ type: 'pending', ask: { ...pending, settle: undefined, timer: undefined } })

    const outcome = await Promise.race([
      decision,
      new Promise((resolve) => {
        const signal = ask?.signal
        if (signal === undefined) return
        if (signal.aborted) {
          resolve(undefined)
          return
        }
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
      }),
    ])
    this.finish(id, undefined)
    return outcome
  }

  /**
   * Settle one pending ask from a phone answer.
   * @param id - Ask identity published to the phone.
   * @param allow - True grants this one action; false denies it.
   * @returns The accepted outcome, or undefined when the ask was already gone.
   */
  answer(id, allow) {
    const outcome = allow ? GRANT : DENY
    return this.finish(id, outcome) ? outcome : undefined
  }

  /** Settle every pending ask by delegating, for example when the plugin unloads. */
  releaseAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, undefined)
  }

  /**
   * Settle one ask and notify the phones.
   * @param id - Ask identity.
   * @param outcome - Accepted outcome, or undefined to delegate.
   * @returns True when this call settled the ask.
   */
  finish(id, outcome) {
    const pending = this.pending.get(id)
    if (pending === undefined) return false
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.settle(outcome)
    this.publish({ type: 'settled', id, outcome })
    return true
  }
}
