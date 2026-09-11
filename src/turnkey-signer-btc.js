'use strict'

import { InvalidSignerError, UnsupportedOperationError, ValueError } from '@tetherto/wdk-wallet'
import { ISignerBtc } from '@tetherto/wdk-wallet-btc/signers'
import { Psbt, networks } from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import btcmessage from '@bitcoinerlab/btcmessage'

const message = btcmessage.MessageFactory(ecc)
const FORMAT = { bitcoin: 'MAINNET', testnet: 'TESTNET', regtest: 'REGTEST', signet: 'SIGNET' }

// Turnkey signs a PSBT and hands it back unfinalized, which is what ISignerBtc.signPsbt wants.
// Turnkey requires nonWitnessUtxo on every segwit input; the WDK account only sets witnessUtxo,
// so pass fetchTransaction(txid) -> raw tx hex and the signer fills the gap before sending.
export default class TurnkeySignerBtc extends ISignerBtc {
  // client is `new Turnkey(config).apiClient()` from @turnkey/sdk-server
  constructor ({ client, walletId, network = 'bitcoin', bip = 84, path, isChild = false, fetchTransaction } = {}) {
    super()
    if (!client) throw new ValueError('A Turnkey API client is required.')
    if (!walletId) throw new ValueError('A Turnkey wallet id is required.')
    if (!FORMAT[network]) throw new ValueError(`Unsupported network "${network}".`)
    if (bip !== 44 && bip !== 84) throw new ValueError('bip must be 44 or 84.')
    this._client = client
    this._walletId = walletId
    this._network = network
    this._bip = bip
    this._path = path ?? `m/${bip}'/${network === 'bitcoin' ? 0 : 1}'`
    this._isChild = isChild
    this._fetchTransaction = fetchTransaction
    this._address = undefined
    this._publicKey = null
  }

  get isDerivable () { return !this._isChild }
  get index () { return +this._path.split('/').pop().replace("'", '') }
  get path () { return this._path }
  get address () { return this._address }
  get network () { return this._network }
  get bip () { return this._bip }
  get keyPair () { return { privateKey: null, publicKey: this._publicKey } }

  async derive (relPath) {
    if (!this.isDerivable) throw new InvalidSignerError('Cannot derive: this signer is a derived child.')
    return new TurnkeySignerBtc({
      client: this._client, walletId: this._walletId, network: this._network, bip: this._bip,
      path: `${this._path}/${relPath}`, isChild: true, fetchTransaction: this._fetchTransaction
    })
  }

  async getExtendedPublicKey () {
    throw new UnsupportedOperationError('Turnkey does not expose extended public keys.')
  }

  async getAddress () {
    if (this._address) return this._address
    if (!this._client) throw new InvalidSignerError('The signer has been disposed.')

    const addressFormat = `ADDRESS_FORMAT_BITCOIN_${FORMAT[this._network]}_${this._bip === 84 ? 'P2WPKH' : 'P2PKH'}`
    let account = await this._findAccount(addressFormat)
    if (!account) {
      const { addresses } = await this._client.createWalletAccounts({
        walletId: this._walletId,
        accounts: [{ curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: this._path, addressFormat }]
      })
      account = (await this._findAccount(addressFormat)) || { address: addresses[0] }
    }
    this._address = account.address
    this._publicKey = account.publicKey ? Buffer.from(account.publicKey, 'hex') : null
    return this._address
  }

  // BIP-137 signature, the digest is computed locally and signed raw by Turnkey
  async sign (text) {
    const address = await this.getAddress()
    const signer = {
      signRecoverable: async (hash) => {
        const { r, s, v } = await this._client.signRawPayload({
          signWith: address, payload: Buffer.from(hash).toString('hex'),
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_NO_OP'
        })
        return { signature: Buffer.from(r.padStart(64, '0') + s.padStart(64, '0'), 'hex'), recoveryId: parseInt(v, 16) }
      }
    }
    const opts = this._bip === 84 ? { segwitType: 'p2wpkh' } : undefined
    const sig = await message.signAsync(text, signer, true, networks[this._network === 'signet' ? 'testnet' : this._network].messagePrefix, opts)
    return Buffer.from(sig).toString('base64')
  }

  async signPsbt (psbt) {
    const address = await this.getAddress()
    const p = typeof psbt === 'string' ? Psbt.fromBase64(psbt) : psbt
    await this._addNonWitnessUtxos(p)
    const { signedTransaction } = await this._client.signTransaction({
      signWith: address, unsignedTransaction: p.toHex(), type: 'TRANSACTION_TYPE_BITCOIN'
    })
    return Psbt.fromHex(signedTransaction).toBase64()
  }

  dispose () {
    this._client = undefined
    this._publicKey = null
  }

  async _addNonWitnessUtxos (psbt) {
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i]
      if (input.nonWitnessUtxo) continue
      if (!this._fetchTransaction) throw new ValueError('Turnkey needs nonWitnessUtxo on every input: pass fetchTransaction(txid) to the signer.')
      const txid = Buffer.from(psbt.txInputs[i].hash).reverse().toString('hex')
      psbt.updateInput(i, { nonWitnessUtxo: Buffer.from(await this._fetchTransaction(txid), 'hex') })
    }
  }

  async _findAccount (addressFormat) {
    const { accounts } = await this._client.getWalletAccounts({ walletId: this._walletId, paginationOptions: { limit: '100' } })
    return accounts.find(a => a.path === this._path && a.addressFormat === addressFormat)
  }
}
