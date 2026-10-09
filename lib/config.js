/**
 * Config declaration and defaults.
 *
 * The Host validates a plugin `Config` through Standard Schema
 * (`Config['~standard'].validate`), which Cordis calls during activation. This
 * module implements that interface directly instead of importing a schema
 * library: the plugin runs from a workspace directory that has no
 * `node_modules`, so importing a Harness runtime package by name cannot resolve
 * to the Host's own copy. Keeping the dependency list empty is what makes the
 * plugin loadable from a `link:` install.
 */

/** Field kinds the plugin accepts, each with its own parse and fallback. */
const KINDS = {
  boolean: {
    parse: (raw) => (typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, message: 'expected a boolean' }),
    fallback: () => false,
  },
  string: {
    parse: (raw) => (typeof raw === 'string' ? { ok: true, value: raw } : { ok: false, message: 'expected a string' }),
    fallback: () => '',
  },
  port: {
    parse: (raw) =>
      Number.isSafeInteger(raw) && raw >= 1 && raw <= 65535
        ? { ok: true, value: raw }
        : { ok: false, message: 'expected an integer from 1 through 65535' },
    fallback: () => 1,
  },
  counter: {
    parse: (raw) => (Number.isSafeInteger(raw) && raw >= 1 ? { ok: true, value: raw } : { ok: false, message: 'expected a positive integer' }),
    fallback: () => 1,
  },
  size: {
    parse: (raw) =>
      Number.isSafeInteger(raw) && raw >= 1024 && raw <= 8 * 1024 * 1024
        ? { ok: true, value: raw }
        : { ok: false, message: 'expected an integer from 1024 through 8388608' },
    fallback: () => 1024,
  },
}

/** Field declarations, in the order a validation report lists them. */
const FIELDS = {
  enabled: { kind: 'boolean', fallback: true, description: 'Serve the remote surface while this plugin is loaded.' },
  listenAddress: {
    kind: 'string',
    fallback: '',
    description: 'IPv4 address to bind. Empty selects the ZeroTier interface automatically.',
  },
  listenPort: { kind: 'port', fallback: 8790, description: 'TCP port for the remote surface.' },
  interfaceHint: {
    kind: 'string',
    fallback: 'zerotier',
    description: 'Case-insensitive interface-name substring used to auto-detect the bind address.',
  },
  pairCodeTtlSeconds: {
    kind: 'counter',
    fallback: 600,
    min: 30,
    max: 3600,
    description: 'Lifetime of one pairing code, in seconds.',
  },
  deviceTokenDays: { kind: 'counter', fallback: 30, min: 1, max: 365, description: 'Lifetime of one issued device token, in days.' },
  bodyLimitBytes: { kind: 'size', fallback: 1024 * 1024, description: 'Maximum request body size, in bytes.' },
  historyPageLimit: {
    kind: 'counter',
    fallback: 60,
    min: 1,
    max: 200,
    description: 'Default messages returned per history page.',
  },
  stateDir: {
    kind: 'string',
    fallback: '',
    description: 'Directory holding paired devices. Empty uses $DSH_HOME/plugin-data/dsh-plugin-zt-remote.',
  },
  webui: {
    kind: 'boolean',
    fallback: true,
    description: 'Proxy the official Web UI from the Host loopback listener so a remote browser gets the real interface.',
  },
  autoAccess: {
    kind: 'boolean',
    fallback: true,
    description:
      'Open the Web UI for any peer that can reach the listener, without a pairing step, the way the loopback URL works on this machine. The ZeroTier network is then the only boundary, so keep its membership restricted.',
  },
  hostBase: {
    kind: 'string',
    fallback: 'http://127.0.0.1:19387',
    description: 'Loopback origin of the Host Web UI the proxy forwards to.',
  },
  webuiPrefix: {
    kind: 'string',
    fallback: '/ui',
    description: 'Path prefix the proxy serves the official Web UI under.',
  },
}

/**
 * Validate one raw value against its field declaration.
 * @param field - Field declaration from `FIELDS`.
 * @param raw - Value supplied by the profile's cordis.patch.yml.
 * @returns The parsed value, or an issue naming the expectation.
 */
function parseField(field, raw) {
  const parsed = KINDS[field.kind].parse(raw)
  if (!parsed.ok) return { issue: parsed.message }
  if (field.min !== undefined && (parsed.value < field.min || parsed.value > field.max)) {
    return { issue: `expected ${field.min} through ${field.max}` }
  }
  return { value: parsed.value }
}

/**
 * Apply the documented default for an absent field.
 * @param field - Field declaration from `FIELDS`.
 * @returns The default value for this field.
 */
function defaultField(field) {
  return field.fallback ?? KINDS[field.kind].fallback()
}

/**
 * Standard Schema validator for this plugin's Config.
 *
 * `validate` never throws for bad input: it returns issues, which Cordis turns
 * into a load-time failure. A typo in cordis.patch.yml therefore fails loudly
 * instead of silently falling back to defaults.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-zt-remote',
    /**
     * Validate one raw config object.
     * @param raw - Config value from the profile layer.
     * @returns `{ value }` on success, or `{ issues }` listing every bad field.
     */
    validate(raw) {
      if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
        return { issues: [{ message: 'expected an object', path: [] }] }
      }
      const supplied = raw ?? {}
      const issues = []
      const value = {}
      for (const [key, field] of Object.entries(FIELDS)) {
        if (supplied[key] === undefined) {
          value[key] = defaultField(field)
          continue
        }
        const parsed = parseField(field, supplied[key])
        if (parsed.issue !== undefined) issues.push({ message: parsed.issue, path: [key] })
        else value[key] = parsed.value
      }
      for (const key of Object.keys(supplied)) {
        if (!(key in FIELDS)) issues.push({ message: 'unknown field', path: [key] })
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}
