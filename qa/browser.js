'use strict';
/* ทดสอบหน้าเว็บด้วยเบราว์เซอร์จริง (Microsoft Edge ผ่าน playwright-core)
   ติดตั้งครั้งแรก:  cd qa && npm install
   รัน:            node qa/browser.js <เคส>     เคส: pay-race, reqid-reload, xss, day, all
   QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/browser.js <เคส>   รันกับโค้ดก่อนแก้
   QA_BROWSER=chrome  ใช้ Google Chrome แทน Edge */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, until, rmrf, salesLines, checker, PIN } = require('./lib');

const CHANNEL = process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function launch() { return chromium.launch({ channel: CHANNEL, headless: process.env.QA_HEADED ? false : true }); }
// เก็บ error จาก console และ JS ทุกหน้า เพื่อสรุปท้ายเคส
// ไม่นับ 4xx ที่เบราว์เซอร์ log เองแต่หน้าเว็บจัดการแล้ว (401 ก่อนกรอก PIN, 409 ยอดเปลี่ยน) นับ 5xx และ JS error ทุกตัว
function watch(page, errors, label) {
  page.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('dialog', d => { errors.push(label + ' dialog(' + d.type() + '): ' + d.message()); d.dismiss().catch(() => {}); });
}
async function staffPage(browser, s, opts, errors) {
  const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, opts || {}));
  const page = await ctx.newPage(); watch(page, errors, 'staff');
  await page.goto('/staff');
  await page.fill('#pin', PIN); await page.press('#pin', 'Enter');
  await page.waitForSelector('#tabs .tab');
  return page;
}
async function customerPage(browser, s, t, key, errors, opts) {
  const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE, opts || {}));
  const page = await ctx.newPage(); watch(page, errors, 'customer' + t);
  await page.goto('/order?t=' + t + '&k=' + key);
  await page.waitForSelector('.item');
  return page;
}
const tab = (page, v) => page.click('#tabs [data-v="' + v + '"]');
const toastText = page => page.textContent('#toast');
// ไม่มีแถบเลื่อนแนวนอน: หาว่าอะไรล้นขอบจอ
async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w + 1) return null;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > w + 1 && !el.closest('[hidden]') && getComputedStyle(el).position !== 'fixed') bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' right=' + Math.round(r.right));
    });
    return { scrollWidth: document.documentElement.scrollWidth, width: w, offenders: bad.slice(0, 6) };
  });
}

const cases = {
  /* ลูกค้าสั่งเพิ่มระหว่างพนักงานกดรับเงิน (กดครั้งแรกแล้ว ยังไม่กดยืนยัน) */
  async 'pay-race'(browser) {
    const ok = checker('pay-race'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] }, { staff: false });
    const page = await staffPage(browser, s, null, errors);
    await tab(page, 'tables'); await page.click('[data-a="sel"][data-id="1"]');
    const btn = page.locator('[data-a="pay"][data-m="cash"]');
    const shown = (await page.textContent('.receipt .grand .a')).trim();
    await btn.click();                                              // ครั้งแรก: ปุ่มเปลี่ยนเป็น "ยืนยัน ฿..."
    const armedText = (await btn.textContent()).trim();
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 2, qty: 1 }] }, { staff: false });   // ลูกค้าสั่งเพิ่ม
    await until(async () => (await page.textContent('.receipt .grand .a')).trim() !== shown, 5000, 'หน้าจอได้ยอดใหม่');
    const newArmed = (await btn.textContent()).trim();
    await btn.click();                                              // ครั้งที่สอง: พนักงานกดยืนยันตามที่ตั้งใจไว้
    await sleep(500);
    const st = (await s.call('GET', '/api/state')).json;
    const sales = salesLines(app.code);
    console.log('  ยอดที่พนักงานเห็นตอนกดครั้งแรก ' + armedText + ' · หลังลูกค้าสั่งเพิ่ม ปุ่มกลายเป็น ' + newArmed + ' · toast: ' + (await toastText(page)));
    ok(sales.length === 0, 'ปิดบิลไม่ได้ถ้ายอดเปลี่ยนหลังกดรับเงินครั้งแรก', sales.map(x => x.total));
    ok(st.bills[1], 'โต๊ะ 1 ยังเปิดอยู่ให้ตรวจยอดใหม่');
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await page.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* เน็ตลูกค้าหลุดตอนกดสั่ง (คำสั่งถึงครัวแล้วแต่คำตอบไม่กลับ) แล้วกดใหม่ ทั้งแบบไม่รีเฟรชและรีเฟรชหน้า */
  async 'reqid-reload'(browser) {
    const ok = checker('reqid-reload'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const count = async t => (await s.call('GET', '/api/state')).json.tickets.filter(k => k.table === t).length;
    for (const [t, reload] of [[2, false], [3, true]]) {
      const page = await customerPage(browser, s, t, keys[t], []);
      await page.click('.item [data-a="inc"]');
      await page.click('[data-a="open"]');
      let dropped = 0;
      await page.route('**/api/order', async route => {
        if (dropped) return route.continue();
        dropped++; await route.fetch(); await route.abort('failed');   // ถึงเซิร์ฟเวอร์แล้ว แต่คำตอบหาย
      });
      await page.click('[data-a="send"]');
      await page.waitForSelector('#sheet .err');
      if (reload) { await page.reload(); await page.waitForSelector('.item'); await page.click('[data-a="open"]'); }
      await page.click('[data-a="send"]');
      await until(async () => /ส่งออเดอร์เข้าครัวแล้ว/.test(await toastText(page)) || await page.$('#sheet .err') !== null, 5000);
      await sleep(300);
      ok(await count(t) === 1, 'โต๊ะ ' + t + ': เน็ตหลุดตอนสั่ง แล้วกดใหม่' + (reload ? 'หลังรีเฟรชหน้า' : '') + ' ได้ออเดอร์เดียว', await count(t));
      await page.context().close();
    }
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ระหว่างพนักงานเลือกไฟล์ (หน้าต่างเลือกไฟล์เปิดอยู่) มีออเดอร์เข้า หน้าจอ re-render: ไฟล์ที่เลือกต้องไม่หาย */
  async 'file-picker'(browser) {
    const ok = checker('file-picker'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const bkFile = path.join(app.code, 'backups', name);
    const pngFile = path.join(app.base, 'p.png');
    fs.writeFileSync(pngFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const page = await staffPage(browser, s, null, errors);
    let n = 0;
    const orderAndWait = async () => { n++; await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }], memo: 'ระหว่างเลือกไฟล์ ' + n }, { staff: false }); await sleep(800); };
    // ไฟล์สำรอง
    await tab(page, 'settings'); await page.waitForSelector('label[for="rs-file"]');
    const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.click('label[for="rs-file"]')]);
    await orderAndWait();
    await fc1.setFiles(bkFile); await sleep(800);
    ok(await page.$('[data-a="rsgo"]') !== null, 'เลือกไฟล์สำรองระหว่างมีออเดอร์เข้า: ไฟล์ไม่หาย ขึ้นปุ่มกู้คืน');
    // รูปเมนู
    await tab(page, 'menu'); await page.click('[data-a="eopen"][data-id="1"]'); await page.waitForSelector('label[for="e-file"]');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('label[for="e-file"]')]);
    await orderAndWait();
    await fc2.setFiles(pngFile); await sleep(800);
    ok(await page.$('#editor img.thumb') !== null, 'เลือกรูปเมนูระหว่างมีออเดอร์เข้า: รูปไม่หาย ขึ้นตัวอย่างรูป');
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ใส่ XSS ในทุกช่องที่ผู้ใช้กรอกได้ (และที่มาจากไฟล์สำรอง) แล้วเปิดทุกหน้า: ต้องไม่มี script ทำงาน */
  async xss(browser) {
    const ok = checker('xss'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const P = [
      '<img src=x onerror="window.__xss=(window.__xss||0)+1">',
      '"><svg onload="window.__xss=(window.__xss||0)+1">',
      "'><script>window.__xss=(window.__xss||0)+1</script>",
      '</textarea><iframe srcdoc="<script>parent.__xss=1</script>">'
    ];
    const p = i => P[i % P.length];
    const r = [];
    r.push(await s.call('POST', '/api/settings', { shop: p(0), address: p(1), phone: p(2), footer: p(3), baseUrl: 'javascript:window.__xss=1' }));
    r.push(await s.call('POST', '/api/settings', { shop: p(0).slice(0, 60), address: p(1), phone: p(2).slice(0, 40), footer: p(3).slice(0, 80) }));
    const cat = (await s.call('POST', '/api/menu/category', { name: p(1).slice(0, 30) })).json.category;
    const it = (await s.call('POST', '/api/menu/item', { name: p(0).slice(0, 60), price: 45.5, cat: cat.id, station: 'hot', desc: p(2) })).json.item;
    r.push(await s.call('POST', '/api/menu/notes', { notes: [p(0).slice(0, 24), p(1).slice(0, 24), 'ไม่เผ็ด'] }));
    const notes = (await s.call('GET', '/api/menu')).json.notes;
    const keys = (await s.call('GET', '/api/state')).json.keys;
    r.push(await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: it.id, qty: 1, note: notes }], memo: p(3) }, { staff: false }));
    // ค่าที่แก้ผ่านหน้าเว็บไม่ได้ (ชื่อจุดทำอาหาร ชื่อในบิลเก่า) มาจากไฟล์สำรองที่ถูกแก้
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(app.code, 'backups', name))).toString('utf8'));
    b.data.menu.stations = { hot: p(0), bar: p(1) };
    b.data.sales = [{ no: 7, at: Date.now() - 60000, table: 2, sub: 10, svc: 0, vat: 0, total: 10, method: p(2), items: [{ name: p(3), qty: 1, price: p(0) }] }];
    b.data.nextBill = 8;
    const rr = await s.call('POST', '/api/backup/restore', Buffer.from(JSON.stringify(b)), { headers: { 'content-type': 'application/json' } });
    if (rr.headers['set-cookie']) s.cookie = rr.headers['set-cookie'][0].split(';')[0];
    ok(rr.status === 200, 'กู้คืนไฟล์ที่มี payload ได้', rr.json);
    ok(r[0].status === 400, 'baseUrl แบบ javascript: ถูกปฏิเสธ', r[0].json);

    const page = await staffPage(browser, s, null, errors);
    for (const v of ['kitchen', 'tables', 'menu', 'report', 'settings']) {
      await tab(page, v); await sleep(300);
      if (v === 'tables') { await page.click('[data-a="sel"][data-id="1"]'); await sleep(200); }
      if (v === 'menu') { await page.click('[data-a="eopen"][data-id="' + it.id + '"]'); await sleep(200); await page.click('[data-a="catedit"][data-id="' + cat.id + '"]'); await sleep(200); }
      if (v === 'report') { await page.waitForSelector('[data-a="viewsale"]'); await page.click('[data-a="viewsale"]'); await sleep(200); }
    }
    const staffX = await page.evaluate(() => window.__xss || 0);
    const shopShown = await page.evaluate(() => document.body.innerText.includes('<img src=x onerror='));
    const cust = await customerPage(browser, s, 1, keys[1], errors);
    await cust.click('[data-a="cat"][data-id="' + cat.id + '"]');
    await cust.click('[data-a="inc"][data-id="' + it.id + '"]');
    await cust.click('[data-a="open"]'); await cust.click('[data-a="notes"]'); await sleep(300);
    await cust.click('[data-a="zoom"]').catch(() => {});
    const custX = await cust.evaluate(() => window.__xss || 0);
    ok(staffX === 0, 'หน้าพนักงานทุกแท็บ: ไม่มี script จาก payload ทำงาน', staffX);
    ok(custX === 0, 'หน้าลูกค้า เมนู ตะกร้า หมายเหตุ: ไม่มี script จาก payload ทำงาน', custX);
    ok(shopShown, 'payload แสดงเป็นข้อความธรรมดา');
    ok(!errors.some(e => /dialog/.test(e)), 'ไม่มี alert/dialog', errors.filter(e => /dialog/.test(e)));
    // ตัวควบคุม: ถ้าใส่ payload แบบไม่ escape ตัวตรวจต้องจับได้ (พิสูจน์ว่าเทสต์นี้ไม่ผ่านเพราะตรวจไม่เป็น)
    await page.evaluate(h => document.body.insertAdjacentHTML('beforeend', h), P[0]);
    await sleep(300);
    ok(await page.evaluate(() => window.__xss || 0) > 0, 'ตัวควบคุม: payload ที่ไม่ escape ถูกตรวจจับได้');
    await page.context().close(); await cust.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* จำลองหนึ่งวันทำงาน + 390 px + light/dark + รีสตาร์ทเซิร์ฟเวอร์ระหว่างเปิดหน้าเว็บ */
  async day(browser) {
    const ok = checker('day'); const errors = [];
    const app = makeApp(); let s = start(app.code); await s.ready; await s.login();
    const port = s.port;
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const staff = await staffPage(browser, s, null, errors);
    // ตั้งค่าร้าน
    await tab(staff, 'settings');
    await staff.fill('#s-shop', 'ร้านป้าแดง'); await staff.fill('#s-pp', '0812345678');
    await staff.click('[data-a="savesettings"]'); await sleep(400);
    ok((await s.call('GET', '/api/state')).json.settings.promptpay === '0812345678', 'บันทึกตั้งค่าร้านจากหน้าเว็บ');
    // มือถือ 3 เครื่องสั่งพร้อมกัน
    const custs = await Promise.all([1, 2, 3].map(t => customerPage(browser, s, t, keys[t], errors)));
    await Promise.all(custs.map(async (c, i) => {
      await c.click('.item [data-a="inc"]'); for (let n = 0; n <= i; n++) await c.click('.item [data-a="inc"]');
      await c.click('[data-a="open"]');
    }));
    await Promise.all(custs.map(c => c.click('[data-a="send"]')));
    await Promise.all(custs.map(c => c.waitForFunction(() => /ส่งออเดอร์เข้าครัวแล้ว/.test(document.querySelector('#toast').textContent))));
    await tab(staff, 'kitchen');
    await until(async () => (await staff.$$('#v-kitchen .card')).length >= 3, 5000, 'ครัวเห็นออเดอร์ 3 ใบ');
    ok(true, 'ครัวเห็นออเดอร์จากมือถือ 3 เครื่องที่สั่งพร้อมกัน');
    // ครัวกดสถานะ
    await staff.click('#v-kitchen .card [data-a="adv"][data-st="cooking"]'); await sleep(300);
    await staff.click('#v-kitchen .card [data-a="adv"][data-st="ready"]'); await sleep(300);
    await until(async () => /พร้อมเสิร์ฟ/.test(await custs.map(c => c).reduce(async (a, c) => (await a) + await c.textContent('#status'), Promise.resolve(''))), 8000, 'ลูกค้าเห็นพร้อมเสิร์ฟ');
    ok(true, 'ลูกค้าเห็นสถานะ "พร้อมเสิร์ฟ" เอง');
    // ตั้งเมนูหมด
    await tab(staff, 'menu');
    await staff.click('[data-a="sold"][data-id="2"]'); await sleep(300);
    await until(async () => (await custs[0].$$('.item.out')).length > 0, 8000, 'ลูกค้าเห็นเมนูหมด');
    ok(true, 'ลูกค้าเห็นเมนูหมดภายใน 5 วินาที');
    // แก้เมนูและอัปรูป
    const png = await staff.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d'); x.fillStyle = '#c2410c'; x.fillRect(0, 0, 1600, 1200); x.fillStyle = '#fff'; x.fillRect(200, 200, 600, 400); return c.toDataURL('image/png').split(',')[1]; });
    const pngFile = path.join(app.base, 'dish.png'); fs.writeFileSync(pngFile, Buffer.from(png, 'base64'));
    await staff.click('[data-a="eopen"][data-id="1"]');
    await staff.fill('#e-price', '65.5');
    await staff.setInputFiles('#e-file', pngFile);
    await staff.waitForSelector('#editor img.thumb');
    await staff.click('[data-a="esave"]');
    await until(async () => { const m = (await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1); return m.price === 65.5 && m.image; }, 5000, 'บันทึกเมนู');
    const m1 = (await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1);
    const img = await s.call('GET', '/img/' + m1.image);
    ok(img.status === 200 && img.buf.length < 300 * 1024, 'อัปรูป 1600x1200 แล้วย่อเหลือ ' + Math.round(img.buf.length / 1024) + ' KB');
    await until(async () => (await custs[0].$$('.item img')).length > 0, 8000, 'ลูกค้าเห็นรูปใหม่');
    ok(true, 'ลูกค้าเห็นราคาใหม่และรูปใหม่โดยไม่ต้องรีเฟรช');
    // ปิดบิลเงินสดและโอน
    await tab(staff, 'tables');
    const bills = {};
    for (const [t, m] of [[1, 'cash'], [2, 'transfer']]) {
      await staff.click('[data-a="sel"][data-id="' + t + '"]');
      const shown = (await staff.textContent('.receipt .grand .a')).trim();
      await staff.click('[data-a="pay"][data-m="' + m + '"]'); await staff.click('[data-a="pay"][data-m="' + m + '"]');
      await staff.waitForSelector('[data-a="donesale"]');
      bills[t] = shown;
      await staff.click('[data-a="donesale"]');
    }
    const rep = (await s.call('GET', '/api/report')).json;
    ok(rep.count === 2 && rep.cash > 0 && rep.transfer > 0, 'ปิดบิลเงินสดและโอนจากหน้าเว็บ', { cash: rep.cash, transfer: rep.transfer, shown: bills });
    // สรุปยอดและ CSV
    await tab(staff, 'report'); await staff.waitForSelector('.kpis');
    const kpi = (await staff.textContent('.kpis .kpi .v')).replace(/[^\d.]/g, '');
    ok(+kpi === rep.total, 'ยอดในหน้าสรุปตรงกับ API', { page: kpi, api: rep.total });
    const [dl] = await Promise.all([staff.waitForEvent('download'), staff.click('a[href^="/api/export.csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    const csvTotal = csv.trim().split('\r\n').slice(1).reduce((a, l) => a + +l.split('","')[7], 0);
    ok(Math.abs(csvTotal - rep.total) < 0.001, 'ยอดใน CSV ตรงกับหน้าสรุป', { csv: csvTotal, report: rep.total });
    // สำรองแล้วกู้คืนจากหน้าเว็บ
    await tab(staff, 'settings'); await staff.waitForSelector('[data-a="bknow"]');
    await staff.click('[data-a="bknow"]'); await staff.waitForSelector('#bk table');
    const [bk] = await Promise.all([staff.waitForEvent('download'), staff.click('#bk a[href^="/api/backup/download"]')]);
    const bkFile = path.join(app.base, 'dl-backup.json.gz'); await bk.saveAs(bkFile);
    await s.call('POST', '/api/settings', { shop: 'เปลี่ยนชั่วคราว' });
    await staff.setInputFiles('#rs-file', bkFile);
    await staff.waitForSelector('[data-a="rsgo"]');
    await staff.click('[data-a="rsgo"]'); await staff.click('[data-a="rsgo"]');
    await until(async () => /กู้คืนข้อมูลแล้ว/.test(await toastText(staff)), 10000, 'กู้คืนจากหน้าเว็บ');
    if (staff) { const c = (await staff.context().cookies()).find(x => x.name === 'st'); if (c) s.cookie = 'st=' + c.value; }
    ok((await s.call('GET', '/api/state')).json.settings.shop === 'ร้านป้าแดง', 'สำรองแล้วกู้คืนจากหน้าเว็บ ข้อมูลกลับมา');

    // รีสตาร์ทเซิร์ฟเวอร์ระหว่างหน้าเว็บเปิดอยู่ แล้วมีออเดอร์เข้าทันทีหลังเปิดใหม่ (ก่อนหน้าเว็บต่อกลับ)
    await tab(staff, 'kitchen');
    await s.stop();
    await until(async () => /ขาดการเชื่อมต่อ/.test(await staff.textContent('#conn')), 8000, 'หน้าพนักงานรู้ว่าหลุด');
    s = start(app.code, { PORT: String(port) }); await s.ready; await s.login();
    await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 3, qty: 1 }], memo: 'หลังรีสตาร์ท' }, { staff: false });
    await until(async () => /หลังรีสตาร์ท/.test(await staff.textContent('#v-kitchen')), 15000, 'ครัวเห็นออเดอร์ที่เข้ามาช่วงต่อกลับ');
    ok(/ออนไลน์/.test(await staff.textContent('#conn')), 'หน้าพนักงานต่อกลับเองและไม่พลาดออเดอร์ที่เข้ามาช่วงนั้น');
    await custs[2].click('.item [data-a="inc"]'); await custs[2].click('[data-a="open"]'); await custs[2].click('[data-a="send"]');
    await custs[2].waitForFunction(() => /ส่งออเดอร์เข้าครัวแล้ว/.test(document.querySelector('#toast').textContent), null, { timeout: 8000 });
    ok(true, 'หน้าลูกค้าที่เปิดค้างไว้ สั่งต่อได้หลังรีสตาร์ท');

    // 390 px ทุกแท็บ ทั้ง light และ dark
    const mob = await staffPage(browser, s, MOBILE, errors);
    for (const scheme of ['light', 'dark']) {
      await mob.emulateMedia({ colorScheme: scheme });
      for (const v of ['kitchen', 'tables', 'menu', 'report', 'settings']) {
        await tab(mob, v); await sleep(250);
        if (v === 'tables') { await mob.click('[data-a="sel"][data-id="3"]'); await sleep(150); }
        if (v === 'menu') { await mob.click('[data-a="eopen"][data-id="1"]'); await sleep(150); }
        const o = await overflow(mob);
        ok(!o, 'staff 390px ' + scheme + ' แท็บ ' + v + ' ไม่เลื่อนแนวนอน', o || undefined);
        await mob.screenshot({ path: path.join(__dirname, 'out', 'staff-' + v + '-' + scheme + '.png'), fullPage: true });
      }
      await custs[0].emulateMedia({ colorScheme: scheme });
      await custs[0].click('[data-a="open"]').catch(() => {});
      const oc = await overflow(custs[0]);
      ok(!oc, 'customer 390px ' + scheme + ' ไม่เลื่อนแนวนอน', oc || undefined);
      await custs[0].screenshot({ path: path.join(__dirname, 'out', 'customer-' + scheme + '.png'), fullPage: true });
      const colors = await mob.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
      ok(scheme === 'dark' ? /rgb\((1\d|2\d),/.test(colors.bg) : /rgb\(2[34]\d,/.test(colors.bg), 'staff ใช้สีพื้นของโหมด ' + scheme, colors);
    }
    const real = errors.filter(e => !/ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error ทั้งวัน (ไม่นับการเชื่อมต่อไม่ได้ช่วงเซิร์ฟเวอร์ดับ)', real);
    await browser.close(); await s.stop(); rmrf(app.base);
    return ok.done();
  }
};

async function main() {
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const which = process.argv[2] || 'all';
  if (which === 'all') {
    // แยก process ต่อเคส พร้อม timeout เคสใดค้างจะไม่ลากเคสอื่น
    let bad = 0;
    const cp = require('node:child_process');
    for (const n of Object.keys(cases)) {
      const code = await new Promise(resolve => {
        const c = cp.spawn(process.execPath, [__filename, n], { stdio: 'inherit' });
        // หมดเวลา: ปิดทั้งต้นไม้ (เซิร์ฟเวอร์และ Edge ที่เคสเปิดไว้) ไม่ใช่แค่ process ลูก
        const t = setTimeout(() => { console.log('  ✖ ' + n + ': เกิน 5 นาที'); if (process.platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f']); else c.kill('SIGKILL'); }, 300000);
        c.on('exit', s => { clearTimeout(t); resolve(s); });
      });
      if (code !== 0) bad++;
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }
  const names = [which];
  let failed = 0;
  for (const n of names) {
    if (!cases[n]) { console.error('ไม่รู้จักเคส ' + n); process.exit(2); }
    console.log('\n=== ' + n + (process.env.QA_FROM ? '  (โค้ดจาก ' + process.env.QA_FROM + ')' : '') + ' ===');
    const browser = await launch();
    try { if (!(await cases[n](browser))) failed++; }
    catch (e) { failed++; console.log('  ✖ ' + e.message.split('\n')[0] + '  @' + ((e.stack || '').split('\n').find(l => l.includes('browser.js')) || '').trim()); }
    finally { await browser.close().catch(() => {}); }
  }
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(2); });
