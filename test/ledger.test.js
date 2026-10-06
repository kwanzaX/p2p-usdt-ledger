'use strict'
// Runs real peers over a local HyperDHT testnet: no internet, no central server.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createTestnet = require('hyperdht/testnet')
const { openLedger, appendTransfer, appendDeposit, fold } = require('../src/ledger')
const { shareLedger, waitForLength } = require('../src/swarm')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-ledger-'))
const USDT = (n) => Math.round(n * 1e6)

test('a reader replicates the writer\'s ledger over the DHT and rebuilds the same balances', async (t) => {
  const testnet = await createTestnet(3)
  const writer = await openLedger(tmp())
  await appendDeposit(writer, { id: 'dep-1', to: 'treasury', amount: USDT(100), txHash: '0xabc' })
  await appendTransfer(writer, { id: 'pay-1', from: 'treasury', to: 'partner-a', amount: USDT(40) })
  await appendTransfer(writer, { id: 'pay-2', from: 'treasury', to: 'partner-b', amount: USDT(25.5) })

  const reader = await openLedger(tmp(), writer.key) // only the public key is shared
  const w = await shareLedger(writer, { bootstrap: testnet.bootstrap })
  const r = await shareLedger(reader, { bootstrap: testnet.bootstrap })
  t.after(async () => {
    await r.close(); await w.close()
    await reader.close(); await writer.close()
    await testnet.destroy()
  })

  await waitForLength(reader, writer.length)
  assert.equal(reader.writable, false)
  assert.deepEqual((await fold(reader)).balances, (await fold(writer)).balances)
  assert.deepEqual((await fold(reader)).balances, { treasury: USDT(34.5), 'partner-a': USDT(40), 'partner-b': USDT(25.5) })

  // New blocks keep flowing to the live replica.
  await appendTransfer(writer, { id: 'pay-3', from: 'treasury', to: 'partner-a', amount: USDT(4.5) })
  await waitForLength(reader, writer.length)
  assert.equal((await fold(reader)).balances['partner-a'], USDT(44.5))
})

test('a replica cannot write: only the holder of the secret key can extend the log', async () => {
  const writer = await openLedger(tmp())
  const replica = await openLedger(tmp(), writer.key)
  await assert.rejects(appendTransfer(replica, { id: 'x', from: 'a', to: 'b', amount: 1 }), /read-only/)
  await replica.close(); await writer.close()
})

test('signed but invalid entries are rejected by the reader\'s own rules', async () => {
  const core = await openLedger(tmp())
  await appendDeposit(core, { id: 'dep-1', to: 'treasury', amount: USDT(10) })
  await appendTransfer(core, { id: 'pay-1', from: 'treasury', to: 'a', amount: USDT(6) })
  await appendTransfer(core, { id: 'pay-1', from: 'treasury', to: 'a', amount: USDT(1) }) // replayed id
  await appendTransfer(core, { id: 'pay-2', from: 'treasury', to: 'b', amount: USDT(5) }) // only 4 left
  const { balances, rejected } = await fold(core)
  assert.deepEqual(balances, { treasury: USDT(4), a: USDT(6) })
  assert.deepEqual(rejected.map((r) => r.reason), ['duplicate id pay-1', 'overdraft on treasury'])
  await core.close()
})

test('malformed transfers never reach the log', async () => {
  const core = await openLedger(tmp())
  await assert.rejects(appendTransfer(core, { id: 'f', from: 'a', to: 'b', amount: 1.5 }), /positive integer/)
  await assert.rejects(appendTransfer(core, { id: 'n', from: 'a', to: 'b', amount: 5, network: 'SOL' }), /unsupported network/)
  await assert.rejects(appendTransfer(core, { id: 's', from: 'a', to: 'a', amount: 5 }), /must differ/)
  assert.equal(core.length, 0)
  await core.close()
})
