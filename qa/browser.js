'use strict';
/* ทดสอบหน้าเว็บด้วยเบราว์เซอร์จริง (Microsoft Edge ผ่าน playwright-core)
   ติดตั้งครั้งแรก:  cd qa && npm install
   รัน:            node qa/browser.js <เคส>     เคส: pay-race, reqid-reload, xss, day, customer, theme, confirm, qrfiles, antiprank, themeretry, cover, shopinfo, payqr, waiter, sound, print, itemvoid, acceptance, all
   QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/browser.js <เคส>   รันกับโค้ดก่อนแก้
   QA_BROWSER=chrome  ใช้ Google Chrome แทน Edge */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, until, rmrf, salesLines, checker, PIN, fakePhoto, fakeCover } = require('./lib');

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

  /* รับเงินสด: กรอกเงินที่รับมา เห็นเงินทอน เงินไม่พอกดยืนยันไม่ได้ ออเดอร์เข้าระหว่างพิมพ์ไม่ทำให้ช่องหาย
     และหน้าสรุปยอดแสดงประวัติการแก้ไข (ยกเลิกออเดอร์) */
  async cash(browser) {
    const ok = checker('cash'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] }, { staff: false });   // 120 + ค่าบริการ 12 = 132
    const v = await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 3, qty: 1 }] }, { staff: false });
    await s.call('POST', '/api/ticket/void', { id: v.json.tickets[0], reason: 'ทดสอบ' });
    const page = await staffPage(browser, s, MOBILE, errors);
    await tab(page, 'tables'); await page.click('[data-a="sel"][data-id="1"]');
    const pay = page.locator('[data-a="pay"][data-m="cash"]');
    await pay.click();
    await page.waitForSelector('#cash-in');
    ok(await page.evaluate(() => document.activeElement.id === 'cash-in'), 'กดรับเงินสดแล้วเคอร์เซอร์อยู่ที่ช่องรับเงินมา');
    await page.keyboard.type('10');
    await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 2, qty: 1 }] }, { staff: false });   // ออเดอร์เข้าระหว่างพิมพ์
    await sleep(600);
    await page.keyboard.type('0');
    ok(await page.inputValue('#cash-in') === '100', 'ออเดอร์เข้าระหว่างพิมพ์ ตัวเลขที่พิมพ์ไม่หาย', await page.inputValue('#cash-in'));
    ok(/ขาดอีก ฿32/.test(await page.textContent('#cash-change')) && await pay.isDisabled(), 'รับ 100 จากยอด 132: เตือนเงินไม่พอ และกดยืนยันไม่ได้', await page.textContent('#cash-change'));
    await page.click('[data-a="cashq"][data-v="500"]');
    ok(/ทอน ฿368/.test(await page.textContent('#cash-change')) && !(await pay.isDisabled()), 'กดปุ่มลัด 500: ทอน ฿368');
    await page.screenshot({ path: path.join(__dirname, 'out', 'cash-armed.png'), fullPage: true });
    await pay.click();
    await page.waitForSelector('[data-a="donesale"]');
    ok(/รับมา ฿500 · ทอน ฿368/.test(await page.textContent('#v-tables')) && /เงินทอน/.test(await page.textContent('.receipt')), 'หลังรับเงิน: แสดงรับมา/ทอน และใบเสร็จมีบรรทัดเงินทอน');
    await page.screenshot({ path: path.join(__dirname, 'out', 'cash-done.png'), fullPage: true });
    const paid = (await s.call('GET', '/api/audit')).json.events.find(e => e.action === 'bill.paid');
    ok(paid && paid.received === 500 && paid.change === 368, 'audit log บันทึกรับมา 500 ทอน 368', paid && [paid.received, paid.change]);
    // กด Enter ในช่องรับเงินเพื่อยืนยัน
    await page.click('[data-a="donesale"]'); await page.click('[data-a="sel"][data-id="5"]');
    await pay.click(); await page.waitForSelector('#cash-in');
    await page.keyboard.type('1000'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-a="donesale"]');
    ok(true, 'พิมพ์จำนวนแล้วกด Enter ยืนยันรับเงินได้');
    // ประวัติการแก้ไขในหน้าสรุปยอด
    await tab(page, 'report'); await page.waitForSelector('.audit-row');
    const rep = await page.textContent('#v-report');
    ok(/ประวัติการแก้ไขวันนี้/.test(rep) && /ยกเลิกออเดอร์ 1 ใบ/.test(rep) && /log ครบถ้วน/.test(rep), 'สรุปยอดแสดงประวัติการแก้ไข ยอดที่ถูกยกเลิก และสถานะ log', rep.match(/ยกเลิกออเดอร์[^฿]*฿[\d.,]+/));
    await page.screenshot({ path: path.join(__dirname, 'out', 'audit-report.png'), fullPage: true });
    const o = await overflow(page);
    ok(!o, 'หน้าสรุปยอดที่มีประวัติการแก้ไข 390px ไม่เลื่อนแนวนอน', o || undefined);
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* พนักงานรายคน: เจ้าของเพิ่มพนักงานจากหน้าเว็บ แต่ละบทบาทเห็นเฉพาะส่วนของตัวเอง เปลี่ยนสิทธิ์แล้วเครื่องที่เข้าอยู่หลุด */
  async roles(browser) {
    const ok = checker('roles'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const owner = await staffPage(browser, s, null, errors);
    await tab(owner, 'settings'); await owner.waitForSelector('[data-a="stnew"]');
    for (const [name, role, pin] of [['สมใจ', 'cashier', '520011'], ['ช่างต้ม', 'kitchen', '520022']]) {
      await owner.click('[data-a="stnew"]');
      await owner.fill('#sf-name', name); await owner.selectOption('#sf-role', role); await owner.fill('#sf-pin', pin);
      await owner.click('[data-a="stsave"]');
      await owner.waitForFunction(n => document.querySelector('#stf').textContent.includes(n), name);
    }
    ok(/สมใจ[\s\S]*แคชเชียร์[\s\S]*ช่างต้ม[\s\S]*ครัว/.test(await owner.textContent('#stf')), 'เจ้าของเพิ่มแคชเชียร์และครัวจากหน้าตั้งค่า');
    await owner.click('#stf [data-a="stedit"][data-id="s1"]');
    await (await owner.$('#stf')).screenshot({ path: path.join(__dirname, 'out', 'staff-panel.png') });
    await owner.click('#stf [data-a="stcancel"]');
    const o1 = await overflow(await (async () => { const p = await staffPage(browser, s, MOBILE, errors); await tab(p, 'settings'); await p.waitForSelector('#stf .status-line'); return p; })());
    ok(!o1, 'ส่วนพนักงานที่ 390px ไม่เลื่อนแนวนอน', o1 || undefined);
    // เข้าสู่ระบบด้วย PIN ของแต่ละคน
    const login = async pin => {
      const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE)); const p = await ctx.newPage(); watch(p, errors, 'pin' + pin);
      await p.goto('/staff'); await p.fill('#pin', pin); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab'); return p;
    };
    const kitchen = await login('520022');
    const kt = (await kitchen.$$eval('#tabs .tab', b => b.map(x => x.dataset.v))).join(',');
    ok(kt === 'kitchen,menu' && /ช่างต้ม \(ครัว\)/.test(await kitchen.textContent('#brand')), 'ครัวเห็นแค่แท็บครัวกับเมนูหมด และหัวจอบอกชื่อ', kt);
    await s.call('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 1 }] }, { staff: false });
    await kitchen.waitForSelector('#v-kitchen .card');
    ok(!(await kitchen.$('#v-kitchen [data-a="void"]')), 'ครัวไม่มีปุ่มยกเลิกออเดอร์');
    await kitchen.click('#v-kitchen [data-a="adv"]'); await sleep(300);
    await tab(kitchen, 'menu'); await kitchen.waitForSelector('[data-a="sold"]');
    ok(!(await kitchen.$('[data-a="eopen"]')) && !(await kitchen.$('[data-a="enew"]')) && !(await kitchen.$('#c-new')), 'ครัวแก้เมนูไม่ได้ เห็นแค่ปุ่มตั้งเมนูหมด');
    await kitchen.click('[data-a="sold"][data-id="2"]'); await sleep(300);
    ok((await s.call('GET', '/api/state')).json.settings.soldOut.includes(2), 'ครัวตั้งเมนูหมดได้');
    const cashier = await login('520011');
    ok((await cashier.$$eval('#tabs .tab', b => b.map(x => x.dataset.v))).join(',') === 'kitchen,tables,menu,report', 'แคชเชียร์เห็นครัว โต๊ะ เมนูหมด สรุปยอด (ไม่มีตั้งค่า)');
    await tab(cashier, 'tables'); await cashier.click('[data-a="sel"][data-id="3"]');
    await cashier.click('[data-a="pay"][data-m="cash"]'); await cashier.waitForSelector('#cash-in');
    await cashier.keyboard.type('100'); await cashier.keyboard.press('Enter'); await cashier.waitForSelector('[data-a="donesale"]');
    await tab(cashier, 'report'); await cashier.waitForSelector('.kpis');
    ok(!(await cashier.$('a[href^="/api/export.csv"]')) && !/ประวัติการแก้ไข/.test(await cashier.textContent('#v-report')), 'แคชเชียร์ดูสรุปยอดได้ แต่ไม่เห็น CSV และประวัติการแก้ไข');
    // เจ้าของเห็นว่าใครรับเงิน
    const paid = (await s.call('GET', '/api/audit')).json.events.find(e => e.action === 'bill.paid');
    ok(paid && paid.name === 'สมใจ' && paid.role === 'cashier', 'log บอกว่าสมใจ (แคชเชียร์) เป็นคนรับเงิน', paid && paid.name);
    // ปิดบัญชีครัวจากหน้าเว็บ: จอครัวหลุดไปหน้าใส่ PIN
    await owner.click('#stf [data-a="sttoggle"][data-id="s2"]'); await owner.waitForSelector('#confirm-dlg[open]'); await owner.click('#cf-ok');
    await s.call('POST', '/api/order', { table: 4, key: keys[4], items: [{ id: 1, qty: 1 }] }, { staff: false });   // ให้จอครัวโหลดข้อมูลใหม่
    await kitchen.waitForSelector('#login:not([hidden])', { timeout: 8000 }).catch(() => {});
    ok(await kitchen.isVisible('#login'), 'ปิดบัญชีแล้ว จอครัวที่เปิดอยู่หลุดไปหน้าใส่ PIN');
    ok(errors.filter(e => !/net::ERR/.test(e)).length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
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
    await fc2.setFiles(pngFile);
    // ย่อรูปในเบราว์เซอร์ใช้เวลาไม่แน่นอน รอผลแทนการรอเวลาตายตัว
    const shown = await page.waitForSelector('#editor img.thumb', { timeout: 5000 }).then(() => true, () => false);
    ok(shown, 'เลือกรูปเมนูระหว่างมีออเดอร์เข้า: รูปไม่หาย ขึ้นตัวอย่างรูป');
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
    await cust.click('[data-a="close"]'); await cust.click('.item .open[data-id="' + it.id + '"]'); await cust.waitForSelector('#detail:not([hidden])');
    await cust.click('[data-a="dtab"][data-t="notes"]').catch(() => {}); await sleep(200);   // หน้ารายละเอียด: ชื่อ คำอธิบาย หมวด หมายเหตุ
    const custX = await cust.evaluate(() => window.__xss || 0);
    ok(staffX === 0, 'หน้าพนักงานทุกแท็บ: ไม่มี script จาก payload ทำงาน', staffX);
    ok(custX === 0, 'หน้าลูกค้า เมนู ตะกร้า หมายเหตุ หน้ารายละเอียด: ไม่มี script จาก payload ทำงาน', custX);
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
    await staff.click('[data-a="rsgo"]'); await staff.waitForSelector('#confirm-dlg[open]'); await staff.click('#cf-ok');
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
  },

  /* หน้าลูกค้าแบบใหม่: หน้ารายละเอียด, หมายเหตุแยกแถว, ปุ่มย้อนกลับ, เมนูหมดระหว่างเปิด, ไม่มีรูป, XSS, ตะกร้าแบบเดิม, ธีม/โลโก้ */
  async customer(browser) {
    const ok = checker('customer'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const img = async (id, hue) => s.call('POST', '/api/menu/image?id=' + id, await fakePhoto(browser, hue), { headers: { 'content-type': 'image/png' } });
    await img(1, 20); await img(3, 35);
    const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const xi = (await s.call('POST', '/api/menu/item', { name: 'ข้าว' + X, price: 49.5, cat: 1, station: 'hot', desc: 'อร่อย' + X })).json.item;
    const c = await customerPage(browser, s, 4, keys[4], errors);
    await c.evaluate(() => { window.__xss = 0; });

    // 0) ทุกหมวดเรียงต่อกัน: เห็นทุกจานโดยไม่ต้องเลือกหมวด (เดิมแสดงทีละหมวด ลูกค้าคิดว่าเมนูหาย)
    const vis = (await s.call('GET', '/api/menu', undefined, { staff: false })).json.items.length;
    ok(await c.$$eval('.item', x => x.length) === vis, 'เห็นทุกจานในหน้าเดียว ' + vis + ' จาน', await c.$$eval('.item', x => x.length));
    const lastCat = await c.$$eval('nav.cats .cat', x => +x[x.length - 1].dataset.id);
    await c.click('nav.cats .cat[data-id="' + lastCat + '"]'); await sleep(1300);
    const secTop = await c.$eval('#sec-' + lastCat, e => e.getBoundingClientRect().top);
    ok(secTop < 200 && await c.getAttribute('nav.cats .cat[data-id="' + lastCat + '"]', 'aria-pressed') === 'true', 'แตะปุ่มหมวดสุดท้าย: เลื่อนไปหมวดนั้น ปุ่มถูกเลือก', secTop);
    await c.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
    ok(await c.$eval('nav.cats .cat', b => b.getAttribute('aria-pressed')) === 'true', 'เลื่อนกลับบนสุด: ปุ่มหมวดแรกถูกเลือกตามตำแหน่ง');

    // 1) แตะการ์ด → หน้ารายละเอียด → เลือกหมายเหตุ → เพิ่มจำนวน → ใส่ตะกร้า
    await c.click('.item .open[data-id="1"]');
    await c.waitForSelector('#detail:not([hidden])');
    ok(await c.evaluate(() => document.activeElement && document.activeElement.dataset.a === 'dback'), 'เปิดหน้ารายละเอียดแล้วโฟกัสอยู่ที่ปุ่มกลับ');
    await c.click('[data-a="dtab"][data-t="notes"]');
    await c.click('[data-a="dnote"][data-n="ไม่เผ็ด"]');
    await c.click('[data-a="dinc"]');
    ok(/฿120/.test(await c.textContent('[data-a="dadd"]')), 'ปุ่มเพิ่มรายการแสดงราคารวมตามจำนวน (2 × 60)', await c.textContent('[data-a="dadd"]'));
    await c.click('[data-a="dadd"]');
    await c.waitForSelector('#detail', { state: 'hidden' });
    await sleep(200);
    ok(await c.evaluate(() => document.activeElement && document.activeElement.matches('.item .open[data-id="1"]')), 'ปิดแล้วโฟกัสกลับไปที่การ์ดเดิม');
    // ใส่ตะกร้าเร็ว (ปุ่ม + บนการ์ด) = แถวไม่มีหมายเหตุ แยกจากแถว "ไม่เผ็ด"
    await c.click('.item [data-a="inc"][data-id="1"]');
    const st0 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)), 4);
    ok(st0.lines.length === 2 && st0.lines.some(l => l.note.join() === 'ไม่เผ็ด' && l.qty === 2) && st0.lines.some(l => !l.note.length && l.qty === 1), 'เมนูเดียวกันหมายเหตุต่างกัน = คนละแถวในตะกร้า', st0.lines);
    // ใส่ "ไม่เผ็ด" อีก 1 จาน: รวมกับแถวเดิม ไม่เพิ่มแถว
    await c.click('.item .open[data-id="1"]'); await c.click('[data-a="dtab"][data-t="notes"]'); await c.click('[data-a="dnote"][data-n="ไม่เผ็ด"]'); await c.click('[data-a="dadd"]');
    const st1 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)), 4);
    ok(st1.lines.length === 2 && st1.lines.find(l => l.note.length).qty === 3, 'หมายเหตุเหมือนกัน = รวมแถวเดิม', st1.lines);

    // 1b) คีย์บอร์ด: เปิดหน้ารายละเอียดค้างไว้ข้ามรอบ poll (5 วินาที) โฟกัสต้องไม่หลุด
    await c.click('.item .open[data-id="2"]'); await c.click('[data-a="dtab"][data-t="notes"]');
    await c.focus('[data-a="dnote"][data-n="เผ็ดน้อย"]'); await sleep(6500);
    ok(await c.evaluate(() => document.activeElement && document.activeElement.dataset.n === 'เผ็ดน้อย'), 'เปิดหน้ารายละเอียดค้างข้ามรอบ poll: โฟกัสอยู่ที่ปุ่มเดิม');
    await c.keyboard.press('Enter');
    ok(await c.getAttribute('[data-a="dnote"][data-n="เผ็ดน้อย"]', 'aria-pressed') === 'true' && await c.evaluate(() => document.activeElement.dataset.n === 'เผ็ดน้อย'), 'กด Enter เลือกหมายเหตุ แล้วโฟกัสยังอยู่ที่ปุ่มเดิม');
    await c.keyboard.press('Escape');

    // 2) ปุ่มย้อนกลับของมือถือ (history.back) ปิดหน้ารายละเอียด/ตะกร้า ไม่ออกจากหน้าเว็บ
    const url0 = c.url();
    await c.click('.item .open[data-id="2"]'); await c.waitForSelector('#detail:not([hidden])');
    await c.goBack(); await c.waitForSelector('#detail', { state: 'hidden', timeout: 5000 }).catch(() => {});
    ok(await c.isHidden('#detail') && c.url() === url0, 'ปุ่ม back ปิดหน้ารายละเอียด ยังอยู่หน้าเดิม');
    await c.click('[data-a="open"]'); await c.waitForSelector('#sheetbg:not([hidden])');
    await c.goBack(); await c.waitForSelector('#sheetbg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    ok(await c.isHidden('#sheetbg') && c.url() === url0, 'ปุ่ม back ปิดตะกร้า ยังอยู่หน้าเดิม');
    await c.click('.item .open[data-id="2"]'); await c.keyboard.press('Escape');
    ok(await c.isHidden('#detail'), 'Esc ปิดหน้ารายละเอียด');
    await c.goBack().catch(() => {}); await sleep(300);
    ok(c.url() !== url0 || await c.isVisible('.item'), 'ปิดด้วยปุ่มในหน้าแล้ว history ไม่ค้าง (back ครั้งเดียวออกจากหน้าได้ตามปกติ)');
    if (c.url() !== url0) { await c.goto(url0); await c.waitForSelector('.item'); }

    // 3) ส่งออเดอร์: ครัวได้หมายเหตุแยกจาน
    await c.click('[data-a="open"]'); await c.click('[data-a="send"]');
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.length > 0, 8000);
    const items = (await s.call('GET', '/api/state')).json.tickets.flatMap(k => k.items).filter(i => i.id === 1);
    ok(items.length === 2 && items.some(i => i.qty === 3 && i.note.join() === 'ไม่เผ็ด') && items.some(i => i.qty === 1 && !i.note.length), 'ครัวได้ 2 แถว: ไม่เผ็ด ×3 และปกติ ×1', items);

    // 4) เมนูหมดระหว่างเปิดหน้ารายละเอียด: ปุ่มเปลี่ยนเป็น "หมดแล้ว" เอง
    await c.click('.item .open[data-id="3"]'); await c.waitForSelector('#detail:not([hidden])');
    await s.call('POST', '/api/soldout', { id: 3, soldOut: true });
    await c.waitForFunction(() => { const b = document.querySelector('[data-a="dadd"]'); return b && b.disabled && /หมดแล้ว/.test(b.textContent); }, null, { timeout: 9000 }).catch(() => {});
    const outBtn = await c.$eval('[data-a="dadd"]', b => ({ dis: b.disabled, t: b.textContent }));
    ok(outBtn.dis && /หมดแล้ว/.test(outBtn.t) && await c.$('.hero.out'), 'เมนูหมดระหว่างเปิด: ปุ่ม "หมดแล้ว" กดไม่ได้ รูปเป็นสีเทา', outBtn);
    await c.click('[data-a="dback"]');
    await s.call('POST', '/api/soldout', { id: 3, soldOut: false });

    // 5) เมนูไม่มีรูป: การ์ดและหน้ารายละเอียดใช้พื้นสีจาง + ชื่อหมวด
    // ชื่อหมวดอยู่ที่หัวข้อหมวดเหนือการ์ด (ไม่ซ้ำในทุกใบ) การ์ดใช้พื้นจางตามโทนหมวด + ไอคอนจาน
    const noimg = await c.$eval('.item .open[data-id="2"]', b => ({ ph: !!b.querySelector('.noimg[class*="tn"] svg'), head: b.closest('.sec').querySelector('h2').textContent }));
    ok(noimg.ph && noimg.head.trim().length > 0, 'การ์ดไม่มีรูป: พื้นจางตามหมวด + ไอคอน และมีชื่อหมวดเป็นหัวข้อ', noimg);
    await c.click('.item .open[data-id="2"]'); await c.waitForSelector('.hero.noimg');
    ok(true, 'หน้ารายละเอียดไม่มีรูป: hero แบบพื้นจาง');
    await c.click('[data-a="dback"]');

    // 6) XSS ในชื่อ/คำอธิบายเมนู: การ์ด หน้ารายละเอียด ตะกร้า
    await c.click('[data-a="cat"][data-id="1"]').catch(() => {});
    await c.click('.item .open[data-id="' + xi.id + '"]'); await c.waitForSelector('#detail:not([hidden])'); await sleep(300);
    const shown = await c.textContent('#detail');
    await c.click('[data-a="dadd"]'); await c.click('[data-a="open"]'); await sleep(300);
    const xs = await c.evaluate(() => window.__xss || 0);   // หน้าอาจถูกโหลดใหม่ในขั้นก่อน (ตัวแปรหาย = ไม่มีอะไรทำงาน)
    ok(xs === 0 && shown.includes('<img src=x'), 'ชื่อ/คำอธิบายที่เป็น HTML แสดงเป็นข้อความ ไม่ทำงาน', { xss: xs, shown: shown.slice(0, 120) });
    await c.click('[data-a="close"]');

    // 7) ตะกร้าแบบเดิมที่ลูกค้าเปิดค้างไว้ตอนอัปเดต: แปลงเอง และ reqId เดิมกันสั่งซ้ำ
    const rid = 'abcdef0123456789abcd';
    const first = await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 1, qty: 2, note: ['เผ็ดน้อย'] }], reqId: rid }, { staff: false });
    const c5 = await customerPage(browser, s, 5, keys[5], errors);
    await c5.evaluate(r => { localStorage.setItem('cart-5', JSON.stringify({ cart: { 1: { qty: 2, note: ['เผ็ดน้อย'], open: false } }, memo: '', reqId: r })); }, rid);
    await c5.reload(); await c5.waitForSelector('.item');
    ok(/2 จาน/.test(await c5.textContent('[data-a="open"]')), 'ตะกร้ารูปแบบเดิมแปลงเป็นแบบใหม่ ของไม่หาย');
    await c5.click('[data-a="open"]'); await c5.click('[data-a="send"]'); await sleep(800);
    const t5 = (await s.call('GET', '/api/state')).json.tickets.filter(k => k.table === 5);
    ok(first.status === 200 && t5.length === 1, 'reqId เดิมจากตะกร้าแบบเดิม: ไม่เกิดออเดอร์ซ้ำ', t5.length);

    // 7b) ใส่จานเดียวกันหมายเหตุเดียวกันรวมเกิน 20: ส่วนเกินเป็นแถวใหม่ ไม่หายเงียบๆ / เกินลิมิตต่อครั้งเตือนก่อนกดสั่ง
    await c.evaluate(t => localStorage.removeItem('cart-' + t), 4); await c.reload(); await c.waitForSelector('.item');
    for (const n of [15, 10]) {
      await c.click('.item .open[data-id="2"]'); await c.waitForSelector('#detail:not([hidden])');
      for (let i = 1; i < n; i++) await c.click('[data-a="dinc"]');
      await c.click('[data-a="dadd"]'); await c.waitForSelector('#detail', { state: 'hidden' });
    }
    const st2 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)).lines, 4);
    ok(st2.reduce((n, l) => n + l.qty, 0) === 25 && st2.every(l => l.qty <= 20), 'ใส่ 15 + 10 จาน: ได้ครบ 25 (แถวละไม่เกิน 20)', st2);
    for (const n of [20, 20]) {
      await c.click('.item .open[data-id="4"]'); for (let i = 1; i < n; i++) await c.click('[data-a="dinc"]'); await c.click('[data-a="dadd"]'); await c.waitForSelector('#detail', { state: 'hidden' });
    }
    await c.click('[data-a="open"]'); await sleep(200);
    ok(/ไม่เกิน 60 จาน/.test(await c.textContent('#sheet')) && await c.$eval('[data-a="send"]', b => b.disabled), 'เกิน 60 จาน: เตือนในตะกร้าและปุ่มสั่งกดไม่ได้ (ไม่ต้องรอเซิร์ฟเวอร์ปฏิเสธ)');
    await c.click('[data-a="close"]');
    await c.evaluate(t => localStorage.removeItem('cart-' + t), 4); await c.reload(); await c.waitForSelector('.item');

    // 8) ร้านปิดรับ QR: ปุ่มหลักกดไม่ได้ พร้อมข้อความเดิม
    await s.call('POST', '/api/settings', { acceptOrders: false });
    await c.click('.item .open[data-id="1"]').catch(() => {});
    await c.waitForFunction(() => { const b = document.querySelector('[data-a="dadd"]'); return b && b.disabled; }, null, { timeout: 9000 }).catch(() => {});
    ok(await c.$eval('[data-a="dadd"]', b => b.disabled) && /ปิดรับออเดอร์/.test(await c.textContent('#detail')), 'ร้านปิดรับ: ปุ่มใส่ตะกร้ากดไม่ได้ มีข้อความบอก');
    await c.click('[data-a="dback"]');
    await s.call('POST', '/api/settings', { acceptOrders: true });

    // 9) ธีมร้าน: เปลี่ยนสีและโลโก้แล้วหน้าลูกค้าที่เปิดอยู่เปลี่ยนตามเอง
    await s.call('POST', '/api/settings', { accent: '#dc2626' });
    await s.call('POST', '/api/settings/logo', await fakePhoto(browser, 200, 256), { headers: { 'content-type': 'image/png' } });
    await c.waitForSelector('header .logo', { timeout: 9000 }).catch(() => {});
    await sleep(500);
    const capBg = await c.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    ok(await c.$('header .logo') && capBg === '#dc2626', 'เปลี่ยนสี/โลโก้แล้วหน้าลูกค้าที่เปิดอยู่เปลี่ยนตาม', capBg);
    const lp = await (await browser.newContext({ baseURL: s.B })).newPage();
    await lp.goto('/staff'); await lp.waitForSelector('#login-logo:not([hidden])', { timeout: 5000 }).catch(() => {});
    ok(await lp.isVisible('#login-logo') && (await lp.textContent('#login-shop')).length > 0, 'หน้าใส่รหัสเข้าสู่ระบบแสดงโลโก้และชื่อร้าน');
    await lp.context().close();

    // 10) ไม่มีแถบเลื่อนแนวนอน 360 / 768 px ทุกจอ
    for (const w of [360, 768]) {
      const p = await customerPage(browser, s, 6, keys[6], errors, { viewport: { width: w, height: 800 } });
      const bad = [];
      const chk = async n => { const o = await overflow(p); if (o) bad.push(n + ' ' + JSON.stringify(o)); };
      await chk('เมนู'); await p.click('.item .open[data-id="1"]'); await chk('รายละเอียด');
      await p.click('[data-a="dtab"][data-t="notes"]'); await chk('หมายเหตุ'); await p.click('[data-a="dadd"]');
      await p.click('[data-a="open"]'); await p.click('[data-a="notes"]'); await chk('ตะกร้า');
      ok(!bad.length, w + 'px: เมนู รายละเอียด ตะกร้า ไม่เลื่อนแนวนอน', bad);
      await p.context().close();
    }
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await c.context().close(); await c5.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ธีมร้านจากหน้าตั้งค่า: เลือกสี บันทึก อัปโหลดโลโก้ สีขาวไม่รับ เครื่องอื่นเปลี่ยนสีแล้วหน้านี้ตาม */
  async theme(browser) {
    const ok = checker('theme'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const p = await staffPage(browser, s, null, errors);
    await tab(p, 'settings'); await p.waitForSelector('[data-a="tpreset"]');
    const accent = () => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    const before = await accent();
    await p.click('[data-a="tpreset"][data-c="#dc2626"]'); await sleep(400);
    ok(await p.evaluate(() => getComputedStyle(document.querySelector('#t-prev')).getPropertyValue('--accent').trim()) === '#dc2626' && await accent() === before, 'เลือกสี: ตัวอย่างเปลี่ยน หน้าจริงยังไม่เปลี่ยนจนกดบันทึก');
    await p.click('[data-a="tsave"]');
    await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#dc2626', null, { timeout: 8000 }).catch(() => {});
    ok(await accent() === '#dc2626', 'บันทึกสี: หน้าพนักงานใช้สีใหม่ทันที');
    // สีเกือบขาว: ระบบไม่รับ ปุ่มบันทึกกดไม่ได้
    await p.evaluate(() => { const i = document.querySelector('#t-color'); i.value = '#fafafa'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitForFunction(() => /อ่อนเกินไป/.test(document.querySelector('#theme .err').textContent), null, { timeout: 5000 }).catch(() => {});
    ok(/อ่อนเกินไป/.test(await p.textContent('#theme .err')) && await p.$eval('[data-a="tsave"]', b => b.disabled), 'สีเกือบขาว: แจ้งเหตุผล กดบันทึกไม่ได้');
    await p.click('[data-a="treset"]'); await sleep(300);
    // โลโก้: เลือกไฟล์ (input อยู่นอกส่วนที่วาดใหม่)
    await p.setInputFiles('#logo-file', { name: 'logo.png', mimeType: 'image/png', buffer: await fakePhoto(browser, 140, 300) });
    await p.waitForSelector('#brand-logo:not([hidden])', { timeout: 8000 }).catch(() => {});
    ok(await p.isVisible('#brand-logo'), 'อัปโหลดโลโก้: แสดงที่แถบเมนูหน้าพนักงาน');
    ok(await p.$('.qcard .qlogo'), 'โลโก้อยู่บนแผ่น QR ติดโต๊ะ');
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] }, { staff: false });
    await tab(p, 'tables'); await p.click('[data-a="sel"][data-id="2"]'); await sleep(300);
    ok(await p.$('.receipt .rlogo'), 'โลโก้อยู่บนใบแจ้งยอด/ใบเสร็จ');
    // อีกเครื่องเปลี่ยนสี: หน้าที่เปิดค้างไว้ตามเอง ไม่แสดงสีเก่าเหมือนยังไม่บันทึก
    await tab(p, 'settings'); await p.waitForSelector('[data-a="tpreset"]');
    await s.call('POST', '/api/settings', { accent: '#1d4ed8' });
    await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#1d4ed8', null, { timeout: 8000 }).catch(() => {});
    await sleep(500);
    ok(await accent() === '#1d4ed8' && await p.getAttribute('[data-a="tpreset"][data-c="#1d4ed8"]', 'aria-pressed') === 'true' && !(await p.$('[data-a="treset"]')), 'อีกเครื่องเปลี่ยนสี: หน้านี้ตาม และไม่ขึ้นว่ายังไม่บันทึก');
    // ตัวควบคุม: เปลี่ยนสีกลับเป็นตั้งต้น
    await s.call('POST', '/api/settings', { accent: '' });
    await p.waitForFunction(b => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === b, before, { timeout: 8000 }).catch(() => {});
    ok(await accent() === before, 'กลับเป็นสีตั้งต้น');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ยืนยันก่อนลบ + ลบโต๊ะ: หน้าต่างบอกว่าลบอะไร โฟกัสเริ่มที่ "ไม่ลบ" Esc/ไม่ลบ = ไม่มีอะไรหาย */
  async confirm(browser) {
    const ok = checker('confirm'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const X = '<img src=x onerror="window.__xss=1">';
    const it = (await s.call('POST', '/api/menu/item', { name: 'ทดสอบ' + X, price: 10, cat: 1, station: 'hot' })).json.item;
    const p = await staffPage(browser, s, null, errors);
    // ลบโต๊ะ
    await tab(p, 'tables'); await p.waitForSelector('[data-a="deltable"]');
    ok(/ลบโต๊ะ 12/.test(await p.textContent('[data-a="deltable"]')), 'มีปุ่มลบโต๊ะเลขสุดท้าย (โต๊ะ 12)');
    await p.click('[data-a="deltable"]'); await p.waitForSelector('#confirm-dlg[open]');
    ok(await p.evaluate(() => document.activeElement.id === 'cf-no'), 'เปิดหน้าต่างแล้วโฟกัสที่ "ไม่ลบ" (กด Enter พลาดก็ไม่ลบ)');
    ok(/QR โต๊ะ 12/.test(await p.textContent('#cf-b')), 'หน้าต่างบอกผลที่ตามมา (QR โต๊ะ 12 ใช้ไม่ได้)');
    await p.keyboard.press('Enter'); await sleep(400);
    ok((await s.call('GET', '/api/state')).json.settings.tables === 12, 'กด Enter ตอนโฟกัส "ไม่ลบ": ไม่ลบ');
    await p.click('[data-a="deltable"]'); await p.waitForSelector('#confirm-dlg[open]'); await p.keyboard.press('Escape'); await sleep(400);
    ok((await s.call('GET', '/api/state')).json.settings.tables === 12, 'กด Esc: ไม่ลบ');
    await p.click('[data-a="deltable"]'); await p.waitForSelector('#confirm-dlg[open]'); await p.click('#cf-ok');
    await until(async () => (await s.call('GET', '/api/state')).json.settings.tables === 11, 5000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.settings.tables === 11, 'ยืนยัน: เหลือ 11 โต๊ะ');
    // โต๊ะสุดท้ายมีออเดอร์ค้าง: ไม่เปิดหน้าต่าง บอกเหตุผล
    await s.call('POST', '/api/order', { table: 11, key: keys[11], items: [{ id: 1, qty: 1 }] }, { staff: false });
    await sleep(800);
    await p.click('[data-a="deltable"]'); await sleep(300);
    ok(!(await p.$('#confirm-dlg[open]')) && /ยังมีออเดอร์/.test(await toastText(p)), 'โต๊ะที่ยังมีออเดอร์ ลบไม่ได้ บอกเหตุผล');
    // เพิ่มโต๊ะกลับ: QR แผ่นเดิมใช้ได้
    await p.click('[data-a="addtable"]'); await sleep(600);
    const k12 = (await s.call('GET', '/api/state')).json.keys[12];
    ok(k12 === keys[12], 'เพิ่มโต๊ะ 12 กลับ: รหัส QR เดิม แผ่นเดิมใช้ต่อได้');
    // ลบเมนู: ชื่อเมนูในหน้าต่างเป็นข้อความธรรมดา
    await tab(p, 'menu'); await p.click('[data-a="eopen"][data-id="' + it.id + '"]'); await sleep(300);
    await p.click('[data-a="edel"]'); await p.waitForSelector('#confirm-dlg[open]');
    ok((await p.textContent('#cf-h')).includes('<img src=x') && !(await p.evaluate(() => window.__xss)), 'ชื่อเมนูในหน้าต่างยืนยันแสดงเป็นข้อความ ไม่ทำงาน');
    await p.click('#cf-no'); await sleep(300);
    ok((await s.call('GET', '/api/state')).json.menu.items.some(m => m.id === it.id), 'กด "ไม่ลบ": เมนูยังอยู่');
    await p.click('[data-a="edel"]'); await p.click('#cf-ok');
    await until(async () => !(await s.call('GET', '/api/state')).json.menu.items.some(m => m.id === it.id), 5000).catch(() => {});
    ok(!(await s.call('GET', '/api/state')).json.menu.items.some(m => m.id === it.id), 'ยืนยัน: ลบเมนูแล้ว');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* QR ติดโต๊ะ: พิมพ์รวม A4 หน้าละ 6 ใบ, พิมพ์ทีละโต๊ะ, PNG ทีละโต๊ะ (อ่านจุดในรูปกลับมาตรงกับ QR จริง), zip ทุกโต๊ะ */
  async qrfiles(browser) {
    const ok = checker('qrfiles'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { baseUrl: 'http://192.168.1.50:3000', tables: 7 });
    await s.call('POST', '/api/settings/logo', await fakePhoto(browser, 200, 200), { headers: { 'content-type': 'image/png' } });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const ctx = await browser.newContext({ baseURL: s.B, acceptDownloads: true });
    const p = await ctx.newPage(); watch(p, errors, 'staff');
    await p.goto('/staff'); await p.fill('#pin', PIN); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
    await tab(p, 'settings'); await p.waitForSelector('[data-a="qrpng"][data-t="5"]');
    // PNG โต๊ะ 5
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-a="qrpng"][data-t="5"]')]);
    const png = fs.readFileSync(await dl.path());
    ok(dl.suggestedFilename() === 'QR-โต๊ะ-5.png' && png.slice(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 1600, 'ดาวน์โหลด PNG โต๊ะ 5: ชื่อไฟล์ถูก ขนาด 1200×1600', dl.suggestedFilename());
    // อ่านรูปกลับ: ทุกจุดของ QR ตรงกับข้อมูล QR ของ URL โต๊ะ 5 (ใช้ qrcode.js ตัวเดียวกับที่หน้าเว็บใช้)
    const match = await p.evaluate(async ([b64, url]) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      const n = q.getModuleCount(), box = { x: 150, y: 520, size: 900, margin: 4 }, m = box.size / (n + box.margin * 2);
      let bad = 0;
      for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) {
        const px = x.getImageData(Math.floor(box.x + (cc + box.margin + .5) * m), Math.floor(box.y + (r + box.margin + .5) * m), 1, 1).data;
        if ((px[0] < 128) !== q.isDark(r, cc)) bad++;
      }
      return { n, bad };
    }, [png.toString('base64'), 'http://192.168.1.50:3000/order?t=5&k=' + keys[5]]);
    ok(match.bad === 0 && match.n > 20, 'QR ในรูปตรงกับ URL โต๊ะ 5 ทุกจุด (' + match.n + '×' + match.n + ')', match);
    // zip ทุกโต๊ะ
    const [dz] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('[data-a="qrzip"]')]);
    const zip = fs.readFileSync(await dz.path());
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(eocd + 10), cdOff = zip.readUInt32LE(eocd + 16);
    const entries = []; let o = cdOff;
    for (let i = 0; i < count; i++) {
      const nl = zip.readUInt16LE(o + 28), lo = zip.readUInt32LE(o + 42), crc = zip.readUInt32LE(o + 16), size = zip.readUInt32LE(o + 20);
      const name = zip.slice(o + 46, o + 46 + nl).toString('utf8');
      const data = zip.slice(lo + 30 + zip.readUInt16LE(lo + 26), lo + 30 + zip.readUInt16LE(lo + 26) + size);
      entries.push({ name, crcOk: require('node:zlib').crc32(data) === crc, png: data.slice(1, 4).toString() === 'PNG' });
      o += 46 + nl;
    }
    ok(count === 7 && entries.every(e => e.crcOk && e.png) && entries[0].name === 'QR-โต๊ะ-01.png' && entries[6].name === 'QR-โต๊ะ-07.png', 'zip ทุกโต๊ะ: 7 ไฟล์ PNG ชื่อภาษาไทยถูก CRC ถูก', entries.map(e => e.name));
    // พิมพ์: ปิด window.print แล้วจำลองหน้าพิมพ์
    await p.evaluate(() => { window.print = () => {}; });
    await p.click('[data-a="printqr"]'); await p.emulateMedia({ media: 'print' }); await sleep(200);
    const all = await p.$$eval('.qcard', cs => cs.filter(c => getComputedStyle(c).display !== 'none').map(c => { const r = c.getBoundingClientRect(); return { t: c.dataset.t, x: Math.round(r.x), y: Math.round(r.y), act: getComputedStyle(c.querySelector('.qact')).display }; }));
    ok(all.length === 7 && all[0].y === all[1].y && all[0].x !== all[1].x && all.every(c => c.act === 'none'), 'พิมพ์รวม: 7 ใบ 2 คอลัมน์ ไม่มีปุ่มติดไปในกระดาษ', all.slice(0, 3));
    await p.emulateMedia({ media: 'screen' }); await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await p.click('[data-a="qrprint"][data-t="3"]'); await p.emulateMedia({ media: 'print' }); await sleep(200);
    const one = await p.$$eval('.qcard', cs => cs.filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.t));
    ok(one.length === 1 && one[0] === '3', 'พิมพ์ทีละโต๊ะ: เห็นแค่โต๊ะ 3', one);
    await p.emulateMedia({ media: 'screen' }); await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    ok(!(await p.$('.qcard.pick')) && !(await p.evaluate(() => document.body.className.includes('pm-'))), 'พิมพ์เสร็จ: หน้าจอกลับเป็นปกติ');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await ctx.close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* กันออเดอร์ปลอม: เปิดโต๊ะก่อนสั่ง, ปิดรับตามเวลา, เปลี่ยนรหัส QR, ใส่ PIN ซ้ำก่อนเรื่องสำคัญ (ผ่านหน้าจอจริง) */
  async antiprank(browser) {
    const ok = checker('antiprank'); const errors = [];
    const app = makeApp(); const s = start(app.code, { REAUTH_SEC: '3' }); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const p = await staffPage(browser, s, null, errors);
    // 1) เปิดใช้ "ต้องเปิดโต๊ะก่อนลูกค้าสั่ง" จากหน้าตั้งค่า
    await tab(p, 'settings'); await p.waitForSelector('#s-seat');
    await p.click('#s-seat'); await p.click('[data-a="savesettings"]');
    await until(async () => (await s.call('GET', '/api/state')).json.settings.requireSeat === true, 5000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.settings.requireSeat === true, 'เปิดโหมด "ต้องเปิดโต๊ะก่อนสั่ง" จากหน้าตั้งค่าได้');
    const c = await customerPage(browser, s, 2, keys[2], errors);
    await c.waitForFunction(() => /ยังไม่ได้เปิด/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    ok(/ยังไม่ได้เปิด/.test(await c.textContent('#app')), 'ลูกค้าโต๊ะที่ยังไม่เปิด เห็นข้อความให้เรียกพนักงาน');
    await c.click('.item .open[data-id="1"]'); await c.waitForSelector('#detail:not([hidden])');
    ok(await c.$eval('[data-a="dadd"]', b => b.disabled && /รอพนักงานเปิดโต๊ะ/.test(b.textContent)), 'ปุ่มเพิ่มรายการกดไม่ได้ บอกว่ารอพนักงานเปิดโต๊ะ');
    await c.click('[data-a="dback"]');
    ok(await c.isEnabled('[data-a="call"][data-k="staff"]'), 'ยังกดเรียกพนักงานได้');
    // พนักงานเปิดโต๊ะ → ลูกค้าสั่งได้เอง (ไม่ต้องรีเฟรช)
    await tab(p, 'tables'); await p.click('[data-a="sel"][data-id="2"]'); await p.waitForSelector('[data-a="seat"][data-on="1"]');
    await p.click('[data-a="seat"][data-on="1"]');
    await c.waitForFunction(() => !/ยังไม่ได้เปิด/.test(document.querySelector('#app').innerText), null, { timeout: 9000 }).catch(() => {});
    await c.click('.item [data-a="inc"][data-id="1"]').catch(() => {}); await c.click('[data-a="open"]').catch(() => {}); await c.click('[data-a="send"]').catch(() => {});
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.some(t => t.table === 2), 6000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.tickets.some(t => t.table === 2), 'พนักงานกดเปิดโต๊ะ ลูกค้าสั่งได้ทันทีโดยไม่ต้องรีเฟรช');
    // 2) นอกเวลารับออเดอร์: ป้ายบนหน้าพนักงาน
    const m = new Date().getHours() * 60 + new Date().getMinutes(), hh = x => { x = ((x % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
    await s.call('POST', '/api/settings', { hours: { on: true, open: hh(m + 60), close: hh(m + 120) } });
    await p.waitForSelector('#closedpill:not([hidden])', { timeout: 6000 }).catch(() => {});
    ok(/นอกเวลารับออเดอร์/.test(await p.textContent('#closedpill')), 'นอกเวลา: หน้าพนักงานมีป้าย "นอกเวลารับออเดอร์ QR"');
    await s.call('POST', '/api/settings', { hours: { on: false, open: '10:00', close: '22:00' } });
    // 3) ใส่ PIN ซ้ำ: หมดเวลายืนยันแล้วเพิ่มพนักงาน → หน้าต่างขอ PIN → PIN ผิดแจ้ง → PIN ถูกแล้วทำต่อให้เอง
    await sleep(3300);
    await tab(p, 'settings'); await p.waitForSelector('[data-a="stnew"]'); await p.click('[data-a="stnew"]');
    await p.fill('#sf-name', 'ทดสอบยืนยัน'); await p.fill('#sf-pin', '640099'); await p.click('[data-a="stsave"]');
    await p.waitForSelector('#reauth-dlg[open]', { timeout: 5000 }).catch(() => {});
    ok(await p.isVisible('#reauth-dlg'), 'เรื่องสำคัญหลังหมดเวลา: ขึ้นหน้าต่างใส่ PIN');
    await p.fill('#ra-pin', '111111'); await p.click('#ra-ok'); await sleep(500);
    ok(/ไม่ถูกต้อง/.test(await p.textContent('#ra-err')) && await p.isVisible('#reauth-dlg'), 'PIN ผิด: บอกในหน้าต่าง ไม่ทำรายการ');
    await p.fill('#ra-pin', PIN); await p.click('#ra-ok');
    await until(async () => (await s.call('GET', '/api/staff')).json.list.some(x => x.name === 'ทดสอบยืนยัน'), 5000).catch(() => {});
    ok((await s.call('GET', '/api/staff')).json.list.some(x => x.name === 'ทดสอบยืนยัน') && await p.isHidden('#reauth-dlg'), 'PIN ถูก: ทำรายการเดิมต่อให้เอง ไม่ต้องกดซ้ำ');
    // 4) เปลี่ยนรหัส QR โต๊ะ 2 จากการ์ด QR → ลูกค้าที่เปิดค้างอยู่ด้วย QR เก่าเห็นว่าต้องสแกนใหม่
    await p.waitForSelector('[data-a="qrrekey"][data-t="2"]'); await p.click('[data-a="qrrekey"][data-t="2"]');
    await p.waitForSelector('#confirm-dlg[open]'); await p.click('#cf-ok');
    await until(async () => (await s.call('GET', '/api/state')).json.keys[2] !== keys[2], 5000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.keys[2] !== keys[2], 'เปลี่ยนรหัส QR โต๊ะ 2 จากหน้าตั้งค่าได้ (อยู่ในเวลายืนยัน ไม่ต้องใส่ PIN ซ้ำ)');
    await c.waitForFunction(() => /QR ของโต๊ะไม่ถูกต้อง/.test(document.body.innerText), null, { timeout: 9000 }).catch(() => {});
    ok(/QR ของโต๊ะไม่ถูกต้อง/.test(await c.textContent('#app')), 'ลูกค้าที่ใช้ QR เก่า: หน้าบอกให้สแกนใหม่ ไม่ค้างแสดงเมนูที่สั่งไม่ได้');
    // ดาวน์โหลดไฟล์สำรองหลังหมดเวลายืนยัน: ขอ PIN ก่อน
    await s.call('POST', '/api/backup', {}); await sleep(3300);
    await p.evaluate(() => { const b = document.querySelector('[data-a="bknow"]'); if (b) b.scrollIntoView(); });
    await p.click('[data-a="bknow"]').catch(() => {}); await p.waitForSelector('[data-a="bkdl"]', { timeout: 5000 }).catch(() => {});
    await p.click('[data-a="bkdl"]');
    await p.waitForSelector('#reauth-dlg[open]', { timeout: 5000 }).catch(() => {});
    ok(await p.isVisible('#reauth-dlg'), 'ดาวน์โหลดไฟล์สำรองหลังหมดเวลา: ขอ PIN ก่อน');
    await p.click('#ra-no');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await c.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ไฟล์สีร้าน (/theme.css) โหลดไม่สำเร็จชั่วคราว (เซิร์ฟเวอร์รีสตาร์ท/เน็ตสะดุด): หน้าต้องลองใหม่เอง ไม่ค้างสีตั้งต้น */
  async themeretry(browser) {
    const ok = checker('themeretry'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { accent: '#dc2626' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const accent = pg => pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    for (const who of ['customer', 'staff']) {
      const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, who === 'customer' ? MOBILE : {}));
      let failed = 0;
      await ctx.route('**/theme.css*', r => { if (failed++ === 0) return r.abort('connectionrefused'); return r.continue(); });   // ครั้งแรกล้ม
      const p = await ctx.newPage();
      if (who === 'customer') { await p.goto('/order?t=1&k=' + keys[1]); await p.waitForSelector('.item'); }
      else { await p.goto('/staff'); await p.fill('#pin', PIN); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab'); }
      const first = await accent(p);
      await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#dc2626', null, { timeout: 9000 }).catch(() => {});
      ok(failed >= 2 && await accent(p) === '#dc2626', who + ': โหลดสีร้านครั้งแรกล้ม แล้วลองใหม่เองจนได้สีร้าน', { first, after: await accent(p), tries: failed });
      ok(await p.evaluate(() => document.querySelectorAll('link[rel=stylesheet]').length) === 1, who + ': ไม่มีไฟล์สีซ้อนค้าง');
      await ctx.close();
    }
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ภาพพื้นหลังหน้าลูกค้า: อัปโหลดจากหน้าตั้งค่า หน้าลูกค้าที่เปิดอยู่เปลี่ยนตาม หน้าเข้าสู่ระบบใช้ภาพเดียวกัน เอาออกแล้วกลับเป็นไล่สี
     + ป้ายขายดีจากยอดขายจริง + ท้ายหน้ามีที่อยู่/เบอร์โทร */
  async cover(browser) {
    const ok = checker('cover'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { address: '88/8 ถ.สุขุมวิท', phone: '02-123-4567' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 3, qty: 4 }] }, { staff: false });
    const sub = (await s.call('GET', '/api/state')).json.bills[5].sub;
    await s.call('POST', '/api/pay', { table: 5, expectedSub: sub, method: 'cash' });
    const c = await customerPage(browser, s, 2, keys[2], errors);
    ok(!(await c.evaluate(() => document.body.classList.contains('has-cover'))) && await c.$('header.top .cov'), 'ยังไม่มีภาพ: หัวหน้าเป็นพื้นไล่สีจากสีร้าน');
    ok(await c.$eval('.item:has(.open[data-id="3"]) .badge', e => e.textContent).catch(() => '') === 'ขายดี' && !(await c.$('.item:has(.open[data-id="1"]) .badge')), 'เมนูที่ขายได้ 4 จานมีป้าย "ขายดี" เมนูที่ยังไม่มียอดไม่มีป้าย');
    ok(/02-123-4567/.test(await c.textContent('footer.foot')) && await c.getAttribute('footer.foot a', 'href') === 'tel:021234567', 'ท้ายหน้ามีที่อยู่และเบอร์โทร กดโทรได้');
    const p = await staffPage(browser, s, null, errors);
    await tab(p, 'settings'); await p.waitForSelector('label[for="cover-file"]');
    await p.setInputFiles('#cover-file', { name: 'cover.jpg', mimeType: 'image/jpeg', buffer: await fakeCover(browser, 20) });
    await until(async () => !!(await s.call('GET', '/api/state')).json.settings.cover, 8000).catch(() => {});
    const cv = (await s.call('GET', '/api/state')).json.settings.cover;
    ok(/^cover-/.test(cv || ''), 'อัปโหลดภาพพื้นหลังจากหน้าตั้งค่า (input อยู่นอกส่วนที่วาดใหม่)', cv);
    await c.waitForFunction(() => document.body.classList.contains('has-cover'), null, { timeout: 9000 }).catch(() => {});
    const bg = await c.evaluate(() => getComputedStyle(document.querySelector('header.top .cov')).backgroundImage);
    ok(bg.includes(cv), 'หน้าลูกค้าที่เปิดอยู่เปลี่ยนเป็นภาพใหม่เอง (ไม่ต้องรีเฟรช)', bg.slice(0, 80));
    ok(await c.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage.includes('cover-')), 'ภาพจางเป็นพื้นหลังทั้งหน้า');
    const lp = await (await browser.newContext({ baseURL: s.B })).newPage();
    await lp.goto('/staff'); await lp.waitForSelector('#login.has-cover', { timeout: 5000 }).catch(() => {});
    ok(await lp.$('#login.has-cover'), 'หน้าใส่รหัสพนักงานใช้ภาพพื้นหลังของร้าน');
    await lp.context().close();
    await p.waitForSelector('[data-a="coverdel"]'); await p.click('[data-a="coverdel"]'); await p.waitForSelector('#confirm-dlg[open]'); await p.click('#cf-ok');
    await c.waitForFunction(() => !document.body.classList.contains('has-cover'), null, { timeout: 9000 }).catch(() => {});
    ok(!(await c.evaluate(() => document.body.classList.contains('has-cover'))), 'เอาภาพออก (ผ่านหน้าต่างยืนยัน): หน้าลูกค้ากลับเป็นไล่สี');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await c.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* หน้าลูกค้าแบบใหม่: เจ้าของใส่ลิงก์โซเชียลมีเดีย/แชร์ คำโปรย เมนูแนะนำ โทนสี จากหน้าพนักงาน แล้วลูกค้าเห็น
     + แผ่นข้อมูลร้าน (ปุ่ม back ปิด) แชร์ไม่ส่งรหัส QR ของโต๊ะ ค้นหาเมนู แถบล่าง */
  async shopinfo(browser) {
    const ok = checker('shopinfo'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const p = await staffPage(browser, s, null, errors);
    await tab(p, 'settings'); await p.waitForSelector('#s-facebook');
    await p.fill('#s-tag', 'อาหารไทยรสชาติต้นตำรับ');
    await p.fill('#s-facebook', 'facebook.com/kruapadaeng'); await p.fill('#s-instagram', '@krua.pa');
    await p.fill('#s-line', '@kruapa'); await p.fill('#s-share', 'https://maps.app.goo.gl/abc');
    await p.click('[data-a="savesettings"]');
    await until(async () => (await s.call('GET', '/api/state')).json.settings.shareUrl, 8000).catch(() => {});
    const st = (await s.call('GET', '/api/state')).json.settings;
    ok(st.tagline === 'อาหารไทยรสชาติต้นตำรับ' && st.social.facebook === 'https://facebook.com/kruapadaeng' && st.social.line === 'https://line.me/R/ti/p/@kruapa' && st.shareUrl === 'https://maps.app.goo.gl/abc', 'บันทึกคำโปรย ลิงก์โซเชียลมีเดีย และลิงก์แชร์จากหน้าตั้งค่า', st.social);
    await sleep(1200); await p.waitForSelector('#s-tiktok'); await p.fill('#s-tiktok', 'https://evil.example/tiktok'); await p.click('[data-a="savesettings"]'); await sleep(600);
    ok(/TikTok/.test(await p.textContent('#toast')) && (await s.call('GET', '/api/state')).json.settings.social.tiktok === '', 'ลิงก์ผิดโดเมน: บอกว่าผิดช่องไหน ไม่บันทึก', await p.textContent('#toast'));
    await p.fill('#s-tiktok', ''); await p.click('[data-a="savesettings"]'); await sleep(500);
    // เมนูแนะนำจากหน้าแก้เมนู
    await tab(p, 'menu'); await p.click('[data-a="eopen"][data-id="3"]'); await p.waitForSelector('#e-rec');
    await p.click('#e-rec'); await p.click('[data-a="esave"]');
    await until(async () => (await s.call('GET', '/api/state')).json.menu.items.find(i => i.id === 3).rec, 8000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.menu.items.find(i => i.id === 3).rec === true, 'ตั้งเมนูแนะนำจากหน้าแก้เมนู');

    const c = await customerPage(browser, s, 2, keys[2], errors);
    ok(await c.getAttribute('html', 'data-look') === 'dark' && /อาหารไทยรสชาติต้นตำรับ/.test(await c.textContent('header.top')), 'หน้าลูกค้าโทนมืดเป็นค่าเริ่มต้น มีคำโปรยใต้ชื่อร้าน');
    ok(/เมนูแนะนำ/.test(await c.textContent('#h-rec')) && await c.$('.rcard .open[data-id="3"]') && await c.$$eval('.item', x => x.length) === (await s.call('GET', '/api/menu', undefined, { staff: false })).json.items.length, 'แถวเมนูแนะนำแสดงเมนูที่ร้านเลือก (การ์ดในหมวดยังครบทุกจาน)');
    await c.click('.rcard [data-a="inc"][data-id="3"]');
    ok(await c.evaluate(() => document.activeElement && document.activeElement.matches('.rcard [data-a="inc"][data-id="3"]')), 'กด + บนการ์ดแนะนำแล้วโฟกัสอยู่ที่ปุ่มเดิม');
    ok(/1 จาน/.test(await c.textContent('[data-a="open"]')), 'เพิ่มจากการ์ดแนะนำลงรายการสั่ง');

    // ค้นหา
    await c.fill('#q', 'ผัด'); await sleep(300);
    const names = await c.$$eval('.item .nm', x => x.map(e => e.textContent));
    const box = await c.evaluate(() => ({ s: document.querySelector('.sbox').getBoundingClientRect().top, n: document.querySelector('nav.cats').getBoundingClientRect().bottom }));
    ok(names.length > 0 && names.length < (await s.call('GET', '/api/menu', undefined, { staff: false })).json.items.length && await c.$('#h-search'), 'ค้นหา "ผัด": เหลือเฉพาะเมนูที่ตรง', names);
    ok(box.s >= box.n - 1, 'ระหว่างค้นหา ช่องค้นหาไม่ถูกแถบหมวดบัง', box);
    await c.fill('#q', 'ไม่มีเมนูนี้แน่นอน'); await sleep(200);
    ok(/ไม่พบเมนู/.test(await c.textContent('#main')), 'ค้นหาไม่เจอ: บอกตรงๆ มีปุ่มดูทั้งหมด');
    await c.click('#main [data-a="qclear"]'); await sleep(200);
    ok(await c.$$eval('.item', x => x.length) === (await s.call('GET', '/api/menu', undefined, { staff: false })).json.items.length && await c.inputValue('#q') === '', 'ล้างคำค้น: กลับมาเห็นทุกจาน');

    // แถบล่าง: ออเดอร์ → เลื่อนไปสถานะโต๊ะ / ร้าน → แผ่นข้อมูลร้าน
    await c.click('#bnav [data-v="orders"]'); await sleep(900);
    const stTop = await c.$eval('#status', e => [Math.round(e.getBoundingClientRect().top), innerHeight, scrollY, document.documentElement.scrollHeight]);
    ok(stTop[0] >= 0 && stTop[0] < stTop[1] * 0.6, 'แถบล่าง "ออเดอร์": เลื่อนไปออเดอร์ของโต๊ะ', stTop);
    const url0 = c.url();
    await c.click('#bnav [data-v="shop"]'); await c.waitForSelector('#shopbg:not([hidden])');
    const links = await c.$$eval('#shop a.soc', x => x.map(a => ({ h: a.href, t: a.target, r: a.rel })));
    ok(links.length === 3 && links.every(l => l.h.startsWith('https://') && l.t === '_blank' && /noopener/.test(l.r) && /noreferrer/.test(l.r)), 'ข้อมูลร้าน: ปุ่มติดตาม 3 ช่องที่ใส่ไว้ (ช่องว่างไม่แสดง) เปิดแท็บใหม่ ไม่ส่ง referrer', links);
    const allHref = await c.$$eval('a[href]', x => x.map(a => a.href).join(' '));
    ok(!allHref.includes(keys[2]) && allHref.includes(encodeURIComponent('https://maps.app.goo.gl/abc')), 'ลิงก์แชร์ใช้ลิงก์ร้าน ไม่มีรหัส QR ของโต๊ะ');
    await c.click('#shop [data-a="copy"]'); await sleep(300);
    ok(/คัดลอก/.test(await c.textContent('#toast')), 'คัดลอกลิงก์ร้าน (เว็บร้านเป็น http ก็คัดลอกได้)', await c.textContent('#toast'));
    await c.goBack(); await c.waitForSelector('#shopbg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    ok(await c.isHidden('#shopbg') && c.url() === url0, 'ปุ่ม back ปิดข้อมูลร้าน ยังอยู่หน้าเดิม');

    // เจ้าของเปลี่ยนโทน: หน้าลูกค้าที่เปิดอยู่เปลี่ยนตามเอง
    await tab(p, 'settings'); await p.click('[data-a="tlook"][data-v="light"]');
    await c.waitForFunction(() => document.documentElement.dataset.look === 'light', null, { timeout: 9000 }).catch(() => {});
    const bg = await c.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(await c.getAttribute('html', 'data-look') === 'light' && bg === 'rgb(248, 250, 252)', 'เปลี่ยนเป็นโทนสว่าง: หน้าลูกค้าที่เปิดอยู่เปลี่ยนเอง', bg);
    const c2 = await customerPage(browser, s, 3, keys[3], errors, { viewport: { width: 360, height: 740 } });
    ok(await c2.getAttribute('html', 'data-look') === 'light', 'เปิดหน้าใหม่ได้โทนที่ร้านตั้ง');
    const bad = [];
    const chk = async n => { const o = await overflow(c2); if (o) bad.push(n + ' ' + JSON.stringify(o)); };
    await chk('เมนู'); await c2.click('#bnav [data-v="shop"]'); await sleep(300); await chk('ข้อมูลร้าน');
    ok(!bad.length, '360px: เมนูและข้อมูลร้านไม่เลื่อนแนวนอน', bad);
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await c.context().close(); await c2.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* รูป QR รับเงินของร้าน: อัปโหลดจากหน้าตั้งค่า ใบแจ้งยอดใช้รูปนั้นพร้อมบอกยอด หมดเวลายืนยันแล้วขอ PIN ก่อน เลิกใช้แล้วกลับเป็น QR จากเบอร์ */
  async payqr(browser) {
    const ok = checker('payqr'); const errors = [];
    const app = makeApp(); const s = start(app.code, { REAUTH_SEC: '3' }); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { promptpay: '0812345678' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] }, { staff: false });
    const p = await staffPage(browser, s, null, errors);
    const bill = async () => { await tab(p, 'tables'); await sleep(200); if (!(await p.$('.receipt .grand .a'))) await p.click('[data-a="sel"][data-id="1"]'); await p.waitForSelector('.receipt .grand .a', { timeout: 5000 }).catch(() => {}); await sleep(300); return p.evaluate(() => { const q = document.querySelector('.receipt .qr'); return { img: q && q.querySelector('img.payqr') ? q.querySelector('img.payqr').getAttribute('src') : '', svg: !!(q && q.querySelector('svg')), t: q ? q.textContent : '', total: document.querySelector('.receipt .grand .a').textContent.trim() }; }); };
    let b = await bill();
    ok(b.svg && !b.img, 'ยังไม่อัปโหลด: ใบแจ้งยอดใช้ QR ที่สร้างจากเบอร์ PromptPay');
    await tab(p, 'settings'); await p.waitForSelector('label[for="payqr-file"]');
    await p.setInputFiles('#payqr-file', { name: 'qr.png', mimeType: 'image/png', buffer: await fakePhoto(browser, 120, 300) });
    await until(async () => !!(await s.call('GET', '/api/state')).json.settings.payQr, 8000).catch(() => {});
    const q1 = (await s.call('GET', '/api/state')).json.settings.payQr;
    ok(/^payqr-/.test(q1 || ''), 'อัปโหลดรูป QR จากหน้าตั้งค่า (input อยู่นอกส่วนที่วาดใหม่)', q1);
    await p.waitForSelector('#payqr .pq img', { timeout: 5000 }).catch(() => {});
    ok(await p.$('#payqr .pq img'), 'หน้าตั้งค่าแสดงรูป QR ที่ใช้อยู่');
    b = await bill();
    ok(b.img.includes(q1) && !b.svg && b.t.includes(b.total), 'ใบแจ้งยอดใช้รูป QR ของร้าน และบอกยอดให้ลูกค้าพิมพ์เอง', b);
    // หมดเวลายืนยัน: เปลี่ยนรูปต้องใส่ PIN ก่อน แล้วอัปโหลดต่อให้เอง
    await sleep(3300);
    await tab(p, 'settings'); await p.waitForSelector('label[for="payqr-file"]');
    await p.setInputFiles('#payqr-file', { name: 'qr2.png', mimeType: 'image/png', buffer: await fakePhoto(browser, 200, 300) });
    await p.waitForSelector('#reauth-dlg[open]', { timeout: 5000 }).catch(() => {});
    ok(await p.isVisible('#reauth-dlg') && (await s.call('GET', '/api/state')).json.settings.payQr === q1, 'หมดเวลายืนยัน: ขอ PIN ก่อน ยังไม่เปลี่ยนรูป');
    await p.fill('#ra-pin', PIN); await p.click('#ra-ok');
    await until(async () => (await s.call('GET', '/api/state')).json.settings.payQr !== q1, 8000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.settings.payQr !== q1, 'ใส่ PIN ถูกแล้วอัปโหลดต่อเอง');
    // เลิกใช้รูป: ผ่านหน้าต่างยืนยัน กลับไปใช้ QR จากเบอร์
    await p.waitForSelector('[data-a="payqrdel"]'); await p.click('[data-a="payqrdel"]'); await p.waitForSelector('#confirm-dlg[open]');
    ok(/0812345678/.test(await p.textContent('#confirm-dlg')), 'หน้าต่างยืนยันบอกว่าจะกลับไปใช้เบอร์ไหน');
    await p.click('#cf-ok');
    await until(async () => !(await s.call('GET', '/api/state')).json.settings.payQr, 8000).catch(() => {});
    b = await bill();
    ok(b.svg && !b.img, 'เลิกใช้รูปแล้ว ใบแจ้งยอดกลับไปใช้ QR จากเบอร์');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* พนักงานเสิร์ฟ: เห็นแท็บ ครัว / โต๊ะ / เมนูหมด เห็นโต๊ะที่เรียก สั่งแทนลูกค้าได้ ไม่มีปุ่มรับเงิน ยกเลิก สรุปยอด */
  async waiter(browser) {
    const ok = checker('waiter'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/staff', { name: 'น้องเอ', role: 'waiter', pin: '520033' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 2 }] }, { staff: false });
    const ctx = await browser.newContext({ baseURL: s.B }); const p = await ctx.newPage(); watch(p, errors, 'waiter');
    await p.goto('/staff'); await p.fill('#pin', '520033'); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
    const tabs = await p.$$eval('#tabs .tab', x => x.map(b => b.dataset.v));
    ok(JSON.stringify(tabs) === JSON.stringify(['kitchen', 'tables', 'menu']) && /พนักงานเสิร์ฟ/.test(await p.textContent('#brand')), 'แท็บ: ครัว โต๊ะ & บิล เมนูหมด (ไม่มีสรุปยอด ตั้งค่า)', tabs);
    await tab(p, 'kitchen'); await p.waitForSelector('#v-kitchen .card');
    ok(!(await p.$('#v-kitchen [data-a="void"]')) && await p.$('#v-kitchen [data-a="adv"]'), 'จอครัว: เปลี่ยนสถานะได้ ไม่มีปุ่มยกเลิกออเดอร์');
    await s.call('POST', '/api/call', { table: 2, key: keys[2], kind: 'bill' }, { staff: false });
    await tab(p, 'tables'); await p.click('[data-a="sel"][data-id="2"]'); await p.waitForSelector('.receipt .grand .a');
    ok(/ขอเช็คบิล/.test(await p.textContent('#v-tables')), 'เห็นโต๊ะที่ลูกค้าขอเช็คบิล');
    ok(!(await p.$('[data-a="pay"]')) && !(await p.$('[data-a="bsvc"]')) && /รับเงินได้เฉพาะแคชเชียร์/.test(await p.textContent('#v-tables')) && await p.$('[data-a="printr"]'), 'ใบแจ้งยอดดู/พิมพ์ได้ แต่ไม่มีปุ่มรับเงินและปรับค่าบริการ');
    await p.click('[data-a="clearcall"]');
    await until(async () => !(await s.call('GET', '/api/state')).json.calls[2], 6000).catch(() => {});
    ok(!(await s.call('GET', '/api/state')).json.calls[2], 'กดรับทราบการเรียกได้');
    // สั่งแทนลูกค้า: ลิงก์เปิดหน้าลูกค้าในโหมดพนักงาน (ใช้ cookie เดียวกัน)
    const href = await p.getAttribute('#v-tables a[href*="/order?"]', 'href');
    const c = await ctx.newPage(); watch(c, errors, 'waiter-order');
    ok(href.startsWith('/order?'), 'ลิงก์สั่งแทนลูกค้าเป็นที่อยู่เดียวกับหน้าพนักงาน (cookie ไปด้วย)', href);
    await c.goto(href); await c.waitForSelector('.item');
    ok(/โหมดพนักงาน/.test(await c.textContent('header.top')), 'สั่งแทนลูกค้า: หน้าลูกค้าเปิดในโหมดพนักงาน');
    await c.click('.item [data-a="inc"][data-id="2"]'); await c.click('[data-a="open"]'); await c.click('[data-a="send"]');
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.some(k => k.table === 2 && k.by === 'staff'), 6000).catch(() => {});
    ok((await s.call('GET', '/api/state')).json.tickets.some(k => k.table === 2 && k.by === 'staff'), 'ส่งออเดอร์แทนลูกค้าเข้าครัวได้');
    // เปิด URL สรุปยอดตรงๆ ก็ไม่ได้ข้อมูล
    const rep = await p.evaluate(() => fetch('/api/report', { credentials: 'same-origin' }).then(r => r.status));
    ok(rep === 403, 'เรียกข้อมูลสรุปยอดตรงๆ ได้ 403', rep);
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await ctx.close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* เสียงแจ้งเตือน: ครัวได้ยินเฉพาะออเดอร์ใหม่ของจุดที่ดูอยู่ หน้าร้านได้ยินการเรียก ขอบิล พร้อมเสิร์ฟ เจ้าของได้ยินทุกเรื่อง
     เสียงแต่ละเรื่องไม่เหมือนกัน และเตือนซ้ำถ้ามีเรื่องค้าง (เร่งนาฬิกาในหน้าเว็บ) */
  async sound(browser) {
    const ok = checker('sound'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/staff', { name: 'ครัว', role: 'kitchen', pin: '520022' });
    await s.call('POST', '/api/staff', { name: 'เสิร์ฟ', role: 'waiter', pin: '520033' });
    const st0 = (await s.call('GET', '/api/state')).json, keys = st0.keys;
    const hot = st0.menu.items.find(i => i.station === 'hot').id, bar = st0.menu.items.find(i => i.station === 'bar').id;
    // นับเสียงจาก oscillator ที่เริ่มเล่น: โน้ตแรกของแต่ละเสียง order 660 · call 1200 (สองครั้ง) · bill 990 · ready 1320
    const open = async (pin, label) => {
      const ctx = await browser.newContext({ baseURL: s.B });
      await ctx.addInitScript(() => {
        window.__f = [];
        const A = window.AudioContext;
        window.AudioContext = function () {
          const ac = new A(), co = ac.createOscillator.bind(ac);
          ac.createOscillator = () => { const o = co(), st = o.start.bind(o); o.start = t => { window.__f.push(o.frequency.value); return st(t); }; return o; };
          return ac;
        };
      });
      const p = await ctx.newPage(); watch(p, errors, label);
      await p.clock.install();
      await p.goto('/staff'); await p.fill('#pin', pin); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
      await p.mouse.click(5, 5); await sleep(200);
      return p;
    };
    const k = await open('520022', 'kitchen'), w = await open('520033', 'waiter'), o = await open(PIN, 'owner');
    const P = { k, w, o };
    const kinds = async p => { const f = await p.evaluate(() => window.__f.slice()); const n = x => f.filter(v => v === x).length; return { order: n(660), call: n(1200) / 2, bill: n(990), ready: n(1320) }; };
    const delta = async fn => { const a = {}; for (const x in P) a[x] = await kinds(P[x]); await fn(); await sleep(1500); const d = {}; for (const x in P) { const b = await kinds(P[x]); d[x] = {}; for (const kk in b) if (b[kk] - a[x][kk]) d[x][kk] = b[kk] - a[x][kk]; } return d; };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let d = await delta(() => s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: hot, qty: 1 }] }, { staff: false }));
    ok(eq(d, { k: { order: 1 }, w: {}, o: { order: 1 } }), 'ออเดอร์ใหม่: ครัวและเจ้าของได้ยินเสียงออเดอร์ หน้าร้านไม่ดัง (เห็นข้อความ)', d);
    ok(/ออเดอร์ใหม่/.test(await w.textContent('#toast')), 'พนักงานเสิร์ฟยังเห็นข้อความออเดอร์ใหม่บนจอ');
    await k.click('[data-a="kst"][data-s="bar"]');
    d = await delta(() => s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: hot, qty: 1 }] }, { staff: false }));
    ok(!d.k.order, 'จอครัวที่ดูเฉพาะเครื่องดื่ม: ออเดอร์ครัวร้อนไม่ดัง', d.k);
    d = await delta(() => s.call('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: bar, qty: 1 }] }, { staff: false }));
    ok(d.k.order === 1, 'จอครัวที่ดูเฉพาะเครื่องดื่ม: ออเดอร์เครื่องดื่มดัง', d.k);
    d = await delta(() => s.call('POST', '/api/call', { table: 4, key: keys[4], kind: 'staff' }, { staff: false }));
    ok(eq(d, { k: {}, w: { call: 1 }, o: { call: 1 } }), 'ลูกค้าเรียกพนักงาน: หน้าร้านและเจ้าของได้ยิน ครัวไม่ดัง', d);
    d = await delta(() => s.call('POST', '/api/call', { table: 5, key: keys[5], kind: 'bill' }, { staff: false }));
    ok(eq(d, { k: {}, w: { bill: 1 }, o: { bill: 1 } }), 'ขอเช็คบิล: เสียงคนละแบบกับเรียกพนักงาน ครัวไม่ดัง', d);
    const t1 = (await s.call('GET', '/api/state')).json.tickets.find(x => x.table === 1);
    await s.call('POST', '/api/ticket', { id: t1.id, from: 'new', status: 'cooking' }); await sleep(800);
    d = await delta(() => s.call('POST', '/api/ticket', { id: t1.id, from: 'cooking', status: 'ready' }));
    ok(eq(d, { k: {}, w: { ready: 1 }, o: { ready: 1 } }), 'อาหารพร้อมเสิร์ฟ: พนักงานเสิร์ฟและเจ้าของได้ยิน (เดิมไม่มีเสียง)', d);
    // เรื่องค้าง: ออเดอร์ที่ยังไม่มีใครเริ่มทำ / การเรียกที่ยังไม่มีใครรับทราบ → เตือนซ้ำ
    d = await delta(async () => { for (const p of [k, w, o]) await p.clock.fastForward('02:30'); });
    ok(d.k.order >= 1 && !d.k.call && !d.k.bill, 'ออเดอร์ค้างเกิน 2 นาที: จอครัวเตือนซ้ำ', d.k);
    ok((d.w.bill || 0) + (d.w.call || 0) >= 1 && !d.w.order, 'ลูกค้าเรียก/ขอบิลค้าง: หน้าร้านเตือนซ้ำ', d.w);
    // จัดการทุกเรื่องแล้วต้องเงียบ
    const st = (await s.call('GET', '/api/state')).json;
    for (const t of st.tickets) { let from = t.status; for (const nx of ['cooking', 'ready', 'served'].slice(['new', 'cooking', 'ready'].indexOf(from))) { await s.call('POST', '/api/ticket', { id: t.id, from, status: nx }); from = nx; } }
    for (const t of Object.keys(st.calls)) await s.call('POST', '/api/call/clear', { table: +t });
    await sleep(1500);
    d = await delta(async () => { for (const p of [k, w, o]) await p.clock.fastForward('03:00'); });
    ok(eq(d, { k: {}, w: {}, o: {} }), 'ไม่มีเรื่องค้าง: ไม่เตือนซ้ำ', d);
    // แท็บเล็ตนาฬิกาเร็วกว่าเครื่องร้าน 5 นาที: ออเดอร์ที่เพิ่งเข้าต้องไม่ถูกนับว่าค้าง (ใช้เวลาที่ชดเชยแล้ว ไม่ใช่นาฬิกาแท็บเล็ต)
    {
      const ctx = await browser.newContext({ baseURL: s.B });
      await ctx.addInitScript(() => {
        window.__f = [];
        const A = window.AudioContext;
        window.AudioContext = function () { const ac = new A(), co = ac.createOscillator.bind(ac); ac.createOscillator = () => { const o2 = co(), st2 = o2.start.bind(o2); o2.start = t => { window.__f.push(o2.frequency.value); return st2(t); }; return o2; }; return ac; };
      });
      const sk = await ctx.newPage(); watch(sk, errors, 'skew');
      await sk.clock.install({ time: Date.now() + 5 * 60000 });
      await sk.goto('/staff'); await sk.fill('#pin', '520022'); await sk.press('#pin', 'Enter'); await sk.waitForSelector('#tabs .tab');
      await sk.mouse.click(5, 5); await sleep(200);
      await s.call('POST', '/api/order', { table: 9, key: keys[9], items: [{ id: hot, qty: 1 }] }, { staff: false }); await sleep(1500);
      const before = (await kinds(sk)).order;
      await sk.clock.fastForward('01:15'); await sleep(800);
      const after = (await kinds(sk)).order;
      ok(before === 1 && after === 1, 'แท็บเล็ตนาฬิกาเร็ว 5 นาที: ออเดอร์ใหม่ดังครั้งเดียว ไม่เตือนซ้ำทั้งที่เพิ่งเข้า', { before, after });
      await ctx.close();
    }
    // รีเฟรชหน้าแล้วยังไม่ได้แตะจอ: ป้ายบอกว่าเสียงปิดอยู่ แตะแล้วหาย
    await w.reload(); await w.waitForSelector('#tabs .tab');
    const before = await w.isVisible('#sound'); await w.click('#sound'); await sleep(300);
    ok(before && !(await w.isVisible('#sound')), 'รีเฟรชแล้วยังไม่แตะจอ: มีป้ายเปิดเสียง แตะแล้วเสียงเปิดและป้ายหาย');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    for (const p of [k, w, o]) await p.context().close();
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* พิมพ์ใบเสร็จ (กระดาษความร้อน 80 มม.): ใบสั้นได้หน้าเดียวไม่ซ้ำ ใบยาวไหลต่อหน้าไม่ทับกัน มีแต่ใบเสร็จ ไม่มีส่วนอื่นของหน้าจอ */
  async print(browser) {
    const ok = checker('print'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { promptpay: '0812345678' });
    const st0 = (await s.call('GET', '/api/state')).json, keys = st0.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }] }, { staff: false });
    for (let r = 0; r < 2; r++) await s.call('POST', '/api/order', { table: 2, key: keys[2], items: st0.menu.items.slice(r * 11, r * 11 + 11).map(m => ({ id: m.id, qty: 1, note: ['ไม่เผ็ด'] })) }, { staff: false });
    const p = await staffPage(browser, s, null, errors);
    await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    const pdfOf = async t => {
      await tab(p, 'tables'); await sleep(200);
      await p.click('[data-a="sel"][data-id="' + t + '"]'); await p.waitForSelector('.view:not([hidden]) .receipt .grand'); await sleep(200);
      const before = await p.evaluate(() => window.__printed);
      await p.click('[data-a="printr"]');
      await p.waitForFunction(n => window.__printed > n, before, { timeout: 5000 }).catch(() => {});
      await p.emulateMedia({ media: 'print' });
      const info = await p.evaluate(() => {
        const pa = document.querySelector('#print-area'), mm = px => Math.round(px * 25.4 / 96);
        const shown = [...document.body.children].filter(e => e !== pa && getComputedStyle(e).display !== 'none').map(e => e.id || e.className);
        const r = pa.getBoundingClientRect();
        return { h: mm(r.height), w: mm(pa.querySelector('.receipt').getBoundingClientRect().width), shown, fixed: [...pa.querySelectorAll('*')].some(e => getComputedStyle(e).position === 'fixed'), grand: pa.querySelectorAll('.grand').length };
      });
      const buf = await p.pdf({ width: '80mm', height: '200mm', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
      info.pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      await p.emulateMedia({ media: 'screen' });
      return info;
    };
    const a = await pdfOf(1);
    ok(a.pages === 1 && a.grand === 1, 'ใบเสร็จสั้น: หน้าเดียว ไม่พิมพ์ซ้ำ (เดิมออกมา 2 ใบ)', a);
    ok(!a.shown.length && !a.fixed, 'ตอนพิมพ์มีแต่ใบเสร็จ ส่วนอื่นของหน้าจอไม่กินกระดาษ', a);
    ok(a.w >= 70 && a.w <= 74, 'กว้างพอดีพื้นที่พิมพ์กระดาษ 80 มม. (72 มม.)', a.w);
    const b = await pdfOf(2);
    ok(b.h > 200 && b.pages === Math.ceil(b.h / 200) && b.grand === 1, 'ใบเสร็จยาวเกินหน้า: ไหลต่อหน้าตามความยาวจริง ไม่ทับกัน (เดิมหัวใบเสร็จพิมพ์ทับยอดรวม)', b);
    ok(!(await p.evaluate(() => document.body.className.includes('pm-receipt'))) && !(await p.evaluate(() => document.querySelector('#print-area').innerHTML)), 'พิมพ์เสร็จ: กลับหน้าจอปกติ ล้างสำเนาใบเสร็จ');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* POS: ยกเลิกทีละรายการจากรายละเอียดโต๊ะ: เลือกจำนวน เหตุผล ยอดบิลลดทันที ครัวทำแล้วต้อง PIN เจ้าของ พนักงานเสิร์ฟไม่เห็นปุ่ม */
  async itemvoid(browser) {
    const ok = checker('itemvoid'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/staff', { name: 'สมใจ', role: 'cashier', pin: '520011' });
    await s.call('POST', '/api/staff', { name: 'เสิร์ฟ', role: 'waiter', pin: '520033' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 3 }, { id: 2, qty: 1 }] }, { staff: false });
    const login = async pin => { const ctx = await browser.newContext({ baseURL: s.B }); const p = await ctx.newPage(); watch(p, errors, pin); await p.goto('/staff'); await p.fill('#pin', pin); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab'); return p; };
    const c = await login('520011');
    await tab(c, 'tables'); await c.click('[data-a="sel"][data-id="1"]'); await c.waitForSelector('.receipt .grand .a');
    const total0 = (await c.textContent('.receipt .grand .a')).trim();
    const btns = await c.$$eval('[data-a="voiditem"]', x => x.length);
    ok(btns === 2, 'แคชเชียร์เห็นปุ่มยกเลิกข้างแต่ละรายการ', btns);
    const st = (await s.call('GET', '/api/state')).json, k = st.tickets.find(x => x.table === 1), i1 = k.items.findIndex(x => x.id === 1);
    await c.click('[data-a="voiditem"][data-i="' + i1 + '"]'); await c.waitForSelector('#void-dlg[open]');
    ok(await c.isVisible('#void-qty') && await c.inputValue('#void-qty') === '3', 'หน้าต่างยกเลิกมีช่องจำนวน ค่าเริ่มต้น = ทั้งหมดของรายการนั้น');
    await c.fill('#void-qty', '2'); await c.check('#void-form input[value="ลูกค้าเปลี่ยนใจ"]'); await c.click('#void-ok');
    await c.waitForSelector('#void-dlg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.find(x => x.id === k.id).items.find(x => x.id === 1).qty === 1, 6000).catch(() => {});
    const qty = (await s.call('GET', '/api/state')).json.tickets.find(x => x.id === k.id).items.find(x => x.id === 1).qty;
    await c.waitForFunction(t0 => document.querySelector('.receipt .grand .a').textContent.trim() !== t0, total0, { timeout: 5000 }).catch(() => {});
    ok(qty === 1 && (await c.textContent('.receipt .grand .a')).trim() !== total0, 'ยกเลิก 2 จาก 3: เหลือ 1 จาน ยอดบนใบแจ้งยอดลดทันที', { qty, total0 });
    // ครัวเริ่มทำแล้ว: ขอ PIN เจ้าของในหน้าต่างเดียวกัน
    await s.call('POST', '/api/ticket', { id: k.id, from: 'new', status: 'cooking' }); await sleep(800);
    await c.click('[data-a="voiditem"][data-i="' + i1 + '"]'); await c.waitForSelector('#void-dlg[open]');
    ok(await c.isVisible('#void-pin'), 'ครัวทำแล้ว: หน้าต่างขอ PIN เจ้าของ');
    await c.check('#void-form input[value="ของหมด"]'); await c.fill('#void-pin', PIN); await c.click('#void-ok');
    await until(async () => !(await s.call('GET', '/api/state')).json.tickets.find(x => x.id === k.id).items.some(x => x.id === 1), 6000).catch(() => {});
    ok(!(await s.call('GET', '/api/state')).json.tickets.find(x => x.id === k.id).items.some(x => x.id === 1), 'PIN เจ้าของถูก: ยกเลิกจานสุดท้ายของรายการนั้น');
    const w = await login('520033');
    await tab(w, 'tables'); await w.click('[data-a="sel"][data-id="1"]'); await w.waitForSelector('.receipt .grand .a');
    ok(!(await w.$('[data-a="voiditem"]')), 'พนักงานเสิร์ฟไม่เห็นปุ่มยกเลิก (เรื่องเงิน)');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await c.context().close(); await w.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* เกณฑ์ตรวจรับ: มือถือจอแคบไม่เลื่อนแนวนอน, ราคาเปลี่ยนระหว่างสั่ง, เน็ตหลุด, ยกเลิกออเดอร์ต้องมีเหตุผลและ PIN เจ้าของ */
  async acceptance(browser) {
    const ok = checker('acceptance'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/menu/item', { name: 'ข้าวผัดกระเพราหมูกรอบไข่ดาวไม่สุกพิเศษเพิ่มข้าวราดน้ำปลาพริกมะนาวกระเทียมเจียวหอมๆ', price: 89, cat: 1, station: 'hot', desc: 'เผ็ดมากกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกก' });

    // 1) จอ 320 px (มือถือเล็กสุดที่ยังใช้กัน) ทุกขั้นตอนสั่งอาหาร
    const c = await customerPage(browser, s, 1, keys[1], errors, { viewport: { width: 320, height: 640 } });
    ok(!(await overflow(c)), '320px หน้าเมนู ไม่เลื่อนแนวนอน', await overflow(c) || undefined);
    await c.click('[data-a="inc"][data-id="1"]'); await c.click('[data-a="inc"][data-id="1"]');
    await c.click('[data-a="open"]'); await c.waitForSelector('#sheet [data-a="send"]');
    await c.click('[data-a="notes"]').catch(() => {});
    ok(!(await overflow(c)), '320px ตะกร้าและหมายเหตุ ไม่เลื่อนแนวนอน', await overflow(c) || undefined);

    // 2) ราคาเปลี่ยนตอนลูกค้าเปิดตะกร้าค้างไว้: ต้องเห็นยอดใหม่ก่อน ไม่ใช่เก็บเงินต่างจากที่เห็นเงียบๆ
    await s.call('POST', '/api/menu/item', { id: 1, name: 'ผัดกะเพราหมูสับ', price: 75, cat: 1, station: 'hot' });
    await c.click('[data-a="send"]');
    await c.waitForFunction(() => /ราคาเมนูเพิ่งเปลี่ยน/.test(document.querySelector('#sheet').textContent), null, { timeout: 8000 });
    await c.waitForFunction(() => /150/.test(document.querySelector('#sheet').textContent), null, { timeout: 8000 });
    ok((await s.call('GET', '/api/state')).json.tickets.length === 0, 'ราคาเปลี่ยน: ยังไม่มีออเดอร์เข้าครัว และตะกร้าแสดงยอดใหม่ 150');
    await c.click('[data-a="send"]');
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.length === 1, 8000);
    const t1 = (await s.call('GET', '/api/state')).json.tickets;
    ok(t1.length === 1 && t1[0].items[0].price === 75, 'กดอีกครั้งหลังเห็นยอดใหม่ สั่งได้ 1 ใบ ราคา 75');

    // 3) เน็ตหลุด: มีป้ายบอก ไม่แสดงข้อมูลเก่าเหมือนเป็นปัจจุบัน และหายเองเมื่อกลับมา
    await c.context().setOffline(true);
    await c.waitForSelector('#offline:not([hidden])', { timeout: 15000 }).catch(() => {});
    ok(await c.isVisible('#offline'), 'เน็ตหลุด: มีป้ายเตือนบนหน้าลูกค้า');
    await c.context().setOffline(false);
    await c.waitForSelector('#offline', { state: 'hidden', timeout: 15000 }).catch(() => {});
    ok(!(await c.isVisible('#offline')), 'เน็ตกลับมา: ป้ายหายเอง');

    // 4) ยกเลิกออเดอร์จากแคชเชียร์
    await s.call('POST', '/api/staff', { name: 'สมใจ', role: 'cashier', pin: '520011' });
    const ctx = await browser.newContext({ baseURL: s.B });
    const p = await ctx.newPage(); watch(p, errors, 'cashier');
    await p.goto('/staff'); await p.fill('#pin', '520011'); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
    const id = t1[0].id;
    await p.click('[data-a="void"][data-id="' + id + '"]');
    await p.waitForSelector('#void-dlg[open]');
    ok(await p.isHidden('#void-pin-row'), 'ออเดอร์ใหม่ ไม่ต้องใช้ PIN เจ้าของ');
    await p.click('#void-ok');
    ok(/เลือกเหตุผล/.test(await p.textContent('#void-err')), 'ไม่เลือกเหตุผล กดยืนยันไม่ได้');
    await p.check('#void-form input[value="อื่นๆ"]'); await p.fill('#void-note', 'ลูกค้าย้ายโต๊ะ');
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 2, qty: 1 }] }, { staff: false });   // มีออเดอร์ใหม่เข้าระหว่างพิมพ์
    await sleep(800);
    ok(await p.inputValue('#void-note') === 'ลูกค้าย้ายโต๊ะ' && await p.isChecked('#void-form input[value="อื่นๆ"]'), 'ออเดอร์ใหม่เข้าระหว่างพิมพ์ เหตุผลที่พิมพ์ไม่หาย');
    // ระหว่างนั้นครัวเริ่มทำ: เซิร์ฟเวอร์ขอ PIN เจ้าของ หน้าจอเปิดช่อง PIN ให้เอง
    await s.call('POST', '/api/ticket', { id, from: 'new', status: 'cooking' });
    await p.click('#void-ok');
    await p.waitForSelector('#void-pin-row:not([hidden])', { timeout: 5000 }).catch(() => {});
    ok(await p.isVisible('#void-pin-row'), 'ครัวเริ่มทำระหว่างเปิดหน้าต่าง: ขอ PIN เจ้าของ');
    await p.fill('#void-pin', '520011'); await p.click('#void-ok');
    await p.waitForFunction(() => /ไม่ถูกต้อง/.test(document.querySelector('#void-err').textContent), null, { timeout: 5000 }).catch(() => {});
    ok(/ไม่ถูกต้อง/.test(await p.textContent('#void-err')), 'PIN ผิด: แจ้งในหน้าต่าง ไม่ปิดเอง');
    await p.fill('#void-pin', PIN); await p.press('#void-pin', 'Enter');
    await p.waitForSelector('#void-dlg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    const left = (await s.call('GET', '/api/state')).json.tickets.map(t => t.id);
    ok(!left.includes(id), 'PIN เจ้าของถูก: ยกเลิกสำเร็จ หน้าต่างปิด');
    // คีย์บอร์ด: Esc ปิดหน้าต่าง โฟกัสอยู่ในหน้าต่างตอนเปิด
    const id2 = left[0];
    await p.click('[data-a="void"][data-id="' + id2 + '"]'); await p.waitForSelector('#void-dlg[open]');
    ok(await p.evaluate(() => !!document.activeElement.closest('#void-dlg')), 'เปิดหน้าต่างแล้วโฟกัสอยู่ในหน้าต่าง');
    await p.keyboard.press('Escape');
    ok(await p.isHidden('#void-dlg'), 'กด Esc ปิดหน้าต่าง ไม่ยกเลิกออเดอร์');
    ok((await s.call('GET', '/api/state')).json.tickets.some(t => t.id === id2), 'Esc แล้วออเดอร์ยังอยู่');
    const real = errors.filter(e => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
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
