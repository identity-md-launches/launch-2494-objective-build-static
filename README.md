# Belroll

A static, client-side payroll prototype for **Beldex testnet and test funds**. Upload a CSV, review full recipient addresses, then approve each payment in the Beldex Wallet extension. Source, lockfile, and the complete static export are included. The entry point is `dist/index.html`.

## Install, build and preview

Use Node.js 22 or newer and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run preview
```

Open the local preview URL printed by Vite. Preview is useful for layout and local CSV parsing. **The real wallet extension only injects on HTTPS pages**: use an HTTPS static host for an actual extension connection. Serve the contents of `dist/`; there is no backend, server routing, deployment script or runtime configuration endpoint. Vite uses `base: './'`, and receipt routing uses the fragment, so a gateway subpath works. Production includes the SDK, fonts, favicon, sample CSV and share image locally.

Hosting, the `belroll-testnet` publication label and repository publication are handled after this delivery; this app does not publish anything itself.

## Run a payroll

1. Choose **Connect Wallet**, approve `bdx.connect()` in Beldex Wallet, and select testnet in the extension. The app shows the connected address and network. Expand the address to read it in full. A missing extension produces an install link; mainnet is blocked.
2. Choose or drop a UTF-8 CSV. CSV parsing happens entirely in the browser and accepts quoted commas, escaped quotes, multiline notes, BOM and CRLF. Any invalid row rejects the entire file with physical line numbers. A downloadable sample is available before connecting.
3. Set a **pay run reference**, such as `October payroll`. Keep the reference, original CSV, account, browser, origin and send settings unchanged when resuming. A new reference means a separate payroll, even if its recipients are the same.
4. Choose the send asset, priority and optional Flash setting, then select **Review payments**. BNS names resolve through the SDK's `resolveBns()` / `bdx_resolveBns`. Each row shows the recipient as typed, full resolved address, exact amount, note and status. Review also shows the payment count, total and remaining amount. Resolution is trusted to the wallet's resolver, not proven on-chain.
5. Check the confirmation box and choose **Confirm and send**. Each row is a separate wallet approval. Payments run sequentially and stop at the first rejection, error or unknown outcome. **Pause after this payment** lets the current wallet request finish and leaves subsequent rows untouched. **Resume remaining payments** preserves existing keys and skips recorded sent rows.
6. Open **View receipt** on any sent row. The receipt contains its details only in `#/receipt/...`, can be printed or saved as PDF, and has a Copy link button. Anyone with the link can read it. A receipt is a link-supplied record, not independent proof of blockchain confirmation.

## Sample CSV

```csv
recipient,amount,note
alice.bdx,1250,October salary
sam.bdx,750.50,"Design work, October"
taylor.bdx,250,Project bonus
```

These BNS names are format examples, not endorsed payment destinations. Replace them with recipients you control on testnet and verify every resolved address. The same sample is at `public/sample-payroll.csv` and `dist/sample-payroll.csv`.

The header must be `recipient,amount,note` in that order. A recipient is a `.bdx` name or an SDK-valid Beldex address shape; the wallet performs full address validation before signing. Amounts must be positive, have at most 9 decimal places, and fit a uint64 in atomic units: at most `18446744073.709551615` BDX per row. Scientific notation, grouping commas and currency symbols are rejected. Totals and conversion use BigInt, never floating point. Limits are 500 payments, 256 KB per file and 2,000 UTF-16 code units per note. Blank notes are allowed. Notes remain local and in any receipt link; they are not transaction memos.

## SDK inspection and privacy token TODO

The installed and exactly pinned package is **`@bdxi/web3js@1.0.1`**. Its `dist/index.d.ts`, `SendTransactionParams`, `BeldexWeb3`, `BDX_METHODS` and packaged protocol were inspected. The available payment API is `sendTransaction()` / `sendTransactionSafe()` with `to`, atomic `amount`, `priority` and `idempotencyKey`. There is **no exported token-send method or token ID argument in this version**. See the [SDK repository and protocol](https://github.com/Beldex-Coin/bdx-web3js) and [published package version](https://www.npmjs.com/package/@bdxi/web3js/v/1.0.1).

`PRIVACY_TOKEN_ID` is declared as `null` in `src/config.ts` with a clearly marked TODO. This implements the brief's **BDX fallback**. Setting that constant alone will not enable token payments. When a future SDK exports a real token-send API, add that documented method to `sendPayment(row)`, supply the requester's actual testnet token ID and decimals, and revalidate conversion, recovery and receipts. Do not reuse `paymentId` for a token ID.

`createPaymentSender()` in `src/payments.ts` returns the single **`sendPayment(row)`** function; it owns all wallet send calls. Its explicit `SendOptions` include `token`, `priority` and `flash`. The only available asset is BDX. Normal maps to priority `1`, matching the wallet's default; the other supported numeric priorities are displayed as levels 2, 3 and 4. Flash maps to priority `5`, rather than an invented `flash` RPC field. The [wallet's own send implementation](https://github.com/Beldex-Coin/beldex-wallet-extension/blob/main/src/popup/views/Dashboard.tsx) also uses priorities 1 and 5 for Normal and Flash. Fees are paid in BDX and displayed by the wallet; the app does not invent a fee estimate.

The SDK exposes no separate approval event. A row is pending while the wallet prompt is open. An approval is established only after a successful wallet result; sent rows show **Approved in wallet**, their full transaction hash and a receipt. No timer pretends that approval happened.

## Idempotency and resume boundaries

Each row has a SHA-256 key derived from the testnet, connected account, pay run reference and row position. A fingerprint pins the original CSV and settings to that run. A second payload hash pins the resolved destination, amount, asset and effective priority. Modified files/settings or a changed BNS destination cannot silently replace an attempted payment.

Before any send, an opaque local journal is durably written in `localStorage` under `belroll.journal.v1`. It stores hashed run identifiers/fingerprints, row payload hashes, status, timestamps, transaction hashes and optional operation IDs. It does **not** persist the CSV, names, addresses, amounts or notes as plaintext. After reloading, reconnect and upload the same CSV/reference/settings to recover the run. Receipts have no separate storage: their payload is in the URL fragment.

Retries call `sendTransactionSafe()` with the **same** `idempotencyKey`, never a new key. An unknown outcome is treated as possibly paid, stops the run and is recovered with that key. A sent row is never submitted again from this journal. Web Locks prevent simultaneous sends from multiple tabs on the same origin. Journal read/write failures stop sending. Account, network, lock and disconnect events invalidate the session; network and account are rechecked before each row.

Safe recovery requires a wallet implementing the SDK's v1.2+ idempotent operation protocol. The app checks `bdx_getOperationStatus` support and blocks sends when recovery support cannot be established. The SDK describes wallet operation retention as approximately 24 hours; this app conservatively refuses automatic retries of **any attempted, unsent row after 12 hours**. Reconcile an expired or unknown payment in the wallet. Do not create a replacement reference as a retry workaround.

Protection depends on retaining this browser's journal and the wallet's same-origin operation records. Clearing browser data, changing origin/device, removing the wallet's records or deliberately starting a new reference breaks that continuity. This is not a cross-device or permanent exactly-once payment service. Do not use the prototype for real payroll.

## Privacy and architecture

There are no analytics, API fetches, RPC URLs, external font loads, service workers, secrets or backend services. The production CSP has `connect-src 'none'`; SDK operations use the injected wallet bridge. The extension itself may contact its own Beldex network and BNS resolver. Opening an install link or sharing a receipt is an explicit user action.

CSV rows live in memory and disappear on reload. The journal described above stays on this device. Receipt fragments are base64url-encoded JSON, **not encrypted**; they do not form part of the HTTP request path or query, but remain readable by anyone with the complete link and may remain in browser history. Print rendering uses a light, readable receipt layout. Receipt parsing is bounded and rejects malformed or unsupported data; React renders notes as text.

Important source paths:

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Wallet lifecycle, file flow, review UI, sequential-run lock, receipt route |
| `src/csv.ts` | Strict CSV parsing and exact decimal validation |
| `src/payments.ts` | Journal, identity checks, stable keys and `sendPayment(row)` |
| `src/receipt.ts` | Bounded Unicode-safe fragment encoding and decoding |
| `src/config.ts` | Testnet, token TODO, limits, recovery window and install link |
| `src/styles.css` | Shared design tokens, responsive table and print styles |
| `test/` | Unit tests and production-export browser validation |

## Validation actually performed

- `npm run typecheck`: passed.
- `npm test`: 31 tests passed, including exact decimals, CSV failures, sequential stop/resume, unknown broadcast recovery, journal corruption/storage refusal, changed account/network, modified run payloads and receipt encoding.
- `npm run build`: passed; production export is included in `dist/`.
- Production-export Playwright tests: 9 Chromium scenarios passed at a static `/preview/` subpath, including a simulated wallet transport, keyboard controls, sample download, receipt copy/print, PDF generation, cross-tab locking and reload recovery. No real wallet signatures or funds were used.
- Axe WCAG A/AA scans: no violations in the tested no-wallet, review and receipt states. This is not a full accessibility certification.
- Pinned `taste@1` probe: 16/16 checks passed at 320, 390 and 1440. Screenshots were inspected. Additional interaction reflow covered 720 and 980, maximum-length values, 200% CSS text enlargement, reduced motion and an RTL mirror.
- WebKit could not launch because its supplied browser runtime was unavailable. Safari/iOS, physical devices, a screen reader, native browser zoom and an actual Beldex extension transaction remain unverified.

Full coverage, findings and repairs are in `artifacts/validation.md`. Implemented design tokens and reuse rules are in `DESIGN.md`.

To rerun browser checks, install Playwright/Chromium in your normal test toolchain, or point `IMD_PLAYWRIGHT` at an existing Playwright `index.mjs` and `PLAYWRIGHT_BROWSERS_PATH` at its browser installation:

```sh
npm run build
node test/browser.mjs
```

The test script serves `dist/` at a subpath, owns its browser/server within one foreground process and writes disposable evidence only under `test/scratch/browser/`. A simulated provider is injected only by the test harness, never included as an application option. It also attempts WebKit and reports availability separately. The share PNG can be regenerated from the authored SVG using `node test/browser.mjs --render-share`, then rebuilding.

## Submission and attribution

The explicit `.gitignore` path budget is dependency directories named `node_modules/` at any depth, Vite cache directories named `.vite/`, TypeScript `*.tsbuildinfo` files and `/test/scratch/`. It deliberately keeps **`dist/` included**. No package archives, dependency trees or cache directories are part of the deliverable. Retain the source, manifests, lockfile, public assets, tests, documentation and complete `dist/` together.

Runtime license notices are in `public/third-party-notices.txt` and copied to `dist/`; full React, SDK and Manrope notices accompany them. Better Interface design guidance is adapted from [Jakub Krehel](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-interface), MIT. The design documentation method is adapted from [Paul Bakaus's Impeccable](https://github.com/pbakaus/impeccable/blob/9d715cc4f5564a990ca8345abfdd5df6dc9b41c8/skill/reference/document.md), Apache-2.0. Both guide license notices are retained in `docs/design-guide-LICENSE.txt`.
