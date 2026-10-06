'use strict'
// Integration tests against real MySQL and MongoDB. They run when MYSQL_URL / MONGO_URL
// are set and are skipped otherwise, so `npm test` works on a laptop without databases.
//   MYSQL_URL=mysql://root:pw@127.0.0.1:3306/ledger
//   MONGO_URL=mongodb://127.0.0.1:27017/?replicaSet=rs0   (transactions need a replica set)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { openLedger, appendTransfer, appendDeposit, fold } = require('../src/ledger')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-ledger-'))
const USDT = (n) => Math.round(n * 1e6)

// The same history for both databases: valid entries, a replayed id and an overdraft.
async function buildLedger () {
  const core = await openLedger(tmp())
  await appendDeposit(core, { id: 'dep-1', to: 'treasury', amount: USDT(100) })
  await appendTransfer(core, { id: 'pay-1', from: 'treasury', to: 'a', amount: USDT(60) })
  await appendTransfer(core, { id: 'pay-1', from: 'treasury', to: 'a', amount: USDT(1) })
  await appendTransfer(core, { id: 'pay-2', from: 'treasury', to: 'b', amount: USDT(50) })
  await appendTransfer(core, { id: 'pay-3', from: 'a', to: 'b', amount: USDT(10) })
  return core
}

// Wraps a core so get() fails once at a given index: a crash in the middle of a projection.
function crashingAt (core, index) {
  let crashed = false
  return new Proxy(core, {
    get (target, prop) {
      if (prop === 'get') {
        return async (i) => {
          if (i === index && !crashed) { crashed = true; throw new Error('simulated crash') }
          return target.get(i)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

test('MySQL projection matches fold(), resumes after a crash and is idempotent', { skip: !process.env.MYSQL_URL && 'MYSQL_URL not set' }, async (t) => {
  const mysql = require('mysql2/promise')
  const { migrate, projectToMysql, balancesFromMysql } = require('../src/projections/mysql')
  const pool = mysql.createPool({ uri: process.env.MYSQL_URL, connectionLimit: 4 })
  const core = await buildLedger()
  t.after(async () => { await pool.end(); await core.close() })
  await migrate(pool)

  await assert.rejects(projectToMysql(crashingAt(core, 3), pool), /simulated crash/)
  const resumed = await projectToMysql(core, pool) // picks up at block 3, nothing applied twice
  assert.equal(resumed.applied + resumed.rejected, 2)

  const { balances, rejected } = await fold(core)
  assert.deepEqual(await balancesFromMysql(pool, core), balances)
  const [rej] = await pool.query('SELECT reason FROM ledger_rejections WHERE ledger_key = ? ORDER BY idx', [core.key.toString('hex')])
  assert.deepEqual(rej.map((r) => r.reason), rejected.map((r) => r.reason))

  assert.deepEqual(await projectToMysql(core, pool), { applied: 0, rejected: 0, nextIndex: core.length })

  await appendTransfer(core, { id: 'pay-4', from: 'b', to: 'treasury', amount: USDT(5) })
  await projectToMysql(core, pool)
  assert.deepEqual(await balancesFromMysql(pool, core), (await fold(core)).balances)
})

test('MongoDB projection matches fold(), resumes after a crash and is idempotent', { skip: !process.env.MONGO_URL && 'MONGO_URL not set' }, async (t) => {
  const { MongoClient } = require('mongodb')
  const { migrate, projectToMongo, balancesFromMongo } = require('../src/projections/mongo')
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db('ledger_test_' + Date.now())
  const core = await buildLedger()
  t.after(async () => { await db.dropDatabase(); await client.close(); await core.close() })
  await migrate(db)

  await assert.rejects(projectToMongo(crashingAt(core, 3), client, db), /simulated crash/)
  const resumed = await projectToMongo(core, client, db)
  assert.equal(resumed.applied + resumed.rejected, 2)

  const { balances, rejected } = await fold(core)
  assert.deepEqual(await balancesFromMongo(db, core), balances)
  const rej = await db.collection('ledger_rejections').find({ ledgerKey: core.key.toString('hex') }).sort({ idx: 1 }).toArray()
  assert.deepEqual(rej.map((r) => r.reason), rejected.map((r) => r.reason))

  assert.deepEqual(await projectToMongo(core, client, db), { applied: 0, rejected: 0, nextIndex: core.length })

  await appendTransfer(core, { id: 'pay-4', from: 'b', to: 'treasury', amount: USDT(5) })
  await projectToMongo(core, client, db)
  assert.deepEqual(await balancesFromMongo(db, core), (await fold(core)).balances)
})
