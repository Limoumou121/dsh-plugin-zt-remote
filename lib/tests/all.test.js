/**
 * Single-process test entry.
 *
 * `node --test <dir>` spawns a child per file, which the sandbox forbids, so the
 * suite is imported into one process instead.
 */
import './auth.test.js'
import './net.test.js'
import './projection.test.js'
import './remote.test.js'
import './proxy.test.js'
import './query-target.test.js'
import './upgrade-handler.test.js'
import './approvals.test.js'
import './server.test.js'
import './client.test.js'
