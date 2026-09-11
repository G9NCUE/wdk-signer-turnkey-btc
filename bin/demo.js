#!/usr/bin/env node
// Bitcoin testnet4 demo: Turnkey wallet, WDK account, transfer signed by Turnkey as a PSBT, confirmation.
// Usage: wdk-turnkey-btc-demo [--fresh-wallet] [--to tb1...] [--amount 1000] [--dry-run]
import { parseArgs } from 'node:util'
import { Turnkey } from '@turnkey/sdk-server'
import * as ecc from '@bitcoinerlab/secp256k1'
import btcmessage from '@bitcoinerlab/btcmessage'
import { networks } from 'bitcoinjs-lib'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import { TurnkeySignerBtc } from '../index.js'

const { values: opts } = parseArgs({ options: {
  'fresh-wallet': { type: 'boolean', default: false },
  to: { type: 'string' },
  amount: { type: 'string', default: process.env.DEMO_AMOUNT_SATS || '1000' },
  'dry-run': { type: 'boolean', default: false }
} })

const env = (k, fallback) => process.env[k] ?? fallback ?? (() => { throw new Error(`${k} is not set, see .env.example`) })()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let n = 0
const step = (title) => console.log(`\n${++n}. ${title}`)
const out = (k, v) => console.log(`   ${k.padEnd(14)} ${v}`)

const network = env('BTC_NETWORK', 'testnet')
const explorer = env('BTC_EXPLORER', 'https://mempool.space/testnet4')
const electrum = { type: 'electrum', clientConfig: { host: env('BTC_ELECTRUM_HOST', 'mempool.space'), port: +env('BTC_ELECTRUM_PORT', '40002'), protocol: env('BTC_ELECTRUM_PROTOCOL', 'ssl') } }
const fetchTransaction = async (txid) => (await fetch(`${explorer}/api/tx/${txid}/hex`)).text()

const client = new Turnkey({
  apiBaseUrl: env('TURNKEY_BASE_URL', 'https://api.turnkey.com'),
  apiPublicKey: env('TURNKEY_API_PUBLIC_KEY'),
  apiPrivateKey: env('TURNKEY_API_PRIVATE_KEY'),
  defaultOrganizationId: env('TURNKEY_ORGANIZATION_ID')
}).apiClient()

console.log(`WDK Bitcoin wallet on ${network === 'testnet' ? 'testnet4' : network}, signing with Turnkey.`)

step('Turnkey wallet')
let walletId = opts['fresh-wallet'] ? undefined : process.env.TURNKEY_WALLET_ID
if (walletId) {
  out('wallet', `${walletId} (from TURNKEY_WALLET_ID)`)
} else {
  ({ walletId } = await client.createWallet({ walletName: `wdk-btc-demo-${new Date().toISOString().slice(0, 16)}`, accounts: [] }))
  out('wallet', `${walletId} (created, no accounts yet)`)
}

step('WDK wallet manager backed by TurnkeySignerBtc')
const wallet = new WalletManagerBtc(new TurnkeySignerBtc({ client, walletId, network, fetchTransaction }), { network, client: electrum })
const account = await wallet.getAccount(0)
const address = await account.getAddress()
out('account', `path ${account.path}`)
out('address', address)
out('privateKey', String(account.keyPair.privateKey))

step('Message signature through Turnkey (BIP-137)')
const sig = await account.sign('hello from wdk')
out('signature', sig.slice(0, 22) + '…')
const ok = btcmessage.MessageFactory(ecc).verify('hello from wdk', address, Buffer.from(sig, 'base64'), networks[network].messagePrefix, true)
out('verifies for', ok ? 'the account address' : 'MISMATCH')

step('Balance')
let balance = await account.getBalance()
if (opts['dry-run'] && balance === 0n) {
  out('balance', '0 sats, nothing to quote (--dry-run)')
  wallet.dispose()
  process.exit(0)
}
while (balance === 0n) {
  out('balance', `0 sats. Fund ${address} from a testnet4 faucet (${explorer}/faucet or coinfaucet.eu), checking every 20s`)
  await sleep(20000)
  balance = await account.getBalance()
}
out('balance', `${balance} sats`)

step(`Send ${opts.amount} sats`)
const tx = { to: opts.to || address, value: BigInt(opts.amount) }
out('to', tx.to === address ? `${tx.to} (self)` : tx.to)
const { fee } = await account.quoteSendTransaction(tx)
out('quoted fee', `${fee} sats`)
if (opts['dry-run']) {
  out('dry run', 'stopping before the PSBT is built and signed')
  wallet.dispose()
  process.exit(0)
}
const { hash } = await account.sendTransaction(tx)
out('broadcast', `${explorer}/tx/${hash}`)

step('Confirmation')
const receipt = await account.waitForTransaction(hash, { target: 'confirmed', timeout: 1_800_000 })
out('finality', receipt.finality)
out('block', receipt.block ?? '-')
out('fee paid', `${receipt.fee ?? fee} sats`)
out('balance', `${await account.getBalance()} sats`)

console.log(`\nDone. Turnkey wallet ${walletId}, account ${address}, tx ${hash}`)
wallet.dispose()
