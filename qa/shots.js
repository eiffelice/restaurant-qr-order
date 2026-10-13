'use strict';
/* ภาพหน้าจอสำหรับตรวจหน้าตา (ไม่มี assert) ใช้ดูหลังแก้ CSS หรือเทียบกับโค้ดเดิมด้วย QA_FROM=
   รัน: node qa/shots.js   ภาพอยู่ใน qa/out/shots/ (desktop 1440, tablet 1024, มือถือ 390 ทั้ง light/dark) */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, rmrf, PIN } = require('./lib');

const OUT = path.join(__dirname, 'out', 'shots');
const CHANNEL = process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const g = (t, items, memo) => s.call('POST', '/api/order', { table: t, key: keys[t], items, memo }, { staff: false });
  const a = (await g(1, [{ id: 1, qty: 2, note: ['ไม่เผ็ด'] }, { id: 3, qty: 1 }], 'แยกจาน')).json.tickets;
  await g(3, [{ id: 2, qty: 1 }]);
  const b = (await g(5, [{ id: 1, qty: 1 }])).json.tickets;
  await s.call('POST', '/api/ticket', { id: a[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'cooking', status: 'ready' });
  await s.call('POST', '/api/call', { table: 3, key: keys[3], kind: 'bill' }, { staff: false });

  const browser = await chromium.launch({ channel: CHANNEL });
  // เข้าสู่ระบบครั้งเดียวแล้วใช้ cookie ซ้ำ (ลิมิตเข้าสู่ระบบ 6 ครั้ง/นาที)
  const lc = await browser.newContext({ baseURL: s.B }); const lp = await lc.newPage();
  await lp.goto('/staff'); await lp.fill('#pin', PIN); await lp.press('#pin', 'Enter'); await lp.waitForSelector('#tabs .tab');
  const state = await lc.storageState(); await lc.close();
  const sizes = { desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } };
  for (const scheme of ['light', 'dark']) {
    for (const [name, viewport] of Object.entries(sizes)) {
      const ctx = await browser.newContext({ baseURL: s.B, viewport, colorScheme: scheme, deviceScaleFactor: 1, storageState: state });
      const p = await ctx.newPage();
      await p.goto('/staff'); await p.waitForSelector('#tabs .tab');
      for (const v of ['kitchen', 'tables', 'report']) {
        await p.click('#tabs [data-v="' + v + '"]'); await sleep(300);
        if (v === 'tables') { await p.click('[data-a="sel"][data-id="1"]'); await sleep(200); }
        await p.screenshot({ path: path.join(OUT, `staff-${v}-${name}-${scheme}.png`), fullPage: name === 'mobile' });
      }
      await ctx.close();
    }
    const ctx = await browser.newContext({ baseURL: s.B, viewport: sizes.mobile, colorScheme: scheme, isMobile: true, hasTouch: true });
    const c = await ctx.newPage();
    await c.goto('/order?t=2&k=' + keys[2]); await c.waitForSelector('.item');
    await c.click('[data-a="inc"][data-id="1"]'); await c.click('[data-a="inc"][data-id="2"]');
    await c.screenshot({ path: path.join(OUT, `customer-menu-${scheme}.png`) });
    await c.click('[data-a="open"]'); await sleep(300);
    await c.screenshot({ path: path.join(OUT, `customer-cart-${scheme}.png`) });
    await ctx.close();
  }
  await browser.close(); await s.stop(); rmrf(app.base);
  console.log('ภาพอยู่ใน ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
