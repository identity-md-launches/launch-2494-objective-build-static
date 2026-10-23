import { checkAddress, fromAtomic, toAtomic } from '@bdxi/web3js';
import { MAX_CSV_BYTES, MAX_ROWS } from './config';

export interface CsvRow {
  line: number;
  recipient: string;
  amount: string;
  atomic: string;
  note: string;
}
export interface CsvError { line: number; message: string }
export interface CsvResult { rows: CsvRow[]; errors: CsvError[] }
export const isBns = (s: string) => /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?\.bdx$/i.test(s);
const MAX_ATOMIC = (1n << 64n) - 1n;

export function parseCsv(input: string): CsvResult {
  const errors: CsvError[] = [];
  if (new TextEncoder().encode(input).length > MAX_CSV_BYTES)
    return { rows: [], errors: [{ line: 1, message: 'Choose a CSV smaller than 256 KB.' }] };
  const records: { fields: string[]; line: number }[] = [];
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let fields: string[] = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  const finish = () => {
    fields.push(field);
    if (fields.some(s => s.trim() !== '') || fields.length > 1) records.push({ fields, line: start });
    fields = []; field = ''; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else { field += c; if (c === '\n') line++; }
    } else if (c === ',') { fields.push(field); field = ''; closed = false; }
    else if (c === '\n') { finish(); line++; start = line; }
    else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === '"' || closed) {
      errors.push({ line, message: 'Check CSV quoting. Put the entire field in double quotes and escape quotes as "".' });
      return { rows: [], errors };
    } else field += c;
  }
  if (quoted) errors.push({ line: start, message: 'Close the quoted field with a double quote.' });
  finish();
  if (errors.length) return { rows: [], errors };
  const header = records.shift();
  if (!header || header.fields.map(s => s.trim()).join(',') !== 'recipient,amount,note')
    return { rows: [], errors: [{ line: header?.line ?? 1, message: 'Use this exact header: recipient,amount,note' }] };
  if (!records.length) errors.push({ line: header.line + 1, message: 'Add at least one payment below the header.' });
  if (records.length > MAX_ROWS) errors.push({ line: records[MAX_ROWS].line, message: 'Use at most 500 payments in one CSV.' });
  const rows: CsvRow[] = [];
  for (const record of records.slice(0, MAX_ROWS)) {
    const { fields: f, line: rowLine } = record;
    if (f.length !== 3) { errors.push({ line: rowLine, message: 'Use three columns: recipient, amount and note. Quote notes containing commas.' }); continue; }
    const recipient = f[0].trim(), amount = f[1].trim(), note = f[2];
    const before = errors.length;
    if (!checkAddress(recipient).valid && !isBns(recipient)) errors.push({ line: rowLine, message: 'Enter a BNS name ending in .bdx or a full Beldex address.' });
    let atomic = 0n;
    if (!/^\d+(\.\d{1,9})?$/.test(amount)) errors.push({ line: rowLine, message: 'Use a positive decimal amount with up to 9 decimal places, without commas or currency symbols.' });
    else {
      atomic = toAtomic(amount);
      if (atomic <= 0n || atomic > MAX_ATOMIC) errors.push({ line: rowLine, message: 'Amount must be greater than zero and at most 18446744073.709551615 BDX.' });
    }
    if (note.length > 2000) errors.push({ line: rowLine, message: 'Keep the note within 2,000 characters.' });
    if (before === errors.length) rows.push({ line: rowLine, recipient, amount: fromAtomic(atomic), atomic: atomic.toString(), note });
  }
  return { rows: errors.length ? [] : rows, errors };
}

export function totalAmount(rows: Pick<CsvRow, 'atomic'>[]) {
  return fromAtomic(rows.reduce((total, r) => total + BigInt(r.atomic), 0n));
}
