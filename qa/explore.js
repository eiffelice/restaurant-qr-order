'use strict';
/* QA สำรวจ (exploratory): สิ่งที่เทสต์อัตโนมัติอื่นยังไม่ครอบ ดูภาพใน qa/out/explore/
   node qa/explore.js */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, rmrf, checker, PIN } = require('./lib');
const OUT = path.join(__dirname, 'out', 'explore');
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function staff(browser, s, opts) {
  const p = await (await browser.newContext(Object.assign({ baseURL: s.B }, opts || {}))).newPage();
  await p.goto('/staff'); await p.fill('#pin', PIN); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
  return p;
}
async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ? document.documentElement.scrollWidth : 0);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ok = checker('explore');
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge' });
  const keys0 = (await s.call('GET', '/api/state')).json.keys;

  // 1) ชื่อเมนูยาวสุด (60 ตัวอักษร ไม่มีเว้นวรรค) ทุกหน้าจอที่แสดงชื่อ ที่ 390 px
  const longName = 'ข้าวผัดกะเพราหมูสับไข่ดาวไม่สุกพิเศษเผ็ดมากเพิ่มกุ้งสดตัวใหญ่ใส่ถั่วฝักยาวเยอะๆ'.slice(0, 60);
  const it = (await s.call('POST', '/api/menu/item', { name: longName, price: 189.75, cat: 1, station: 'hot', desc: 'คำอธิบายยาวมาก'.repeat(9).slice(0, 120) })).json.item;
  await s.call('POST', '/api/order', { table: 1, key: keys0[1], items: [{ id: it.id, qty: 20 }], memo: 'ขอจานแยกสามใบ ไม่ใส่ผงชูรส แพ้ถั่วลิสงรุนแรงมาก กรุณาแยกเขียง' }, { staff: false });
  const cust = await (await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE))).newPage();
  await cust.goto('/order?t=1&k=' + keys0[1]); await cust.waitForSelector('.item');
  await cust.click('[data-a="inc"][data-id="' + it.id + '"]'); await cust.click('[data-a="open"]'); await sleep(200);
  await cust.screenshot({ path: path.join(OUT, 'long-customer.png'), fullPage: true });
  const ow = await overflow(cust);
  const mob = await staff(browser, s, MOBILE);
  await mob.screenshot({ path: path.join(OUT, 'long-kitchen.png'), fullPage: true });
  const kw = await overflow(mob);
  await mob.click('#tabs [data-v="tables"]'); await mob.click('[data-a="sel"][data-id="1"]'); await sleep(200);
  await mob.screenshot({ path: path.join(OUT, 'long-bill.png'), fullPage: true });
  const bw = await overflow(mob);
  ok(!ow && !kw && !bw, 'ชื่อเมนู 60 ตัวอักษร + memo ยาว: หน้าลูกค้า จอครัว ใบแจ้งยอด ไม่ล้นจอ 390px', { ow, kw, bw });

  // 2) พิมพ์ใบเสร็จ: มีแค่ใบเสร็จ ไม่มีปุ่ม/แท็บ ขนาดกระดาษ 80 mm
  const desk = await staff(browser, s);
  await desk.click('#tabs [data-v="tables"]'); await desk.click('[data-a="sel"][data-id="1"]');
  await desk.evaluate(() => document.body.classList.add('pm-receipt'));
  await desk.emulateMedia({ media: 'print' });
  await desk.screenshot({ path: path.join(OUT, 'print-receipt.png'), fullPage: true });
  // หน้าพิมพ์ใช้ visibility:hidden ซ่อนทุกอย่างยกเว้นใบเสร็จ
  const printVis = await desk.evaluate(() => ['#tabs .tab', '.pay-wrap button', '.tables .tbl', '.receipt .grand'].map(sel => sel + ':' + getComputedStyle(document.querySelector(sel)).visibility));
  ok(printVis.slice(0, 3).every(v => /hidden$/.test(v)) && /visible$/.test(printVis[3]), 'พิมพ์ใบแจ้งยอด: เห็นแค่ใบเสร็จ ไม่มีแท็บ ปุ่ม และผังโต๊ะ', printVis);
  await desk.emulateMedia({ media: 'screen' });
  await desk.evaluate(() => document.body.classList.remove('pm-receipt'));

  // 3) ไม่มี PromptPay: ข้อความบอกทางไปตั้งค่าต้องตรงกับชื่อแท็บจริง
  const hint = await desk.textContent('.receipt .qr small');
  const tabNames = await desk.$$eval('#tabs .tab', b => b.map(x => x.textContent.trim()));
  const m = hint.match(/แท็บ "([^"]+)"/);
  ok(!m || tabNames.includes(m[1]), 'ข้อความ "ตั้งค่าเบอร์ PromptPay ในแท็บ ..." ชี้ไปแท็บที่มีอยู่จริง', { hint, tabNames });

  // 4) เพิ่มโต๊ะ: หาเจอจากแท็บโต๊ะ & บิลไหม
  const addBtn = await desk.$('#v-tables [data-a="addtable"]');
  if (addBtn) { await addBtn.click(); await sleep(500); }
  const nAfter = (await s.call('GET', '/api/state')).json.settings.tables;
  ok(addBtn && nAfter === 13 && await desk.$('[data-a="sel"][data-id="13"]'), 'เจ้าของกด "เพิ่มโต๊ะ" ได้จากแท็บโต๊ะ & บิล แล้วโต๊ะ 13 ขึ้นทันที', nAfter);

  // 5) ร้านใหญ่ 60 โต๊ะ บนมือถือ
  await s.call('POST', '/api/settings', { tables: 60 });
  await mob.click('#tabs [data-v="tables"]'); await sleep(400);
  await mob.screenshot({ path: path.join(OUT, 'tables-60-mobile.png'), fullPage: true });
  ok(!(await overflow(mob)), '60 โต๊ะบนมือถือ 390px ไม่ล้นจอ');
  await desk.click('#tabs [data-v="settings"]'); await sleep(300);
  await desk.emulateMedia({ media: 'print' }); await desk.evaluate(() => document.body.classList.add('pm-qr'));
  await desk.screenshot({ path: path.join(OUT, 'print-qr-60.png'), fullPage: true });
  const qrCount = await desk.$$eval('.qcard', q => q.length);
  ok(qrCount === 60, 'พิมพ์ QR ทุกโต๊ะ: ได้ 60 ใบ', qrCount);
  await desk.emulateMedia({ media: 'screen' }); await desk.evaluate(() => document.body.classList.remove('pm-qr'));

  // 6) ลดจำนวนโต๊ะ ขณะลูกค้าโต๊ะที่ถูกลดเปิดหน้าค้าง: ลูกค้าต้องรู้ ไม่ใช่สั่งไม่ได้แบบงงๆ
  const c50 = await (await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE))).newPage();
  const k50 = (await s.call('GET', '/api/state')).json.keys[50];
  await c50.goto('/order?t=50&k=' + k50); await c50.waitForSelector('.item');
  await s.call('POST', '/api/settings', { tables: 20 });
  await sleep(5600);
  // หน้าลูกค้าบอกเองในรอบ poll ถัดไป (เดิมต้องกดสั่งก่อนถึงจะรู้) ถ้ายังไม่ขึ้น ลองกดสั่งแบบเดิม
  let msg = (await c50.textContent('#app')).replace(/\s+/g, ' ');
  if (!/ไม่พบโต๊ะ/.test(msg)) { await c50.click('.item [data-a="inc"]'); await c50.click('[data-a="open"]'); await c50.click('[data-a="send"]'); await sleep(600); msg = (await c50.textContent('#sheet')).replace(/\s+/g, ' '); }
  ok(/ไม่พบโต๊ะ/.test(msg), 'ลูกค้าโต๊ะที่ถูกลดออก กดสั่งแล้วได้ข้อความบอกเหตุผล', msg.slice(0, 120));

  // 7) แก้เมนูเดียวกันจากสองเครื่องพร้อมกัน: เครื่องที่บันทึกทีหลังทับโดยไม่รู้ตัวไหม
  const a = await staff(browser, s), b = await staff(browser, s);
  for (const p of [a, b]) { await p.click('#tabs [data-v="menu"]'); await p.click('[data-a="eopen"][data-id="1"]'); }
  await a.fill('#e-price', '75'); await a.click('[data-a="esave"]'); await sleep(600);
  await b.fill('#e-desc', 'แก้คำอธิบาย'); await b.click('[data-a="esave"]'); await sleep(600);
  const price = (await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1).price;
  ok(price === 75, 'สองเครื่องแก้เมนูเดียวกัน: ราคาที่อีกเครื่องเพิ่งแก้ไม่ถูกทับกลับเป็นค่าเก่า', price);

  // 8) เซิร์ฟเวอร์ดับตอนลูกค้ากดสั่ง: ข้อความชัดเจน ตะกร้าไม่หาย
  const c2 = await (await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE))).newPage();
  await c2.goto('/order?t=2&k=' + keys0[2]); await c2.waitForSelector('.item');
  await c2.click('.item [data-a="inc"]'); await c2.click('[data-a="open"]');
  await c2.route('**/api/order', r => r.abort('connectionrefused'));
  await c2.click('[data-a="send"]'); await sleep(500);
  const err = await c2.textContent('#sheet .err').catch(() => '');
  // ตะกร้าแบบใหม่เก็บเป็นแถว (lines) แบบเดิมเป็น object (cart) นับได้ทั้งสองแบบ
  const cartKept = await c2.evaluate(() => { const c = JSON.parse(localStorage.getItem('cart-2')); return c.lines ? c.lines.length : Object.keys(c.cart).length; });
  ok(/ส่งไม่สำเร็จ/.test(err) && cartKept === 1, 'เน็ต/เซิร์ฟเวอร์ล่มตอนกดสั่ง: บอกให้ลองใหม่ ตะกร้ายังอยู่', err);

  await browser.close(); await s.stop(); rmrf(app.base);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
