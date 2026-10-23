import { BeldexWeb3, checkAddress, type SendTransactionParams } from '@bdxi/web3js';
import { JOURNAL_KEY, NETWORK, RECOVERY_WINDOW_MS, SEND_ASSET } from './config';
import { isBns, type CsvRow } from './csv';

export type PaymentStatus = 'ready' | 'resolution-failed' | 'pending' | 'approved' | 'sent' | 'failed' | 'unresolved';
export interface SendOptions { token: 'BDX'; priority: 1 | 2 | 3 | 4; flash: boolean }
export interface PaymentRow extends CsvRow {
  address: string;
  idempotencyKey: string;
  payloadHash: string;
  status: PaymentStatus;
  error?: string;
  txHash?: string;
  sentAt?: string;
  operationId?: string;
}
type JournalState = 'pending' | 'sent' | 'failed' | 'unresolved';
interface Entry {
  payloadHash: string;
  state: JournalState;
  attemptedAt: number;
  txHash?: string;
  sentAt?: string;
  operationId?: string;
}
interface JournalData {
  version: 1;
  runs: Record<string, string>;
  entries: Record<string, Entry>;
}
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Wallet = Pick<BeldexWeb3, 'getNetwork' | 'getAddress' | 'getOperationStatus' | 'resolveBns' | 'sendTransactionSafe'>;

export class PaymentJournal {
  constructor(private storage: JournalStorage) {}
  private read(): JournalData {
    try {
      const raw = this.storage.getItem(JOURNAL_KEY);
      if (raw === null) return { version: 1, runs: {}, entries: {} };
      const d = JSON.parse(raw) as JournalData;
      if (d.version !== 1 || !d.runs || !d.entries || typeof d.runs !== 'object' || typeof d.entries !== 'object' || Array.isArray(d.runs) || Array.isArray(d.entries)) throw new Error();
      for (const [key, entry] of Object.entries(d.entries)) {
        if (!/^belroll_[a-f0-9]{64}$/.test(key) || !entry || !['pending', 'sent', 'failed', 'unresolved'].includes(entry.state) || !/^[a-f0-9]{64}$/.test(entry.payloadHash) || !Number.isFinite(entry.attemptedAt)) throw new Error();
        if (entry.state === 'sent' && (!entry.txHash || !/^[a-f0-9]{64}$/i.test(entry.txHash) || !entry.sentAt || !Number.isFinite(Date.parse(entry.sentAt)))) throw new Error();
      }
      if (Object.entries(d.runs).some(([k, v]) => !/^[a-f0-9]{64}$/.test(k) || typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) throw new Error();
      return d;
    } catch { throw new Error('The local payment journal cannot be read. Sending is blocked. Keep this browser data and reconcile payments in your wallet before starting another run.'); }
  }
  private write(data: JournalData) {
    try {
      const serialized = JSON.stringify(data);
      this.storage.setItem(JOURNAL_KEY, serialized);
      if (this.storage.getItem(JOURNAL_KEY) !== serialized) throw new Error();
    } catch { throw new Error('The payment journal could not be saved. Sending has stopped. Allow local browser storage before continuing; check your wallet for any payment already approved.'); }
  }
  get(key: string) { return this.read().entries[key]; }
  assertRun(runKey: string, fingerprint: string) {
    const saved = this.read().runs[runKey];
    if (saved && saved !== fingerprint) throw new Error('This pay run reference already has a different CSV or send settings. Restore the original CSV and settings to resume. Use a new reference only for a separate payroll.');
  }
  bindRun(runKey: string, fingerprint: string) {
    this.assertRun(runKey, fingerprint);
    const d = this.read(); d.runs[runKey] = fingerprint; this.write(d);
  }
  put(key: string, entry: Entry) {
    const d = this.read(); d.entries[key] = entry; this.write(d);
  }
}

export async function digest(data: unknown): Promise<string> {
  const buffer = new TextEncoder().encode(JSON.stringify(data));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function assertWallet(bdx: Wallet, owner: string, guard = () => {}) {
  guard();
  const network = await bdx.getNetwork();
  if (network.nettype !== NETWORK) throw new Error('Switch your Beldex Wallet to testnet, then reconnect. Mainnet payments are blocked.');
  const address = await bdx.getAddress();
  if (address !== owner) throw new Error('The wallet account changed. Reconnect and review this payroll again.');
  guard();
}

export async function assertRecoverySupport(bdx: Wallet) {
  try { await bdx.getOperationStatus('belroll-capability-check'); }
  catch { throw new Error('This wallet cannot verify safe send recovery. Update to a Beldex Wallet with idempotent sends (SDK protocol v1.2+), unlock it, then reconnect.'); }
}

export async function preparePayments(args: {
  bdx: Wallet; owner: string; reference: string; rows: CsvRow[];
  options: SendOptions; journal: PaymentJournal; guard?: () => void;
}) {
  const { bdx, owner, rows, options, journal } = args;
  await assertWallet(bdx, owner, args.guard);
  const reference = args.reference.trim();
  if (!reference || reference.length > 120) throw new Error('Enter a pay run reference of 1 to 120 characters. Keep it unchanged when resuming.');
  const runKey = await digest([NETWORK, owner, reference]);
  const fingerprint = await digest([rows.map(({ recipient, atomic, note }) => [recipient, atomic, note]), options]);
  journal.assertRun(runKey, fingerprint);
  const prepared: PaymentRow[] = [];
  for (const row of rows) {
    args.guard?.();
    let address = row.recipient, error: string | undefined;
    try {
      if (isBns(row.recipient)) address = (await bdx.resolveBns(row.recipient)).address;
      if (!checkAddress(address).valid) throw new Error();
    } catch { error = `Could not resolve or validate ${row.recipient}. Check the recipient in your wallet, correct the CSV and review again.`; address = ''; }
    const idempotencyKey = 'belroll_' + await digest([runKey, prepared.length]);
    const payloadHash = await digest([address, row.atomic, options.token, options.flash ? 5 : options.priority]);
    const entry = journal.get(idempotencyKey);
    if (entry && entry.payloadHash !== payloadHash) throw new Error(`Line ${row.line}: the resolved destination or send details changed after an attempt. Sending is blocked. Reconcile this payment in your wallet.`);
    prepared.push({ ...row, address, idempotencyKey, payloadHash,
      status: error ? 'resolution-failed' : entry?.state === 'sent' ? 'sent' : entry?.state === 'pending' ? 'unresolved' : entry?.state ?? 'ready',
      error, txHash: entry?.txHash, sentAt: entry?.sentAt, operationId: entry?.operationId });
  }
  await assertWallet(bdx, owner, args.guard);
  return { rows: prepared, runKey, fingerprint };
}

export function paymentError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 4001) return 'Declined in wallet. No further payments were requested. Resume when you are ready.';
  if (code === 4900) return 'Unlock your Beldex Wallet, then resume with this same pay run.';
  if (code === 4100) return 'Reconnect your Beldex Wallet, review this pay run, then resume.';
  if (code === 4901) return 'Create or restore a testnet wallet in the extension, then reconnect.';
  if (code === 4998 || code === 4999) return 'The outcome is not confirmed. Keep the same CSV, reference and browser. Resume checks the same payment key.';
  if (code === -32602) return 'The wallet rejected the payment details. Check the recipient and amount in the CSV.';
  if (code === -32603) return 'The wallet could not complete this request. Check its payment history, then resume using the same payment key.';
  return error instanceof Error && code === undefined ? error.message : 'The wallet could not complete this request. Open the extension and check the payment before resuming.';
}

/** All sending goes through this factory's single sendPayment(row) function.
 * Token, priority and flash are explicit inputs here. This SDK exposes BDX only;
 * Flash is priority 5, not an invented `flash` RPC parameter. Notes stay local.
 */
export function createPaymentSender(args: {
  bdx: Wallet; owner: string; options: SendOptions; journal: PaymentJournal;
  onUpdate: (row: PaymentRow) => void; guard?: () => void; now?: () => number;
}) {
  const { bdx, owner, journal, options, onUpdate } = args;
  const now = args.now ?? Date.now;
  return async function sendPayment(row: PaymentRow): Promise<PaymentRow> {
    if (!row.address || row.status === 'resolution-failed') throw new Error('Resolve every recipient before sending.');
    await assertWallet(bdx, owner, args.guard);
    const previous = journal.get(row.idempotencyKey);
    if (previous && previous.payloadHash !== row.payloadHash) throw new Error('Payment details changed. Sending is blocked to protect this run.');
    if (previous?.state === 'sent') {
      const sent = { ...row, status: 'sent' as const, txHash: previous.txHash, sentAt: previous.sentAt, operationId: previous.operationId, error: undefined };
      onUpdate(sent); return sent;
    }
    if (previous && now() - previous.attemptedAt >= RECOVERY_WINDOW_MS)
      throw new Error(`Line ${row.line}: safe recovery has expired. Do not resend or create a new reference for this payment. Reconcile its outcome in your wallet; automatic resume is blocked.`);
    await assertRecoverySupport(bdx);
    args.guard?.();
    const pending: PaymentRow = { ...row, status: 'pending', error: undefined };
    const entry: Entry = { payloadHash: row.payloadHash, state: 'pending', attemptedAt: previous?.attemptedAt ?? now() };
    // This durable write MUST finish before a wallet request can happen.
    journal.put(row.idempotencyKey, entry);
    onUpdate(pending);
    const params: SendTransactionParams = {
      to: row.address, amount: row.atomic,
      priority: options.flash ? 5 : options.priority,
      idempotencyKey: row.idempotencyKey,
    };
    let updated: PaymentRow;
    try {
      if (options.token !== SEND_ASSET) throw new Error('Only testnet BDX is supported by this SDK.');
      const result = await bdx.sendTransactionSafe(params, { resolveTimeoutMs: 0 });
      if (result.status === 'unresolved') {
        updated = { ...pending, status: 'unresolved', error: 'The wallet outcome is unknown. Resume with this same payment key; do not start a replacement payroll.' };
        journal.put(row.idempotencyKey, { ...entry, state: 'unresolved' });
      } else {
        if (!/^[a-f0-9]{64}$/i.test(result.txHash)) throw new Error('The wallet returned an incomplete transaction result. Check the wallet before resuming.');
        // The SDK has no separate approval event. Only a confirmed wallet result
        // establishes that approval occurred; never infer it from elapsed time.
        onUpdate({ ...pending, status: 'approved', txHash: result.txHash });
        updated = { ...pending, status: 'sent', txHash: result.txHash, sentAt: new Date(now()).toISOString(), operationId: result.operationId };
        journal.put(row.idempotencyKey, { ...entry, state: 'sent', txHash: updated.txHash, sentAt: updated.sentAt, operationId: updated.operationId });
      }
    } catch (error) {
      const rejected = BeldexWeb3.isUserRejection(error);
      updated = { ...pending, status: rejected ? 'failed' : 'unresolved', error: paymentError(error) };
      // A wallet error is not proof that broadcast never happened. Same key only.
      try { journal.put(row.idempotencyKey, { ...entry, state: rejected ? 'failed' : 'unresolved' }); } catch { /* The pre-send pending record remains. Stop the run. */ }
    }
    onUpdate(updated);
    return updated;
  };
}

export async function sendSequentially(rows: PaymentRow[], sendPayment: (row: PaymentRow) => Promise<PaymentRow>, shouldPause = () => false) {
  const results: PaymentRow[] = [];
  for (const row of rows) {
    if (shouldPause()) break;
    if (row.status === 'sent') { results.push(row); continue; }
    const result = await sendPayment(row);
    results.push(result);
    if (result.status !== 'sent') break;
  }
  return results;
}
