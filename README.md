# p2p-usdt-ledger

A USDT payout ledger that replicates peer to peer, with no central server. Built on [Hypercore](https://github.com/holepunchto/hypercore) and [Hyperswarm](https://github.com/holepunchto/hyperswarm).

The writer appends deposits and transfers to an append-only log. Readers find the writer (or any other reader) on the HyperDHT, replicate the log over an encrypted connection, and rebuild the balances themselves.

## Why it is built this way

- **Integrity comes from the log, not the peer.** Every block is covered by a Merkle tree signed with the writer's key. A reader can replicate from a stranger and still get exactly what the writer signed. Only the public key is shared; peers announce a *discovery key* derived from it, so the key itself never goes on the DHT.
- **Validity is checked by every reader.** A signed entry can still be wrong: a bug, a replayed id, an overdraft. `fold()` applies the business rules on the reader side and reports what it rejects, instead of trusting the writer's code.
- **Money is integers.** Amounts are micro-units (USDT has 6 decimals), so no floating point touches a balance.
- **An invariant guards the fold.** Money only enters through deposits, so the sum of balances must equal deposits applied, or the fold throws.
- **Readers help readers.** Every peer serves the blocks it holds, so the writer does not have to stay online for new readers to catch up.

## Install

```
npm install p2p-usdt-ledger
# for the projections, add the driver you use:
npm install mysql2   # or: npm install mongodb
```

## Use

```js
const { openLedger, appendDeposit, appendTransfer, fold } = require('./src/ledger')
const { shareLedger, waitForLength } = require('./src/swarm')

// Writer
const ledger = await openLedger('./writer-data')
await appendDeposit(ledger, { id: 'dep-1', to: 'treasury', amount: 100_000000, txHash: '0x…' })
await appendTransfer(ledger, { id: 'pay-1', from: 'treasury', to: 'partner-a', amount: 40_000000 })
await shareLedger(ledger)
console.log(ledger.key.toString('hex')) // give this public key to readers

// Reader, anywhere
const replica = await openLedger('./reader-data', Buffer.from(publicKeyHex, 'hex'))
await shareLedger(replica)
await waitForLength(replica, 2)
console.log(await fold(replica)) // { balances: { treasury: 60000000, 'partner-a': 40000000 }, rejected: [], ... }
```

## Projections to MySQL and MongoDB

The rest of a backend usually wants SQL or document queries, not a log. `src/projections/` keeps balances in **MySQL** or **MongoDB** in step with any replica:

- **One transaction per block**: the entry, the balance changes and the cursor that records progress commit together. A crash leaves the database at a clean block boundary and the next run resumes from the cursor, so no block is applied twice or skipped.
- **Same rules as `fold()`**: shape checks come from one shared module (`src/rules.js`); duplicate ids are caught with a unique index, overdrafts with a locked balance read (`SELECT … FOR UPDATE` in MySQL). Rejected entries are stored with their reason.
- **Safe to run twice**: in MySQL the cursor row is locked, so two projectors serialize; in MongoDB both write the cursor in their transaction, so one conflicts and retries.
- **Integer money**: balances are `BIGINT` micro-units in MySQL and integers in MongoDB.

```js
const { migrate, projectToMysql } = require('./src/projections/mysql')
await migrate(pool)
await projectToMysql(replica, pool) // call again whenever the replica grows
```

MongoDB needs a replica set for transactions; a single-node one is enough.

## Tests

```
npm install
npm test
# with databases (otherwise those two tests are skipped):
MYSQL_URL=mysql://root:pw@127.0.0.1:3306/ledger \
MONGO_URL="mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true" npm test
```

The MySQL and MongoDB tests run against real servers: they project a history with a replayed id and an overdraft, crash the projection halfway, resume it, check it matches `fold()` exactly, re-run it to prove nothing is applied twice, then append and project again.

The P2P tests start a local HyperDHT testnet and run real peers against it, with no internet needed:

- a reader discovers the writer, replicates, rebuilds identical balances, and keeps receiving new blocks live;
- a replica cannot append (only the secret key can);
- signed but invalid entries (replayed id, overdraft) are rejected by the reader's rules;
- malformed transfers (fractional amounts, unknown network, self-transfer) never reach the log.

## Limits

Single writer. Multi-writer (several services appending) would use Autobase on top of Hypercore, with a deterministic view built from all writers' logs.
