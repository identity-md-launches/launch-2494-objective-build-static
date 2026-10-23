import { useEffect, useRef, useState, type DragEvent } from 'react';
import { BeldexWeb3, detectProvider, type ConnectResult } from '@bdxi/web3js';
import { Icon, Logo } from './icons';
import { MAX_CSV_BYTES, WALLET_INSTALL_URL } from './config';
import { parseCsv, totalAmount, isBns, type CsvError, type CsvRow } from './csv';
import { assertRecoverySupport, createPaymentSender, PaymentJournal, paymentError, preparePayments, sendSequentially, type PaymentRow, type SendOptions } from './payments';
import { readReceipt, receiptFragment, type Receipt } from './receipt';

const defaultReference = () => `Payroll ${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
const initialOptions: SendOptions = { token: 'BDX', priority: 1, flash: false };
type Review = Awaited<ReturnType<typeof preparePayments>>;
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const change = () => { setHash(location.hash); if (location.hash.startsWith('#/')) window.scrollTo(0, 0); }; addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  return hash;
}

function Status({ row }: { row: PaymentRow }) {
  const labels = { ready: 'Ready', 'resolution-failed': 'Check recipient', pending: 'Pending approval', approved: 'Approved', sent: 'Sent', failed: 'Failed', unresolved: 'Outcome unknown' };
  return <span className={`status status-${row.status}`}><span className="status-dot" />{labels[row.status]}</span>;
}

function ReceiptPage({ receipt }: { receipt: Receipt | null }) {
  const [copied, setCopied] = useState('');
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.href); setCopied('Link copied'); }
    catch { setCopied('Copy the full link from your browser address bar.'); }
  }
  if (!receipt) return <main id="main" tabIndex={-1} className="receipt-main"><a className="back-link" href="#/">← Back to payroll</a><h1>This receipt cannot be read</h1><p>The link is incomplete or invalid. Ask for the full receipt link, including everything after #.</p></main>;
  return <main id="main" tabIndex={-1} className="receipt-main">
    <a className="back-link no-print" href="#/">← Back to payroll</a>
    <div className="receipt-heading"><div className="receipt-seal"><Icon name="check" size={28}/></div><h1>Payment receipt</h1><p>A record of a testnet payment.</p></div>
    <div className="receipt-amount">{receipt.amount} <span>BDX</span></div>
    <dl className="receipt-data">
      <div><dt>Recipient as entered</dt><dd dir="auto">{receipt.name}</dd></div>
      <div><dt>Full recipient address</dt><dd className="mono" dir="ltr">{receipt.recipient}</dd></div>
      <div><dt>Note</dt><dd className="note" dir="auto">{receipt.note || 'No note'}</dd></div>
      <div><dt>Transaction hash</dt><dd className="mono" dir="ltr">{receipt.txHash}</dd></div>
      <div><dt>Date</dt><dd><time dateTime={receipt.date}>{new Date(receipt.date).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}</time></dd></div>
      <div><dt>Network</dt><dd>Beldex testnet · Test funds</dd></div>
    </dl>
    <p className="receipt-disclaimer">This receipt is supplied by its link and is not independently verified. Anyone with the link can read its contents. It does not prove blockchain confirmation.</p>
    <div className="receipt-actions no-print"><button className="button primary" onClick={() => window.print()}><Icon name="print"/>Print / Save as PDF</button><button className="button secondary" onClick={copyLink}><Icon name="copy"/>Copy link</button></div>
    <p role="status" className="copy-status no-print">{copied}</p>
    <p className="receipt-footer"><Icon name="lock" size={14}/> Receipt data stays in the URL fragment.</p>
  </main>;
}

export default function App() {
  const hash = useHash();
  const [bdx, setBdx] = useState<BeldexWeb3 | null>(null);
  const [wallet, setWallet] = useState<ConnectResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [missingWallet, setMissingWallet] = useState(false);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [reference, setReference] = useState(defaultReference);
  const [options, setOptions] = useState<SendOptions>(initialOptions);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [error, setError] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const csvErrorBox = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pause = useRef(false);
  const busy = useRef(false);
  const fileLoading = useRef(false);
  const connectedTestnet = wallet?.network === 'testnet';
  const paid = review?.rows.filter(r => r.status === 'sent').length ?? 0;
  const complete = !!review && paid === review.rows.length;
  const total = totalAmount(csvRows);
  const canSend = connectedTestnet && !!review && !review.rows.some(r => r.status === 'resolution-failed') && agreed && !sending && !reviewing && !complete;
  const step = review ? (attempted || paid ? 3 : 2) : 1;
  const disabledInputs = sending || reviewing || attempted;

  useEffect(() => {
    if (!bdx) return;
    const invalidate = () => {
      generation.current++; pause.current = true;
      setWallet(null); setAgreed(false);
      setWalletError('The wallet was locked, disconnected or changed. Reconnect and review before continuing.');
    };
    const events = ['accountsChanged', 'networkChanged', 'disconnect', 'lock'] as const;
    for (const event of events) bdx.on(event, invalidate);
    return () => { for (const event of events) bdx.off(event, invalidate); };
  }, [bdx]);

  useEffect(() => {
    if (!sending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    return () => removeEventListener('beforeunload', beforeUnload);
  }, [sending]);

  const guardFor = (version: number) => () => {
    if (generation.current !== version) throw new Error('The wallet changed. Reconnect and review the payroll before continuing.');
  };

  async function connect() {
    if (connecting || sending) return;
    setConnecting(true); setWalletError(''); setMissingWallet(false);
    const version = ++generation.current;
    try {
      if (!window.isSecureContext) throw new Error('Open Belroll over HTTPS to connect the wallet.');
      const provider = await detectProvider({ timeoutMs: 1800 });
      if (!provider) { setMissingWallet(true); throw new Error('Beldex Wallet was not found. Install the extension, open this site over HTTPS, then try again.'); }
      const client = bdx?.provider === provider ? bdx : new BeldexWeb3(provider);
      setBdx(client);
      const result = await client.connect();
      guardFor(version)();
      setWallet(result); setAgreed(false); setReview(null);
      if (result.network !== 'testnet') throw new Error('Switch to Testnet in your Beldex Wallet, then reconnect. Mainnet payroll is blocked.');
      await assertRecoverySupport(client);
      guardFor(version)();
    } catch (e) { setWalletError(paymentError(e)); }
    finally { setConnecting(false); }
  }

  async function disconnect() {
    if (!bdx || sending) return;
    try { await bdx.disconnect(); } catch (e) { setWalletError(paymentError(e)); }
    generation.current++; setWallet(null); setAgreed(false); setReview(null);
  }

  function resetReview() { setReview(null); setAgreed(false); setError(''); setRunMessage(''); }

  async function loadFile(file?: File) {
    if (!file || disabledInputs || fileLoading.current) return;
    fileLoading.current = true;
    setFileBusy(true); resetReview(); setCsvErrors([]); setCsvRows([]); setFileName(file.name);
    try {
      if (file.size > MAX_CSV_BYTES) { setCsvErrors([{ line: 1, message: 'Choose a CSV smaller than 256 KB.' }]); return; }
      const result = parseCsv(await file.text());
      setCsvRows(result.rows); setCsvErrors(result.errors);
      if (result.errors.length) requestAnimationFrame(() => csvErrorBox.current?.focus());
    } catch { setCsvErrors([{ line: 1, message: 'This file could not be read. Save it as a UTF-8 CSV and choose it again.' }]); }
    finally { fileLoading.current = false; setFileBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function reviewPayments() {
    if (!bdx || !wallet || !connectedTestnet || !csvRows.length || reviewing || sending) return;
    setReviewing(true); setError(''); setRunMessage('');
    const version = generation.current;
    try {
      const result = await preparePayments({ bdx, owner: wallet.address, reference, rows: csvRows, options, journal: new PaymentJournal(localStorage), guard: guardFor(version) });
      guardFor(version)(); setReview(result); setAgreed(false);
      if (result.rows.some(r => r.status === 'sent' || r.status === 'unresolved' || r.status === 'failed')) setAttempted(true);
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (e) { setError(paymentError(e)); }
    finally { setReviewing(false); }
  }

  async function sendRun() {
    if (!canSend || !bdx || !wallet || !review || busy.current) return;
    busy.current = true; pause.current = false; setPauseRequested(false); setError(''); setRunMessage('');
    const version = generation.current;
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely lock a payroll run. Use a current desktop browser with Web Locks support.');
      await navigator.locks.request('belroll-payment-run', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another Belroll tab is sending payments. Wait for it to finish, then review this run again.');
        guardFor(version)();
        const journal = new PaymentJournal(localStorage);
        journal.bindRun(review.runKey, review.fingerprint);
        setSending(true); setAttempted(true);
        const sendPayment = createPaymentSender({ bdx, owner: wallet.address, options, journal, guard: guardFor(version), onUpdate: row => {
          setReview(current => current ? { ...current, rows: current.rows.map(r => r.idempotencyKey === row.idempotencyKey ? row : r) } : current);
        } });
        const results = await sendSequentially(review.rows, sendPayment, () => pause.current);
        const stopped = results.find(r => r.status !== 'sent');
        if (stopped) setError(`Payroll stopped at line ${stopped.line}. ${stopped.error ?? 'Check the payment in your wallet before resuming.'}`);
        else if (pause.current) setRunMessage('Payroll paused. Any approved payment has finished; remaining rows have not been requested.');
        else setRunMessage('Every payment was sent. Open a receipt beside each payment.');
      });
    } catch (e) { setError(paymentError(e)); }
    finally { setSending(false); busy.current = false; }
  }

  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setCsvErrors([{ line: 1, message: 'Choose one CSV file at a time.' }]); return; } void loadFile(event.dataTransfer.files[0]); }

  function receiptFor(row: PaymentRow) {
    return receiptFragment({ version: 1, recipient: row.address, name: row.recipient, amount: row.amount, note: row.note, txHash: row.txHash!, date: row.sentAt!, network: 'testnet', asset: 'BDX' });
  }

  function newPayroll() {
    if (sending) return;
    setCsvRows([]); setFileName(''); setCsvErrors([]); setAttempted(false); setReference(''); resetReview();
  }

  const receiptRoute = hash.startsWith('#/receipt/');
  return <div className={`app-shell ${receiptRoute ? 'receipt-shell' : ''}`}>
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to {receiptRoute ? 'receipt' : 'payroll'}</a>
    <aside className="sidebar no-print">
      <Logo/>
      <div className="workspace-label"><span className="workspace-mark"><Icon name="grid" size={16}/></span><span>Payroll workspace</span></div>
      <nav aria-label="Main navigation"><a href="#/" className={!receiptRoute ? 'nav-item active' : 'nav-item'}><Icon name="plus"/>New payroll</a><a href={receiptRoute ? '#/' : '#how-it-works'} className="nav-item"><Icon name="file"/>How it works<Icon name="chevron" size={14}/></a></nav>
      <div className="sidebar-bottom"><div className="local-mark"><Icon name="lock" size={18}/></div><strong>Local by design.</strong><p>Your CSV stays in your browser.</p><a href={receiptRoute ? '#/' : '#about'} className="sidebar-about">About Belroll <Icon name="external" size={14}/></a></div>
    </aside>
    <div className="app-body">
      <header className="topbar no-print"><div className="mobile-brand"><Logo/></div><div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={14}/><span>{receiptRoute ? 'Receipt' : 'New payroll'}</span></div><div className="topbar-end"><span className="testnet-badge"><span/>TESTNET</span><span className="prototype-label">Prototype</span></div></header>
      {receiptRoute ? <ReceiptPage key={hash} receipt={readReceipt(hash)}/> : <main id="main" tabIndex={-1} className="workspace">
        <div className="page-heading"><div><h1>Payroll. With privacy.</h1><p>Pay your team on Beldex testnet. Your wallet stays in control.</p></div><span className="private-label"><Icon name="lock" size={14}/>Client-side only</span></div>
        <ol className="steps" aria-label="Payroll progress">{['Upload CSV', 'Review payments', 'Send & receipts'].map((label, i) => <li key={label} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}><span className="step-number">{step > i + 1 ? <Icon name="check" size={14}/> : i + 1}</span><span>{label}</span>{i < 2 && <span className="step-line"/>}</li>)}</ol>
        <section className={`wallet-strip ${connectedTestnet ? 'is-connected' : ''}`} aria-labelledby="wallet-title">
          <div className="wallet-symbol"><Icon name="wallet" size={22}/></div><div className="wallet-copy"><h2 id="wallet-title">{connectedTestnet ? 'Wallet connected' : wallet ? 'Testnet wallet required' : 'Connect your Beldex Wallet'}</h2>{wallet ? <><span className="wallet-network">Beldex {wallet.network}</span><span className="wallet-short mono">{wallet.address.slice(0, 10)}…{wallet.address.slice(-8)}</span><details className="wallet-address"><summary>View full wallet address</summary><p className="mono" dir="ltr">{wallet.address}</p></details></> : <p>Connect a testnet wallet before reviewing payments.</p>}</div>
          {wallet && connectedTestnet ? <button className="button secondary compact" disabled={sending} onClick={disconnect}>Disconnect</button> : <button className="button primary" onClick={connect} disabled={connecting || sending}><Icon name="wallet"/>{connecting ? 'Connecting…' : wallet ? 'Reconnect wallet' : 'Connect Wallet'}{!connecting && <Icon name="arrow" size={16}/>}</button>}
        </section>
        {walletError && <div className="notice warning" role="alert"><Icon name="info"/><div>{walletError}{missingWallet && <p><a href={WALLET_INSTALL_URL} target="_blank" rel="noreferrer">Install Beldex Wallet <Icon name="external" size={14}/></a><span className="install-help">After installing, reload this HTTPS page.</span></p>}{wallet && <button className="text-button" onClick={connect} disabled={connecting || sending}>Check wallet again</button>}</div></div>}
        <div className="workspace-grid"><div className="payroll-column">
          <section className="upload-panel" aria-labelledby="upload-title"><div className="section-heading"><div><h2 id="upload-title">{review ? 'Payroll file' : 'Upload your payroll'}</h2><p>One CSV. One payment per row.</p></div><a className="text-link sample-link" href="./sample-payroll.csv" download="belroll-sample.csv"><Icon name="download" size={16}/><span>Download sample CSV</span></a></div>
            <input className="visually-hidden" id="csv-file" type="file" accept=".csv,text/csv" ref={fileInput} tabIndex={-1} disabled={disabledInputs} aria-label="Payroll CSV file" onChange={event => void loadFile(event.target.files?.[0])}/>
            {fileName && csvRows.length ? <div className="loaded-file"><span className="file-symbol"><Icon name="file" size={24}/></span><div><strong dir="auto">{fileName}</strong><p>{csvRows.length} {csvRows.length === 1 ? 'payment' : 'payments'} · CSV validated</p></div>{!disabledInputs && <button className="button secondary compact" onClick={() => fileInput.current?.click()}>Replace CSV</button>}<Icon name="check" className="success-ink"/></div> : <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabledInputs) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
              <div className="file-illustration" aria-hidden="true"><span className="file-back"/><div className="file-front"><Icon name="file" size={32}/><span className="csv-label">.csv</span></div></div>
              <h3>{fileBusy ? 'Reading your CSV…' : 'Drop your payroll CSV here'}</h3><p>or choose a file from your device</p><button className="button secondary" onClick={() => fileInput.current?.click()} disabled={disabledInputs || fileBusy}><Icon name="upload" size={16}/>Choose CSV</button><span className="file-limit">Up to 500 payments · 256 KB max</span>
            </div>}
            {csvErrors.length > 0 && <div className="csv-errors notice danger" role="alert" tabIndex={-1} ref={csvErrorBox}><strong>Fix {csvErrors.length} {csvErrors.length === 1 ? 'issue' : 'issues'} and upload again</strong><ul>{csvErrors.map((item, i) => <li key={i}><strong>Line {item.line}:</strong> {item.message}</li>)}</ul><p>No rows were accepted. Nothing was sent.</p></div>}
            <div className="csv-format"><Icon name="info" size={16}/><p>Required columns: <code>recipient,amount,note</code><br/><span>Use a .bdx name or full Beldex address.</span></p></div>
            {csvRows.length > 0 && <div className="run-settings"><div className="field"><label htmlFor="run-reference">Pay run reference</label><input id="run-reference" name="reference" autoComplete="off" maxLength={120} value={reference} disabled={disabledInputs} onChange={event => { setReference(event.target.value); resetReview(); }}/><p>Keep this reference and the same CSV to resume. Use a new reference only for a separate payroll.</p></div><div className="send-fields"><div className="field"><label htmlFor="asset">Send asset</label><select id="asset" value="BDX" disabled={disabledInputs} onChange={() => {}}><option value="BDX">BDX (testnet)</option></select></div><div className="field"><label htmlFor="priority">Priority</label><select id="priority" value={options.priority} disabled={disabledInputs || options.flash} onChange={event => { setOptions({ ...options, priority: Number(event.target.value) as SendOptions['priority'] }); resetReview(); }}><option value="1">Normal</option><option value="2">Level 2</option><option value="3">Level 3</option><option value="4">Level 4</option></select></div></div><label className="checkbox-line"><input type="checkbox" checked={options.flash} disabled={disabledInputs} onChange={event => { setOptions({ ...options, flash: event.target.checked }); resetReview(); }}/><span>Use Flash instant confirmation<span className="field-hint">May increase the BDX network fee.</span></span></label><p className="asset-note">This prototype sends testnet BDX. Privacy token sends are not available yet.</p></div>}
            {csvRows.length > 0 && !review && <div className="review-next"><p>{connectedTestnet ? 'Resolve names and check every payment before sending.' : 'Connect a testnet wallet to continue.'}</p><button className="button primary" onClick={reviewPayments} disabled={!connectedTestnet || reviewing || !reference.trim()}>{reviewing ? 'Resolving recipients…' : 'Review payments'}<Icon name="arrow" size={16}/></button></div>}
          </section>
          {review && <section className="review-panel" aria-labelledby="review-title"><div className="section-heading"><div><h2 id="review-title" tabIndex={-1} ref={reviewHeading}>{complete ? 'Payroll sent' : 'Review payments'}</h2><p>{complete ? `${paid} payments sent from your wallet.` : 'Check the full address and amount for every recipient.'}</p></div>{!attempted && <button className="button secondary compact" onClick={resetReview} disabled={sending}>Edit payroll</button>}</div>
            <div className="review-totals"><span>{review.rows.length} {review.rows.length === 1 ? 'payment' : 'payments'}</span><span>Total <strong>{total} BDX</strong><span className="fee-caption"> + network fees</span></span></div>
            <div className="review-notice"><Icon name="info" size={16}/><p>Names are resolved by your wallet, without an on-chain proof. Notes stay in this browser and receipt links.</p></div>
            <table className="payment-table" role="table"><caption className="visually-hidden">Every payroll payment, its full resolved address, amount, note and send status</caption><thead><tr role="row"><th scope="col">Recipient / Full address</th><th scope="col">Amount</th><th scope="col">Note</th><th scope="col">Status</th></tr></thead><tbody>{review.rows.map((row, i) => <tr key={row.idempotencyKey} role="row"><td className="recipient-cell" role="cell"><div className="recipient-name"><span className="row-number">{String(i + 1).padStart(2, '0')}</span><strong dir="auto">{row.recipient}</strong>{isBns(row.recipient) && <span className="bns-label">BNS</span>}</div><span className="mobile-label">Full address</span><span className="full-address mono" dir="ltr">{row.address || 'Not resolved'}</span><details className="payment-key"><summary>Payment key</summary><code>{row.idempotencyKey}</code></details></td><td role="cell" className="amount-cell"><span className="mobile-label">Amount</span><strong>{row.amount}</strong><span> BDX</span></td><td role="cell" className="note-cell"><span className="mobile-label">Note</span><span dir="auto">{row.note || 'No note'}</span></td><td role="cell" className="status-cell"><Status row={row}/>{row.status === 'pending' && <span className="status-hint">Review in your wallet</span>}{row.status === 'sent' && row.txHash && <><span className="status-hint">Approved in wallet</span><span className="tx-label">Transaction hash</span><code className="tx-hash">{row.txHash}</code><a className="receipt-link" href={receiptFor(row)} target="_blank" rel="noreferrer"><Icon name="receipt" size={14}/>View receipt</a></>}{row.error && <p className="row-error">{row.error}</p>}</td></tr>)}</tbody></table>
            <div className="send-footer">{complete ? <div className="completion"><span className="completion-mark"><Icon name="check"/></span><div><strong>Payroll complete</strong><p>{paid} of {review.rows.length} sent. Receipts are ready.</p></div><button className="button secondary" onClick={newPayroll}>Start new payroll</button></div> : <><p className="send-explainer"><Icon name="lock" size={16}/>Each payment needs a separate approval in your wallet. Sending stops at the first failure.</p><p className="send-total">Remaining to send: <strong>{totalAmount(review.rows.filter(r => r.status !== 'sent'))} BDX</strong> + network fees</p><label className="checkbox-line confirm-line"><input type="checkbox" checked={agreed} disabled={sending || !connectedTestnet || review.rows.some(r => r.status === 'resolution-failed')} onChange={event => setAgreed(event.target.checked)}/><span>I checked every full address and amount. These are test funds.</span></label><div className="send-action-row"><span>{paid} of {review.rows.length} payments sent</span>{sending ? <button className="button secondary" disabled={pauseRequested} onClick={() => { pause.current = true; setPauseRequested(true); }}><Icon name="pause"/>{pauseRequested ? 'Pausing after this payment…' : 'Pause after this payment'}</button> : <button className="button primary" disabled={!canSend} onClick={sendRun}>{attempted ? 'Resume remaining payments' : 'Confirm and send'}<Icon name="arrow" size={16}/></button>}</div></>}</div>
          </section>}
          {error && <div className="notice danger" role="alert"><Icon name="info"/><div>{error}</div></div>}
          {runMessage && <div className="notice success" role="status"><Icon name="check"/><span>{runMessage}</span></div>}
          <section id="how-it-works" className="how-it-works" aria-labelledby="how-title"><h2 id="how-title">A clear path to payday</h2><div className="how-grid"><div><span className="how-number">01</span><h3>Bring your CSV</h3><p>Add recipients, amounts and notes. Your file stays on this device.</p></div><div><span className="how-number">02</span><h3>Review every detail</h3><p>Check resolved names, full addresses and the payroll total.</p></div><div><span className="how-number">03</span><h3>Approve in your wallet</h3><p>Send one payment at a time, then share a receipt if needed.</p></div></div></section>
        </div><aside className="run-summary" aria-labelledby="summary-title"><div className="summary-heading"><Icon name="receipt" size={18}/><h2 id="summary-title">Run summary</h2></div><div className="summary-total"><span>Total payroll</span><div><strong>{csvRows.length ? total : '0.00'}</strong><span>BDX</span></div><span>Excludes network fees</span></div><dl className="summary-details"><div><dt>Payments</dt><dd>{csvRows.length}</dd></div>{review && <div><dt>Sent</dt><dd>{paid} of {review.rows.length}</dd></div>}<div><dt>Network</dt><dd><span className="network-dot"/>Beldex testnet</dd></div><div><dt>Asset</dt><dd>Testnet BDX</dd></div><div><dt>Priority</dt><dd>{options.flash ? 'Flash' : options.priority === 1 ? 'Normal' : `Level ${options.priority}`}</dd></div></dl><div className="summary-note"><Icon name="info" size={16}/><p>Network fees are paid in BDX and shown in your wallet before you approve.</p></div><div className="privacy-note"><Icon name="lock" size={18}/><div><strong>Private from the start</strong><p>No uploads. No analytics. No payroll server.</p></div></div></aside></div>
        <details id="about" className="about-box"><summary><Icon name="info" size={18}/><span>About Belroll</span><Icon name="chevron" size={16}/></summary><div><p>Belroll runs on Beldex testnet with test funds. It is a client-side payroll prototype, not a production payroll service.</p><p>Your CSV, notes and recipient list stay in this browser. Only wallet requests leave the page through the Beldex Wallet extension. The extension may contact its own network and BNS resolver. It only injects on HTTPS pages.</p><p>A small local journal stores payment keys, transaction hashes and timestamps so this browser can resume the same run. Keep your browser data, origin, CSV, reference and send settings unchanged. An uncertain payment older than 12 hours is blocked from automatic resend. Clearing storage or using another device loses this protection.</p><p>Receipt links contain readable payment details in their URL fragment. Anyone you share a link with can read those details. Links are records supplied by their creator, not independent proof of payment. Notes are not sent on-chain.</p><p>Privacy token sends are a TODO: the bundled SDK exposes BDX only. Normal uses the wallet’s default priority; Flash uses its instant-confirmation priority. No other transaction options are implied.</p></div></details>
        <footer className="workspace-footer"><span><span className="footer-dot"/>Your data stays in your browser</span><span>Built for Beldex testnet <Icon name="lock" size={13}/></span></footer>
      </main>}
    </div>
  </div>;
}
