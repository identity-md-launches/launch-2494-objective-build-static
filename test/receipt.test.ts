import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFragment, readReceipt, type Receipt } from '../src/receipt';

const receipt: Receipt = { version: 1, recipient: 'bx' + 'A'.repeat(95), name: 'alice.bdx', amount: '0.000000001', note: 'Payroll, "approved"\n日本語 • مرحبا <script>alert(1)</script>', txHash: 'a'.repeat(64), date: '2026-10-23T10:20:00.000Z', network: 'testnet', asset: 'BDX' };
test('round trips Unicode, punctuation and markup entirely inside the fragment', () => {
  const fragment = receiptFragment(receipt);
  assert.match(fragment, /^#\/receipt\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(readReceipt(fragment), receipt);
  assert.equal(new URL('https://example.org/subpath/' + fragment).pathname, '/subpath/');
  assert.equal(new URL('https://example.org/subpath/' + fragment).search, '');
});
test('rejects malformed or unsupported receipt links without crashing', () => {
  for (const hash of ['', '#/receipt/', '#/receipt/!!!', '#/receipt/1234', '#/receipt/' + 'a'.repeat(24001), receiptFragment({ ...receipt, txHash: 'no-hash' }), receiptFragment({ ...receipt, network: 'mainnet' as 'testnet' })]) assert.equal(readReceipt(hash), null);
});
