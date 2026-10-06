'use strict'
// A payout ledger on a Hypercore: an append-only log that only the holder of the
// writer key can extend. Every block is covered by a signed Merkle tree, so a reader
// that replicates from any peer, trusted or not, gets exactly what the writer signed.
//
// Two layers of checking, on purpose:
//   - integrity (was this written by the key holder, unmodified?) -> Hypercore does it
//   - validity  (does this transfer make sense?)                  -> fold() does it
// A signed entry can still be wrong (a bug, a replayed id, an overdraft). Readers apply
// the business rules themselves instead of trusting the writer's code.

const Hypercore = require('hypercore')

const ASSETS = new Set(['USDT'])
const NETWORKS = new Set(['TRC-20', 'BEP-20', 'ERC-20'])

/** Opens the writer's ledger (no key) or a read-only replica (with the writer's public key). */
async function openLedger (dir, key) {
  const core = new Hypercore(dir, key, { valueEncoding: 'json' })
  await core.ready()
  return core
}

/**
 * Appends one transfer. Amounts are integers in micro-units (USDT has 6 decimals)
 * so no floating point ever touches money.
 */
async function appendTransfer (core, t) {
  if (!core.writable) throw new Error('read-only replica: only the writer key can append')
  const entry = {
    type: 'transfer',
    id: t.id,
    from: t.from,
    to: t.to,
    asset: t.asset ?? 'USDT',
    network: t.network ?? 'BEP-20',
    amount: t.amount,
    ts: t.ts ?? Date.now()
  }
  const problem = checkShape(entry)
  if (problem) throw new Error(`refusing to append: ${problem}`)
  const { length } = await core.append(entry)
  return length - 1 // index of the new block
}

/** Credits an account from outside the ledger (e.g. a confirmed on-chain deposit). */
async function appendDeposit (core, d) {
  if (!core.writable) throw new Error('read-only replica: only the writer key can append')
  const entry = { type: 'deposit', id: d.id, to: d.to, asset: 'USDT', network: d.network ?? 'BEP-20', amount: d.amount, txHash: d.txHash, ts: d.ts ?? Date.now() }
  const problem = checkShape(entry)
  if (problem) throw new Error(`refusing to append: ${problem}`)
  const { length } = await core.append(entry)
  return length - 1
}

function checkShape (e) {
  if (typeof e.id !== 'string' || !e.id) return 'id must be a non-empty string'
  if (!Number.isSafeInteger(e.amount) || e.amount <= 0) return 'amount must be a positive integer (micro-units)'
  if (!ASSETS.has(e.asset)) return `unsupported asset ${e.asset}`
  if (!NETWORKS.has(e.network)) return `unsupported network ${e.network}`
  if (typeof e.to !== 'string' || !e.to) return 'to is required'
  if (e.type === 'transfer' && (typeof e.from !== 'string' || !e.from)) return 'from is required'
  if (e.type === 'transfer' && e.from === e.to) return 'from and to must differ'
  return null
}

/**
 * Replays the log into balances. Entries that break a rule are reported, not applied:
 * duplicate ids (replays), bad shape, or transfers that would overdraw an account.
 */
async function fold (core, { upTo = core.length } = {}) {
  const balances = new Map()
  const seen = new Set()
  const rejected = []
  let deposited = 0
  for (let i = 0; i < upTo; i++) {
    const e = await core.get(i)
    const reason =
      checkShape(e) ||
      (seen.has(e.id) && `duplicate id ${e.id}`) ||
      (e.type === 'transfer' && (balances.get(e.from) ?? 0) < e.amount && `overdraft on ${e.from}`)
    if (reason) {
      rejected.push({ index: i, id: e.id, reason })
      continue
    }
    seen.add(e.id)
    if (e.type === 'deposit') deposited += e.amount
    if (e.type === 'transfer') balances.set(e.from, balances.get(e.from) - e.amount)
    balances.set(e.to, (balances.get(e.to) ?? 0) + e.amount)
  }
  // Invariant: money is only created by deposits, so the total held must equal deposits applied.
  const total = [...balances.values()].reduce((a, b) => a + b, 0)
  if (total !== deposited) throw new Error(`invariant broken: balances ${total} != deposits ${deposited}`)
  return { balances: Object.fromEntries(balances), rejected, deposited, length: upTo }
}

const toUsdt = (micros) => (micros / 1e6).toFixed(2)

module.exports = { openLedger, appendTransfer, appendDeposit, fold, toUsdt }
