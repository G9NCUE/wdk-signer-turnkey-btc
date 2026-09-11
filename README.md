# wdk-signer-turnkey-btc

A Turnkey signer for the Tether WDK Bitcoin wallet. It implements `ISignerBtc`, the Bitcoin
signer contract proposed in [wdk-wallet-btc#50](https://github.com/tetherto/wdk-wallet-btc/pull/50),
so the WDK can build and broadcast Bitcoin transactions while [Turnkey](https://www.turnkey.com)
signs the PSBT. Third of a series after the EVM ones for
[Turnkey](https://github.com/G9NCUE/wdk-signer-turnkey-evm) and [Dfns](https://github.com/G9NCUE/wdk-signer-dfns-evm).

Unlike the EVM packages this one targets a branch, not a release: the Bitcoin signer abstraction is
still under review, and this repo installs `github:claudiovb/wdk-wallet-btc#poc-signer` directly.

## Usage

```js
import { Turnkey } from '@turnkey/sdk-server'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import { TurnkeySignerBtc } from 'wdk-signer-turnkey-btc'

const client = new Turnkey({ apiBaseUrl, apiPublicKey, apiPrivateKey, defaultOrganizationId }).apiClient()
const fetchTransaction = async (txid) => (await fetch(`https://mempool.space/testnet4/api/tx/${txid}/hex`)).text()

const signer = new TurnkeySignerBtc({ client, walletId, network: 'testnet', fetchTransaction })
const wallet = new WalletManagerBtc(signer, { network: 'testnet', client: { type: 'electrum', clientConfig: { host: 'mempool.space', port: 40002, protocol: 'ssl' } } })
const account = await wallet.getAccount(0)     // Turnkey account at m/84'/1'/0'/0/0, created if missing
await account.sendTransaction({ to, value })   // the WDK selects coins and builds the PSBT, Turnkey signs it, the WDK finalizes and broadcasts
```

The root signer sits at `m/84'/1'` (or `m/84'/0'` on mainnet) and children are Turnkey wallet
accounts below it, same convention as `SeedSignerBtc`. BIP-44 legacy addresses work with `bip: 44`.

## What goes to Turnkey

| WDK call | Turnkey call | Checked against the live API |
|---|---|---|
| `getAddress`, `derive` | `getWalletAccounts`, `createWalletAccounts` with `ADDRESS_FORMAT_BITCOIN_<NET>_P2WPKH` | yes |
| `signPsbt` | `signTransaction`, PSBT hex in, PSBT hex with signatures out, `TRANSACTION_TYPE_BITCOIN` | yes |
| `sign` (BIP-137 message) | `signRawPayload` on the message digest, `HASH_FUNCTION_NO_OP` | yes |
| `getExtendedPublicKey` | none, throws `UnsupportedOperationError` | |

Turnkey does not finalize the PSBT, which matches the contract: the WDK account finalizes and
extracts the transaction itself.

## The one real gap: `nonWitnessUtxo`

Turnkey refuses to sign a segwit input unless the PSBT carries both `witnessUtxo` and
`nonWitnessUtxo`. The WDK account only sets `witnessUtxo` on BIP-84 inputs, so the signer needs a
way to fetch each previous transaction: pass `fetchTransaction(txid) -> raw tx hex` and it fills the
gap before sending. Without it, `signPsbt` throws instead of letting Turnkey reject the PSBT.

Ledger devices have the same requirement, so the account should probably include the previous
transaction itself. Worth raising on the PR.

## Running it

```sh
npm install
npm test                                # 14 offline tests, fake Turnkey client backed by a local HD wallet
cp .env.example .env && chmod 600 .env  # Turnkey organization id, API key pair, wallet id
npm run example                         # address, message, PSBT against Turnkey, spending a made-up funding tx, nothing broadcast
npm run demo                            # testnet4: wallet, account, funding, transfer, confirmation
npm run demo -- --dry-run               # stop before anything is signed
```

The demo waits for a testnet4 faucet to fund the address it prints, then sends 1000 sats to itself.
Testnet4 goes through mempool.space, both the Electrum endpoint and the REST API used to fetch
previous transactions. Testnet3 works too, set `BTC_ELECTRUM_HOST=electrum.blockstream.info`,
`BTC_ELECTRUM_PORT=60001`, `BTC_ELECTRUM_PROTOCOL=tcp`, `BTC_EXPLORER=https://mempool.space/testnet`.

## Things I found

- The PR branch exports the `ISignerBtc` class from `/signers`, so this signer extends it directly.
  The EVM package on npm does not yet, see the EVM repos.
- `getExtendedPublicKey()` is in the contract but nothing in the account or manager calls it. Remote
  signers have no xpub to give.
- `WalletAccountBtc` has `path` but no `index` getter, unlike the EVM account.
- The account builds BIP-84 inputs with `witnessUtxo` only. See above.
- Turnkey has address formats for mainnet, testnet, signet and regtest, so the same signer runs
  against the WDK's regtest test harness with bitcoind and electrs.

## Status

A prototype against an unmerged branch. Apache-2.0 like the WDK.
