'use strict'
// Peer discovery and replication. Peers find each other on the HyperDHT by the core's
// discovery key (a hash of the public key, so the key itself is never announced) and
// every connection is end-to-end encrypted with Noise before Hypercore replicates on it.

const Hyperswarm = require('hyperswarm')

/**
 * Joins the swarm for one ledger and replicates it with every peer that connects.
 * The writer announces (server); readers look it up (client). Both can serve blocks
 * they already hold, so readers also help other readers.
 */
async function shareLedger (core, { bootstrap, announce = core.writable } = {}) {
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
  const connections = new Set()
  swarm.on('connection', (conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => {}) // a dropped peer is normal; replication resumes with the next one
    core.replicate(conn)
  })
  const discovery = swarm.join(core.discoveryKey, { server: announce, client: true })
  await discovery.flushed()
  return {
    swarm,
    peers: () => connections.size,
    async close () {
      await swarm.leave(core.discoveryKey)
      await swarm.destroy()
    }
  }
}

/** Waits until a replica has at least `length` blocks, or fails after `timeoutMs`. */
async function waitForLength (core, length, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (core.length < length) {
    if (Date.now() > deadline) throw new Error(`timed out at ${core.length}/${length} blocks`)
    await core.update({ wait: true }).catch(() => {})
    if (core.length < length) await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

module.exports = { shareLedger, waitForLength }
