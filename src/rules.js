'use strict'
// The business rules every consumer of the log applies, whether it folds in memory,
// projects into MySQL or into MongoDB. One definition, so the three cannot drift apart.

const ASSETS = new Set(['USDT'])
const NETWORKS = new Set(['TRC-20', 'BEP-20', 'ERC-20'])

/** Returns why an entry is malformed, or null. */
function checkShape (e) {
  if (!e || typeof e !== 'object') return 'entry must be an object'
  if (e.type !== 'deposit' && e.type !== 'transfer') return `unknown type ${e.type}`
  if (typeof e.id !== 'string' || !e.id) return 'id must be a non-empty string'
  if (!Number.isSafeInteger(e.amount) || e.amount <= 0) return 'amount must be a positive integer (micro-units)'
  if (!ASSETS.has(e.asset)) return `unsupported asset ${e.asset}`
  if (!NETWORKS.has(e.network)) return `unsupported network ${e.network}`
  if (typeof e.to !== 'string' || !e.to) return 'to is required'
  if (e.type === 'transfer' && (typeof e.from !== 'string' || !e.from)) return 'from is required'
  if (e.type === 'transfer' && e.from === e.to) return 'from and to must differ'
  return null
}

module.exports = { checkShape, ASSETS, NETWORKS }
