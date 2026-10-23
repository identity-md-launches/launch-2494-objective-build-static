import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, totalAmount } from '../src/csv';

test('accepts BOM, CRLF, exact decimals, escaped quotes, commas and multiline notes', () => {
  const result = parseCsv('\uFEFFrecipient,amount,note\r\nalice.bdx,0001.230000000,"Review, ""approved""\r\nمرحبا"\r\nsam.bdx,0.000000001,\r\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].note, 'Review, "approved"\nمرحبا');
  assert.equal(result.rows[0].amount, '1.23');
  assert.equal(result.rows[1].line, 4);
  assert.equal(totalAmount(result.rows), '1.230000001');
});

test('sums without floating point rounding', () => {
  const { rows } = parseCsv('recipient,amount,note\na.bdx,0.1,\nb.bdx,0.2,');
  assert.equal(totalAmount(rows), '0.3');
});

test('reports physical line numbers and rejects the complete invalid file', () => {
  const result = parseCsv('recipient,amount,note\nalice.bdx,1,"two\nlines"\nbad recipient,-2,note\nsam.bdx,0.1,ok');
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(e => e.line === 4));
});

for (const amount of ['0', '-1', '+1', '1e3', 'NaN', 'Infinity', '.1', '1.', '1.0000000001', '18446744073.709551616', '1,000']) {
  test(`rejects unsafe amount ${amount}`, () => {
    const result = parseCsv(`recipient,amount,note\nalice.bdx,"${amount}",ok`);
    assert.ok(result.errors.some(e => e.line === 2));
    assert.equal(result.rows.length, 0);
  });
}

test('accepts the smallest and largest supported atomic amounts', () => {
  const { rows, errors } = parseCsv('recipient,amount,note\na.bdx,0.000000001,\nb.bdx,18446744073.709551615,');
  assert.equal(errors.length, 0);
  assert.equal(rows[1].atomic, '18446744073709551615');
});

test('validates headers, columns, empty files and quote boundaries', () => {
  for (const text of ['', 'recipient,amount,note', 'name,amount,note\na.bdx,1,', 'recipient,amount,note\na.bdx,1', 'recipient,amount,note\na.bdx,1,"unclosed', 'recipient,amount,note\na.bdx,1,"closed"garbage', 'recipient,amount,note\na.bdx,1,not"quoted']) {
    assert.ok(parseCsv(text).errors.length > 0, text);
  }
});

test('rejects invalid address shapes, oversized files, rows and notes', () => {
  assert.ok(parseCsv('recipient,amount,note\nbx123,1,').errors.length);
  assert.ok(parseCsv('x'.repeat(262145)).errors.length);
  assert.ok(parseCsv('recipient,amount,note\n' + 'a.bdx,1,\n'.repeat(501)).errors.some(e => e.line === 502));
  assert.ok(parseCsv('recipient,amount,note\na.bdx,1,' + 'x'.repeat(2001)).errors.length);
});

test('accepts direct SDK-valid address shapes and treats markup as plain note text', () => {
  const address = 'bx' + 'A'.repeat(95);
  const result = parseCsv(`recipient,amount,note\n${address},1,<script>alert(1)</script>`);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].note, '<script>alert(1)</script>');
});
