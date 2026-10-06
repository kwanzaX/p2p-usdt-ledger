'use strict'
// Projects a ledger replica into MongoDB. Same guarantees as the MySQL projection:
// one multi-document transaction per block (entry + balances + cursor), so a crash
// resumes cleanly from the cursor. Requires a replica set, which transactions need;
// a single-node replica set is enough.

const { checkShape } = require('../rules')

async function migrate (db) {
  await db.collection('ledger_entries').createIndex({ ledgerKey: 1, entryId: 1 }, { unique: true })
  await db.collection('ledger_entries').createIndex({ ledgerKey: 1, idx: 1 }, { unique: true })
  await db.collection('balances').createIndex({ ledgerKey: 1, account: 1 }, { unique: true })
}

/**
 * @param {import('hypercore')} core
 * @param {import('mongodb').MongoClient} client
 * @param {import('mongodb').Db} db
 */
async function projectToMongo (core, client, db) {
  const key = core.key.toString('hex')
  const cursors = db.collection('ledger_cursor')
  const entries = db.collection('ledger_entries')
  const rejections = db.collection('ledger_rejections')
  const balances = db.collection('balances')
  await cursors.updateOne({ _id: key }, { $setOnInsert: { nextIndex: 0 } }, { upsert: true })
  let applied = 0
  let rejected = 0
  let nextIndex = 0

  for (;;) {
    const session = client.startSession()
    try {
      let done = false
      let outcome = null
      await session.withTransaction(async () => {
        outcome = null // the callback can be retried; only the committed attempt counts
        const cursor = await cursors.findOne({ _id: key }, { session })
        nextIndex = cursor.nextIndex
        if (nextIndex >= core.length) { done = true; return }
        const e = await core.get(nextIndex)
        const reason = await validate({ entries, balances, session, key, e })
        if (reason) {
          await rejections.insertOne({ ledgerKey: key, idx: nextIndex, entryId: typeof e?.id === 'string' ? e.id : null, reason }, { session })
        } else {
          await entries.insertOne({ ledgerKey: key, idx: nextIndex, entryId: e.id, type: e.type, from: e.from ?? null, to: e.to, amount: e.amount, network: e.network }, { session })
          if (e.type === 'transfer') await balances.updateOne({ ledgerKey: key, account: e.from }, { $inc: { amount: -e.amount } }, { session })
          await balances.updateOne({ ledgerKey: key, account: e.to }, { $inc: { amount: e.amount } }, { upsert: true, session })
        }
        // The cursor moves in the same transaction; this write also makes concurrent
        // projectors conflict, so one of them retries instead of both applying the block.
        await cursors.updateOne({ _id: key, nextIndex }, { $set: { nextIndex: nextIndex + 1 } }, { session })
        outcome = reason ? 'rejected' : 'applied'
      })
      if (done) break
      if (outcome === 'rejected') rejected++
      else if (outcome === 'applied') applied++
    } finally {
      await session.endSession()
    }
  }
  return { applied, rejected, nextIndex }
}

async function validate ({ entries, balances, session, key, e }) {
  const shape = checkShape(e)
  if (shape) return shape
  if (await entries.findOne({ ledgerKey: key, entryId: e.id }, { session })) return `duplicate id ${e.id}`
  if (e.type === 'transfer') {
    const row = await balances.findOne({ ledgerKey: key, account: e.from }, { session })
    if (!row || row.amount < e.amount) return `overdraft on ${e.from}`
  }
  return null
}

async function balancesFromMongo (db, core) {
  const rows = await db.collection('balances').find({ ledgerKey: core.key.toString('hex') }).sort({ account: 1 }).toArray()
  return Object.fromEntries(rows.map((r) => [r.account, r.amount]))
}

module.exports = { migrate, projectToMongo, balancesFromMongo }
