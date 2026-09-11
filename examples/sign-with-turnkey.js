// Runs each ISignerBtc operation against a real Turnkey wallet. Nothing is broadcast: the PSBT
// spends a made-up previous transaction that pays the account, enough for Turnkey to sign it.
// Run: node --env-file=.env examples/sign-with-turnkey.js
import { Turnkey } from '@turnkey/sdk-server'
import { Psbt, Transaction, address as addr, networks } from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import btcmessage from '@bitcoinerlab/btcmessage'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import { TurnkeySignerBtc } from '../index.js'

const env = (k, fallback) => process.env[k] ?? fallback ?? (() => { throw new Error(`${k} is not set`) })()
const network = env('BTC_NETWORK', 'testnet')
const net = networks[network]

const client = new Turnkey({
  apiBaseUrl: env('TURNKEY_BASE_URL', 'https://api.turnkey.com'),
  apiPublicKey: env('TURNKEY_API_PUBLIC_KEY'),
  apiPrivateKey: env('TURNKEY_API_PRIVATE_KEY'),
  defaultOrganizationId: env('TURNKEY_ORGANIZATION_ID')
}).apiClient()

// a fake funding transaction, so the PSBT has a real-looking input the account owns
const fakeFunding = (address, value) => {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 1), 0)
  tx.addOutput(addr.toOutputScript(address, net), value)
  return tx
}

const wallet = new WalletManagerBtc(new TurnkeySignerBtc({ client, walletId: env('TURNKEY_WALLET_ID'), network, fetchTransaction: async () => funding.toHex() }), { network })
const account = await wallet.getAccount(0)
const address = await account.getAddress()
console.log('getAddress       ', address, account.path)

const sig = await account.sign('hello from wdk')
console.log('sign (BIP-137)   ', btcmessage.MessageFactory(ecc).verify('hello from wdk', address, Buffer.from(sig, 'base64'), net.messagePrefix, true) ? 'ok' : 'FAIL')

const funding = fakeFunding(address, 50_000n)
const psbt = new Psbt({ network: net })
psbt.addInput({ hash: funding.getId(), index: 0, witnessUtxo: { script: addr.toOutputScript(address, net), value: 50_000n } })
psbt.addOutput({ address, value: 40_000n })
const signedB64 = await wallet.getSigner().derive("0'/0/0").then(s => s.signPsbt(psbt))
const signed = Psbt.fromBase64(signedB64)
signed.finalizeAllInputs()
const tx = signed.extractTransaction()
console.log('signPsbt         ', tx.ins[0].witness.length === 2 ? `ok, ${tx.virtualSize()} vbytes, txid ${tx.getId().slice(0, 16)}…` : 'FAIL')

const child = await wallet.getAccount(1)
console.log('derive           ', await child.getAddress(), child.path)
wallet.dispose()
