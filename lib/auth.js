import { createHash, randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto'

/** Algorithm label for stored device-token hashes. */
const TOKEN_HASH = 'sha256'
/** Digits and letters used by pairing codes; no look-alike pairs. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Hash a pairing secret with scrypt so a leaked state file does not reveal it.
 * @param secret - The random pairing secret generated with the code.
 * @returns Salted scrypt digest as a hex string.
 */
export function hashSecret(secret) {
  const salt = randomBytes(16)
  return `scrypt:${salt.toString('hex')}:${scryptSync(secret, salt, 32).toString('hex')}`
}

/**
 * Verify a pairing secret against a stored scrypt digest in constant time.
 * @param secret - Secret supplied by the pairing client.
 * @param stored - Value previously produced by {@link hashSecret}.
 * @returns True only for the matching secret.
 */
export function verifySecret(secret, stored) {
  const parts = String(stored).split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(secret, salt, expected.byteLength)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

/**
 * Hash an issued access token for storage. The token itself is never persisted.
 * @param token - Bearer token handed to one paired device.
 * @returns Hex SHA-256 digest.
 */
export function hashToken(token) {
  return createHash(TOKEN_HASH).update(token).digest('hex')
}

/** Generate one human-typable pairing code. */
function randomCode() {
  const bytes = randomBytes(8)
  let out = ''
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * Pairing-code registry and device roster.
 *
 * One pending pairing exists at a time. A successful pair consumes it and issues
 * a device token; the caller stores only the token hash. Every mutation emits
 * through `persist` so the owner decides where state lands.
 */
export class PairingRegistry {
  /** @param persist - Receives the serializable device roster after each change. */
  constructor(persist = async () => {}) {
    this.persist = persist
    this.devices = new Map()
    this.pending = undefined
    this.failures = []
  }

  /**
   * Adopt a previously stored roster.
   * @param state - Parsed state file contents, or undefined for a fresh start.
   */
  restore(state) {
    this.devices = new Map()
    for (const device of state?.devices ?? []) {
      if (typeof device?.id === 'string' && typeof device?.tokenHash === 'string') this.devices.set(device.id, device)
    }
  }

  /** Serializable roster written by `persist`. */
  snapshot() {
    return { version: 1, devices: [...this.devices.values()] }
  }

  /**
   * Insert one device whose plaintext token the caller already holds.
   * @param deviceName - Operator-visible name.
   * @param token - Plaintext bearer token to authorize.
   * @param tokenDays - Lifetime in days.
   * @param now - Injectable clock.
   * @returns The stored device row without its hash.
   */
  seed(deviceName, token, tokenDays, now = Date.now()) {
    const device = {
      id: randomUUID(),
      name: deviceName,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + tokenDays * 86_400_000,
      lastSeenAt: undefined,
    }
    this.devices.set(device.id, device)
    return device
  }

  /**
   * Issue a device token without a pairing exchange.
   *
   * Used when access is granted by the network itself: the caller is admitted
   * immediately but still appears in the roster, so the operator can revoke it.
   *
   * @param deviceName - Operator-visible name, normally derived from the peer address.
   * @param tokenDays - Lifetime in days.
   * @param now - Injectable clock.
   * @returns The plaintext token and its stored row.
   */
  async issueDevice(deviceName, tokenDays, now = Date.now()) {
    const token = randomBytes(32).toString('base64url')
    const device = {
      id: randomUUID(),
      name: typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim().slice(0, 64) : 'auto-device',
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + tokenDays * 86_400_000,
      lastSeenAt: undefined,
    }
    this.devices.set(device.id, device)
    await this.persist(this.snapshot())
    return { token, device }
  }

  /**
   * Replace the pending pairing code, invalidating any earlier one.
   * @param ttlSeconds - How long the code stays usable.
   * @param now - Injectable clock for tests.
   * @returns The plaintext code and secret to render in the pairing QR.
   */
  issueCode(ttlSeconds, now = Date.now()) {
    const code = randomCode()
    const secret = randomBytes(24).toString('base64url')
    this.pending = { code, secret, secretHash: hashSecret(secret), expiresAt: now + ttlSeconds * 1000 }
    return { code, secret, expiresAt: this.pending.expiresAt }
  }

  /**
   * The current pending code and secret, or undefined when none is live.
   * @returns Pairing material for the desktop operator page.
   */
  currentCode() {
    if (this.pending === undefined) return undefined
    return { code: this.pending.code, secret: this.pending.secret, expiresAt: this.pending.expiresAt }
  }

  /**
   * Whether a usable pairing code exists.
   * @param now - Injectable clock for tests.
   */
  hasLiveCode(now = Date.now()) {
    return this.pending !== undefined && this.pending.expiresAt > now
  }

  /** Drop the pending code, for example when the operator revokes access. */
  clearCode() {
    this.pending = undefined
  }

  /**
   * Rate-limit guard: admit at most ten pairing attempts per rolling minute.
   * Records the attempt so a client cannot probe the code faster than the limit.
   * @param now - Injectable clock for tests.
   * @returns True when this attempt may be evaluated against the pending code.
   */
  admitAttempt(now = Date.now()) {
    this.failures = this.failures.filter((at) => now - at < 60_000)
    if (this.failures.length >= 10) return false
    this.failures.push(now)
    return true
  }

  /**
   * Exchange a valid code and secret for a device token.
   * @param code - Code displayed by the Host.
   * @param secret - Secret carried by the pairing QR.
   * @param deviceName - Operator-visible name for the paired device.
   * @param tokenDays - Token lifetime in days.
   * @param now - Injectable clock for tests.
   * @returns The plaintext token and its device row, or undefined when refused.
   */
  async pair(code, secret, deviceName, tokenDays, now = Date.now()) {
    const pending = this.pending
    if (pending === undefined || pending.expiresAt <= now) return undefined
    if (typeof code !== 'string' || code.toUpperCase() !== pending.code) {
      this.failures.push(now)
      return undefined
    }
    if (typeof secret !== 'string' || !verifySecret(secret, pending.secretHash)) {
      this.failures.push(now)
      return undefined
    }
    const token = randomBytes(32).toString('base64url')
    const device = {
      id: randomUUID(),
      name: typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim().slice(0, 64) : 'device',
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + tokenDays * 86_400_000,
      lastSeenAt: undefined,
    }
    this.devices.set(device.id, device)
    this.pending = undefined
    await this.persist(this.snapshot())
    return { token, device }
  }

  /**
   * Resolve a bearer token to a live device, refreshing its last-seen stamp.
   * @param token - Bearer token from the request.
   * @param now - Injectable clock for tests.
   * @returns The matching device, or undefined when unknown or expired.
   */
  async authenticate(token, now = Date.now()) {
    if (typeof token !== 'string' || token === '') return undefined
    const digest = hashToken(token)
    for (const device of this.devices.values()) {
      if (device.tokenHash !== digest) continue
      if (device.expiresAt <= now) return undefined
      device.lastSeenAt = now
      return device
    }
    return undefined
  }

  /**
   * Revoke one device or every device.
   * @param deviceId - Device to revoke; omitted revokes all of them.
   * @returns How many devices were removed.
   */
  async revoke(deviceId) {
    let removed = 0
    if (deviceId === undefined) {
      removed = this.devices.size
      this.devices.clear()
    } else if (this.devices.delete(deviceId)) {
      removed = 1
    }
    if (removed > 0) await this.persist(this.snapshot())
    return removed
  }

  /** Operator-visible roster without token hashes. */
  roster() {
    return [...this.devices.values()].map(({ tokenHash, ...rest }) => ({ ...rest, tokenHash: undefined }))
  }
}
