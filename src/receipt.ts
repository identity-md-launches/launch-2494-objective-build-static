export interface Receipt {
  version: 1;
  recipient: string;
  name: string;
  amount: string;
  note: string;
  txHash: string;
  date: string;
  network: 'testnet';
  asset: 'BDX';
}

export function receiptFragment(receipt: Receipt): string {
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return '#/receipt/' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function readReceipt(hash: string): Receipt | null {
  try {
    const data = hash.slice('#/receipt/'.length);
    if (!hash.startsWith('#/receipt/') || !data || data.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Receipt;
    if (r.version !== 1 || r.network !== 'testnet' || r.asset !== 'BDX') return null;
    for (const key of ['recipient', 'name', 'amount', 'note', 'txHash', 'date'] as const)
      if (typeof r[key] !== 'string') return null;
    if (r.recipient.length > 200 || r.name.length > 200 || r.note.length > 2000 || !/^[a-f0-9]{64}$/i.test(r.txHash) || !/^\d+(\.\d{1,9})?$/.test(r.amount) || r.amount.length > 32 || !Number.isFinite(Date.parse(r.date))) return null;
    return r;
  } catch { return null; }
}
