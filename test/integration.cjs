const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, scryptSync } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const path = require('node:path');

test('Katyol: auth, roles, warehouse preparation and payment concurrency', { timeout: 300000 }, async t => {
  const baseUrl = new URL(process.env.DATABASE_URL);
  const name = `katyol_test_${Date.now()}`;
  const adminUrl = new URL(baseUrl); adminUrl.pathname = '/postgres';
  const adminDb = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  let child; let db; let web;
  try {
    await adminDb.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    baseUrl.pathname = `/${name}`;
    const env = { ...process.env, DATABASE_URL: baseUrl.toString(), PORT: '3101', FRONTEND_ORIGIN: 'http://127.0.0.1:3100', JWT_SECRET: 'integration-test-secret-which-is-long-enough-123' };
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env, stdio: 'pipe' });
    db = new PrismaClient({ datasourceUrl: baseUrl.toString() });
    const password = 'Test-password-2026!'; const salt = 'integration-test-salt';
    await db.user.create({ data: { name: 'Test Admin', phone: '+998900000099', role: 'ADMIN', passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}` } });
    child = spawn(process.execPath, ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
    for (let i = 0; i < 600; i++) {
      try { if ((await fetch('http://127.0.0.1:3101/api/health')).ok) break; } catch {}
      if (child.exitCode !== null || i === 599) throw new Error(`Test API did not start (exit ${child.exitCode}): ${logs}`);
      await new Promise(r => setTimeout(r, 100));
    }
    async function request(route, cookie = '', method = 'GET', body) {
      const res = await fetch(`http://127.0.0.1:3101/api/${route}`, { method, headers: { 'Content-Type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await res.json();
      return { status: res.status, data, cookie: res.headers.getSetCookie().map(x => x.split(';')[0]).join('; ') };
    }
    async function ok(route, cookie, method, body) { const r = await request(route, cookie, method, body); assert.ok(r.status < 300, `${method ?? 'GET'} ${route}: ${JSON.stringify(r.data)}`); return r.data; }
    const login = await request('auth/login', '', 'POST', { phone: '+998900000099', password }); assert.equal(login.status, 201); const admin = login.cookie;
    await t.test('auth and input validation', async () => {
      assert.equal((await request('orders')).status, 401);
      assert.equal((await request('auth/login', '', 'POST', { phone: '+998900000099', password: 'wrongpass' })).status, 401);
      assert.equal((await request('products', admin, 'POST', { name: 'x', costPrice: '-1' })).status, 400);
    });
    const users = {};
    for (const [i, role] of ['DEALER', 'DEALER', 'WAREHOUSE', 'DELIVERY_INSTALLER', 'ACCOUNTANT'].entries()) {
      const phone = `+99890000010${i}`; const created = await ok('users', admin, 'POST', { name: `Test ${role} ${i}`, phone, role, password });
      const session = await request('auth/login', '', 'POST', { phone, password }); assert.equal(session.status, 201); users[i] = { ...created, cookie: session.cookie };
    }
    const [dealer1, dealer2, warehouse, driver, accountant] = Object.values(users);
    const dealerRecord = await db.dealer.findUniqueOrThrow({ where: { userId: dealer1.id } });
    const category = await ok('categories', admin, 'POST', { name: 'Test category' });
    const wh = await ok('warehouses', admin, 'POST', { name: 'Test warehouse', address: 'Test address' });
    const product = await ok('products', admin, 'POST', { name: 'Test boiler', model: 'TEST-24', categoryId: category.id, powerKw: 24, costPrice: '50.00', dealerPrice: '80.00', salePrice: '100.00' });
    const customer = await ok('customers', dealer1.cookie, 'POST', { firstName: 'Test', lastName: 'Customer', phone: '+998911234567', region: 'Toshkent', district: 'Chilonzor', address: 'Test address' });
    const orderData = { customerId: customer.id, warehouseId: wh.id, address: customer.address, phone: customer.phone, items: [{ productId: product.id, quantity: 1, salePrice: '100.00' }] };
    const order = await ok('orders', dealer1.cookie, 'POST', orderData);
    await t.test('inline customer, deposit ledger and rollback', async () => {
      const input = { phone: customer.phone, address: 'Toshkent, Chilonzor', customer: { firstName: 'Inline', lastName: 'Customer', phone: customer.phone, region: 'Toshkent', district: 'Chilonzor', address: 'Toshkent, Chilonzor' }, orderDate: '2026-10-09T07:00:00.000Z', deposit: '30', items: orderData.items };
      const before = await db.customer.count();
      assert.equal((await request('orders', admin, 'POST', { ...input, deposit: '101' })).status, 400);
      assert.equal(await db.customer.count(), before);
      const created = await ok('orders', admin, 'POST', input);
      const detail = await ok(`orders/${created.id}`, admin);
      assert.equal(detail.customer.firstName, 'Inline');
      assert.equal(detail.dealer.user.phone, '+998900000099');
      assert.equal(detail.warehouseId, wh.id);
      assert.equal(detail.items[0].dealerPrice, undefined);
      assert.equal(detail.createdAt, input.orderDate);
      assert.equal(detail.totalAmount, '100'); assert.equal(detail.paid, '30'); assert.equal(detail.debt, '70');
      assert.equal(detail.deliveryPrice, '0'); assert.equal(detail.installationPrice, '0');
      const ledger = await db.dealerTransaction.findMany({ where: { orderId: created.id } });
      assert.equal(ledger.reduce((sum, row) => sum + Number(row.amount), 0), 70);
      assert.equal((await request('orders', dealer1.cookie, 'POST', input)).status, 403);
      assert.equal(await db.customer.count(), before + 1);
    });
    await t.test('warehouse order options and power snapshot', async () => {
      assert.equal((await request('orders', dealer1.cookie, 'POST', { ...orderData, discount: '5' })).status, 400);
      assert.equal((await request('orders', dealer1.cookie, 'POST', { ...orderData, controlPanel: 'INVALID' })).status, 400);
      assert.equal((await request('orders', dealer1.cookie, 'POST', { ...orderData, accessories: ['INVALID'] })).status, 400);
      assert.equal((await request('orders', dealer1.cookie, 'POST', { ...orderData, items: [{ ...orderData.items[0], boilerType: 'ATK' }] })).status, 400);
      assert.equal((await request('orders', dealer1.cookie, 'POST', { ...orderData, bunkerPosition: 'INVALID' })).status, 400);
      for (const bunkerPosition of ['LEFT', 'RIGHT']) {
        const positioned = await ok('orders', dealer1.cookie, 'POST', { ...orderData, bunkerPosition });
        assert.equal((await ok(`orders/${positioned.id}`, warehouse.cookie)).bunkerPosition, bunkerPosition);
        await ok(`orders/${positioned.id}/status`, dealer1.cookie, 'POST', { status: 'CANCELLED', cancellationReason: 'Position verified', note: 'Position test cleanup' });
      }
      const reportOrder = await ok('orders', dealer1.cookie, 'POST', { ...orderData, controlPanel: 'TURK', accessories: ['BUNKER', 'PASSPORT'] });
      const report = await ok(`orders/${reportOrder.id}`, dealer1.cookie);
      assert.equal(report.controlPanel, 'TURK'); assert.deepEqual(report.accessories, ['BUNKER', 'PASSPORT']); assert.equal(report.items[0].powerKw, 24);
      await ok(`orders/${reportOrder.id}/status`, dealer1.cookie, 'POST', { status: 'CANCELLED', cancellationReason: 'Test complete', note: 'Report test cleanup' });
    });
    await t.test('dealer isolation, financial policy, price snapshot', async () => {
      assert.equal(order.totalAmount, '100'); assert.equal(order.companyAmount, '100');
      assert.equal((await request(`orders/${order.id}`, dealer2.cookie)).status, 404);
      assert.equal((await request(`customers/${customer.id}`, dealer2.cookie)).status, 404);
      assert.equal((await request('reports', warehouse.cookie)).status, 403);
      assert.equal((await request('users', dealer1.cookie)).status, 403);
      const visible = await ok(`orders/${order.id}`, warehouse.cookie); assert.equal(visible.totalAmount, undefined); assert.equal(visible.items[0].costPrice, undefined); assert.equal(visible.items[0].salePrice, undefined);
      await ok(`products/${product.id}`, admin, 'PATCH', { salePrice: '150' });
      assert.equal((await ok(`orders/${order.id}`, dealer1.cookie)).items[0].salePrice, '100');
      assert.equal((await request(`orders/${order.id}/status`, driver.cookie, 'POST', { status: 'COMPLETED' })).status, 403);
    });
    await t.test('warehouse prepares without inventory and stops at ready', async () => {
      assert.equal((await request(`orders/${order.id}/status`, warehouse.cookie, 'POST', { status: 'READY' })).status, 400);
      await ok(`orders/${order.id}/status`, warehouse.cookie, 'POST', { status: 'PREPARING' });
      await ok(`orders/${order.id}/status`, warehouse.cookie, 'POST', { status: 'READY' });
      assert.equal((await ok(`orders/${order.id}`, admin)).statusHistory.length, 3);
      assert.equal((await db.production.findUniqueOrThrow({ where: { orderId: order.id } })).status, 'FINISHED');
      assert.equal(await db.inventory.count(), 0);
      assert.equal(await db.stockMovement.count(), 0);
      for (const status of ['ASSIGNED', 'DELIVERING', 'DELIVERED', 'INSTALLING', 'COMPLETED']) {
        assert.equal((await request(`orders/${order.id}/status`, admin, 'POST', { status })).status, 400);
      }
      for (const route of ['warehouse/stock', 'warehouse/movements', 'deliveries', 'expenses']) {
        assert.equal((await request(route, admin)).status, 404);
      }
      assert.equal((await request(`orders/${order.id}/assign`, admin, 'POST', { assignedToId: driver.id, scheduledAt: new Date().toISOString() })).status, 404);
      assert.equal((await request('expenses', admin, 'POST', { category: 'OTHER', amount: '10', note: 'Removed' })).status, 404);
      const dashboard = await ok('dashboard', warehouse.cookie);
      assert.equal(dashboard.stock, undefined); assert.equal(dashboard.lowStock, undefined);
    });
    await t.test('partial payment, overpayment, idempotency, concurrency', async () => {
      const dto = { orderId: order.id, amount: '30', method: 'CASH', idempotencyKey: randomUUID() };
      const first = await ok('payments', accountant.cookie, 'POST', dto); const repeated = await ok('payments', accountant.cookie, 'POST', dto); assert.equal(first.id, repeated.id);
      assert.equal((await request('payments', accountant.cookie, 'POST', { ...dto, amount: '31' })).status, 400);
      const results = await Promise.all([1, 2].map(() => request('payments', accountant.cookie, 'POST', { ...dto, amount: '70', idempotencyKey: randomUUID() })));
      assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
      const updated = await ok(`orders/${order.id}`, admin); assert.equal(updated.paid, '100'); assert.equal(updated.debt, '0');
      const dealer = await ok(`dealers/${dealerRecord.id}`, admin); assert.equal(dealer.balance, '0'); assert.equal(dealer.margin, '0');
    });
    await t.test('parallel preparation needs no stock; cancellation is recorded once', async () => {
      const a = await ok('orders', dealer1.cookie, 'POST', orderData), b = await ok('orders', dealer1.cookie, 'POST', orderData);
      for (const o of [a, b]) await ok(`orders/${o.id}/status`, warehouse.cookie, 'POST', { status: 'PREPARING' });
      const results = await Promise.all([a, b].map(o => request(`orders/${o.id}/status`, warehouse.cookie, 'POST', { status: 'READY' })));
      assert.deepEqual(results.map(r => r.status), [201, 201]);
      const cancelled = await ok('orders', dealer1.cookie, 'POST', orderData);
      await ok(`orders/${cancelled.id}/status`, warehouse.cookie, 'POST', { status: 'PREPARING' });
      assert.equal((await request(`orders/${cancelled.id}/status`, warehouse.cookie, 'POST', { status: 'CANCELLED' })).status, 400);
      await ok(`orders/${cancelled.id}/status`, warehouse.cookie, 'POST', { status: 'CANCELLED', cancellationReason: 'Test cancel', note: 'Customer request' });
      assert.equal((await request(`orders/${cancelled.id}/status`, warehouse.cookie, 'POST', { status: 'CANCELLED', cancellationReason: 'Again', note: 'Again' })).status, 400);
      assert.equal(await db.inventory.count(), 0);
      assert.equal(await db.stockMovement.count(), 0);
    });
    await t.test('reports, audit, notifications and refresh rotation', async () => {
      const report = await ok('reports', accountant.cookie); assert.equal(report.revenue, '130');
      assert.ok(await db.auditLog.count() > 10); assert.ok((await ok('notifications', warehouse.cookie)).total > 0);
      const refresh = await request('auth/refresh', dealer2.cookie, 'POST'); assert.equal(refresh.status, 201);
      assert.equal((await request('auth/refresh', dealer2.cookie, 'POST')).status, 401);
      await ok('auth/logout', refresh.cookie, 'POST'); assert.equal((await request('auth/me', refresh.cookie)).status, 401);
    });
    await t.test('single catalogue price and atomic repricing during payment', async () => {
      const single = await ok('products', admin, 'POST', { name: 'Single price', model: 'SINGLE', categoryId: category.id, powerKw: 25, salePrice: '200' });
      const created = await ok('orders', admin, 'POST', { ...orderData, deposit: '20', items: [{ productId: single.id, quantity: 2, salePrice: '150' }] });
      const detail = await ok(`orders/${created.id}`, admin);
      assert.equal(detail.totalAmount, '300');
      assert.equal(detail.items[0].costPrice, undefined);
      const itemPrices = [{ id: detail.items[0].id, salePrice: '120' }];
      const dto = { orderId: created.id, amount: '30', method: 'CASH', idempotencyKey: randomUUID(), itemPrices };
      const payment = await ok('payments', accountant.cookie, 'POST', dto);
      assert.equal((await ok('payments', accountant.cookie, 'POST', dto)).id, payment.id);
      assert.equal((await request('payments', accountant.cookie, 'POST', { ...dto, itemPrices: [{ ...itemPrices[0], salePrice: '130' }] })).status, 400);
      let updated = await ok(`orders/${created.id}`, admin);
      assert.equal(updated.totalAmount, '240'); assert.equal(updated.companyAmount, '240');
      assert.equal(updated.paid, '50'); assert.equal(updated.debt, '190');
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: single.id } })).salePrice.toString(), '200');
      const entries = await db.dealerTransaction.findMany({ where: { orderId: created.id } });
      assert.equal(entries.reduce((total, entry) => total + Number(entry.amount), 0), 190);
      for (const [prices, amount] of [
        [[{ ...itemPrices[0], salePrice: '10' }], '1'],
        [[{ ...itemPrices[0], salePrice: '100' }], '151'],
        [[{ id: randomUUID(), salePrice: '100' }], '1'],
        [[itemPrices[0], itemPrices[0]], '1'],
      ]) assert.equal((await request('payments', admin, 'POST', { ...dto, amount, itemPrices: prices, idempotencyKey: randomUUID() })).status, 400);
      updated = await ok(`orders/${created.id}`, admin);
      assert.equal(updated.totalAmount, '240'); assert.equal(updated.paid, '50');
      const attempts = await Promise.all([1, 2].map(() => request('payments', admin, 'POST', { ...dto, amount: '210', itemPrices: [{ ...itemPrices[0], salePrice: '130' }], idempotencyKey: randomUUID() })));
      assert.deepEqual(attempts.map(result => result.status).sort(), [201, 400]);
      updated = await ok(`orders/${created.id}`, admin);
      assert.equal(updated.totalAmount, '260'); assert.equal(updated.paid, '260'); assert.equal(updated.debt, '0');
      assert.equal((await ok('payments', accountant.cookie, 'POST', dto)).id, payment.id);
    });
    if (process.env.BROWSER_TEST === '1') await t.test('browser: login, order form, pages, mobile and logout', { timeout: 180000 }, async () => {
      const webRoot = path.resolve('../frontend');
      web = spawn(process.execPath, [path.join(webRoot, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3100'], { cwd: webRoot, env: { ...process.env, API_URL: 'http://127.0.0.1:3101', NEXT_DIST_DIR: '.next-test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let webLogs = ''; web.stdout.on('data', b => { webLogs += b; }); web.stderr.on('data', b => { webLogs += b; });
      for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:3100/login')).ok) break; } catch {} if (i === 149) throw new Error(webLogs); await new Promise(r => setTimeout(r, 200)); }
      const { chromium } = require(path.join(webRoot, 'node_modules/@playwright/test'));
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:3100/login');
        await page.getByLabel('Telefon raqami').fill('+998900000099'); await page.getByLabel('Parol', { exact: true }).fill(password);
        const loginResponse = page.waitForResponse(r => r.url().endsWith('/api/auth/login'));
        await page.getByRole('button', { name: 'Tizimga kirish' }).click();
        const response = await loginResponse; assert.equal(response.status(), 201, await response.text());
        await page.waitForURL('**/dashboard'); await page.getByRole('heading', { name: /Xush kelibsiz/ }).waitFor();
        const fs = require('node:fs'); fs.mkdirSync(path.join(webRoot, 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(webRoot, 'test-results/dashboard-desktop.png'), fullPage: true });
        const browserProduct = await ok('products', admin, 'POST', { name: 'Browser AT boiler', model: 'BROWSER-AT-25', categoryId: category.id, powerKw: 25, costPrice: '50', salePrice: '100' });
        await page.goto('http://127.0.0.1:3100/orders/new');
        assert.equal(await page.getByLabel('Chegirma').count(), 0);
        await page.getByLabel('Mijoz ismi').fill('Browser');
        await page.getByLabel('Familiyasi').fill('Customer');
        await page.getByLabel('Telefon raqami').fill(customer.phone);
        await page.getByLabel('Viloyat', { exact: false }).fill('Toshkent');
        await page.getByLabel('Tuman', { exact: false }).fill('Chilonzor');
        assert.equal(await page.getByLabel('Sotuvchi', { exact: false }).count(), 0);
        assert.equal(await page.getByLabel('Ombor', { exact: false }).count(), 0);
        await page.getByLabel('Katyol turi').selectOption('ATK');
        assert.equal(await page.locator(`option[value="${browserProduct.id}"]`).count(), 0);
        await page.getByLabel('Katyol turi').selectOption('AT');
        await page.getByLabel('Mahsulot - quvvati va narxi').selectOption(browserProduct.id);
        await page.getByLabel('Mahsulot narxi (USD)', { exact: true }).fill('120');
        await page.getByLabel('Boshqaruv paneli').selectOption('TURK');
        await page.getByLabel('Bunker', { exact: true }).check();
        await page.getByLabel('Olingan zaklad (naqd, USD)').fill('30');
        assert.equal(await page.getByLabel('Yetkazish narxi').count(), 0);
        await page.getByRole('button', { name: 'Buyurtmani yaratish' }).click();
        await page.waitForURL(/\/orders\/[a-f0-9-]{36}$/);
        await page.getByRole('heading', { name: 'Buyurtma tarkibi' }).waitFor();
        const browserOrderId = page.url().split('/').pop();
        assert.equal((await ok(`orders/${browserOrderId}`, admin)).totalAmount, '120');
        await page.getByRole('button', { name: /qabul qilish/ }).click();
        const paymentDialog = page.getByRole('dialog');
        await paymentDialog.getByLabel(/Browser AT boiler/).fill('110');
        await paymentDialog.locator('input[type="number"]').last().fill('80');
        await paymentDialog.locator('select').last().selectOption('CASH');
        await paymentDialog.getByRole('button', { name: 'Saqlash', exact: true }).click();
        await paymentDialog.waitFor({ state: 'hidden' });
        const browserPaid = await ok(`orders/${browserOrderId}`, admin);
        assert.equal(browserPaid.totalAmount, '110'); assert.equal(browserPaid.paid, '110'); assert.equal(browserPaid.debt, '0');
        await page.locator('.report-paper').waitFor();
        assert.equal(await page.getByText('Chegirma', { exact: false }).count(), 0);
        const downloadEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'PDF yuklab olish', exact: true }).click();
        const download = await downloadEvent;
        assert.match(download.suggestedFilename(), /^ORD-\d+-ombor-buyurtmasi\.pdf$/);
        const pdfPath = path.join(webRoot, 'test-results/order-download.pdf');
        await download.saveAs(pdfPath);
        assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');
        await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.sidebar').isVisible(), false);
        assert.equal(await page.locator('.report-paper').isVisible(), true);
        await page.pdf({ path: path.join(webRoot, 'test-results/delivery-report.pdf'), format: 'A4' });
        await page.emulateMedia({ media: 'screen' });
        await page.getByRole('button', { name: 'Tayyorlanmoqda', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Tasdiqlash' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'Tayyor', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Tasdiqlash' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.getByText('Ombor buyurtmani tayyorlab berdi.', { exact: true }).waitFor();
        for (const label of ['Ombor qoldig‘i', 'Ombor harakatlari', 'Yetkazish', 'Xarajatlar']) assert.equal(await page.getByRole('link', { name: label, exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Yetkazuvchi biriktirish' }).count(), 0);
        for (const route of ['customers', `customers/${customer.id}`, 'products', 'categories', 'warehouse', 'production', 'payments', 'dealers', `dealers/${dealerRecord.id}`, `dealers/${dealerRecord.id}/ledger`, 'reports', 'users', 'settings', 'audit', 'notifications']) {
          await page.goto(`http://127.0.0.1:3100/${route}`);
          await page.locator('main h1').first().waitFor();
          await page.waitForTimeout(150);
          assert.equal(await page.locator('.error[role=alert]').count(), 0, `Page error on ${route}: ${await page.locator('.error[role=alert]').allTextContents()}`);
        }
        await page.setViewportSize({ width: 390, height: 844 }); await page.goto('http://127.0.0.1:3100/dashboard');
        await page.getByRole('heading', { name: /Xush kelibsiz/ }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page overflows');
        await page.screenshot({ path: path.join(webRoot, 'test-results/dashboard-mobile.png'), fullPage: true });
        await page.getByRole('button', { name: 'Yana', exact: true }).click();
        await page.getByRole('button', { name: 'Chiqish', exact: true }).click(); await page.waitForURL('**/login');
        await page.getByLabel('Telefon raqami').fill(dealer1.phone); await page.getByLabel('Parol', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Tizimga kirish' }).click(); await page.waitForURL('**/dashboard');
        for (const width of [320, 390, 768]) {
          await page.setViewportSize({ width, height: 844 });
          const bottomNav = page.getByRole('navigation', { name: 'Asosiy menyu', exact: true });
          await bottomNav.waitFor();
          assert.equal(await page.locator('.sidebar').isVisible(), false);
          await bottomNav.getByRole('link', { name: 'Buyurtmalar', exact: true }).click();
          await page.waitForURL('**/orders'); await page.locator('.resource-table').waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Orders overflow at ' + width);
          await bottomNav.getByRole('link', { name: 'Yangi buyurtma' }).click();
          await page.waitForURL('**/orders/new'); await page.getByLabel('Bunker joylashuvi').waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Order form overflow at ' + width);
          await bottomNav.getByRole('button', { name: 'Yana', exact: true }).click();
          const more = page.getByRole('dialog', { name: 'Boshqa menyular' }); await more.waitFor();
          await more.getByRole('link', { name: 'Mahsulotlar', exact: true }).click();
          await page.waitForURL('**/products'); await more.waitFor({ state: 'hidden' });
          await page.screenshot({ path: path.join(webRoot, 'test-results/mobile-seller-' + width + '.png'), fullPage: true });
        }
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  } finally {
    if (web) { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(web.pid), '/t', '/f'], { stdio: 'ignore' }); else web.kill(); }
    if (child && child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill(); await stopped; }
    if (db) await db.$disconnect();
    if (!/^katyol_test_\d+$/.test(name)) throw new Error('Unsafe test database');
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await adminDb.$disconnect();
  }
});
