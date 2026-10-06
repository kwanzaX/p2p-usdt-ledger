'use strict'
// Projects a ledger replica into MySQL so the rest of a backend can query balances with SQL.
//
// Each block is applied in its own transaction together with the cursor that records
// how far the projection got. A crash at any point leaves the database at a clean block
// boundary, and the next run resumes from the cursor: no block is applied twice or skipped.
// Rejected entries are stored with their reason, so the projection matches fold() exactly.

const { checkShape } = require('../rules')

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ledger_cursor (
     ledger_key CHAR(64) PRIMARY KEY,
     next_index BIGINT UNSIGNED NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
     ledger_key CHAR(64) NOT NULL,
     idx BIGINT UNSIGNED NOT NULL,
     entry_id VARCHAR(128) NOT NULL,
     type ENUM('deposit','transfer') NOT NULL,
     from_account VARCHAR(128) NULL,
     to_account VARCHAR(128) NOT NULL,
     amount BIGINT UNSIGNED NOT NULL,
     network VARCHAR(16) NOT NULL,
     PRIMARY KEY (ledger_key, idx),
     UNIQUE KEY uniq_entry (ledger_key, entry_id)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS ledger_rejections (
     ledger_key CHAR(64) NOT NULL,
     idx BIGINT UNSIGNED NOT NULL,
     entry_id VARCHAR(128) NULL,
     reason VARCHAR(255) NOT NULL,
     PRIMARY KEY (ledger_key, idx)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS balances (
     ledger_key CHAR(64) NOT NULL,
     account VARCHAR(128) NOT NULL,
     amount BIGINT NOT NULL,
     PRIMARY KEY (ledger_key, account)
   ) ENGINE=InnoDB`
]

async function migrate (pool) {
  for (const sql of SCHEMA) await pool.query(sql)
}

/**
 * Applies every block from the stored cursor up to core.length.
 * @param {import('hypercore')} core
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{ applied: number, rejected: number, nextIndex: number }>}
 */
async function projectToMysql (core, pool) {
  const key = core.key.toString('hex')
  await pool.query('INSERT IGNORE INTO ledger_cursor (ledger_key, next_index) VALUES (?, 0)', [key])
  let applied = 0
  let rejected = 0
  let nextIndex = 0

  for (;;) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      // Lock the cursor row: two projectors on the same ledger serialize here instead of racing.
      const [[cursor]] = await conn.query('SELECT next_index FROM ledger_cursor WHERE ledger_key = ? FOR UPDATE', [key])
      nextIndex = Number(cursor.next_index)
      if (nextIndex >= core.length) {
        await conn.rollback()
        break
      }
      const e = await core.get(nextIndex)
      const reason = await validate(conn, key, e)
      if (reason) {
        await conn.query('INSERT INTO ledger_rejections (ledger_key, idx, entry_id, reason) VALUES (?, ?, ?, ?)',
          [key, nextIndex, typeof e?.id === 'string' ? e.id : null, reason])
        rejected++
      } else {
        await conn.query(
          'INSERT INTO ledger_entries (ledger_key, idx, entry_id, type, from_account, to_account, amount, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [key, nextIndex, e.id, e.type, e.from ?? null, e.to, e.amount, e.network])
        if (e.type === 'transfer') {
          await conn.query('UPDATE balances SET amount = amount - ? WHERE ledger_key = ? AND account = ?', [e.amount, key, e.from])
        }
        await conn.query(
          'INSERT INTO balances (ledger_key, account, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)',
          [key, e.to, e.amount])
        applied++
      }
      await conn.query('UPDATE ledger_cursor SET next_index = ? WHERE ledger_key = ?', [nextIndex + 1, key])
      await conn.commit()
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  }
  return { applied, rejected, nextIndex }
}

async function validate (conn, key, e) {
  const shape = checkShape(e)
  if (shape) return shape
  const [[dup]] = await conn.query('SELECT 1 AS x FROM ledger_entries WHERE ledger_key = ? AND entry_id = ?', [key, e.id])
  if (dup) return `duplicate id ${e.id}`
  if (e.type === 'transfer') {
    const [[row]] = await conn.query('SELECT amount FROM balances WHERE ledger_key = ? AND account = ? FOR UPDATE', [key, e.from])
    if (!row || Number(row.amount) < e.amount) return `overdraft on ${e.from}`
  }
  return null
}

async function balancesFromMysql (pool, core) {
  const [rows] = await pool.query('SELECT account, amount FROM balances WHERE ledger_key = ? ORDER BY account', [core.key.toString('hex')])
  return Object.fromEntries(rows.map((r) => [r.account, Number(r.amount)]))
}

module.exports = { migrate, projectToMysql, balancesFromMysql }
