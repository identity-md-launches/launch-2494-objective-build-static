import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeldexWeb3, BdxRpcError, type BeldexProvider, type BdxEvent, type BdxMethod } from '@bdxi/web3js';
import { parseCsv } from '../src/csv';
import { createPaymentSender, PaymentJournal, preparePayments, sendSequentially, type JournalStorage, type PaymentRow, type SendOptions } from '../src/payments';
import { JOURNAL_KEY, RECOVERY_WINDOW_MS } from '../src/config';

const owner = 'bx' + 'B'.repeat(95), destination = 'bx' + 'A'.repeat(95);
const options: SendOptions = { token: 'BDX', priority: 1, flash: false };
class MemoryStorage implements JournalStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
class FakeProvider implements BeldexProvider {
  readonly isBeldex = true;
  nettype = 'testnet'; address = owner; resolveAddress = destination;
  capability = true; sends: Record<string, unknown>[] = []; active = 0; maxActive = 0;
  responses: (Error | 'unknown' | 'success')[] = [];
  outcomes = new Map<string, { txHash: string; fee: string; operationId: string }>();
  on(_event: BdxEvent, _listener: (data: unknown) => void) {}
  off(_event: BdxEvent, _listener: (data: unknown) => void) {}
  async request({ method, params }: { method: BdxMethod; params?: object }): Promise<unknown> {
    if (method === 'bdx_getNetwork') return { nettype: this.nettype, protocolVersion: 1, walletVersion: '1.2.0', height: 1 };
    if (method === 'bdx_getAddress') return { address: this.address };
    if (method === 'bdx_resolveBns') return { name: 'name.bdx', address: this.resolveAddress, verified: false };
    if (method === 'bdx_getOperationStatus') { if (!this.capability) throw new BdxRpcError(-32601, 'not supported'); return { status: 'unknown' }; }
    if (method === 'bdx_sendTransaction') {
      const p = params as Record<string, unknown>; this.sends.push(p);
      const prior = this.outcomes.get(p.idempotencyKey as string);
      if (prior) return { ...prior, idempotent: true };
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise(r => setTimeout(r, 2));
      this.active--;
      const response = this.responses.shift() ?? 'success';
      if (response instanceof Error) throw response;
      const result = { txHash: (this.outcomes.size + 1).toString(16).padStart(64, '0'), fee: '1000', operationId: 'operation-' + this.sends.length };
      this.outcomes.set(p.idempotencyKey as string, result);
      // Simulate broadcast succeeding while the page times out.
      if (response === 'unknown') throw new BdxRpcError(4998, 'unknown outcome');
      return result;
    }
    throw new Error(`Unexpected method ${method}`);
  }
}
async function setup(sendOptions = options) {
  const provider = new FakeProvider(); const bdx = new BeldexWeb3(provider);
  const storage = new MemoryStorage(), journal = new PaymentJournal(storage);
  const rows = parseCsv('recipient,amount,note\na.bdx,0.1,Salary\nb.bdx,0.2,Bonus\nc.bdx,0.3,Expenses').rows;
  const args = { bdx, owner, reference: 'October payroll', rows, options: sendOptions, journal };
  const prepared = await preparePayments(args);
  journal.bindRun(prepared.runKey, prepared.fingerprint);
  const updates: PaymentRow[] = [];
  const sender = createPaymentSender({ bdx, owner, options: sendOptions, journal, onUpdate: r => updates.push(r) });
  return { ...args, provider, storage, prepared, updates, sender };
}

test('sends exact atomic units sequentially, only to reviewed full addresses, with unique stable keys', async () => {
  const s = await setup();
  assert.equal(s.provider.sends.length, 0, 'review must not send');
  const results = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(results.filter(r => r.status === 'sent').length, 3);
  assert.equal(s.provider.maxActive, 1);
  assert.deepEqual(s.provider.sends.map(p => p.amount), ['100000000', '200000000', '300000000']);
  assert.ok(s.provider.sends.every(p => p.to === destination && p.priority === 1 && !('note' in p) && !('tokenId' in p)));
  assert.equal(new Set(s.provider.sends.map(p => p.idempotencyKey)).size, 3);
  assert.deepEqual(s.updates.slice(0, 3).map(r => r.status), ['pending', 'approved', 'sent']);
});
test('stops on rejection and resumes without resending an already sent row', async () => {
  const s = await setup();
  s.provider.responses = ['success', new BdxRpcError(4001, 'declined')];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(first.map(r => r.status), ['sent', 'failed']);
  assert.equal(s.provider.sends.length, 2);
  const resumed = await preparePayments(s);
  await sendSequentially(resumed.rows, s.sender);
  assert.equal(s.provider.sends.length, 4);
  assert.equal(s.provider.outcomes.size, 3);
  assert.equal(s.provider.sends[1].idempotencyKey, s.provider.sends[2].idempotencyKey);
});
test('recovers an unknown broadcast with the same key and no second payment', async () => {
  const s = await setup(); s.provider.responses = ['unknown'];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(first[0].status, 'unresolved');
  assert.equal(s.provider.outcomes.size, 1);
  const second = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(second.filter(r => r.status === 'sent').length, 3);
  assert.equal(s.provider.outcomes.size, 3);
  assert.equal(s.provider.sends[0].idempotencyKey, s.provider.sends[1].idempotencyKey);
});
test('re-uploading the same CSV after a reload recovers all sent rows from local journal', async () => {
  const s = await setup(); await sendSequentially(s.prepared.rows, s.sender);
  const journal = new PaymentJournal(s.storage);
  const recovered = await preparePayments({ ...s, journal });
  assert.ok(recovered.rows.every(r => r.status === 'sent' && r.txHash && r.sentAt));
  await sendSequentially(recovered.rows, s.sender);
  assert.equal(s.provider.sends.length, 3);
  assert.ok(!s.storage.getItem(JOURNAL_KEY)!.includes('Salary'), 'notes are not persisted');
  assert.ok(!s.storage.getItem(JOURNAL_KEY)!.includes(destination), 'addresses are not persisted');
});
test('blocks mainnet and changed accounts before any send', async () => {
  for (const changed of ['network', 'account']) {
    const s = await setup();
    if (changed === 'network') s.provider.nettype = 'mainnet'; else s.provider.address = destination;
    await assert.rejects(s.sender(s.prepared.rows[0]));
    assert.equal(s.provider.sends.length, 0);
  }
});
test('blocks an unsupported wallet, unavailable journal and corrupted journal without sending', async () => {
  const s = await setup(); s.provider.capability = false;
  await assert.rejects(s.sender(s.prepared.rows[0]), /recovery/);
  assert.equal(s.provider.sends.length, 0);
  const denied = new PaymentJournal({ getItem: () => null, setItem: () => { throw new Error('denied'); } });
  const sender = createPaymentSender({ ...s, journal: denied, onUpdate: () => {} });
  s.provider.capability = true;
  await assert.rejects(sender(s.prepared.rows[0]), /could not be saved/);
  assert.equal(s.provider.sends.length, 0);
  s.storage.setItem(JOURNAL_KEY, '{broken');
  await assert.rejects(preparePayments(s), /cannot be read/);
});
test('blocks changed CSV, settings and re-resolved addresses for the same pay run', async () => {
  const s = await setup();
  await assert.rejects(preparePayments({ ...s, rows: [{ ...s.rows[0], atomic: '999' }] }), /different CSV/);
  await assert.rejects(preparePayments({ ...s, options: { ...options, flash: true } }), /different CSV/);
  await s.sender(s.prepared.rows[0]); s.provider.resolveAddress = 'bx' + 'C'.repeat(95);
  await assert.rejects(preparePayments(s), /changed after an attempt/);
});
test('blocks an unresolved retry after the conservative recovery window', async () => {
  const s = await setup(); s.provider.responses = ['unknown'];
  await s.sender(s.prepared.rows[0]);
  const sender = createPaymentSender({ ...s, onUpdate: () => {}, now: () => Date.now() + RECOVERY_WINDOW_MS + 1000 });
  await assert.rejects(sender(s.prepared.rows[0]), /recovery has expired/);
  assert.equal(s.provider.sends.length, 1);
});
test('uses SDK priority 5 for Flash and exposes no invented flash or token parameters', async () => {
  const s = await setup({ ...options, flash: true }); await s.sender(s.prepared.rows[0]);
  assert.equal(s.provider.sends[0].priority, 5);
  assert.equal('flash' in s.provider.sends[0], false);
  assert.equal('tokenId' in s.provider.sends[0], false);
});
test('pauses between rows and keeps remaining payments untouched', async () => {
  const s = await setup(); let sent = false;
  await sendSequentially(s.prepared.rows, async r => { const result = await s.sender(r); sent = true; return result; }, () => sent);
  assert.equal(s.provider.sends.length, 1);
});
test('a deliberate new pay run reference gets separate payment keys', async () => {
  const s = await setup(); const next = await preparePayments({ ...s, reference: 'November payroll' });
  assert.notEqual(next.rows[0].idempotencyKey, s.prepared.rows[0].idempotencyKey);
});
