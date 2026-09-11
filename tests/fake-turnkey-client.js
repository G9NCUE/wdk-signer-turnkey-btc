// Stands in for Turnkey's apiClient(), signing with a local HD wallet. Enforces Turnkey's rule
// that segwit inputs carry nonWitnessUtxo. Field names follow @turnkey/sdk-types 8.x.
import { BIP32Factory } from 'bip32'
import * as bip39 from 'bip39'
import * as ecc from '@bitcoinerlab/secp256k1'
import { Psbt, initEccLib, networks, payments } from 'bitcoinjs-lib'

initEccLib(ecc)
const bip32 = BIP32Factory(ecc)

export class FakeTurnkeyClient {
  constructor (mnemonic) {
    this.root = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic))
    this.accounts = []
    this.calls = []
  }

  _node (address) {
    const a = this.accounts.find(x => x.address === address)
    if (!a) throw new Error(`Turnkey: unknown signWith ${address}`)
    return this.root.derivePath(a.path)
  }

  async getWalletAccounts ({ walletId }) {
    this.calls.push('getWalletAccounts')
    return { accounts: this.accounts.filter(a => a.walletId === walletId) }
  }

  async createWalletAccounts ({ walletId, accounts }) {
    this.calls.push('createWalletAccounts')
    const addresses = []
    for (const spec of accounts) {
      const m = /^ADDRESS_FORMAT_BITCOIN_(MAINNET|TESTNET|REGTEST|SIGNET)_(P2WPKH|P2PKH)$/.exec(spec.addressFormat)
      if (!m || spec.curve !== 'CURVE_SECP256K1' || spec.pathFormat !== 'PATH_FORMAT_BIP32') throw new Error('Turnkey: unsupported account spec ' + JSON.stringify(spec))
      const network = networks[{ MAINNET: 'bitcoin', TESTNET: 'testnet', REGTEST: 'regtest', SIGNET: 'testnet' }[m[1]]]
      const node = this.root.derivePath(spec.path)
      const pubkey = Buffer.from(node.publicKey)
      const { address } = m[2] === 'P2WPKH' ? payments.p2wpkh({ pubkey, network }) : payments.p2pkh({ pubkey, network })
      this.accounts.push({ walletId, path: spec.path, curve: spec.curve, addressFormat: spec.addressFormat, address, publicKey: pubkey.toString('hex') })
      addresses.push(address)
    }
    return { addresses }
  }

  async signRawPayload ({ signWith, payload, encoding, hashFunction }) {
    this.calls.push('signRawPayload')
    if (encoding !== 'PAYLOAD_ENCODING_HEXADECIMAL' || hashFunction !== 'HASH_FUNCTION_NO_OP') throw new Error('Turnkey: fake only signs raw hex digests')
    const node = this._node(signWith)
    const { signature, recoveryId } = ecc.signRecoverable(Buffer.from(payload, 'hex'), node.privateKey)
    const sig = Buffer.from(signature)
    return { r: sig.subarray(0, 32).toString('hex'), s: sig.subarray(32).toString('hex'), v: recoveryId === 0 ? '00' : '01' }
  }

  async signTransaction ({ signWith, unsignedTransaction, type }) {
    this.calls.push('signTransaction')
    if (type !== 'TRANSACTION_TYPE_BITCOIN') throw new Error('Turnkey: unsupported type ' + type)
    const node = this._node(signWith)
    const psbt = Psbt.fromHex(unsignedTransaction)
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i]
      if (input.witnessUtxo && !input.nonWitnessUtxo) throw new Error('Turnkey: segwit inputs require both witness_utxo and non_witness_utxo')
    }
    const signer = { publicKey: Buffer.from(node.publicKey), sign: (hash) => Buffer.from(node.sign(hash)) }
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, signer) } catch {}
    }
    return { signedTransaction: psbt.toHex() }
  }
}
