'use strict';
/* ภาพหน้าจอหน้าพนักงานทุกแท็บ (ไม่มี assert) ใช้ตรวจหน้าตาหลังแก้ staff.html
   รัน: node qa/staff-shots.js   ภาพอยู่ใน qa/out/staff/
   ขนาด 1440 / 1180 (แท็บเล็ตแนวนอน) / 768 / 390 · light + dark · รวมหน้าเข้าสู่ระบบ ช่องค้นหา (Ctrl+K) หน้าแก้เมนู ตั้งค่าทั้งหน้า รับเงินสด และหลังปิดบิล */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, rmrf, PIN, fakePhoto, browserOpts } = require('./lib');

const OUT = path.join(__dirname, 'out', 'staff');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const browser = await chromium.launch(browserOpts());
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const png = { headers: { 'content-type': 'image/png' } };
  for (const [id, seed] of [[1, 18], [3, 34], [4, 48], [6, 70]]) await s.call('POST', '/api/menu/image?id=' + id, await fakePhoto(browser, seed), png);
  await s.call('POST', '/api/settings', { shop: 'ครัวป้าแดง', promptpay: '0812345678', address: '88/8 ถ.สุขุมวิท', phone: '02-123-4567' });
  const g = (t, items, memo) => s.call('POST', '/api/order', { table: t, key: keys[t], items, memo }, { staff: false });
  const a = (await g(1, [{ id: 1, qty: 2, note: ['ไม่เผ็ด'] }, { id: 3, qty: 1 }], 'แยกจาน')).json.tickets;
  await g(3, [{ id: 2, qty: 1 }]);
  await g(7, [{ id: 4, qty: 3 }, { id: 5, qty: 1, note: ['เผ็ดน้อย', 'ไม่ใส่ผัก'] }]);
  const b = (await g(5, [{ id: 1, qty: 1 }])).json.tickets;
  await g(9, [{ id: 6, qty: 2 }]);
  await s.call('POST', '/api/ticket', { id: a[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'cooking', status: 'ready' });
  await s.call('POST', '/api/call', { table: 3, key: keys[3], kind: 'bill' }, { staff: false });
  // บิลที่ปิดแล้ว ให้หน้าสรุปยอดมีข้อมูล
  for (const [t, m] of [[10, 'cash'], [11, 'transfer'], [12, 'cash']]) {
    await g(t, [{ id: 1, qty: 2 }, { id: 2, qty: 1 }]);
    const sub = (await s.call('GET', '/api/state')).json.bills[t].sub;
    await s.call('POST', '/api/pay', { table: t, expectedSub: sub, method: m });
  }
  await s.call('POST', '/api/soldout', { id: 2, soldOut: true });

  const lc = await browser.newContext({ baseURL: s.B }); const lp = await lc.newPage();
  await lp.goto('/staff'); await lp.fill('#pin', PIN); await lp.press('#pin', 'Enter'); await lp.waitForSelector('#tabs .tab');
  const state = await lc.storageState(); await lc.close();
  const shot = (p, name, full) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });
  const sizes = { d1440: { width: 1440, height: 900 }, t1180: { width: 1180, height: 820 }, t768: { width: 768, height: 1024 }, m390: { width: 390, height: 844 } };
  for (const scheme of ['light', 'dark']) {
    const lctx = await browser.newContext({ baseURL: s.B, viewport: sizes.m390, colorScheme: scheme });
    const l = await lctx.newPage(); await l.goto('/staff'); await l.waitForSelector('#pin'); await sleep(300);
    await shot(l, `login-m390-${scheme}`); await lctx.close();
    const lctx2 = await browser.newContext({ baseURL: s.B, viewport: sizes.d1440, colorScheme: scheme });
    const l2 = await lctx2.newPage(); await l2.goto('/staff'); await l2.waitForSelector('#pin'); await sleep(300);
    await shot(l2, `login-d1440-${scheme}`); await lctx2.close();
    for (const [name, viewport] of Object.entries(sizes)) {
      const ctx = await browser.newContext({ baseURL: s.B, viewport, colorScheme: scheme, deviceScaleFactor: 1, storageState: state, isMobile: name === 'm390', hasTouch: name !== 'd1440' });
      const p = await ctx.newPage();
      await p.goto('/staff'); await p.waitForSelector('#tabs .tab'); await sleep(300);
      const full = name !== 'd1440';
      await shot(p, `kitchen-${name}-${scheme}`, full);
      await p.click('#tabs [data-v="tables"]'); await sleep(300);
      await shot(p, `tables-none-${name}-${scheme}`, full);
      await p.click('[data-a="sel"][data-id="1"]'); await sleep(500);
      await shot(p, `tables-${name}-${scheme}`, full);
      await p.click('[data-a="pay"][data-m="cash"]'); await p.keyboard.type('500'); await sleep(200);
      await shot(p, `tables-cash-${name}-${scheme}`, full);
      await p.click('#tabs [data-v="menu"]'); await sleep(300);
      await shot(p, `menu-${name}-${scheme}`, full);
      await p.click('[data-a="eopen"][data-id="1"]'); await sleep(500);
      await shot(p, `menu-edit-${name}-${scheme}`, full);
      await p.click('[data-a="ecancel"]');
      await p.click('#tabs [data-v="report"]'); await p.waitForSelector('.kpis'); await sleep(400);
      await shot(p, `report-${name}-${scheme}`, full);
      await p.click('#tabs [data-v="settings"]'); await p.waitForSelector('[data-a="tpreset"]'); await p.waitForSelector('#bk table').catch(() => {}); await sleep(400);
      await shot(p, `settings-${name}-${scheme}`, full);
      if (name === 'd1440') {
        await p.click('#tabs [data-v="kitchen"]'); await sleep(200);
        await p.keyboard.press('Control+k'); await p.fill('#ck-q', 'ผัด'); await sleep(200);
        await shot(p, `cmdk-${name}-${scheme}`);
        await p.keyboard.press('Escape');
      }
      await ctx.close();
    }
  }
  // หลังรับเงิน (มือถือ + จอกว้าง)
  for (const [name, viewport, t] of [['m390', sizes.m390, 9], ['d1440', sizes.d1440, 7]]) {
    const ctx = await browser.newContext({ baseURL: s.B, viewport, storageState: state, isMobile: name === 'm390', hasTouch: true });
    const p = await ctx.newPage(); await p.goto('/staff'); await p.waitForSelector('#tabs .tab');
    await p.click('#tabs [data-v="tables"]'); await p.click('[data-a="sel"][data-id="' + t + '"]'); await sleep(300);
    await p.click('[data-a="pay"][data-m="cash"]'); await p.keyboard.type('1000'); await p.keyboard.press('Enter');
    await p.waitForSelector('[data-a="donesale"]'); await sleep(600);
    await shot(p, `paid-${name}`, name === 'm390');
    await ctx.close();
  }
  await browser.close(); await s.stop(); rmrf(app.base);
  console.log('ภาพอยู่ใน ' + OUT + ' (' + fs.readdirSync(OUT).length + ' ไฟล์)');
})().catch(e => { console.error(e); process.exit(1); });
