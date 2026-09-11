import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { BIP32Factory } from 'bip32'
import * as bip39 from 'bip39'
import * as ecc from '@bitcoinerlab/secp256k1'
import btcmessage from '@bitcoinerlab/btcmessage'
import { Psbt, Transaction, address as addr, networks, payments } from 'bitcoinjs-lib'
import { ISigner } from '@tetherto/wdk-wallet'
import WalletManagerBtc, { WalletAccountBtc } from '@tetherto/wdk-wallet-btc'
import { ISignerBtc } from '@tetherto/wdk-wallet-btc/signers'
import { TurnkeySignerBtc } from '../index.js'
import { FakeTurnkeyClient } from './fake-turnkey-client.js'

// the usual hardhat test mnemonic
const MNEMONIC = 'test test test test test test test test test test test junk'
const WALLET_ID = 'wallet-1'
const net = networks.testnet
const root = BIP32Factory(ecc).fromSeed(bip39.mnemonicToSeedSync(MNEMONIC))
const localAddress = (path) => payments.p2wpkh({ pubkey: Buffer.from(root.derivePath(path).publicKey), network: net }).address
const message = btcmessage.MessageFactory(ecc)

// a previous transaction paying `address`, so a PSBT can spend it
const funding = (address, value) => {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 7), 0)
  tx.addOutput(addr.toOutputScript(address, net), value)
  return tx
}
const spendPsbt = (address, prev, withNonWitness) => {
  const psbt = new Psbt({ network: net })
  psbt.addInput({ hash: prev.getId(), index: 0, witnessUtxo: { script: addr.toOutputScript(address, net), value: 50_000n }, ...(withNonWitness ? { nonWitnessUtxo: prev.toBuffer() } : {}) })
  psbt.addOutput({ address, value: 40_000n })
  return psbt
}

describe('TurnkeySignerBtc', () => {
  let client, rootSigner, signer
  before(async () => {
    client = new FakeTurnkeyClient(MNEMONIC)
    rootSigner = new TurnkeySignerBtc({ client, walletId: WALLET_ID, network: 'testnet' })
    signer = await rootSigner.derive("0'/0/0")
  })

  it('extends ISignerBtc from the PR branch', () => {
    assert.ok(signer instanceof ISignerBtc)
    assert.ok(signer instanceof ISigner)
  })

  it('validates its options', () => {
    assert.throws(() => new TurnkeySignerBtc({ walletId: WALLET_ID }), /client/)
    assert.throws(() => new TurnkeySignerBtc({ client }), /wallet id/)
    assert.throws(() => new TurnkeySignerBtc({ client, walletId: WALLET_ID, network: 'litecoin' }), /network/)
    assert.throws(() => new TurnkeySignerBtc({ client, walletId: WALLET_ID, bip: 49 }), /bip/)
  })

  it('root sits at m/84\'/1\' on testnet and derives children below it', () => {
    assert.equal(rootSigner.isDerivable, true)
    assert.equal(rootSigner.path, "m/84'/1'")
    assert.equal(rootSigner.network, 'testnet')
    assert.equal(rootSigner.bip, 84)
    assert.equal(signer.isDerivable, false)
    assert.equal(signer.path, "m/84'/1'/0'/0/0")
    assert.equal(signer.index, 0)
    assert.equal(new TurnkeySignerBtc({ client, walletId: WALLET_ID }).path, "m/84'/0'")
  })

  it('creates the Turnkey account on first getAddress with the testnet P2WPKH format', async () => {
    const address = await signer.getAddress()
    assert.equal(address, localAddress("m/84'/1'/0'/0/0"))
    assert.equal(client.accounts[0].addressFormat, 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH')
    assert.deepEqual(client.calls, ['getWalletAccounts', 'createWalletAccounts', 'getWalletAccounts'])
    assert.equal(await signer.getAddress(), address)
    assert.equal(client.calls.length, 3)
  })

  it('exposes the public key and no private key', async () => {
    await signer.getAddress()
    assert.equal(signer.keyPair.privateKey, null)
    assert.equal(signer.keyPair.publicKey.toString('hex'), Buffer.from(root.derivePath("m/84'/1'/0'/0/0").publicKey).toString('hex'))
  })

  it('signs a BIP-137 message through signRawPayload', async () => {
    const sig = await signer.sign('hello wdk')
    assert.equal(client.calls.at(-1), 'signRawPayload')
    assert.ok(message.verify('hello wdk', await signer.getAddress(), Buffer.from(sig, 'base64'), net.messagePrefix, true))
  })

  it('signs a PSBT through signTransaction and returns it unfinalized, in base64', async () => {
    const address = await signer.getAddress()
    const prev = funding(address, 50_000n)
    const signed = Psbt.fromBase64(await signer.signPsbt(spendPsbt(address, prev, true)))
    assert.equal(client.calls.at(-1), 'signTransaction')
    assert.equal(signed.data.inputs[0].partialSig.length, 1)
    assert.equal(signed.data.inputs[0].finalScriptWitness, undefined)
    signed.finalizeAllInputs()
    assert.equal(signed.extractTransaction().ins[0].witness.length, 2)
  })

  it('accepts a base64 PSBT too', async () => {
    const address = await signer.getAddress()
    const prev = funding(address, 50_000n)
    const signed = Psbt.fromBase64(await signer.signPsbt(spendPsbt(address, prev, true).toBase64()))
    assert.equal(signed.data.inputs[0].partialSig.length, 1)
  })

  it('fills nonWitnessUtxo from fetchTransaction when the PSBT only has witnessUtxo', async () => {
    const txs = {}
    const s = await new TurnkeySignerBtc({ client, walletId: WALLET_ID, network: 'testnet', fetchTransaction: async (txid) => txs[txid] }).derive("0'/0/0")
    const address = await s.getAddress()
    const prev = funding(address, 50_000n)
    txs[prev.getId()] = prev.toHex()
    const signed = Psbt.fromBase64(await s.signPsbt(spendPsbt(address, prev, false)))
    assert.equal(signed.data.inputs[0].partialSig.length, 1)
    assert.ok(signed.data.inputs[0].nonWitnessUtxo)
  })

  it('refuses a witness-only PSBT when it has no way to fetch previous transactions', async () => {
    const address = await signer.getAddress()
    await assert.rejects(signer.signPsbt(spendPsbt(address, funding(address, 50_000n), false)), /fetchTransaction/)
  })

  it('has no extended public key to give', async () => {
    await assert.rejects(signer.getExtendedPublicKey(), /extended public key/)
  })

  it('refuses to work after dispose', async () => {
    const s = await rootSigner.derive("0'/0/9")
    s.dispose()
    await assert.rejects(s.getAddress(), /disposed/)
  })
})

describe('TurnkeySignerBtc inside wdk-wallet-btc', () => {
  it('backs a WalletManagerBtc as the default signer', async () => {
    const client = new FakeTurnkeyClient(MNEMONIC)
    const manager = new WalletManagerBtc(new TurnkeySignerBtc({ client, walletId: WALLET_ID, network: 'testnet' }), { network: 'testnet' })
    const account = await manager.getAccount(2)
    assert.ok(account instanceof WalletAccountBtc)
    assert.equal(await account.getAddress(), localAddress("m/84'/1'/0'/0/2"))
    assert.equal(account.path, "m/84'/1'/0'/0/2")
    const sig = await account.sign('from the manager')
    assert.ok(message.verify('from the manager', await account.getAddress(), Buffer.from(sig, 'base64'), net.messagePrefix, true))
    const byPath = await manager.getAccountByPath("0'/1/0")
    assert.equal(await byPath.getAddress(), localAddress("m/84'/1'/0'/1/0"))
    manager.dispose()
  })

  it('is accepted by addSigner and resolved with getAccount(signerName)', async () => {
    const client = new FakeTurnkeyClient(MNEMONIC)
    const seedManager = new WalletManagerBtc(MNEMONIC, { network: 'testnet' })
    seedManager.addSigner('turnkey', await new TurnkeySignerBtc({ client, walletId: WALLET_ID, network: 'testnet' }).derive("0'/0/7"))
    const account = await seedManager.getAccount('turnkey')
    assert.equal(await account.getAddress(), localAddress("m/84'/1'/0'/0/7"))
    assert.equal(account.keyPair.privateKey, null)
    seedManager.dispose()
  })
})
