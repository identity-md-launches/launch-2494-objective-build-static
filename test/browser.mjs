// Production-export tests. A wallet transport is injected ONLY into browser test
// contexts; the production app contains no demo provider or simulated payments.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';

const { chromium, webkit } = await import(process.env.IMD_PLAYWRIGHT ? pathToFileURL(process.env.IMD_PLAYWRIGHT).href : 'playwright');
const scratch = resolve('test/scratch/browser');
await mkdir(scratch, { recursive: true });
const root = resolve('dist');
const serverRequests = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv' };
const server = createServer(async (req, res) => {
  try {
    serverRequests.push(req.url);
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!pathname.startsWith('/preview/')) { res.writeHead(404).end(); return; }
    const file = resolve(root, pathname.slice('/preview/'.length) || 'index.html');
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const results = [];
let browser;
const runtimeErrors = [], foreignRequests = [], resourceFailures = [];
const destination = 'bx' + 'A'.repeat(95), owner = 'bx' + 'B'.repeat(95), direct = 'bx' + 'C'.repeat(95);
const csv = `recipient,amount,note\nalice.bdx,0.1,"Salary, October"\n${direct},0.2,"日本語 <script>window.__xss=1</script>"\nsam.bdx,0.000000001,Bonus`;
const reference = 'Browser validation payroll';

function installMock({ nettype = 'testnet', failAt = 0, unknownAt = 0, delay = 50, capability = true } = {}) {
  const owner = 'bx' + 'B'.repeat(95), destination = 'bx' + 'A'.repeat(95);
  const listeners = new Map();
  const state = { nettype, requests: [], outcomes: {}, failAt, unknownAt, delay, capability, printed: 0, maxActive: 0, active: 0 };
  window.__belrollTest = state;
  window.print = () => { state.printed++; };
  const provider = {
    isBeldex: true,
    on(event, fn) { const set = listeners.get(event) || new Set(); set.add(fn); listeners.set(event, set); },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    async request({ method, params }) {
      if (method === 'bdx_connect') return { address: owner, network: state.nettype };
      if (method === 'bdx_disconnect') return {};
      if (method === 'bdx_getNetwork') return { nettype: state.nettype, height: 100, protocolVersion: 1, walletVersion: '1.2.0' };
      if (method === 'bdx_getAddress') return { address: owner };
      if (method === 'bdx_getOperationStatus') { if (!state.capability) throw { code: -32601, message: 'unsupported' }; return { status: 'unknown' }; }
      if (method === 'bdx_resolveBns') { if (params.name === 'unresolved.bdx') throw { code: -32603, message: 'not found' }; return { name: params.name, address: destination, verified: false }; }
      if (method === 'bdx_sendTransaction') {
        state.requests.push(params);
        const saved = state.outcomes[params.idempotencyKey];
        if (saved) return { ...saved, idempotent: true };
        state.active++; state.maxActive = Math.max(state.active, state.maxActive);
        await new Promise(r => setTimeout(r, state.delay));
        state.active--;
        if (state.requests.length === state.failAt) throw { code: 4001, message: 'declined' };
        const result = { txHash: (Object.keys(state.outcomes).length + 1).toString(16).padStart(64, '0'), fee: '1000', operationId: 'op-' + state.requests.length };
        state.outcomes[params.idempotencyKey] = result;
        if (state.requests.length === state.unknownAt) throw { code: 4998, message: 'unknown outcome' };
        return result;
      }
      throw { code: -32601, message: 'unknown method' };
    },
  };
  window.__emitWalletEvent = (event, data) => { for (const fn of listeners.get(event) || []) fn(data); };
  window.beldex = provider;
  window.addEventListener('beldex:requestProvider', () => window.dispatchEvent(new CustomEvent('beldex:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Simulated test wallet', icon: '', rdns: 'test.belroll' }, provider } })));
}

async function waitUntil(check, message, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(message);
}
async function scenario(name, fn) {
  const started = Date.now(); await fn(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`);
}
async function contextWithMock(config = {}, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  observeContext(context);
  await context.addInitScript(installMock, config);
  const page = await context.newPage();
  await page.goto(url); return { context, page };
}
function observeContext(context) {
  context.on('page', page => {
    page.on('pageerror', error => runtimeErrors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(url)) foreignRequests.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400) resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  });
}
async function connectAndLoad(page, file = csv) {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByRole('heading', { name: 'Wallet connected' }).waitFor();
  await page.locator('#csv-file').setInputFiles({ name: 'october-payroll.csv', mimeType: 'text/csv', buffer: Buffer.from(file) });
  await page.locator('#run-reference').fill(reference);
}
async function reviewAndAgree(page) {
  await page.getByRole('button', { name: 'Review payments', exact: true }).click();
  await page.getByRole('heading', { name: 'Review payments', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'I checked every full address' }).check();
}
async function assertNoOverflow(page, widths = [320, 390, 720, 980, 1440]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `horizontal overflow at ${width}`);
  }
}
async function tabTo(page, locator) {
  for (let i = 0; i < 50; i++) {
    if (await locator.evaluate(el => document.activeElement === el)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Could not reach the control with Tab');
}

try {
  browser = await chromium.launch({ headless: true });

  await scenario('production export, first mobile screen, sample download, no-wallet recovery and keyboard entry', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    observeContext(context);
    const page = await context.newPage(); await page.goto(url);
    await page.keyboard.press('Tab');
    assert.match(await page.locator(':focus').textContent(), /Skip to payroll/);
    await page.keyboard.press('Enter'); assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
    const connect = page.getByRole('button', { name: 'Connect Wallet', exact: true });
    const box = await connect.boundingBox(); assert.ok(box.y + box.height < 844, 'main action is on the first screen');
    await page.screenshot({ path: resolve(scratch, '390-initial.png'), fullPage: false });
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download sample CSV' }).click()]);
    await download.saveAs(resolve(scratch, 'sample.csv'));
    assert.match(await readFile(resolve(scratch, 'sample.csv'), 'utf8'), /^recipient,amount,note/);
    await connect.click(); await page.getByRole('link', { name: 'Install Beldex Wallet' }).waitFor();
    assert.match(await page.getByRole('alert').textContent(), /HTTPS/);
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(scan.violations.map(v => ({ id: v.id, nodes: v.nodes.length })), []);
    await assertNoOverflow(page); await context.close();
  });

  await scenario('mainnet is shown and review/send are blocked', async () => {
    const { page, context } = await contextWithMock({ nettype: 'mainnet' });
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('heading', { name: 'Testnet wallet required' }).waitFor();
    await page.locator('#csv-file').setInputFiles({ name: 'pay.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    assert.equal(await page.getByRole('button', { name: 'Review payments', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 0);
    await context.close();
  });

  await scenario('complete payment workflow with a simulated SDK transport', async () => {
    const { page, context } = await contextWithMock({ failAt: 2, delay: 150 }, { width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('heading', { name: 'Wallet connected' }).waitFor();
    await page.getByText('View full wallet address').click(); assert.equal(await page.locator('.wallet-address p').textContent(), owner);
    await page.locator('#csv-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('recipient,amount,note\na.bdx,1,ok\nb.bdx,-1,bad') });
    await page.getByRole('alert').filter({ hasText: 'Line 3:' }).waitFor();
    await waitUntil(() => page.locator('.csv-errors').evaluate(el => document.activeElement === el), 'CSV errors did not receive focus');
    assert.equal(await page.getByRole('button', { name: 'Review payments', exact: true }).count(), 0);
    await page.locator('#csv-file').setInputFiles({ name: 'october-payroll.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.locator('#run-reference').fill(reference);
    assert.equal(await page.locator('.summary-total strong').textContent(), '0.300000001');
    await page.getByRole('checkbox', { name: 'Use Flash' }).check();
    await page.getByRole('button', { name: 'Review payments', exact: true }).click();
    await page.getByRole('heading', { name: 'Review payments', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 0);
    assert.equal(await page.locator('.full-address').nth(0).textContent(), destination);
    assert.equal(await page.locator('.full-address').nth(1).textContent(), direct);
    assert.equal(await page.getByRole('button', { name: 'Confirm and send' }).isDisabled(), true);
    await assertNoOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#review-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(scratch, '390-review.png'), fullPage: true });
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(scan.violations.map(v => ({ id: v.id, nodes: v.nodes.length })), []);
    await page.getByRole('checkbox', { name: 'I checked every full address' }).check();
    await page.getByRole('button', { name: 'Confirm and send' }).click();
    await page.getByText('Pending approval', { exact: true }).first().waitFor();
    await page.getByRole('alert').filter({ hasText: 'Payroll stopped at line 3' }).waitFor();
    let state = await page.evaluate(() => window.__belrollTest);
    assert.equal(state.requests.length, 2); assert.equal(state.maxActive, 1);
    assert.equal(state.requests[0].amount, '100000000'); assert.equal(state.requests[0].priority, 5);
    assert.equal('note' in state.requests[0], false); assert.equal('flash' in state.requests[0], false);
    await page.getByRole('button', { name: 'Resume remaining payments' }).click();
    await page.getByRole('heading', { name: 'Payroll sent' }).waitFor();
    state = await page.evaluate(() => window.__belrollTest);
    assert.equal(state.requests.length, 4); assert.equal(Object.keys(state.outcomes).length, 3);
    assert.equal(state.requests[1].idempotencyKey, state.requests[2].idempotencyKey);
    assert.equal(await page.locator('.tx-hash').count(), 3);
    await assertNoOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#review-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(scratch, '1440-sent.png'), fullPage: true });
    const [receipt] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'View receipt' }).nth(1).click()]);
    await receipt.waitForLoadState(); await receipt.getByRole('heading', { name: 'Payment receipt' }).waitFor();
    assert.ok(receipt.url().includes('#/receipt/'));
    assert.equal(new URL(receipt.url()).search, '');
    assert.match(await receipt.locator('.receipt-data').textContent(), /日本語 <script>window.__xss=1<\/script>/);
    assert.equal(await receipt.evaluate(() => window.__xss), undefined);
    await receipt.getByRole('button', { name: 'Copy link' }).click(); await receipt.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
    assert.equal(await receipt.evaluate(() => navigator.clipboard.readText()), receipt.url());
    await receipt.getByRole('button', { name: 'Print / Save as PDF' }).click();
    assert.equal(await receipt.evaluate(() => window.__belrollTest.printed), 1);
    await assertNoOverflow(receipt);
    await receipt.setViewportSize({ width: 390, height: 844 });
    await receipt.screenshot({ path: resolve(scratch, '390-receipt.png'), fullPage: true });
    const receiptScan = await new AxeBuilder({ page: receipt }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(receiptScan.violations.map(v => ({ id: v.id, nodes: v.nodes.length })), []);
    await receipt.emulateMedia({ media: 'print' });
    assert.equal(await receipt.locator('.receipt-actions').isVisible(), false);
    await receipt.pdf({ path: resolve(scratch, 'receipt.pdf'), format: 'A4', printBackground: false });
    await receipt.emulateMedia({ media: 'screen' });
    await receipt.goto(url + '#/receipt/invalid'); await receipt.getByRole('heading', { name: 'This receipt cannot be read' }).waitFor();
    await receipt.close();
    await page.reload(); await connectAndLoad(page); await page.getByRole('checkbox', { name: 'Use Flash' }).check();
    await page.getByRole('button', { name: 'Review payments', exact: true }).click(); await page.getByRole('heading', { name: 'Payroll sent' }).waitFor();
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 0, 'reloaded page sent nothing');
    assert.ok(serverRequests.every(path => !path.includes('#') && !path.includes('Salary') && !path.includes('alice.bdx')));
    await context.close();
  });

  await scenario('unknown broadcast stops the run and resumes with the same idempotency key', async () => {
    const { context, page } = await contextWithMock({ unknownAt: 1 });
    await connectAndLoad(page); await reviewAndAgree(page);
    await page.getByRole('button', { name: 'Confirm and send' }).click();
    await page.getByText('Outcome unknown', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 1);
    await page.getByRole('button', { name: 'Resume remaining payments' }).click();
    await page.getByRole('heading', { name: 'Payroll sent' }).waitFor();
    const s = await page.evaluate(() => window.__belrollTest);
    assert.equal(Object.keys(s.outcomes).length, 3); assert.equal(s.requests[0].idempotencyKey, s.requests[1].idempotencyKey);
    await context.close();
  });

  await scenario('pause, cross-tab locking and wallet account-change invalidation', async () => {
    const { context, page } = await contextWithMock({ delay: 900 });
    await connectAndLoad(page); await reviewAndAgree(page);
    const second = await context.newPage(); await second.goto(url); await connectAndLoad(second); await reviewAndAgree(second);
    await page.getByRole('button', { name: 'Confirm and send' }).click();
    await page.getByText('Pending approval', { exact: true }).waitFor();
    await second.getByRole('button', { name: 'Confirm and send' }).click();
    await second.getByRole('alert').filter({ hasText: 'Another Belroll tab' }).waitFor();
    assert.equal(await second.evaluate(() => window.__belrollTest.requests.length), 0);
    await page.getByRole('button', { name: 'Pause after this payment', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Payroll paused' }).waitFor();
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 1);
    await page.evaluate(() => window.__emitWalletEvent('accountsChanged', { address: null }));
    await page.getByRole('heading', { name: 'Connect your Beldex Wallet' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume remaining payments' }).isDisabled(), true);
    await context.close();
  });

  await scenario('BNS failure has a row error and blocks confirmation', async () => {
    const { context, page } = await contextWithMock();
    await connectAndLoad(page, 'recipient,amount,note\nunresolved.bdx,1,Wrong name');
    await page.getByRole('button', { name: 'Review payments', exact: true }).click();
    await page.getByText('Check recipient', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm and send' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__belrollTest.requests.length), 0);
    await context.close();
  });

  await scenario('longest supported values, 200 percent text enlargement and reduced motion remain usable', async () => {
    const { context, page } = await contextWithMock();
    const longest = `recipient,amount,note\n${'bx' + 'A'.repeat(108)},18446744073.709551615,${'長い注記'.repeat(500)}`;
    await connectAndLoad(page, longest);
    await page.locator('#run-reference').fill('A'.repeat(120));
    await page.getByRole('button', { name: 'Review payments', exact: true }).click();
    await page.getByRole('heading', { name: 'Review payments', exact: true }).waitFor();
    await assertNoOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      for (const [name, size] of Object.entries({ xs: 24, sm: 28, body: 32, lg: 40, title: 56, display: 80 }))
        document.documentElement.style.setProperty('--text-' + name, size + 'px');
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '200 percent text enlargement overflows');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const transition = await page.getByRole('button', { name: 'Confirm and send' }).evaluate(el => getComputedStyle(el).transitionDuration);
    assert.equal(transition, '0s');
    await page.screenshot({ path: resolve(scratch, '390-enlarged.png'), fullPage: false });
    await context.close();
  });

  await scenario('keyboard-only primary controls, visible focus, local fonts and RTL reflow', async () => {
    const { context, page } = await contextWithMock();
    await tabTo(page, page.getByRole('button', { name: 'Connect Wallet', exact: true }));
    await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Wallet connected' }).waitFor();
    await tabTo(page, page.getByRole('button', { name: 'Choose CSV', exact: true }));
    assert.equal(await page.locator('#csv-file').isEnabled(), true);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')]);
    await chooser.setFiles({ name: 'keyboard-payroll.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await tabTo(page, page.locator('#run-reference'));
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('Keyboard payroll');
    const reviewButton = page.getByRole('button', { name: 'Review payments', exact: true });
    await tabTo(page, reviewButton);
    assert.equal(await reviewButton.evaluate(el => getComputedStyle(el).outlineWidth), '2px');
    await page.screenshot({ path: resolve(scratch, '390-keyboard-focus.png'), fullPage: false });
    await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Review payments', exact: true }).waitFor();
    await tabTo(page, page.getByRole('checkbox', { name: 'I checked every full address' })); await page.keyboard.press('Space');
    await tabTo(page, page.getByRole('button', { name: 'Confirm and send', exact: true })); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Payroll sent' }).waitFor();
    assert.equal(await page.evaluate(() => document.fonts.check('14px "Manrope Variable"')), true);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await assertNoOverflow(page, [320, 390, 1440]);
    await context.close();
  });

  await scenario('no application errors or remote requests in all Chromium interactions', async () => {
    assert.deepEqual(runtimeErrors, []); assert.deepEqual(foreignRequests, []); assert.deepEqual(resourceFailures, []);
  });

  // Rasterize the authored share SVG locally; no hosted image service or asset.
  if (process.argv.includes('--render-share')) {
    const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await card.goto(url + 'share.svg'); await card.screenshot({ path: resolve('public/share.png') }); await card.close();
  }

  let webkitResult;
  try {
    const safari = await webkit.launch({ headless: true });
    const context = await safari.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(installMock, {});
    const page = await context.newPage(); await page.goto(url); await connectAndLoad(page); await reviewAndAgree(page);
    await page.getByRole('button', { name: 'Confirm and send' }).click(); await page.getByRole('heading', { name: 'Payroll sent' }).waitFor();
    await assertNoOverflow(page, [320, 390, 1440]);
    webkitResult = { passed: true, scope: 'connect, CSV, review, sending and reflow with simulated wallet' };
    await safari.close();
  } catch (error) { webkitResult = { passed: false, limitation: error.message.split('\n')[0] }; }
  const report = { results, webkit: webkitResult, screenshots: ['390-initial.png', '390-review.png', '1440-sent.png', '390-receipt.png'], liveWalletTested: false };
  await writeFile(resolve(scratch, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(resolve(scratch, 'failure.txt'), error.stack || String(error));
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await new Promise(r => server.close(r));
}
