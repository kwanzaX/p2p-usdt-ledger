# p2p-usdt-ledger

A USDT payout ledger that replicates peer to peer, with no central server. Built on [Hypercore](https://github.com/holepunchto/hypercore) and [Hyperswarm](https://github.com/holepunchto/hyperswarm).

The writer appends deposits and transfers to an append-only log. Readers find the writer (or any other reader) on the HyperDHT, replicate the log over an encrypted connection, and rebuild the balances themselves.

## Why it is built this way

- **Integrity comes from the log, not the peer.** Every block is covered by a Merkle tree signed with the writer's key. A reader can replicate from a stranger and still get exactly what the writer signed. Only the public key is shared; peers announce a *discovery key* derived from it, so the key itself never goes on the DHT.
- **Validity is checked by every reader.** A signed entry can still be wrong: a bug, a replayed id, an overdraft. `fold()` applies the business rules on the reader side and reports what it rejects, instead of trusting the writer's code.
- **Money is integers.** Amounts are micro-units (USDT has 6 decimals), so no floating point touches a balance.
- **An invariant guards the fold.** Money only enters through deposits, so the sum of balances must equal deposits applied, or the fold throws.
- **Readers help readers.** Every peer serves the blocks it holds, so the writer does not have to stay online for new readers to catch up.

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

## Tests

```
npm install
npm test
```

The tests start a local HyperDHT testnet and run real peers against it, with no internet needed:

- a reader discovers the writer, replicates, rebuilds identical balances, and keeps receiving new blocks live;
- a replica cannot append (only the secret key can);
- signed but invalid entries (replayed id, overdraft) are rejected by the reader's rules;
- malformed transfers (fractional amounts, unknown network, self-transfer) never reach the log.

## Limits

Single writer. Multi-writer (several services appending) would use Autobase on top of Hypercore, with a deterministic view built from all writers' logs.
