'use strict';
/* ภาพหน้าจอสำหรับคู่มือ (docs/GUIDE.md) ข้อมูลตัวอย่างสมจริง: ร้าน "ครัวป้าแดง" มีรูปเมนู โลโก้ ออเดอร์ บิล ยอดขาย
   รัน: node qa/docs-shots.js   ภาพไปที่ docs/screenshots/ (เขียนทับของเดิม) */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, rmrf, PIN, fakePhoto } = require('./lib');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const CHANNEL = process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const browser = await chromium.launch({ channel: CHANNEL });
  const png = { headers: { 'content-type': 'image/png' } };
  const st0 = (await s.call('GET', '/api/state')).json, keys = st0.keys;

  // ---------- ข้อมูลร้านตัวอย่าง ----------
  await s.call('POST', '/api/settings', { shop: 'ครัวป้าแดง', address: '88/8 ถ.สุขุมวิท แขวงคลองตัน เขตคลองเตย กรุงเทพฯ', phone: '02-123-4567', promptpay: '0812345678', footer: 'ขอบคุณที่อุดหนุนค่ะ' });
  await s.call('POST', '/api/settings/logo', await fakePhoto(browser, 8, 300), png);
  const hues = { 1: 18, 2: 40, 3: 30, 4: 52, 6: 5, 7: 12, 11: 190, 12: 330 };
  for (const id of Object.keys(hues)) await s.call('POST', '/api/menu/image?id=' + id, await fakePhoto(browser, hues[id]), png);
  const m1 = st0.menu.items.find(i => i.id === 1);
  await s.call('POST', '/api/menu/item', { id: 1, name: m1.name, price: m1.price, cat: m1.cat, station: m1.station, desc: 'กะเพราใบสดผัดไฟแรงกับหมูสับ พริกขี้หนูสวน กระเทียมไทย เสิร์ฟพร้อมข้าวสวยร้อนๆ เลือกระดับความเผ็ดได้ในแท็บหมายเหตุ' });
  await s.call('POST', '/api/staff', { name: 'น้องฝน', role: 'cashier', pin: '520011' });
  await s.call('POST', '/api/staff', { name: 'พี่ชัย', role: 'kitchen', pin: '520022' });
  const g = (t, items, memo) => s.call('POST', '/api/order', { table: t, key: keys[t], items, memo }, { staff: false });
  // บิลที่ปิดแล้ว (ให้หน้าสรุปยอดมีข้อมูล)
  for (const [t, items] of [[7, [{ id: 1, qty: 2 }, { id: 11, qty: 2 }]], [8, [{ id: 3, qty: 1 }, { id: 6, qty: 1 }]], [9, [{ id: 4, qty: 3 }]]]) {
    await g(t, items);
    const sub = (await s.call('GET', '/api/state')).json.bills[t].sub;
    await s.call('POST', '/api/pay', { table: t, expectedSub: sub, svc: true, vat: false, method: t === 8 ? 'transfer' : 'cash', received: t === 8 ? undefined : 1000 });
  }
  const a = (await g(1, [{ id: 1, qty: 2, note: ['ไม่เผ็ด'] }, { id: 3, qty: 1 }, { id: 11, qty: 2 }], 'แยกจาน')).json.tickets;
  const b = (await g(3, [{ id: 2, qty: 1 }, { id: 6, qty: 1, note: ['เผ็ดมาก'] }])).json.tickets;
  const c = (await g(5, [{ id: 7, qty: 1 }])).json.tickets;
  await g(2, [{ id: 12, qty: 2 }]);
  await s.call('POST', '/api/ticket', { id: a[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: c[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: c[0], from: 'cooking', status: 'ready' });
  await s.call('POST', '/api/call', { table: 3, key: keys[3], kind: 'bill' }, { staff: false });
  await s.call('POST', '/api/ticket/void', { id: b[1] || b[0], reason: 'ลูกค้าเปลี่ยนใจ' });
  await s.call('POST', '/api/soldout', { id: 4, soldOut: true });

  const shot = (p, name, full) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });
  const el = (p, sel, name) => p.locator(sel).first().screenshot({ path: path.join(OUT, name + '.png') });

  // ---------- ลูกค้า ----------
  const cust = async (opts, t) => { const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, PHONE, opts || {})); const p = await ctx.newPage(); await p.goto('/order?t=' + (t || 4) + '&k=' + keys[t || 4]); await p.waitForSelector('.item'); await sleep(500); return p; };
  let p = await cust();
  await shot(p, 'c01-menu');
  await p.click('.item .open[data-id="1"]'); await sleep(500); await p.click('[data-a="dinc"]'); await sleep(150);
  await shot(p, 'c02-detail');
  await p.click('[data-a="dtab"][data-t="notes"]'); await p.click('[data-a="dnote"][data-n="ไม่เผ็ด"]'); await sleep(150);
  await shot(p, 'c03-detail-notes');
  await p.click('[data-a="dadd"]'); await sleep(2600);
  await p.click('.item [data-a="inc"][data-id="2"]'); await sleep(300);
  await shot(p, 'c04-menu-with-cart');
  await p.click('[data-a="open"]'); await sleep(400);
  await shot(p, 'c05-cart');
  await p.click('[data-a="send"]'); await sleep(2800);
  await p.evaluate(() => document.querySelector('#status').scrollIntoView({ block: 'start' })); await sleep(300);
  await shot(p, 'c06-order-status');
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('.item .open[data-id="4"]').catch(() => {}); await sleep(500);
  if (!(await p.isHidden('#detail'))) await shot(p, 'c07-soldout');
  await p.context().close();
  p = await cust({ colorScheme: 'dark' }); await shot(p, 'c08-menu-dark');
  await p.click('.item .open[data-id="2"]'); await sleep(500); await shot(p, 'c09-detail-noimage-dark'); await p.context().close();
  p = await cust({ viewport: { width: 768, height: 1024 }, isMobile: false, deviceScaleFactor: 1 }); await shot(p, 'c10-tablet-menu'); await p.context().close();

  // ---------- พนักงาน ----------
  const lc = await browser.newContext({ baseURL: s.B, ...PHONE }); const lp = await lc.newPage();
  await lp.goto('/staff'); await lp.waitForSelector('#login-logo:not([hidden])'); await sleep(300);
  await shot(lp, 's01-login');
  await lp.fill('#pin', PIN); await lp.press('#pin', 'Enter'); await lp.waitForSelector('#tabs .tab');
  const state = await lc.storageState();
  await sleep(400); await shot(lp, 's02-kitchen-phone', true);
  await lc.close();
  const staff = async (opts) => { const ctx = await browser.newContext(Object.assign({ baseURL: s.B, storageState: state }, DESK, opts || {})); const q = await ctx.newPage(); await q.goto('/staff'); await q.waitForSelector('#tabs .tab'); await sleep(500); return q; };
  p = await staff();
  await shot(p, 's03-kitchen');
  await p.click('#v-kitchen [data-a="void"]'); await p.waitForSelector('#void-dlg[open]'); await p.check('#void-form input[value="สั่งผิด หรือกดซ้ำ"]'); await sleep(200);
  await shot(p, 's04-void-dialog');
  await p.keyboard.press('Escape');
  await p.click('#tabs [data-v="tables"]'); await sleep(300); await p.click('[data-a="sel"][data-id="1"]'); await sleep(400);
  await shot(p, 's05-tables-bill');
  await p.setViewportSize({ width: 1440, height: 1400 });   // ให้เห็นช่องรับเงินและเงินทอนในภาพเดียว (fullPage ทำให้แถบซ้ายลอย)
  await p.click('[data-a="pay"][data-m="cash"]'); await p.keyboard.type('1000'); await sleep(400);
  await shot(p, 's06-cash-change');
  await p.click('[data-a="pay"][data-m="cash"]'); await sleep(900);
  await shot(p, 's07-receipt-paid'); await p.setViewportSize(DESK.viewport);
  await sleep(2800);   // รอข้อความแจ้งเตือนหายก่อนถ่ายหน้าถัดไป
  await p.click('#tabs [data-v="menu"]'); await sleep(400);
  await shot(p, 's08-menu-manager');
  await p.click('[data-a="eopen"][data-id="1"]'); await sleep(400);
  await shot(p, 's09-menu-editor');
  await p.click('[data-a="ecancel"]').catch(() => {});
  await p.click('#tabs [data-v="report"]'); await sleep(900);
  await shot(p, 's10-report', true);
  await p.click('#tabs [data-v="settings"]'); await p.waitForSelector('[data-a="tpreset"]'); await sleep(500);
  await shot(p, 's11-settings');
  await el(p, '#theme', 's12-theme');
  await el(p, '#stf', 's13-staff');
  await el(p, '#bk', 's14-backup');
  await p.evaluate(() => document.querySelector('.qrsheet').scrollIntoView({ block: 'start' })); await sleep(300);
  await shot(p, 's15-qr-sheet');
  await p.context().close();
  p = await staff({ colorScheme: 'dark' });
  for (let i = 0; i < 3 && await p.isHidden('#v-tables'); i++) { await p.click('#tabs [data-v="tables"]'); await sleep(500); }
  await p.click('[data-a="sel"][data-id="3"]'); await sleep(400);
  await shot(p, 's16-tables-dark'); await p.context().close();
  // แคชเชียร์: เห็นแท็บน้อยกว่าเจ้าของ
  const kc = await browser.newContext({ baseURL: s.B, ...DESK }); const kp = await kc.newPage();
  await kp.goto('/staff'); await kp.fill('#pin', '520011'); await kp.press('#pin', 'Enter'); await kp.waitForSelector('#tabs .tab'); await sleep(500);
  await shot(kp, 's17-cashier-view'); await kc.close();

  await browser.close(); await s.stop(); rmrf(app.base);
  console.log('ภาพอยู่ใน ' + OUT + ' (' + fs.readdirSync(OUT).length + ' ไฟล์)');
})().catch(e => { console.error(e); process.exit(1); });
