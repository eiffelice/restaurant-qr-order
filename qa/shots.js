'use strict';
/* ภาพหน้าจอสำหรับตรวจหน้าตา (ไม่มี assert) ใช้ดูหลังแก้ CSS หรือเทียบกับโค้ดเดิมด้วย QA_FROM=
   รัน: node qa/shots.js   ภาพอยู่ใน qa/out/shots/
   - พนักงาน: desktop 1440, tablet 1024, มือถือ 390 (ครัว, โต๊ะ, สรุปยอด) + หน้าเข้าสู่ระบบมีโลโก้ + แผงหน้าตาร้าน
   - ลูกค้า: 390 และ 768 ทุกจอ (เมนู, รายละเอียดมีรูป/ไม่มีรูป/หมายเหตุ/หมดแล้ว/ร้านปิดรับ, ตะกร้า) + ธีมสีที่เจ้าของตั้ง
   ทั้งหมดทั้ง light และ dark */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, rmrf, PIN, fakePhoto, browserOpts } = require('./lib');

const OUT = path.join(__dirname, 'out', 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const browser = await chromium.launch(browserOpts());
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const png = { headers: { 'content-type': 'image/png' } };
  // รูปเมนู 3 จาน (ที่เหลือไม่มีรูป ตามสภาพร้านช่วงแรก) + คำอธิบาย + ชื่อยาว
  await s.call('POST', '/api/menu/image?id=1', await fakePhoto(browser, 18), png);
  await s.call('POST', '/api/menu/image?id=3', await fakePhoto(browser, 34), png);
  await s.call('POST', '/api/menu/image?id=4', await fakePhoto(browser, 48), png);
  const m1 = (await s.call('GET', '/api/state')).json.menu.items.find(i => i.id === 1);
  await s.call('POST', '/api/menu/item', { id: 1, name: 'ผัดกะเพราหมูสับไข่ดาวไม่สุกพิเศษราดข้าวสวยร้อนๆ', price: 89.5, cat: m1.cat, station: m1.station, desc: 'กะเพราแท้ใบสด ผัดไฟแรงกับหมูสับ พริกขี้หนูสวน กระเทียมไทย เสิร์ฟพร้อมไข่ดาวกรอบขอบ เลือกระดับความเผ็ดได้ในแท็บหมายเหตุ' });
  const g = (t, items, memo) => s.call('POST', '/api/order', { table: t, key: keys[t], items, memo }, { staff: false });
  const a = (await g(1, [{ id: 1, qty: 2, note: ['ไม่เผ็ด'] }, { id: 3, qty: 1 }], 'แยกจาน')).json.tickets;
  await g(3, [{ id: 2, qty: 1 }]);
  const b = (await g(5, [{ id: 1, qty: 1 }])).json.tickets;
  await s.call('POST', '/api/ticket', { id: a[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'new', status: 'cooking' });
  await s.call('POST', '/api/ticket', { id: b[0], from: 'cooking', status: 'ready' });
  await s.call('POST', '/api/call', { table: 3, key: keys[3], kind: 'bill' }, { staff: false });
  await s.call('POST', '/api/settings/logo', await fakePhoto(browser, 140, 300), png);

  // เข้าสู่ระบบครั้งเดียวแล้วใช้ cookie ซ้ำ (ลิมิตเข้าสู่ระบบ 6 ครั้ง/นาที)
  const lc = await browser.newContext({ baseURL: s.B }); const lp = await lc.newPage();
  await lp.goto('/staff'); await lp.fill('#pin', PIN); await lp.press('#pin', 'Enter'); await lp.waitForSelector('#tabs .tab');
  const state = await lc.storageState(); await lc.close();

  const shot = (p, name, full) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });
  const sizes = { desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } };
  for (const scheme of ['light', 'dark']) {
    // หน้าใส่รหัสเข้าสู่ระบบ (มีโลโก้)
    const lctx = await browser.newContext({ baseURL: s.B, viewport: sizes.mobile, colorScheme: scheme });
    const l = await lctx.newPage(); await l.goto('/staff'); await l.waitForSelector('#login-logo:not([hidden])'); await sleep(200);
    await shot(l, `staff-login-${scheme}`); await lctx.close();
    for (const [name, viewport] of Object.entries(sizes)) {
      const ctx = await browser.newContext({ baseURL: s.B, viewport, colorScheme: scheme, deviceScaleFactor: 1, storageState: state });
      const p = await ctx.newPage();
      await p.goto('/staff'); await p.waitForSelector('#tabs .tab');
      for (const v of ['kitchen', 'tables', 'report']) {
        await p.click('#tabs [data-v="' + v + '"]'); await sleep(300);
        if (v === 'tables') { await p.click('[data-a="sel"][data-id="1"]'); await sleep(200); }
        await shot(p, `staff-${v}-${name}-${scheme}`, name === 'mobile');
      }
      if (name === 'desktop') {
        await p.click('#tabs [data-v="settings"]'); await p.waitForSelector('[data-a="tpreset"]'); await sleep(300);
        await p.locator('#theme').screenshot({ path: path.join(OUT, `staff-theme-panel-${scheme}.png`) });
      }
      await ctx.close();
    }
  }

  // หน้าลูกค้า 390 / 768 ทุกจอ
  const cust = async (w, scheme, tag) => {
    const ctx = await browser.newContext({ baseURL: s.B, viewport: { width: w, height: w > 500 ? 1024 : 844 }, colorScheme: scheme, isMobile: w < 500, hasTouch: true, deviceScaleFactor: 1 });
    const c = await ctx.newPage();
    await c.goto('/order?t=2&k=' + keys[2]); await c.waitForSelector('.item'); await sleep(300);
    const n = x => `customer-${x}-${w}-${scheme}${tag || ''}`;
    await shot(c, n('menu'));
    await c.click('.item [data-a="inc"][data-id="2"]'); await c.click('.item [data-a="inc"][data-id="2"]');
    await c.click('.item .open[data-id="1"]'); await c.waitForSelector('#detail:not([hidden])'); await sleep(400);
    await c.click('[data-a="dinc"]'); await sleep(100);
    await shot(c, n('detail'));
    await c.click('[data-a="dtab"][data-t="notes"]'); await c.click('[data-a="dnote"][data-n="ไม่เผ็ด"]'); await sleep(100);
    await shot(c, n('detail-notes'));
    await c.click('[data-a="dadd"]'); await sleep(300);
    await c.click('.item .open[data-id="2"]'); await sleep(400);
    await shot(c, n('detail-noimg'));
    await c.click('[data-a="dback"]'); await sleep(200);
    await c.click('[data-a="open"]'); await c.click('[data-a="notes"]'); await sleep(400);
    await shot(c, n('cart'));
    await ctx.close();
  };
  for (const scheme of ['light', 'dark']) for (const w of [390, 768]) await cust(w, scheme);
  // เมนูหมด + ร้านปิดรับ (390 light/dark)
  const one = async (tag, id) => {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ baseURL: s.B, viewport: { width: 390, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true });
      const c = await ctx.newPage(); await c.goto('/order?t=4&k=' + keys[4]); await c.waitForSelector('.item'); await sleep(300);
      await shot(c, `customer-menu-${tag}-390-${scheme}`);
      await c.click('.item .open[data-id="' + id + '"]'); await sleep(400);
      await shot(c, `customer-detail-${tag}-390-${scheme}`);
      await ctx.close();
    }
  };
  await s.call('POST', '/api/soldout', { id: 3, soldOut: true }); await one('soldout', 3); await s.call('POST', '/api/soldout', { id: 3, soldOut: false });
  await s.call('POST', '/api/settings', { acceptOrders: false }); await one('closed', 1); await s.call('POST', '/api/settings', { acceptOrders: true });
  // ธีมที่เจ้าของตั้ง: ส้มพริก และเหลือง (สีอ่อน มีขอบเข้มให้)
  for (const color of ['#ea580c', '#facc15']) {
    await s.call('POST', '/api/settings', { accent: color });
    for (const scheme of ['light', 'dark']) await cust(390, scheme, '-theme' + color.slice(1));
  }
  await s.call('POST', '/api/settings', { accent: '' });
  await browser.close(); await s.stop(); rmrf(app.base);
  console.log('ภาพอยู่ใน ' + OUT + ' (' + fs.readdirSync(OUT).length + ' ไฟล์)');
})().catch(e => { console.error(e); process.exit(1); });
